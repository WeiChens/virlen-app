//! runner 相关测试：运行器端到端（沙盒 + PTY）、接管预算、结果组装，以及沙盒路径辅助函数。

// 跨平台用例（结果组装）只用下面这两个；其余用例均依赖 ConPTY / PowerShell / 沙盒 ACL，
// 属 Windows 专属（下方逐个 `#[cfg(target_os = "windows")]` 门禁），避免 Linux CI 误报。
use crate::agent::native_tools::NativeToolOutcome;

use super::build_command_result;

#[cfg(target_os = "windows")]
use {
    crate::agent::bridge::AgentBridgeState,
    crate::agent::cancellation::CancellationToken,
    crate::agent::event_sink::TestEventSink,
    crate::agent::native_tools::execute_native_tool,
    crate::agent::native_tools::test_util::test_security,
    serde_json::json,
    std::path::PathBuf,
    std::sync::atomic::Ordering,
    std::sync::LazyLock,
    std::time::Duration,
};

#[cfg(target_os = "windows")]
use super::super::super::pty_session;

#[cfg(target_os = "windows")]
use super::HOLD_MAX_OVERRIDE_SECS;

#[cfg(target_os = "windows")]
use super::sandbox::{collect_extra_roots, expand_env_vars};

#[test]
#[cfg(target_os = "windows")]
fn test_expand_env_vars() {
    std::env::set_var("VIRLEN_TEST_VAR", "C:/foo/bar");
    assert_eq!(
        expand_env_vars("%VIRLEN_TEST_VAR%/baz"),
        PathBuf::from("C:/foo/bar/baz")
    );
    // 反斜杠统一为斜杠
    assert_eq!(
        expand_env_vars("%VIRLEN_TEST_VAR%\\baz"),
        PathBuf::from("C:/foo/bar/baz")
    );
    // 无法解析的占位符保持原样
    assert_eq!(
        expand_env_vars("%NO_SUCH_VAR_XYZ%/x"),
        PathBuf::from("%NO_SUCH_VAR_XYZ%/x")
    );
    // 无占位符：分隔符归一化
    assert_eq!(expand_env_vars("C:\\work"), PathBuf::from("C:/work"));
}

#[test]
#[cfg(target_os = "windows")]
fn test_collect_extra_roots_skips_workspace_ancestor() {
    let base = std::env::temp_dir().join(format!(
        "virlen-extra-root-test-{}",
        std::process::id()
    ));
    let ws = base.join("Documents").join("test").join("demo");
    let docs = base.join("Documents");
    let sibling = base.join("sibling");
    std::fs::create_dir_all(&ws).expect("create ws");
    std::fs::create_dir_all(&sibling).expect("create sibling");

    let whitelist = vec![
        docs.to_string_lossy().to_string(), // workspace 祖先 → 跳过
        base.join("does-not-exist").to_string_lossy().to_string(), // 不存在 → 跳过
        sibling.to_string_lossy().to_string(), // 普通目录 → 保留
    ];
    let roots = collect_extra_roots(&whitelist, ws.to_string_lossy().as_ref(), None);
    assert_eq!(roots.len(), 1, "应只保留 sibling");
    assert!(crate::sandbox::paths::same_path_key(&roots[0], &sibling));

    let _ = std::fs::remove_dir_all(&base);
}

