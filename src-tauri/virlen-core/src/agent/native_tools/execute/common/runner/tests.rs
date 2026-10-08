//! runner 相关测试：结果组装（跨平台）+ 沙盒路径辅助（Windows）。
//!
//! 依赖 ConPTY / PowerShell 的端到端用例（PTY 路由、接管预算等）每条都要真起进程等秒级，
//! 已随 2026-10 的测试提速移除；其实现覆盖由 `execute_command` 的终止/超时用例承担。

use crate::agent::native_tools::NativeToolOutcome;

use super::{attach_sandbox, build_command_result};

#[cfg(target_os = "windows")]
use std::path::PathBuf;

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

/// `attach_sandbox` 必须把沙盒模式写进 `uiData.sandbox`（成功与失败两侧都要）。
#[test]
fn test_attach_sandbox_sets_ui_field() {
    let base = build_command_result(
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
    match attach_sandbox(base, "write_isolation") {
        NativeToolOutcome::Value { ui_data, .. } => {
            let ui = ui_data.expect("ui_data");
            assert_eq!(ui["sandbox"], serde_json::json!("write_isolation"));
        }
        other => panic!("expected Value, got {other:?}"),
    }

    // 失败侧（退出码 >= 2 → Error）同样要带上 sandbox
    let failed = build_command_result(
        "boom\n".into(),
        String::new(),
        Some(3),
        false,
        false,
        30,
        "Terminal environment: powershell · no sandbox (disabled, full permissions)",
        true,
        None,
        false,
    );
    match attach_sandbox(failed, "no_sandbox_disabled") {
        NativeToolOutcome::Error { ui_data, .. } => {
            let ui = ui_data.expect("uiData");
            assert_eq!(ui["sandbox"], serde_json::json!("no_sandbox_disabled"));
        }
        other => panic!("expected Error, got {other:?}"),
    }
}
