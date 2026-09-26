//! 真实 Windows E2E 测试：验证「受限令牌 + NTFS ACL」写隔离闭环 + ConPTY 回归。
//!
//! 这些测试有真实副作用：修改目录 ACL、以受限令牌拉起真实子进程、写入临时文件、
//! 改写 `\\.\NUL` 设备 ACL（`allow_null_device` 只增不减，属生产代码固有行为）。
//!
//! 仅 Windows 编译运行。建议串行执行，避免多个测试同时改 `\\.\NUL` 全局 ACL：
//!   cargo test --lib sandbox::windows::tests -- --nocapture --test-threads=1
//!
//! 覆盖场景：
//!   1. 区内写成功
//!   2. 区外写被拒
//!   3. `.git` 写被拒
//!   4. 孙进程回收（Job Object terminate 连带杀死孙进程）
//!   5. 降级前置条件（prepare 失败正确返回 Err）
//!   6. （附）readonly 模式：连 cwd 都不可写
//!   7. ConPTY 回归（`conpty_with_restricted_token`）——原 `conpty_spike.rs` 并入，
//!      证明「受限令牌 + Job Object + 伪控制台」三者共存（见 `docs/pty-research.md` §8 Step 0）。

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
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
use crate::sandbox::{SandboxRequest, SandboxSession};

/// 每次测试独立的临时环境：写根(cwd) + 写根外(outside) + 独立 state_dir。
struct TestEnv {
    base: PathBuf,
    cwd: PathBuf,
    outside: PathBuf,
    state: SandboxState,
}

impl TestEnv {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "virlen-sb-e2e-{}-{}-{}",
            std::process::id(),
            tag,
            nanos
        ));
        let cwd = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&cwd).expect("create cwd");
        std::fs::create_dir_all(&outside).expect("create outside");
        let state = SandboxState::new(base.join("state")).expect("create state dir");
        Self {
            base,
            cwd,
            outside,
            state,
        }
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        // 清理临时目录（测试进程持完整令牌，deny-write ACE 只针对随机能力 SID，不影响清理）。
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// 构建并 prepare 一个沙盒会话。
fn prepare_session(env: &TestEnv, readonly: bool, extra: Vec<PathBuf>) -> SandboxSession {
    let req = SandboxRequest {
        cwd: env.cwd.clone(),
        extra_roots: extra,
        protect: vec![],
        readonly,
    };
    SandboxSession::prepare(&req, &env.state).expect("prepare failed")
}

/// spawn 一个命令，读完 stdout/stderr，返回 (stdout, stderr, exit_code)。
///
/// 注意：仅适用于「无孙进程持有管道写端」的命令（cmd/powershell 立即退出）。
fn run(
    session: &SandboxSession,
    argv: &[&str],
    raw_cmdline: Option<&str>,
) -> (Vec<u8>, Vec<u8>, Option<i32>) {
    let argv_owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let mut child = session
        .spawn(&argv_owned, raw_cmdline, &BTreeMap::new())
        .expect("spawn failed");
    let mut out = Vec::new();
    let mut err = Vec::new();
    if let Some(mut f) = child.stdout.take() {
        let _ = f.read_to_end(&mut out);
    }
    if let Some(mut f) = child.stderr.take() {
        let _ = f.read_to_end(&mut err);
    }
    let code = child.wait_and_read_exit_code();
    (out, err, code)
}

/// 判断进程是否仍在运行（OpenProcess + GetExitCodeProcess == STILL_ACTIVE）。
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess};
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: 系统调用；句柄随后 CloseHandle。
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn e2e_write_inside_root_succeeds() {
    let env = TestEnv::new("inside");
    let session = prepare_session(&env, false, vec![]);
    let raw = "cmd.exe /s /c echo hello > inside.txt";
    let (_out, err, code) =
        run(&session, &["cmd", "/s", "/c", "echo hello > inside.txt"], Some(raw));
    assert_eq!(
        code,
        Some(0),
        "区内写应成功；stderr={}",
        String::from_utf8_lossy(&err)
    );
    let f = env.cwd.join("inside.txt");
    assert!(f.exists(), "写根内 inside.txt 应被创建");
    let content = std::fs::read_to_string(&f).expect("read inside.txt");
    assert!(content.contains("hello"), "内容不符: {:?}", content);
}

