//! ConPTY 可行性验证（Spike v2 —— 调研用临时代码，验证完即删）
//!
//! 目的：验证 `docs/pty-research.md` §7 风险 #1 ——
//! **「受限令牌（WRITE_RESTRICTED）+ Job Object + 伪控制台（ConPTY）」能否共存**。
//! 这是方案 B（自研 ConPTY）唯一的阻塞项，三轮中英文检索零命中，只能实测。
//!
//! ## v1 实测结果（2026-09-18）
//! - ✅ 主闸门通过：`CreatePseudoConsole` + 同一属性列表挂 `JOB_LIST`/`PSEUDOCONSOLE`
//!   + 受限令牌 `CreateProcessAsUserW` 全部成功；`ResizePseudoConsole` 返回 S_OK；
//!   `ClosePseudoConsole` 14.7ms 返回无死锁；输出严格为 UTF-8。
//! - ✅ 写隔离在 PTY 路径下仍有效。
//! - ❌ **stdout 路由错误**：不设 `STARTF_USESTDHANDLES` 时子进程**继承了父进程的 std 句柄**
//!   （Windows「标准句柄总是被继承」行为，`bInheritHandles=0` 挡不住），导致命令的
//!   真实输出漏到父进程 stdout 而非伪控制台。→ v2 修正：显式设置
//!   `STARTF_USESTDHANDLES` 并把三个句柄置 NULL（CRT 会回退到 CONOUT$/CONIN$）。
//! - ❌ v1 的 Ctrl+C 测试是**假阳性**（`ping -n 20` 未被打断，统计显示 20/20 全收，
//!   而等待窗口 20s 恰好覆盖了 ping 的 19s 生命周期）。→ v2 改为 `ping -n 60`
//!   并把判定窗口收紧到 6s。
//!
//! ⚠️ 本文件不是生产代码。跑完后请把结论回填 `docs/pty-research.md` 并删除本文件。
//!
//! 运行方式（Windows，在常规终端执行）：
//! ```bash
//! cd src-tauri
//! cargo test conpty_with_restricted_token -- --nocapture
//! ```

use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES,
};

use super::acl::{allow_null_device, ensure_allow_write_aces};
use super::cap;
use super::spawn::{current_env, make_env_block, to_wide, Job};
use super::token::{create_write_restricted_token_with_caps, LocalSid};
use super::INTERACTIVE_DESKTOP;
use crate::sandbox::state::SandboxState;

/// 与 `spawn.rs` 保持一致：本地定义，避免 windows-sys 跨版本符号差异。
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;

/// 属性列表包装：**数量 2**（JOB_LIST + PSEUDOCONSOLE）。
///
/// 生产代码里 `spawn.rs::ProcThreadAttributeList` 是私有的，这里按 §5.2 的结论
/// 重新实现，专门验证「两条属性共存」这件事。
struct AttrList {
    buffer: Vec<u8>,
    /// 持有 job 句柄数组，保证 `UpdateProcThreadAttribute` 取值期间内存稳定。
    job_list: Vec<HANDLE>,
}

impl AttrList {
    fn new(attr_count: u32) -> Result<Self, String> {
        let mut size: usize = 0;
        // 第一次调用只查询所需缓冲区大小（list 传 NULL）。
        let _ = unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), attr_count, 0, &mut size)
        };
        if size == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList size query failed: {}",
                unsafe { GetLastError() }
            ));
        }
        let mut buffer = vec![0u8; size];
        let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        let ok = unsafe { InitializeProcThreadAttributeList(list, attr_count, 0, &mut size) };
        if ok == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(Self {
            buffer,
            job_list: Vec::new(),
        })
    }

    fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }

    /// JOB_LIST：value = **指向句柄数组的指针**，size = 数组字节数。
    fn set_job(&mut self, job: HANDLE) -> Result<(), String> {
        self.job_list = vec![job];
        let value = self.job_list.as_mut_ptr().cast();
        let size = std::mem::size_of_val(self.job_list.as_slice());
        let ok = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                value,
                size,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "UpdateProcThreadAttribute(JOB_LIST) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(())
    }

    /// PSEUDOCONSOLE：value = **句柄值本身**，size = `size_of::<HPCON>()`。
    ///
    /// ⚠️ 注意与 `set_job` 的**语义差异**（见 `docs/pty-research.md` §5.2）：
    /// JOB_LIST 要的是「句柄数组的指针」，而 PSEUDOCONSOLE 要的是「句柄值本身」。
    /// 照抄 `set_job` 的写法把 `&hpc` 传进来会失败。
    fn set_pseudoconsole(&mut self, hpc: HPCON) -> Result<(), String> {
        let value = hpc as *const c_void;
        let size = std::mem::size_of::<HPCON>();
        let ok = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                value,
                size,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "UpdateProcThreadAttribute(PSEUDOCONSOLE) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(())
    }
}

