//! Toast 点击的 COM 激活器 —— 「进程内收不到点击」那条路的正解
//!
//! 背景（另见 `notify.rs` 模块头）：Windows 的 toast 点击有**两条互不排斥**的投递路径：
//! ① **进程内事件**：`notify::show_owned` 自持 `NotificationHandle`，点击在进程内到达，
//!    能**精确**知道是哪个会话（dev / 免安装 exe 走这条）；
//! ② **COM 激活**：系统按清单里的 `ToastActivatorCLSID` 唤起「激活器」——
//!    应用没在跑时由它拉起进程（`com:ExeServer@Arguments` 带 `-ToastActivated`），
//!    正在跑时把调用投递进已注册的类对象。
//!
//! 本模块实现 ②。拿不到会话 id（toast 的 `launch` 参数一路没有来源 ——
//! notify-rust 的 winrt 后端不写 `launch`），所以语义与「托盘左键」一致：
//! 唤醒窗口 + 切到最早那条未读。
//!
//! ⚠️ **三处必须一起改**（CLSID / 启动参数名）：
//! - `scripts/msix/AppxManifest.xml.template`：`ToastActivatorCLSID` + `com:ExeServer@Arguments`
//! - 本文件：`TOAST_ACTIVATOR_CLSID` / `TOAST_ACTIVATED_ARG`
//! - `lib.rs` 的单实例回调：argv 带 `-ToastActivated` ⇒ 按「点击通知」处理
//!
//! ⚠️ **只有打包安装版才有清单**，dev / 免安装 exe 注册了也没人来调。但注册本身
//! 无副作用（类对象只在**本进程**可见，不进系统注册表），因此不做环境判断，一律注册
//! —— 少一个「装完包才发现没生效」的坑。

use serde_json::json;
use tauri::AppHandle;

use crate::telemetry;

/// Toast 激活器 CLSID —— **唯一真源是 MSIX 清单**，此处必须逐字一致。
///
/// 清单 schema 要求 GUID **不带花括号**（`{...}` 会被 MakeAppx 报 `error C00CE169`）。
pub const TOAST_ACTIVATOR_CLSID: &str = "bfadf116-f14e-4ede-b4b6-8fe2968e534f";

/// MSIX 清单 `com:ExeServer@Arguments`：系统按 CLSID 拉起本进程时带上的标记
pub const TOAST_ACTIVATED_ARG: &str = "-ToastActivated";

/// 「进程内刚处理过点击」的去重窗口（毫秒）
///
/// 一次点击可能同时走进程内事件与 COM 激活。若两边都切会话，就会出现
/// 「先精确切到 A，又被切到最早未读 B」——用户看到的是明明点了这条、却停在另一条。
/// 窗口内的 COM 激活因此只负责把窗口拎到前台，不再动会话。
#[cfg(target_os = "windows")]
const CLICK_DEDUP_MS: i64 = 3_000;

/// argv 里是否带了「被点击通知拉起」的标记（纯函数，便于单测）
///
/// 大小写不敏感：清单里写的是 `-ToastActivated`，但真到运行时没人保证大小写。
pub fn is_toast_activated(argv: &[String]) -> bool {
    argv.iter()
        .any(|arg| arg.eq_ignore_ascii_case(TOAST_ACTIVATED_ARG))
}

