//! 真实 Windows E2E 测试：验证「受限令牌 + NTFS ACL」写隔离闭环。
//!
//! 这些测试有真实副作用：修改目录 ACL、以受限令牌拉起真实子进程、写入临时文件、
//! 改写 `\\.\NUL` 设备 ACL（`allow_null_device` 只增不减，属生产代码固有行为）。
//!
//! 仅 Windows 编译运行。建议串行执行，避免多个测试同时改 `\\.\NUL` 全局 ACL：
//!   cargo test --lib sandbox::tests -- --nocapture --test-threads=1
//!
//! 覆盖 M7 场景：
//!   1. 区内写成功
//!   2. 区外写被拒
//!   3. `.git` 写被拒
//!   4. 孙进程回收（Job Object terminate 连带杀死孙进程）
//!   5. 降级前置条件（prepare 失败正确返回 Err）
//!   6. （附）readonly 模式：连 cwd 都不可写

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;

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