#[test]
fn e2e_write_outside_root_denied() {
    let env = TestEnv::new("outside");
    let session = prepare_session(&env, false, vec![]);
    let raw = r"cmd.exe /s /c echo hello > ..\outside\outside.txt";
    let (_out, err, code) = run(
        &session,
        &["cmd", "/s", "/c", r"echo hello > ..\outside\outside.txt"],
        Some(raw),
    );
    let f = env.outside.join("outside.txt");
    assert!(
        !f.exists(),
        "写根外的 outside.txt 绝不应被创建（OS 层写隔离失效）"
    );
    assert!(
        code != Some(0),
        "区外写应失败（非 0 退出码）；实际 {code:?}；stderr={}",
        String::from_utf8_lossy(&err)
    );
}

#[test]
fn e2e_write_dot_git_denied() {
    let env = TestEnv::new("dotgit");
    // .git 必须先于 prepare 存在，prepare 才会加 deny-write ACE。
    std::fs::create_dir_all(env.cwd.join(".git")).expect("create .git");
    let session = prepare_session(&env, false, vec![]);
    let raw = r"cmd.exe /s /c echo hello > .git\secret.txt";
    let (_out, err, code) = run(
        &session,
        &["cmd", "/s", "/c", r"echo hello > .git\secret.txt"],
        Some(raw),
    );
    let f = env.cwd.join(".git").join("secret.txt");
    assert!(
        !f.exists(),
        ".git/secret.txt 绝不应被创建（保护路径 deny 失效）"
    );
    assert!(
        code != Some(0),
        ".git 内写应失败；实际 {code:?}；stderr={}",
        String::from_utf8_lossy(&err)
    );
}

#[test]
fn e2e_grandchild_reaped_on_terminate() {
    let env = TestEnv::new("grandchild");
    let session = prepare_session(&env, false, vec![]);

    // 父 powershell 启动一个孙进程（sleep 300s），把孙进程 PID 写进写根，
    // 随后自己退出。孙进程继承 Job（CreateProcess 不 breakaway）。
    let script = r#"$p = Start-Process -WindowStyle Hidden -PassThru -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 300'; Set-Content -Path 'grandchild.pid' -Value $p.Id"#;
    let argv = ["powershell", "-NoProfile", "-Command", script];
    let argv_owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let child = session
        .spawn(&argv_owned, None, &BTreeMap::new())
        .expect("spawn powershell");

    // 只等父进程退出。注意不读 stdout：孙进程继承管道写端，读到 EOF 会阻塞。
    let code = child.wait_and_read_exit_code();
    assert_eq!(code, Some(0), "父 powershell 应正常退出");

    let pid_path = env.cwd.join("grandchild.pid");
    assert!(
        pid_path.exists(),
        "父进程应已写出孙进程 PID 到 grandchild.pid"
    );
    let pid_str = std::fs::read_to_string(&pid_path).expect("read grandchild.pid");
    let gpid: u32 = pid_str.trim().parse().expect("parse grandchild pid");

    assert!(
        process_alive(gpid),
        "孙进程 {gpid} 在 terminate 前应仍存活"
    );

    // 一键终止 Job：孙进程必须被连带杀死（验证 KILL_ON_JOB_CLOSE / TerminateJobObject）。
    child.terminate();

    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(
        !process_alive(gpid),
        "孙进程 {gpid} 应在 Job terminate 后被回收"
    );
}

#[test]
fn readonly_mode_denies_write_in_cwd() {
    // readonly 模式（M6 将正式接入前端，这里先验证底层闭环）：不授予任何写根能力 SID，
    // 连 cwd 都不可写。
    let env = TestEnv::new("readonly");
    let session = prepare_session(&env, true, vec![]);
    let raw = "cmd.exe /s /c echo hello > inside.txt";
    let (_out, _err, _code) =
        run(&session, &["cmd", "/s", "/c", "echo hello > inside.txt"], Some(raw));
    assert!(
        !env.cwd.join("inside.txt").exists(),
        "readonly 模式绝不应在 cwd 写入"
    );
}