/// 注册 COM 激活器（启动时调用一次；非 Windows 是空操作）
pub fn init(app: &AppHandle) {
    telemetry::track(
        "tray.toast_activator",
        json!({
            "action": "init",
            // 只有「被点击通知拉起」的进程才会带这个参数 —— 用来判断
            // 系统到底是走「拉起新进程」还是「投递进已有进程」
            "launched_by_toast": is_toast_activated(&std::env::args().collect::<Vec<_>>()),
            // 顺带记下本构建期望的 CLSID：激活失败不会报错到 UI，只能靠埋点对账
            "clsid": TOAST_ACTIVATOR_CLSID,
        }),
    );

    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("toast-activator".into())
            .spawn(move || windows_impl::register(app));
        if let Err(error) = spawned {
            telemetry::track(
                "tray.toast_activator",
                json!({ "action": "spawn", "ok": false, "error": error.to_string() }),
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// 撤销注册（退出前调用；幂等，非 Windows 是空操作）
///
/// 不做也不会错（进程退出时 COM 自己清），但显式撤销能让「注册 → 撤销」对称，
/// 也方便将来在同一进程里重启注册。
pub fn shutdown() {
    #[cfg(target_os = "windows")]
    windows_impl::revoke();
}

/// Windows 实现：`IClassFactory` + `INotificationActivationCallback` + 常驻注册线程
#[cfg(target_os = "windows")]
mod windows_impl {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    use serde_json::json;
    use tauri::AppHandle;
    use windows::core::{implement, Interface, Ref, BOOL, GUID, IUnknown, PCWSTR};
    use windows::Win32::Foundation::E_POINTER;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, IClassFactory,
        IClassFactory_Impl, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, REGCLS_MULTIPLEUSE,
    };
    use windows::Win32::UI::Notifications::{
        INotificationActivationCallback, INotificationActivationCallback_Impl,
        NOTIFICATION_USER_INPUT_DATA,
    };

    use crate::telemetry;
    use crate::tray::{activate_main_window, notify, show_main_window};

    use super::{CLICK_DEDUP_MS, TOAST_ACTIVATOR_CLSID};

    /// 类对象注册 cookie（0 = 未注册）
    static COOKIE: AtomicU32 = AtomicU32::new(0);

    /// CLSID 常量 —— `GUID::from_u128` 是 const，故可直接当常量用（无需 once_cell）
    const CLSID: GUID = GUID::from_u128(0xbfadf116_f14e_4ede_b4b6_8fe2968e534f);

    /// 激活回调：系统把「用户点了通知」投递到这里
    #[implement(INotificationActivationCallback)]
    struct ToastActivator {
        app: AppHandle,
    }

    impl INotificationActivationCallback_Impl for ToastActivator_Impl {
        fn Activate(
            &self,
            _appusermodelid: &PCWSTR,
            invokedargs: &PCWSTR,
            _data: *const NOTIFICATION_USER_INPUT_DATA,
            _count: u32,
        ) -> windows::core::Result<()> {
            let args_len = if invokedargs.is_null() {
                0
            } else {
                unsafe { invokedargs.len() }
            };
            // ⚠️ 本回调跑在 **COM 的 RPC 线程**上：只做非阻塞投递（tauri 会把
            // 窗口操作 marshal 回主线程），绝不在这里等待或做重活。
            let dedup = notify::click_handled_within(CLICK_DEDUP_MS);
            if dedup {
                // 进程内通道刚精确切过会话 → 只保证窗口在前台，不再动会话
                show_main_window(&self.app, true);
            } else {
                // 拿不到会话 id：唤醒窗口 + 切到最早那条未读（与托盘左键同语义）
                activate_main_window(&self.app, "toast_activated");
            }
            telemetry::track(
                "tray.toast_activate",
                json!({ "dedup": dedup, "args_len": args_len }),
            );
            Ok(())
        }
    }

    /// 类工厂：COM 要求注册的类对象实现 `IClassFactory`，由它交出回调接口
    #[implement(IClassFactory)]
    struct ToastActivatorFactory {
        activator: INotificationActivationCallback,
    }

    impl IClassFactory_Impl for ToastActivatorFactory_Impl {
        fn CreateInstance(
            &self,
            _punkouter: Ref<'_, IUnknown>,
            riid: *const GUID,
            ppvobject: *mut *mut core::ffi::c_void,
        ) -> windows::core::Result<()> {
            if riid.is_null() || ppvobject.is_null() {
                return Err(E_POINTER.into());
            }
            // 按调用方请求的 IID 交出回调对象（实际总是
            // INotificationActivationCallback 的 IID）
            unsafe { self.activator.query(riid, ppvobject).ok() }
        }

        fn LockServer(&self, _flock: BOOL) -> windows::core::Result<()> {
            // 不做「锁定服务器」优化：进程寿命本来就由窗口/托盘决定
            Ok(())
        }
    }

    /// 在一条**常驻线程**上注册类对象
    ///
    /// ⚠️ **线程必须常驻**：`CoRegisterClassObject` 的注册挂在注册线程的 apartment 上，
    /// 线程一退（隐式 `CoUninitialize`）注册就没了；而「点击通知拉起进程」要求进程在
    /// 系统给的那几秒内把类对象挂上并**一直持有**，否则激活直接失败。
    ///
    /// ⚠️ 用 **MTA**（`COINIT_MULTITHREADED`）：MTA 下不需要消息泵，
    /// 激活由 RPC 线程投递进来；放在 tauri 主线程（STA）上就得依赖它的消息循环，
    /// 还得和 WebView2 的 OLE 初始化抢地盘。
    pub(super) fn register(app: AppHandle) {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                telemetry::track(
                    "tray.toast_activator",
                    json!({ "action": "co_init", "ok": false, "hr": hr.0 }),
                );
                return;
            }

            let activator: INotificationActivationCallback = ToastActivator { app }.into();
            let factory: IClassFactory = ToastActivatorFactory { activator }.into();
            let unknown: IUnknown = match factory.cast() {
                Ok(unknown) => unknown,
                Err(error) => {
                    telemetry::track(
                        "tray.toast_activator",
                        json!({ "action": "cast", "ok": false, "error": error.to_string() }),
                    );
                    return;
                }
            };

            match CoRegisterClassObject(&CLSID, &unknown, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE) {
                Ok(cookie) => {
                    COOKIE.store(cookie, Ordering::SeqCst);
                    // 接口引用要活到进程结束（与 `drag_drop.rs` 的 `mem::forget` 同款手法：
                    // 这里没有可挂靠的托管状态，注册是一次性的）
                    std::mem::forget(unknown);
                    telemetry::track(
                        "tray.toast_activator",
                        json!({ "action": "register", "ok": true, "clsid": TOAST_ACTIVATOR_CLSID }),
                    );
                    loop {
                        std::thread::sleep(Duration::from_secs(3_600));
                    }
                }
                Err(error) => {
                    telemetry::track(
                        "tray.toast_activator",
                        json!({ "action": "register", "ok": false, "error": error.to_string() }),
                    );
                }
            }
        }
    }

    /// 撤销注册（幂等）
    pub(super) fn revoke() {
        let cookie = COOKIE.swap(0, Ordering::SeqCst);
        if cookie == 0 {
            return;
        }
        unsafe {
            let _ = CoRevokeClassObject(cookie);
        }
        telemetry::track("tray.toast_activator", json!({ "action": "revoke" }));
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// `CLSID`（GUID 常量，运行时必须是 const）与 `TOAST_ACTIVATOR_CLSID`
        /// （给人看、与清单对照的字符串）必须描述同一个 CLSID。
        ///
        /// ⚠️ 拼错任何一处都会让「点击通知」**静默失效**（COM 激活失败不会弹到 UI），
        /// 所以这里用 GUID 的 Debug 格式（大写、无花括号）反查一遍。
        #[test]
        fn guid_literal_matches_clsid_string() {
            assert_eq!(format!("{:?}", CLSID).to_lowercase(), TOAST_ACTIVATOR_CLSID);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    /// argv 判定：清单里的参数名是唯一依据，只认**完整 token**
    #[test]
    fn detects_toast_activation_arg() {
        assert!(is_toast_activated(&argv(&["virlen-app.exe", "-ToastActivated"])));
        // 大小写不敏感（系统实际怎么写不该成为隐患）
        assert!(is_toast_activated(&argv(&["-toastactivated"])));
        // 普通启动 / 第二个实例携带的其它参数
        assert!(!is_toast_activated(&argv(&["virlen-app.exe"])));
        assert!(!is_toast_activated(&argv(&[])));
        assert!(!is_toast_activated(&argv(&["C:\\Users\\x\\AppData\\Local\\Virlen"])));
        // 只认完整 token，不做前缀/子串匹配（避免误判成「点击通知」）
        assert!(!is_toast_activated(&argv(&["-ToastActivatedX"])));
        assert!(!is_toast_activated(&argv(&["--toast-activated"])));
    }

    /// CLSID 字面量必须与 MSIX 清单一致（清单里不带花括号）
    #[test]
    fn clsid_matches_manifest_literal() {
        assert_eq!(TOAST_ACTIVATOR_CLSID, "bfadf116-f14e-4ede-b4b6-8fe2968e534f");
        assert!(!TOAST_ACTIVATOR_CLSID.starts_with('{'));
        assert_eq!(TOAST_ACTIVATOR_CLSID.len(), 36);
    }

    /// 清单 `com:ExeServer@Arguments` 与本文件的常量是同一份契约
    #[test]
    fn activation_arg_matches_manifest() {
        assert_eq!(TOAST_ACTIVATED_ARG, "-ToastActivated");
    }

    /// 与 MSIX 清单的三处契约（CLSID / CLSID 属性名 / 启动参数）必须逐字一致
    ///
    /// ⚠️ 任何一处错位都表现为「点击通知毫无反应」，而且不报错、不进 UI ——
    /// 只能靠这个单测兜住（直接读清单，不走文档）。
    #[test]
    fn manifest_contract_matches() {
        let manifest = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/msix/AppxManifest.xml.template"
        ));
        assert!(manifest.contains(&format!("ToastActivatorCLSID=\"{TOAST_ACTIVATOR_CLSID}\"")));
        assert!(manifest.contains(&format!("com:Class Id=\"{TOAST_ACTIVATOR_CLSID}\"")));
        assert!(manifest.contains(&format!("Arguments=\"{TOAST_ACTIVATED_ARG}\"")));
        // 花括号会让 MakeAppx 直接报 C00CE169（曾经踩过）
        assert!(!manifest.contains(&format!("ToastActivatorCLSID=\"{{{TOAST_ACTIVATOR_CLSID}}}\"")));
    }
}