/// Step 1 端到端：沙盒开启时 PTY 路径能拿到正确输出、退出码与中文。
///
/// 核心验收：受限令牌 + Job Object + ConPTY 三者共存，且命令真的能跑完、输出经伪控制台回传、中文直接可读。
///
/// ⚠️ 这里故意用 readonly 模式：不授予任何额外写根，避免测试去改用户真实目录的 ACL；「可写根 + 受限令牌 +
/// ConPTY」的组合由 Spike 覆盖。
#[tokio::test]
#[cfg(target_os = "windows")]
async fn test_execute_command_pty_sandboxed_end_to_end() {
    let dir = std::env::temp_dir().join(format!("virlen_pty_e2e_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let ctx = crate::agent::native_tools::NativeToolCtx {
        session_id: "s_pty_e2e",
        tool_call_id: "tc_pty_e2e",
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    let args = json!({
        "command": "Write-Output 'PTY_ROUTE_OK'; Write-Output '中文输出可读'",
        "timeout": 60
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(60),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");

    match outcome {
        NativeToolOutcome::Value { content, ui_data } => {
            assert!(content.contains("PTY_ROUTE_OK"), "content: {content}");
            assert!(
                content.contains("中文输出可读"),
                "中文应直接可读（PTY 输出为 UTF-8）: {content}"
            );
            let ui = ui_data.expect("ui_data");
            assert_eq!(ui["pty"], serde_json::json!(true));
            assert_eq!(ui["exitCode"], serde_json::json!(0));
            assert!(
                content.contains("read-only (no writes)"),
                "readonly 模式应真的跑在沙盒里（而不是降级裸跑）: {content}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// Step 1 端到端：用户可在命令执行中「插键盘」——`pty_write` 把输入送进伪控制台。
///
/// `Read-Host` 会真的去读控制台输入：改造前（stdin = NULL / 管道）它只能拿到 EOF，
/// 所以这条用例是「用户可干预」的直接证据。同时顺带验证 `pty_resize` 能命中会话。
#[tokio::test]
#[cfg(target_os = "windows")]
async fn test_execute_command_pty_write_interaction() {
    let dir = std::env::temp_dir().join(format!("virlen_pty_in_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // 同 `test_execute_command_pty_sandboxed_end_to_end`：readonly 不授予额外写根，避免改真实目录 ACL
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let tool_call_id = "tc_pty_write";
    let ctx = crate::agent::native_tools::NativeToolCtx {
        session_id: "s_pty_write",
        tool_call_id,
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    // 会话在 spawn 后立刻注册，这里轮询等到它出现再写（避免时序竞态）。
    let writer = tokio::spawn(async move {
        for _ in 0..200 {
            if pty_session::pty_write(tool_call_id, "hello\r\n") {
                // 顺带验证尺寸调整能命中同一个会话
                let resized = pty_session::pty_resize(tool_call_id, 120, 40);
                return (true, resized);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        (false, false)
    });

    let args = json!({
        "command": "$x = Read-Host; Write-Output \"GOT=$x\"",
        "timeout": 60
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(60),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");

    let (wrote, resized) = writer.await.unwrap();
    assert!(wrote, "命名 PTY 会话应已注册，pty_write 才能命中");
    assert!(resized, "pty_resize 应命中已注册的会话");

    match outcome {
        NativeToolOutcome::Value { content, .. } => {
            assert!(
                content.contains("GOT=hello"),
                "用户在执行中写入的输入应被命令读到: {content}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// PTY 路径必须禁用分页器：TTY 下 git/gh/bat 会起 `less`/`more` 停在分页界面，命令跑完却等按键
/// → 对 AI 等价于卡死。运行器注入 `GIT_PAGER=cat` / `GH_PAGER=cat` / `BAT_PAGING=never` 关闭它。
///
/// 这里让命令「读回环境变量」来钉住「`env_extra` 真的随 spawn 传进了子进程」这条链路。
#[tokio::test]
#[cfg(target_os = "windows")]
async fn test_execute_command_pty_disables_pager() {
    let dir = std::env::temp_dir().join(format!("virlen_pty_pager_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // readonly 不授予额外写根（同其它 PTY 用例）。
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let ctx = crate::agent::native_tools::NativeToolCtx {
        session_id: "s_pty_pager",
        tool_call_id: "tc_pty_pager",
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    let args = json!({
        "command": "Write-Output \"GIT_PAGER=$env:GIT_PAGER;GH_PAGER=$env:GH_PAGER;BAT_PAGING=$env:BAT_PAGING\"",
        "timeout": 60
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(60),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");

    match outcome {
        NativeToolOutcome::Value { content, .. } => {
            assert!(
                content.contains("GIT_PAGER=cat") && content.contains("GH_PAGER=cat"),
                "PTY 子进程应拿到 GIT_PAGER=cat 与 GH_PAGER=cat: {content}"
            );
            assert!(
                content.contains("BAT_PAGING=never"),
                "PTY 子进程应拿到 BAT_PAGING=never: {content}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// PTY 路径的 uiData 必须带 `pty: true`（UI 据此走 xterm 单流渲染）。
#[test]
fn test_build_command_result_pty_flag() {
    let pty = build_command_result(
        "out\n".into(),
        String::new(),
        Some(0),
        false,
        false,
        30,
        "Terminal environment: powershell · write isolation",
        true,
        None,
        false,
    );
    match pty {
        NativeToolOutcome::Value { content, ui_data } => {
            let ui = ui_data.expect("ui_data");
            assert_eq!(ui["pty"], serde_json::json!(true));
            assert_eq!(ui["stderr"], serde_json::json!(""));
            // PTY 下 stderr 已合并进 stdout，不应出现「[stderr]」分段
            assert!(!content.contains("[stderr]"));
        }
        other => panic!("expected Value, got {other:?}"),
    }

    // 管道路径不带 pty 标记，并保留 [stderr] 分段（向后兼容旧渲染分支）
    let pipes = build_command_result(
        "a\n".into(),
        "w\n".into(),
        Some(0),
        false,
        false,
        30,
        "",
        false,
        None,
        false,
    );
    match pipes {
        NativeToolOutcome::Value { content, ui_data } => {
            assert_eq!(ui_data.expect("ui_data")["pty"], serde_json::json!(false));
            assert!(content.contains("[stderr]"));
        }
        other => panic!("expected Value, got {other:?}"),
    }
}

/// Step 2 ④：`waitReason` 三个取值 + 管道路径同样下发 + 超时无输出的模型引导。
#[test]
fn test_build_command_result_wait_reason() {
    // exit：进程自行退出
    let exit = build_command_result(
        "ok\n".into(),
        String::new(),
        Some(0),
        false,
        false,
        30,
        "",
        false,
        None,
        false,
    );
    match exit {
        NativeToolOutcome::Value { content, ui_data } => {
            let ui = ui_data.expect("ui_data");
            assert_eq!(ui["waitReason"], serde_json::json!("exit"));
            // D5：管道路径也要下发同名 waitReason
            assert_eq!(ui["pty"], serde_json::json!(false));
            assert!(!content.contains("waiting for input"));
        }
        other => panic!("expected Value, got {other:?}"),
    }

    // cancelled：用户主动终止
    let cancelled = build_command_result(
        "partial\n".into(),
        String::new(),
        None,
        true,
        false,
        30,
        "",
        true,
        None,
        false,
    );
    match cancelled {
        NativeToolOutcome::Value { ui_data, .. } => {
            assert_eq!(
                ui_data.expect("ui_data")["waitReason"],
                serde_json::json!("cancelled")
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    // timeout + 全程无输出 → timeout，且追加「疑似等待输入」引导
    let idle_timeout = build_command_result(
        String::new(),
        String::new(),
        None,
        false,
        true,
        5,
        "",
        true,
        None,
        false,
    );
    match idle_timeout {
        NativeToolOutcome::Value { content, ui_data } => {
            assert_eq!(
                ui_data.expect("ui_data")["waitReason"],
                serde_json::json!("timeout")
            );
            assert!(
                content.contains("waiting for input"),
                "超时无输出应引导等待输入: {content}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    // timeout + 有持续输出（超过阈值）→ 不追加引导
    let busy_timeout = build_command_result(
        "下载中...正在解压...持续输出内容已超过引导阈值\n".into(),
        String::new(),
        None,
        false,
        true,
        5,
        "",
        true,
        None,
        false,
    );
    match busy_timeout {
        NativeToolOutcome::Value { content, .. } => {
            assert!(!content.contains("waiting for input"), "有输出时不应引导: {content}");
        }
        other => panic!("expected Value, got {other:?}"),
    }
}

/// 仅测试用：串行化“接管”相关用例，避免 `HOLD_MAX_OVERRIDE_SECS` 全局态互踩。
/// 其余 PTY 用例不接管（held=false）→ 不读该 override，无需锁。
#[cfg(target_os = "windows")]
static HOLD_TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Step 2 ②：接管期间冻结超时预算（人在慢慢输密码，不该被超时杀掉）。
#[tokio::test]
#[cfg(target_os = "windows")]
async fn test_pty_hold_freezes_timeout() {
    let _guard = HOLD_TEST_LOCK.lock().await;
    let dir =
        std::env::temp_dir().join(format!("virlen_pty_hold_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let tool_call_id = "tc_hold_freeze";
    let ctx = crate::agent::native_tools::NativeToolCtx {
        session_id: "s_hold_freeze",
        tool_call_id,
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    // 会话一注册就接管（全程冻结）。timeout=1s 而命令跑 2.5s：
    // 若不冻结，1s 就会被杀（waitReason=timeout）；冻结后命令自然退出（waitReason=exit）。
    let holder = tokio::spawn(async move {
        for _ in 0..200 {
            if pty_session::pty_set_held(tool_call_id, true) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    });

    let started = std::time::Instant::now();
    let args = json!({
        "command": "Start-Sleep -Milliseconds 2500; Write-Output 'HOLD_OK'",
        "timeout": 1
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");
    let elapsed = started.elapsed();
    assert!(holder.await.unwrap(), "会话应已注册，pty_set_held 才能命中");

    assert!(
        elapsed >= Duration::from_millis(2200),
        "冻结后总耗时应接近命令真实时长，实际 {elapsed:?}"
    );
    match outcome {
        NativeToolOutcome::Value { content, ui_data } => {
            let ui = ui_data.expect("ui_data");
            assert_eq!(
                ui["waitReason"],
                serde_json::json!("exit"),
                "接管期间不应超时: {content}"
            );
            assert!(content.contains("HOLD_OK"), "content: {content}");
            let held = ui["userInterventions"]["heldSeconds"]
                .as_u64()
                .unwrap_or(0);
            assert!(held >= 2, "heldSeconds 应 >= 2，实际 {held}");
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// Step 2 ②：接管到达硬上限 → 强制终止，`waitReason=timeout` 且 `holdTimedOut=true`。
#[tokio::test]
#[cfg(target_os = "windows")]
async fn test_pty_hold_hard_cap() {
    let _guard = HOLD_TEST_LOCK.lock().await;
    // 把 30min 硬上限缩短到 1s（仅测试）
    HOLD_MAX_OVERRIDE_SECS.store(1, Ordering::SeqCst);

    let dir = std::env::temp_dir().join(format!("virlen_pty_cap_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let tool_call_id = "tc_hold_cap";
    let ctx = crate::agent::native_tools::NativeToolCtx {
        session_id: "s_hold_cap",
        tool_call_id,
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    let holder = tokio::spawn(async move {
        for _ in 0..200 {
            if pty_session::pty_set_held(tool_call_id, true) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    });

    let started = std::time::Instant::now();
    // timeout=300s，但接管到顶（1s）应远早于此
    let args = json!({ "command": "Start-Sleep -Seconds 60", "timeout": 300 });
    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");
    let elapsed = started.elapsed();
    assert!(holder.await.unwrap(), "会话应已注册，pty_set_held 才能命中");
    HOLD_MAX_OVERRIDE_SECS.store(0, Ordering::SeqCst);

    assert!(
        elapsed < Duration::from_secs(15),
        "到顶应尽快终止，实际 {elapsed:?}"
    );
    match outcome {
        NativeToolOutcome::Value { content, ui_data } => {
            let ui = ui_data.expect("ui_data");
            assert_eq!(ui["waitReason"], serde_json::json!("timeout"));
            assert_eq!(ui["holdTimedOut"], serde_json::json!(true));
            assert!(content.contains("timed out"), "content: {content}");
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// Step 2 ②：干预计数正确，且**干预摘要不含用户输入正文**（D4 回归保护）。
///
/// 命令不读 stdin（Start-Sleep）→ 控制台不会回显，因此 uiData 全串都应无正文；
/// 若将来有人把正文塞进干预摘要，本用例立即失败。
#[tokio::test]
#[cfg(target_os = "windows")]
async fn test_pty_interventions_counted() {
    let dir =
        std::env::temp_dir().join(format!("virlen_pty_iv_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let tool_call_id = "tc_interv";
    let ctx = crate::agent::native_tools::NativeToolCtx {
        session_id: "s_interv",
        tool_call_id,
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    const SECRET: &str = "SECRET_TOKEN_123";
    let writer = tokio::spawn(async move {
        for _ in 0..200 {
            if pty_session::pty_write(tool_call_id, SECRET) {
                pty_session::pty_write(tool_call_id, "\r");
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    });

    let args = json!({
        "command": "Start-Sleep -Milliseconds 1500; Write-Output 'DONE'",
        "timeout": 30
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");
    assert!(writer.await.unwrap(), "pty_write 应命中会话");

    match outcome {
        NativeToolOutcome::Value { content, ui_data } => {
            assert!(content.contains("DONE"), "content: {content}");
            let ui = ui_data.expect("ui_data");
            let iv = &ui["userInterventions"];
            assert_eq!(iv["keys"], serde_json::json!(2));
            assert_eq!(iv["enters"], serde_json::json!(1));
            assert_eq!(iv["ctrlC"], serde_json::json!(0));
            // D4：只记计数，不记正文
            let ui_json = serde_json::to_string(&ui).unwrap();
            assert!(
                !ui_json.contains(SECRET),
                "uiData 不应包含用户输入正文（D4）: {ui_json}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

/// L6（失败侧）：退出码 >= 2 的失败**也要**下发结构化 `uiData`，
/// 否则中文界面下只能把英文失败报告直接贴给用户。
#[test]
fn test_build_command_result_failure_keeps_ui_data() {
    let failed = build_command_result(
        "boom\n".into(),
        String::new(),
        Some(3),
        false,
        false,
        30,
        "Terminal environment: powershell",
        true,
        None,
        false,
    );
    match failed {
        NativeToolOutcome::Error { content, ui_data } => {
            // 模型侧仍是固定英文报告
            assert!(content.contains("Exit code: 3"), "content: {content}");
            let ui = ui_data.expect("失败也应带 uiData");
            assert_eq!(ui["exitCode"], serde_json::json!(3));
            assert_eq!(ui["pty"], serde_json::json!(true));
            assert_eq!(ui["waitReason"], serde_json::json!("exit"));
        }
        other => panic!("expected Error, got {other:?}"),
    }

    // 退出码 1 不算失败（与旧行为一致）→ 仍走 Value
    let warned = build_command_result(
        "warn\n".into(),
        String::new(),
        Some(1),
        false,
        false,
        30,
        "",
        false,
        None,
        false,
    );
    assert!(matches!(warned, NativeToolOutcome::Value { .. }));
}