#[test]
fn prepare_fails_on_missing_cwd() {
    // 降级前置条件：cwd 不存在 → prepare Err，上层据此回退裸跑路径。
    let env = TestEnv::new("missing-cwd");
    let req = SandboxRequest {
        cwd: env.base.join("does-not-exist"),
        extra_roots: vec![],
        protect: vec![],
        readonly: false,
    };
    let res = SandboxSession::prepare(&req, &env.state);
    assert!(res.is_err(), "prepare 对不存在的 cwd 应返回 Err");
}

#[test]
fn prepare_fails_on_readonly_with_extra_roots() {
    // 降级前置条件：readonly 与 extra_roots 互斥 → prepare Err。
    let env = TestEnv::new("ro-extra");
    let extra = env.base.join("extra");
    std::fs::create_dir_all(&extra).expect("create extra");
    let req = SandboxRequest {
        cwd: env.cwd.clone(),
        extra_roots: vec![extra],
        protect: vec![],
        readonly: true,
    };
    let res = SandboxSession::prepare(&req, &env.state);
    assert!(res.is_err(), "readonly + extra_roots 应返回 Err");
}

#[test]
fn e2e_extra_root_writable() {
    // M6 映射：whitelist → extra_roots。extra root 目录应可写（即使不在 cwd 下）。
    let env = TestEnv::new("extra-root");
    let extra = env.base.join("extra-writable");
    std::fs::create_dir_all(&extra).expect("create extra-writable");
    let session = prepare_session(&env, false, vec![extra.clone()]);

    let target = extra.join("extra.txt");
    let raw = format!("cmd.exe /s /c echo hello > \"{}\"", target.display());
    let argv = ["cmd", "/s", "/c", "echo hello > extra.txt"];
    let (_out, err, code) = run(&session, &argv, Some(&raw));
    assert_eq!(
        code,
        Some(0),
        "extra root 写应成功；stderr={}",
        String::from_utf8_lossy(&err)
    );
    assert!(target.exists(), "extra root 内 extra.txt 应被创建");
    assert!(std::fs::read_to_string(&target).unwrap().contains("hello"));
}

#[test]
fn e2e_protect_path_denied() {
    // M6 映射：skills_dir → protect。显式 protect 目录应拒绝写入。
    let env = TestEnv::new("protect-path");
    let protected = env.cwd.join("secrets");
    std::fs::create_dir_all(&protected).expect("create secrets");
    let req = SandboxRequest {
        cwd: env.cwd.clone(),
        extra_roots: vec![],
        protect: vec![protected.clone()],
        readonly: false,
    };
    let session = SandboxSession::prepare(&req, &env.state).expect("prepare");

    let target = protected.join("x.txt");
    let raw = format!("cmd.exe /s /c echo hello > \"{}\"", target.display());
    let argv = ["cmd", "/s", "/c", "echo hello > x.txt"];
    let (_out, err, code) = run(&session, &argv, Some(&raw));
    assert!(
        !target.exists(),
        "protect 目录内 x.txt 绝不应被创建（deny 失效）"
    );
    assert!(
        code != Some(0),
        "protect 内写应失败；实际 {code:?}；stderr={}",
        String::from_utf8_lossy(&err)
    );
}

#[test]
fn e2e_powershell_basic_cmdlets_work() {
    // 沙盒路径下 PowerShell 会进入约束语言模式（CLM），但基本 cmdlet
    // （New-Item/Set-Content/Get-Item）应仍可用 —— 这是用户日常命令（创建/读写文件）的核心。
    let env = TestEnv::new("pwsh-basic");
    let session = prepare_session(&env, false, vec![]);
    let script = "New-Item -ItemType File -Path inside.txt -Force | Out-Null; Set-Content -Path inside.txt -Value 'hello'; Get-Item inside.txt | Select-Object -ExpandProperty Length";
    let argv = ["powershell", "-NoProfile", "-Command", script];
    let (_out, err, code) = run(&session, &argv, None);
    assert_eq!(
        code,
        Some(0),
        "pwsh 基本 cmdlet 应可用；stderr={}",
        String::from_utf8_lossy(&err)
    );
    let f = env.cwd.join("inside.txt");
    assert!(f.exists(), "inside.txt 应被创建");
    assert_eq!(std::fs::read_to_string(&f).unwrap().trim(), "hello");
}