impl Drop for AttrList {
    fn drop(&mut self) {
        // SAFETY: buffer 由 InitializeProcThreadAttributeList 初始化。
        unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
    }
}

/// 建一条**同步**匿名管道（ConPTY 要求同步 I/O，不接受 OVERLAPPED）。
///
/// `lpPipeAttributes = NULL` → 句柄不可继承，SD 取自**当前进程**默认 DACL。
/// 这与官方 ConPTY 示例一致；子进程并不直接继承这些句柄，
/// 而是通过 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 拿到伪控制台。
fn create_sync_pipe() -> Result<(HANDLE, HANDLE), String> {
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    let ok = unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) };
    if ok == 0 {
        return Err(format!("CreatePipe failed: {}", unsafe { GetLastError() }));
    }
    Ok((read, write))
}

/// 轮询等待文件出现（避免依赖固定 sleep 时序）。
fn wait_for_file(p: &Path, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if p.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// 读取当前 PTY 累积输出（有损转字符串，仅用于断言/打印）。
fn raw_text(raw: &Arc<Mutex<Vec<u8>>>) -> String {
    raw.lock()
        .map(|v| String::from_utf8_lossy(&v).to_string())
        .unwrap_or_default()
}

/// 轮询等待 PTY 输出中出现 needle —— 验证「输出路由」是否经过伪控制台。
fn wait_for_text(raw: &Arc<Mutex<Vec<u8>>>, needle: &str, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if raw_text(raw).contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

#[test]
fn conpty_with_restricted_token() {
    let base = std::env::temp_dir().join(format!("virlen-conpty-spike-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    // 工作目录 = 唯一可写根；状态目录也用临时的，避免污染真实 cap_sid.json
    let work = base.join("work");
    let state_dir = base.join("state");
    std::fs::create_dir_all(&work).expect("create work dir");
    let cwd = dunce::canonicalize(&work).expect("canonicalize work dir");

    println!("\n================ ConPTY Spike ================");
    println!("[spike] 工作目录(可写根): {}", cwd.display());

    // ---------- 1) 复用生产代码构建受限令牌 ----------
    // 关键：必须复用真实的 set_default_dacl（token.rs），否则失败了也说明不了问题。
    let state = SandboxState::from_default_or(Some(state_dir)).expect("sandbox state");
    let sid_str = cap::workspace_cap_sid_for_cwd(&state.state_dir, &cwd).expect("cap sid");
    let sid = LocalSid::from_string(&sid_str).expect("parse cap sid");
    allow_null_device(sid.as_ptr());
    ensure_allow_write_aces(&cwd, sid.as_ptr()).expect("grant write ACE on writable root");
    let h_token = unsafe { create_write_restricted_token_with_caps(&[sid.as_ptr()]) }
        .expect("create restricted token");
    println!("[spike] 受限令牌已创建（WRITE_RESTRICTED | LUA_TOKEN | DISABLE_MAX_PRIVILEGE）");

    // ---------- 2) 建管道 + 伪控制台 ----------
    let (in_read, in_write) = create_sync_pipe().expect("input pipe");
    let (out_read, out_write) = create_sync_pipe().expect("output pipe");

    let mut hpc: HPCON = 0;
    let hr = unsafe { CreatePseudoConsole(COORD { X: 120, Y: 30 }, in_read, out_write, 0, &mut hpc) };
    if hr < 0 {
        panic!(
            "❌ CreatePseudoConsole 失败：HRESULT 0x{:08X}（方案 B 不成立）",
            hr as u32
        );
    }
    println!("[spike] ✅ CreatePseudoConsole OK");

    // ---------- 3) 属性列表：JOB_LIST + PSEUDOCONSOLE 同时挂 ----------
    let job = Job::create().expect("create job object");
    let mut attrs = AttrList::new(2).expect("attr list");
    attrs.set_job(job.raw_handle()).expect("set JOB_LIST");
    attrs.set_pseudoconsole(hpc).expect("set PSEUDOCONSOLE");
    println!("[spike] ✅ 同一属性列表挂载 JOB_LIST + PSEUDOCONSOLE 成功");

    // ---------- 4) spawn：无 STARTF_USESTDHANDLES / bInheritHandles=0 ----------
    let mut cmdline = to_wide("cmd.exe /k");
    let mut cwd_wide = to_wide(cwd.to_string_lossy().as_ref());
    let mut desktop_wide = to_wide(INTERACTIVE_DESKTOP);
    let env = current_env();
    let mut env_block = make_env_block(&env);

    let (pid, h_process) = unsafe {
        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.lpDesktop = desktop_wide.as_mut_ptr();
        si.lpAttributeList = attrs.as_mut_ptr();
        // ⚠️ v2 修正：**必须**显式设置 STARTF_USESTDHANDLES 并把三个句柄置 NULL。
        // v1 不设该标志时，子进程**继承了父进程的 std 句柄**（Windows「标准句柄总是被继承」，
        // bInheritHandles=0 挡不住），导致命令真实输出漏到父进程 stdout 而没进伪控制台。
        // 置 NULL 后，CRT 在「句柄无效 + 进程有控制台」时会回退打开 CONOUT$/CONIN$。
        si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = std::ptr::null_mut();
        si.StartupInfo.hStdOutput = std::ptr::null_mut();
        si.StartupInfo.hStdError = std::ptr::null_mut();

        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            h_token,
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // bInheritHandles = 0
            CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            env_block.as_mut_ptr() as *const c_void,
            cwd_wide.as_mut_ptr(),
            &si.StartupInfo,
            &mut pi,
        );
        if ok == 0 {
            let err = GetLastError();
            panic!("❌ CreateProcessAsUserW 失败：Win32 error {err}（方案 B 不成立）");
        }
        CloseHandle(pi.hThread);
        (pi.dwProcessId, pi.hProcess)
    };
    println!("[spike] ✅✅ 主闸门通过：受限令牌 + ConPTY + Job Object 三者共存，pid={pid}");

    // 官方要求：创建后父进程关掉 inputReadSide / outputWriteSide
    unsafe {
        CloseHandle(in_read);
        CloseHandle(out_write);
    }

    // ---------- 5) 读线程（阻塞读，官方要求每条通道独立线程） ----------
    let raw = Arc::new(Mutex::new(Vec::<u8>::new()));
    let raw_reader = raw.clone();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    // HANDLE(*mut c_void) 不是 Send，转成 isize 再跨线程搬运
    // （与 spawn.rs 的 ProcessHandle newtype 同一目的，这里用最简形式）。
    let out_read_addr = out_read as isize;
    let _reader = std::thread::spawn(move || {
        let out_read = out_read_addr as HANDLE;
        let mut f = unsafe { std::fs::File::from_raw_handle(out_read as RawHandle) };
        let mut buf = [0u8; 4096];
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut acc) = raw_reader.lock() {
                        acc.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = done_tx.send(());
    });

    // 写入端：发命令 / 发控制键
    let mut writer = unsafe { std::fs::File::from_raw_handle(in_write as RawHandle) };
    let mut send = |s: &str| -> bool {
        writer.write_all(s.as_bytes()).is_ok() && writer.flush().is_ok()
    };

    // 顺带验证 ResizePseudoConsole（Step 1 的 UI 需要）
    let hr_resize = unsafe { ResizePseudoConsole(hpc, COORD { X: 100, Y: 40 }) };
    println!(
        "[spike] ResizePseudoConsole -> HRESULT 0x{:08X}",
        hr_resize as u32
    );

    // ---------- Test A1：输入能否送达并被执行（次闸门） ----------
    assert!(send("echo SPIKE_A_OK> a.txt\r\n"), "写入伪控制台失败");
    assert!(
        wait_for_file(&cwd.join("a.txt"), 20),
        "❌ 次闸门失败：写入 PTY 后 a.txt 未生成，说明输入未送达子进程"
    );
    println!("[spike] ✅ A1 次闸门通过：inputWriteSide 写入被 cmd 执行（a.txt 已生成）");

    // ---------- Test A2：输出路由是否正确（v1 的失败点） ----------
    let _ = send("echo SPIKE_ROUTE_XYZ\r\n");
    if wait_for_text(&raw, "SPIKE_ROUTE_XYZ", 10) {
        println!("[spike] ✅ A2 输出路由正确：命令输出经伪控制台回传");
    } else {
        println!(
            "[spike] ❌ A2 输出路由失败：PTY 中未见 SPIKE_ROUTE_XYZ（stdout 仍被继承，需继续修）"
        );
    }

    // ---------- Test B：沙盒写隔离在 PTY 路径下是否仍有效 ----------
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            let escape = Path::new(&profile).join("virlen_conpty_spike_escape.txt");
            let _ = std::fs::remove_file(&escape);
            let _ = send(&format!("echo NOPE>\"{}\"\r\n", escape.display()));
            std::thread::sleep(Duration::from_secs(3));
            if escape.exists() {
                println!(
                    "[spike] ⚠️⚠️ 写隔离失效！区外文件被写入: {}（安全红线，必须上报）",
                    escape.display()
                );
                let _ = std::fs::remove_file(&escape);
            } else {
                println!("[spike] ✅ 写隔离仍有效（区外写入被拒）");
            }
        }
    }

    // ---------- Test C：0x03 是否为真信号（v2：收紧判定窗口，杜绝假阳性） ----------
    // ping -n 60 自然跑完约 59s；若 6s 内 c.txt 就生成，说明 ping 确实被中断了。
    let t_c = Instant::now();
    let _ = send("ping -n 60 127.0.0.1\r\n");
    std::thread::sleep(Duration::from_millis(1500));
    let _ = send("\x03");
    std::thread::sleep(Duration::from_millis(600));
    let _ = send("echo SPIKE_C_OK> c.txt\r\n");
    if wait_for_file(&cwd.join("c.txt"), 6) {
        println!(
            "[spike] ✅ C Ctrl+C(0x03) 是有效控制信号：ping 被中断，{:?} 内回到提示符并执行下一条",
            t_c.elapsed()
        );
    } else {
        println!("[spike] ❌ C Ctrl+C 未生效：6s 内 c.txt 未生成（说明 ping 未被中断）");
    }
    println!(
        "[spike]    └ 孙进程(ping)输出是否也经 PTY 回传: {}",
        if raw_text(&raw).contains("TTL=") {
            "是"
        } else {
            "否"
        }
    );

    // ---------- Test D：关停顺序是否死锁 ----------
    job.terminate();
    let _ = unsafe { WaitForSingleObject(h_process, 5000) };
    let mut exit_code: u32 = 0;
    unsafe { GetExitCodeProcess(h_process, &mut exit_code) };
    println!("[spike] 子进程退出码 = {exit_code}");

    // 官方要求：关伪控制台时读线程必须**仍在排空**，故此处不停读线程。
    // 为防测试挂死，在独立线程里关并加超时看门狗。
    let (close_tx, close_rx) = mpsc::channel::<Duration>();
    let _closer = std::thread::spawn(move || {
        let t = Instant::now();
        unsafe { ClosePseudoConsole(hpc) };
        let _ = close_tx.send(t.elapsed());
    });
    match close_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(d) => println!("[spike] ✅ ClosePseudoConsole 正常返回，耗时 {d:?}"),
        Err(_) => println!("[spike] ⚠️ ClosePseudoConsole 超过 10s 未返回（死锁风险，需上报）"),
    }

    match done_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(()) => {
            let bytes = raw.lock().map(|v| v.clone()).unwrap_or_default();
            let is_utf8 = std::str::from_utf8(&bytes).is_ok();
            let text = String::from_utf8_lossy(&bytes).to_string();
            println!(
                "[spike] ✅ 读线程收到 EOF 并正常退出，共 {} 字节；严格 UTF-8 校验: {}",
                bytes.len(),
                if is_utf8 { "通过（印证 §5.6：ConPTY 输出为 UTF-8）" } else { "未通过（需保留 GBK 兜底）" }
            );
            let preview: String = text.chars().take(900).collect();
            println!("[spike] 输出预览(前 900 字符, 含转义):\n{preview:?}");
        }
        Err(_) => println!("[spike] ⚠️ 读线程 10s 未收到 EOF（通道未断开，需上报）"),
    }

    // 清理：Job drop 会 KILL_ON_JOB_CLOSE；临时目录整体删除
    unsafe { CloseHandle(h_process) };
    drop(sid);
    unsafe { CloseHandle(h_token) };
    let _ = std::fs::remove_dir_all(&base);
    println!("================ Spike 结束 ================\n");
}