#[test]
fn e2e_extra_root_acl_failure_skips_gracefully() {
    // 回归：whitelist 里的系统目录（如 C:\Windows\Temp，普通用户无 WRITE_DAC/READ_CONTROL）
    // 改 ACL 失败时，应跳过该 extra root，而不是让整个 prepare 失败 → 静默降级裸跑。
    let env = TestEnv::new("extra-acl-fail");
    let extra = PathBuf::from(r"C:\Windows\Temp");
    if !extra.is_dir() {
        return; // 环境无此目录，跳过
    }
    let session = SandboxSession::prepare(
        &SandboxRequest {
            cwd: env.cwd.clone(),
            extra_roots: vec![extra],
            protect: vec![],
            readonly: false,
        },
        &env.state,
    )
    .expect("extra root 改 ACL 失败不应导致 prepare 整体失败");

    // cwd 仍可写
    let raw_inside = "cmd.exe /s /c echo hello > inside.txt";
    let (_o, _e, code) = run(
        &session,
        &["cmd", "/s", "/c", "echo hello > inside.txt"],
        Some(raw_inside),
    );
    assert_eq!(code, Some(0), "cwd 内写应成功");
    assert!(env.cwd.join("inside.txt").exists());

    // cwd 外不可写（写隔离仍生效）
    let raw_outside = r"cmd.exe /s /c echo hello > ..\outside\outside.txt";
    let (_o, _e, code) = run(
        &session,
        &["cmd", "/s", "/c", r"echo hello > ..\outside\outside.txt"],
        Some(raw_outside),
    );
    assert!(
        !env.outside.join("outside.txt").exists(),
        "cwd 外写应被拒（写隔离失效）"
    );
    assert!(code != Some(0), "cwd 外写应失败");
}

/// 复现用户真机问题：npm 跑依赖 lifecycle script（如 fds 的 node-gyp rebuild）时，
/// 受限令牌内的 node 再 spawn 孙进程（cmd.exe）返回 EPERM。
/// 先用最小 JS 探针隔离：沙箱内 node 分别 spawn cmd 与 node，看各自状态/错误。
#[test]
#[ignore]
#[cfg(target_os = "windows")]
fn e2e_node_spawn_probe_under_sandbox() {
    let env = TestEnv::new("node-spawn");
    let session = prepare_session(&env, false, vec![]);
    let probe_js = r#"
const { spawnSync } = require('child_process');
function t(label, cmd, args, opts) {
  const o = Object.assign({ encoding: 'utf8', shell: false }, opts || {});
  const r = spawnSync(cmd, args, o);
  console.log(label + '|' + JSON.stringify({
    status: r.status,
    signal: r.signal,
    error: r.error ? r.error.code + ':' + r.error.message : null,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim()
  }));
}
t('cmd-spawn', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi']);
t('node-spawn', process.execPath, ['-e', 'console.log("hi-node")']);
t('cmd-hide', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi'], { windowsHide: true });
t('node-hide', process.execPath, ['-e', 'console.log("hi-node")'], { windowsHide: true });
t('shell-echo', 'echo hi', [], { shell: true });
t('cmd-ignore', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi'], { stdio: 'ignore' });
t('cmd-inherit', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi'], { stdio: 'inherit' });
t('stdout-only', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi'], { stdio: ['ignore', 'pipe', 'ignore'] });
t('stderr-only', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi'], { stdio: ['ignore', 'ignore', 'pipe'] });
t('stdin-only', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo hi'], { stdio: ['pipe', 'ignore', 'ignore'] });
"#;
    std::fs::write(env.cwd.join("probe.js"), probe_js).unwrap();
    let script = "node probe.js";
    let (out, err, code) = run(
        &session,
        &["cmd", "/d", "/s", "/c", script],
        Some(script),
    );
    eprintln!("exit={code:?}\nSTDOUT:\n{}\nSTDERR:\n{}", String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
    assert_eq!(code, Some(0));
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("cmd-spawn"), "缺少 cmd-spawn 结果");
    assert!(text.contains("node-spawn"), "缺少 node-spawn 结果");

    // 对照：受限 PowerShell 内部用三种方式建孙进程，区分 cmdlet(ShellExecute) 与原生 CreateProcess。
    let ps_script = r#"
$ErrorActionPreference = 'Continue'
function W($m){ Write-Output $m }
try { & cmd.exe /d /s /c 'echo hi > ps-call.txt' | Out-Null; W ('call-op=' + (Test-Path 'ps-call.txt')) } catch { W ('call-op=err:' + $_.Exception.Message) }
try { $psi = New-Object System.Diagnostics.ProcessStartInfo -Property @{ FileName='powershell.exe'; Arguments='-NoProfile -Command exit 0'; UseShellExecute=$false }; $p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); W ('dotnet-start=' + $p.ExitCode) } catch { W ('dotnet-start=err:' + $_.Exception.Message) }
try { $psi2 = New-Object System.Diagnostics.ProcessStartInfo -Property @{ FileName='powershell.exe'; Arguments='-NoProfile -Command exit 0'; UseShellExecute=$false; RedirectStandardOutput=$true; RedirectStandardError=$true }; $p2 = [System.Diagnostics.Process]::Start($psi2); $p2.WaitForExit(); W ('dotnet-redir=' + $p2.ExitCode) } catch { W ('dotnet-redir=err:' + $_.Exception.Message) }
try { $q = Start-Process -WindowStyle Hidden -PassThru powershell.exe -ArgumentList '-NoProfile','-Command','exit 0'; $q.WaitForExit(); W ('cmdlet-start=' + $q.ExitCode) } catch { W ('cmdlet-start=err:' + $_.Exception.Message) }
"#;
    std::fs::write(env.cwd.join("ps_probe.ps1"), ps_script).unwrap();
    let ps_cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File ps_probe.ps1";
    let (out2, _err2, code2) = run(
        &session,
        &["cmd", "/d", "/s", "/c", ps_cmd],
        Some(ps_cmd),
    );
    eprintln!(
        "ps exit={code2:?}\nSTDOUT:\n{}",
        String::from_utf8_lossy(&out2)
    );
    let text2 = String::from_utf8_lossy(&out2);
    assert!(
        text2.contains("call-op=") && text2.contains("dotnet-start=") && text2.contains("cmdlet-start="),
        "PS 探针结果不完整: {text2}"
    );
}

// ─────────────────────────────────────────────────────────────
// ConPTY 回归测试（原 `sandbox/windows/conpty_spike.rs` 并入）
//
// 验证 `docs/pty-research.md` §7 风险 #1 ——「受限令牌（WRITE_RESTRICTED）+
// Job Object + 伪控制台（ConPTY）」能否共存（方案 B 的唯一阻塞项）。
//
// 背景（v1 实测踩到的两处，当前实现已修正）：
//   1. **必须**显式设 `STARTF_USESTDHANDLES` 并把三句柄置 NULL —— 否则子进程继承父进程
//      标准句柄，命令真实输出会漏到父进程 stdout 而非伪控制台；
//   2. v1 的 Ctrl+C 测试是假阳性（等待窗口恰好覆盖 ping 生命周期）→ 收紧判定窗口。
//
// 运行方式：
//   cargo test --lib conpty_with_restricted_token -- --nocapture
// ─────────────────────────────────────────────────────────────

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

    /// PSEUDOCONSOLE：value = 句柄值本身，size = `size_of::<HPCON>()`。
    ///
    /// 注意与 `set_job` 的语义差异（§5.2）：JOB_LIST 要的是「句柄数组的指针」，而 PSEUDOCONSOLE 要的是
    /// 「句柄值本身」。
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

    // ---------- 4) spawn ----------
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
        // 必须显式设置 STARTF_USESTDHANDLES 并把三个句柄置 NULL。不设该标志时子进程会继承
        // 父进程的 std 句柄（Windows「标准句柄总是被继承」，bInheritHandles=0 挡不住），导致
        // 命令真实输出漏到父进程 stdout 而没进伪控制台。
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
    // HANDLE(*mut c_void) 不是 Send，转成 isize 再跨线程搬运。
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

    // ---------- Test C：0x03 是否为真信号（收紧判定窗口，杜绝假阳性） ----------
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
