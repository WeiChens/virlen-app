use super::*;
use crate::agent::bridge::AgentBridgeState;
use crate::agent::cancellation::CancellationToken;
use crate::agent::event_sink::TestEventSink;
use crate::agent::native_tools::test_util::{test_security, test_security_bare};
use crate::agent::native_tools::execute_native_tool;
use std::time::Duration;

/// 集成测试：真实 spawn 一个长命令，中途触发「终止」，
/// 验证工具能及时返回、不会因进程树没杀干净而无限挂起（前端终止按钮失效的根因）。
#[tokio::test]
async fn test_execute_command_kill_returns_promptly() {
    let dir = std::env::temp_dir().join(format!("virlen_native_kill_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let sec = test_security_bare(&dir.to_string_lossy());
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let tool_call_id = "tc_kill_test";
    let ctx = NativeToolCtx {
        session_id: "s_kill",
        tool_call_id,
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        memory: crate::agent::native_tools::noop_memory(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    // 长命令：确保 kill 发生在执行中途
    let cmd = if cfg!(target_os = "windows") {
        "ping -n 60 127.0.0.1"
    } else {
        "sleep 60"
    };
    let args = json!({ "command": cmd, "timeout": 300 });

    // 独立任务：1.5s 后触发终止（kill 入口在命令 spawn 时注册）
    let killer_tool_call_id = tool_call_id.to_string();
    let killer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(
            super::super::kill_running_command(&killer_tool_call_id),
            "kill entry should exist"
        );
    });

    // 终止后应尽快返回（清理等待有 3s 上限），10s 上限防止测试本身挂起
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command should return promptly after kill")
    .expect("execute_command should not error");

    killer.await.unwrap();

    match outcome {
        NativeToolOutcome::Value { content, .. } => {
            assert!(
                content.contains("Command cancelled by the user"),
                "unexpected content: {}",
                content
            );
        }
        other => panic!("expected Value, got {:?}", other),
    }

    std::fs::remove_dir_all(&dir).ok();
}

// 本次新增：绕过沙盒（sandbox:"off"）的审批策略与文案。
// 显式导入，不依赖 `use super::*` 对父模块 use 绑定的传递。
use super::super::common::{
    command_decision, resolve_decision, with_bypass_hint, PermissionDecision,
    PERM_SANDBOX_COMMAND, PERM_TERMINAL_DANGEROUS, PERM_TERMINAL_INSTALL, PERM_TERMINAL_NORMAL,
    SANDBOX_BYPASS_HINT,
};

/// 决策阶梯：申请脱壳 → 与「沙盒脱壳」权限**取更严格者**（默认 ask）；
/// deny 永远优先（不被放宽）；终端内确认强制至少 ask。
#[test]
fn escape_decision_takes_strictest() {
    // 脱壳权限 ask + 基础 allow/ask → ask（默认弹窗，行为与旧版一致）
    for base in [PermissionDecision::Allow, PermissionDecision::Ask] {
        assert_eq!(
            resolve_decision(base, Some(PermissionDecision::Ask), false),
            PermissionDecision::Ask,
            "脱壳权限 ask → 至少 ask"
        );
    }
    // 脱壳权限 allow + 基础 allow → allow（用户已授权，静默脱壳）
    assert_eq!(
        resolve_decision(
            PermissionDecision::Allow,
            Some(PermissionDecision::Allow),
            false
        ),
        PermissionDecision::Allow
    );
    // 脱壳权限 allow 不能放宽更严格的基础（危险命令仍需确认）
    assert_eq!(
        resolve_decision(
            PermissionDecision::Ask,
            Some(PermissionDecision::Allow),
            false
        ),
        PermissionDecision::Ask
    );
    // 脱壳权限 deny → 直接拒绝
    assert_eq!(
        resolve_decision(
            PermissionDecision::Allow,
            Some(PermissionDecision::Deny),
            false
        ),
        PermissionDecision::Deny
    );
    // 终端内确认 → 强制至少 ask
    assert_eq!(
        resolve_decision(PermissionDecision::Allow, None, true),
        PermissionDecision::Ask
    );
    // deny 永远优先（不被终端内确认 / 脱壳 allow 放宽）
    assert_eq!(
        resolve_decision(
            PermissionDecision::Deny,
            Some(PermissionDecision::Allow),
            true
        ),
        PermissionDecision::Deny,
        "deny 必须优先"
    );
    // 未申请脱壳（None）→ 基础决策不变
    assert_eq!(
        resolve_decision(PermissionDecision::Allow, None, false),
        PermissionDecision::Allow
    );

    // 脱壳权限默认 ask；权限表命中可覆盖；legacy approval_mode 不参与（传空串）
    use std::collections::BTreeMap;
    let empty = BTreeMap::new();
    assert_eq!(
        command_decision(&empty, "", PERM_SANDBOX_COMMAND, "safe"),
        PermissionDecision::Ask
    );
    let mut perms = BTreeMap::new();
    perms.insert(PERM_SANDBOX_COMMAND.to_string(), "allow".to_string());
    assert_eq!(
        command_decision(&perms, "", PERM_SANDBOX_COMMAND, "safe"),
        PermissionDecision::Allow
    );
}

/// 权限表优先；缺失时回退 legacy approval_mode（回归保护，语义与旧 commandApprovalMode 一致）。
#[test]
fn permission_priority_and_legacy_fallback() {
    use std::collections::BTreeMap;

    // 权限表命中 → 按表决策（表内值覆盖 legacy mode）
    let mut perms = BTreeMap::new();
    perms.insert(PERM_TERMINAL_NORMAL.to_string(), "allow".to_string());
    assert_eq!(
        command_decision(&perms, "all", PERM_TERMINAL_NORMAL, "safe"),
        PermissionDecision::Allow
    );
    perms.insert(PERM_TERMINAL_NORMAL.to_string(), "deny".to_string());
    assert_eq!(
        command_decision(&perms, "none", PERM_TERMINAL_NORMAL, "safe"),
        PermissionDecision::Deny
    );

    // 表缺失 → 回退 legacy approval_mode（与既有语义完全一致）
    let empty = BTreeMap::new();
    assert_eq!(
        command_decision(&empty, "all", PERM_TERMINAL_NORMAL, "safe"),
        PermissionDecision::Ask
    );
    assert_eq!(
        command_decision(&empty, "risky", PERM_TERMINAL_NORMAL, "safe"),
        PermissionDecision::Allow
    );
    assert_eq!(
        command_decision(&empty, "risky", PERM_TERMINAL_INSTALL, "install"),
        PermissionDecision::Allow
    );
    assert_eq!(
        command_decision(&empty, "risky", PERM_TERMINAL_DANGEROUS, "dangerous"),
        PermissionDecision::Ask
    );
    assert_eq!(
        command_decision(&empty, "install", PERM_TERMINAL_NORMAL, "safe"),
        PermissionDecision::Allow
    );
    assert_eq!(
        command_decision(&empty, "install", PERM_TERMINAL_INSTALL, "install"),
        PermissionDecision::Ask
    );
    assert_eq!(
        command_decision(&empty, "install", PERM_TERMINAL_DANGEROUS, "dangerous"),
        PermissionDecision::Ask
    );
    assert_eq!(
        command_decision(&empty, "none", PERM_TERMINAL_DANGEROUS, "dangerous"),
        PermissionDecision::Allow
    );
}

/// 绕过沙盒的警告必须拼在基础提示后（基础提示为空时不得产生前导换行）。
#[test]
fn bypass_hint_is_appended() {
    let with_base = with_bypass_hint("此命令可能对系统造成破坏，请确认是否执行");
    assert!(with_base.starts_with("此命令可能对系统造成破坏"));
    assert!(with_base.ends_with(SANDBOX_BYPASS_HINT));
    assert!(with_base.contains('\n'));
    assert_eq!(with_bypass_hint(""), SANDBOX_BYPASS_HINT);
}

/// readonly 模式必须拒绝绕过沙盒（否则只读保护可被绕过），且在审批之前失败。
#[tokio::test]
async fn readonly_mode_rejects_sandbox_bypass() {
    let dir = std::env::temp_dir().join(format!("virlen_native_ro_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security_bare(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let sink = TestEventSink::new();
    let bridge = AgentBridgeState::default();
    let cancel = CancellationToken::new();
    let ctx = NativeToolCtx {
        session_id: "s_ro",
        tool_call_id: "tc_ro_test",
        cancel: &cancel,
        sink: &sink,
        bridge: &bridge,
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        memory: crate::agent::native_tools::noop_memory(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };
    let args = serde_json::json!({ "command": "echo hi", "sandbox": "off" });
    let err = execute_command_tool(&ctx, &args)
        .await
        .expect_err("readonly + sandbox:off 必须被拒绝");
    assert!(err.contains("read-only mode"), "unexpected error: {err}");
    std::fs::remove_dir_all(&dir).ok();
}

/// Step 2 ①：解析审批回传（JSON 优先 → 旧白名单兼容）。
#[test]
fn test_parse_approval() {
    // JSON：批准 + 改后命令
    assert_eq!(
        parse_approval("{\"approved\":true,\"command\":\"echo hi\"}", "orig"),
        (true, "echo hi".to_string())
    );
    // JSON：批准但没带命令 → 用原命令
    assert_eq!(
        parse_approval("{\"approved\":true}", "orig"),
        (true, "orig".to_string())
    );
    // JSON：未批准
    assert_eq!(
        parse_approval("{\"approved\":false,\"command\":\"x\"}", "orig"),
        (false, "orig".to_string())
    );
    // JSON 解析失败 → 回退白名单（也不放行乱码）
    assert_eq!(parse_approval("{not json}", "orig"), (false, "orig".to_string()));
    // 旧白名单（弹窗路径，行为不变）
    assert_eq!(parse_approval("approved", "orig"), (true, "orig".to_string()));
    assert_eq!(parse_approval("  Approved ", "orig"), (true, "orig".to_string()));
    assert_eq!(parse_approval("允许", "orig"), (true, "orig".to_string()));
    assert_eq!(parse_approval("ok", "orig"), (true, "orig".to_string()));
    // 其他文本原样返回（不放行）
    assert_eq!(parse_approval("[error] x", "orig"), (false, "orig".to_string()));
}

/// Step 2 ①：编辑成危险 / 安装命令 → 风险等级升高（仅埋点，不二次审批）。
#[test]
fn test_terminal_confirm_reclassify_escalation() {
    assert_eq!(risk_rank("safe"), 0);
    assert_eq!(risk_rank("install"), 1);
    assert_eq!(risk_rank("dangerous"), 2);
    let safe = risk_rank(classify_command("Write-Output hi"));
    assert!(risk_rank(classify_command("Remove-Item -Recurse -Force X")) > safe);
    assert!(risk_rank(classify_command("npm install")) > safe);
}

/// 模拟「前端在终端块里确认」：等 `agent:user-interaction-request` 事件，
/// 捕获其 `data`，并回传给定 payload。返回 (任务句柄, 捕获到的 data)。
fn spawn_terminal_confirmer(
    sink: std::sync::Arc<TestEventSink>,
    bridge: std::sync::Arc<AgentBridgeState>,
    response_payload: serde_json::Value,
) -> (
    tokio::task::JoinHandle<bool>,
    std::sync::Arc<std::sync::Mutex<serde_json::Value>>,
) {
    let captured = std::sync::Arc::new(std::sync::Mutex::new(serde_json::Value::Null));
    let captured_out = captured.clone();
    let handle = tokio::spawn(async move {
        for _ in 0..600 {
            let found = {
                let evs = sink.events.lock().unwrap();
                evs.iter().find_map(|(name, payload)| {
                    if name == "agent:user-interaction-request" {
                        Some((
                            payload
                                .get("requestId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            payload
                                .get("data")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        ))
                    } else {
                        None
                    }
                })
            };
            if let Some((rid, data)) = found {
                if rid.is_empty() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    continue;
                }
                *captured.lock().unwrap() = data;
                crate::agent::bridge::handle_user_interaction_response(
                    &bridge,
                    &rid,
                    response_payload.clone(),
                )
                .await;
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    });
    (handle, captured_out)
}

/// Step 2 ①：终端内确认——回传的 JSON 带「改后的命令」，必须执行改后的版本。
#[tokio::test]
async fn test_execute_command_terminal_confirm_roundtrip() {
    let dir = std::env::temp_dir().join(format!("virlen_confirm_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // readonly 不授予额外写根；approval_mode=all 强制走审批，便于驱动交互。
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    sec.approval_mode = "all".to_string();
    let sink = std::sync::Arc::new(TestEventSink::new());
    let bridge = std::sync::Arc::new(AgentBridgeState::default());
    let cancel = CancellationToken::new();
    let ctx = NativeToolCtx {
        session_id: "s_confirm",
        tool_call_id: "tc_confirm",
        cancel: &cancel,
        sink: sink.as_ref(),
        bridge: bridge.as_ref(),
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        memory: crate::agent::native_tools::noop_memory(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    let (confirmer, captured) = spawn_terminal_confirmer(
        sink.clone(),
        bridge.clone(),
        json!({
            "__kind": "value",
            "value": "{\"approved\":true,\"command\":\"echo 'EDITED_OK'\"}"
        }),
    );

    // 用跨平台的 `echo`（sh / PowerShell 同名内建）而非 `Write-Output`，
    // 让本用例在两个平台都跑：它验证的是「确认回传的命令被执行」这一跨平台语义，
    // 下方 presentation 断言本身也已按平台分叉。
    let args = json!({
        "command": "echo 'ORIGINAL'",
        "confirm": "terminal",
        "timeout": 30
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");
    assert!(confirmer.await.unwrap(), "应出现用户交互请求");

    match outcome {
        NativeToolOutcome::Value { content, .. } => {
            assert!(content.contains("EDITED_OK"), "应执行用户改后的命令: {content}");
            assert!(
                !content.contains("ORIGINAL"),
                "不应执行原始命令: {content}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    // PTY 可用（Windows）→ 交互 data 必须带 presentation:"terminal"；
    // 否则（非 Windows / 伪控制台不可用）必须**不下发**，让前端回落弹窗。
    let d = captured.lock().unwrap().clone();
    #[cfg(target_os = "windows")]
    assert_eq!(
        d.get("presentation").and_then(|v| v.as_str()),
        Some("terminal"),
        "PTY 可用时应下发 presentation=terminal: {d}"
    );
    #[cfg(not(target_os = "windows"))]
    assert!(
        d.get("presentation").is_none(),
        "无 PTY 时不得下发 presentation（降级回弹窗）: {d}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// Step 2 ①：终端内确认取消（Esc / Ctrl+C）→ 工具返回 `[User cancelled]`，
/// 且必须走 **Error**（失败）通道 —— UI 依据 `is_error` 标红（工具卡片圆点 / 终端状态徽标）。
#[tokio::test]
async fn test_execute_command_terminal_confirm_cancelled() {
    let dir = std::env::temp_dir().join(format!("virlen_confirm_c_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security(&dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    sec.approval_mode = "all".to_string();
    let sink = std::sync::Arc::new(TestEventSink::new());
    let bridge = std::sync::Arc::new(AgentBridgeState::default());
    let cancel = CancellationToken::new();
    let ctx = NativeToolCtx {
        session_id: "s_confirm_c",
        tool_call_id: "tc_confirm_c",
        cancel: &cancel,
        sink: sink.as_ref(),
        bridge: bridge.as_ref(),
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        memory: crate::agent::native_tools::noop_memory(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    let (confirmer, _captured) = spawn_terminal_confirmer(
        sink.clone(),
        bridge.clone(),
        json!({ "__kind": "cancelled" }),
    );

    let args = json!({
        "command": "Write-Output 'SHOULD_NOT_RUN'",
        "confirm": "terminal",
        "timeout": 30
    });
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");
    assert!(confirmer.await.unwrap(), "应出现用户交互请求");

    match outcome {
        NativeToolOutcome::Error { content, .. } => {
            assert_eq!(content, "[User cancelled]");
        }
        other => panic!("拒绝授权必须走 Error（UI 标红），got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

// ==================== 「忽略沙盒命令」规则（免脱壳审批 + 强制裸跑） ====================

/// 本轮出现过的用户交互类型（按发生顺序）
fn interaction_types(sink: &TestEventSink) -> Vec<String> {
    sink.events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == "agent:user-interaction-request")
        .map(|(_, payload)| {
            payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

/// 命中「忽略沙盒命令」规则 → **即使 AI 没传 `sandbox:"off"`** 也免审批、以「不使用沙盒」方式执行。
///
/// S7 之后判定完全在 Rust 侧（规则随 security 快照下发），证据链变为：
/// 1. 全程**没有任何**用户交互请求（既无授权弹窗，也无从前那次 `sandbox_rule_check` 查询）；
/// 2. 结果正文首行「终端环境」提示为「无沙盒」→ 确实裸跑。
#[tokio::test]
async fn test_execute_command_rule_hit_forces_bypass() {
    let dir = std::env::temp_dir().join(format!("virlen_rule_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut sec = test_security(&dir.to_string_lossy());
    // 沙盒启用 + 一条本地规则（前缀匹配）
    sec.sandbox_ignore_rules = crate::security::parse_rules(&json!([
        { "id": "r1", "name": "命中项", "enabled": true, "kind": "text",
          "textMode": "prefix", "pattern": "echo RULE_BYPASS_OK", "caseSensitive": false }
    ]));
    let sink = std::sync::Arc::new(TestEventSink::new());
    let bridge = std::sync::Arc::new(AgentBridgeState::default());
    let cancel = CancellationToken::new();
    let ctx = NativeToolCtx {
        session_id: "s_rule_bypass",
        tool_call_id: "tc_rule_bypass",
        cancel: &cancel,
        sink: sink.as_ref(),
        bridge: bridge.as_ref(),
        security: &sec,
        repo: crate::agent::native_tools::noop_repo(),
        memory: crate::agent::native_tools::noop_memory(),
        skills: None,
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
    };

    // 跨平台 `echo`：本用例验证的是「命中规则 → 免审批 + 裸跑」这一跨平台语义。
    let args = json!({ "command": "echo RULE_BYPASS_OK", "timeout": 30 });
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        execute_native_tool(&ctx, "execute_command", &args),
    )
    .await
    .expect("execute_command 不应挂死")
    .expect("execute_command 不应报错");

    let types = interaction_types(&sink);
    assert!(
        types.is_empty(),
        "命中规则必须完全本地判定（零交互请求），实际: {types:?}"
    );

    match outcome {
        NativeToolOutcome::Value { content, .. } => {
            assert!(content.contains("RULE_BYPASS_OK"), "content: {content}");
            assert!(
                content.contains("no sandbox"),
                "命中规则必须以「不使用沙盒」方式执行: {content}"
            );
        }
        other => panic!("expected Value, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}
/// 规则**不能**推翻显式禁止：命令权限 `deny` 优先于规则命中，且判定过程零交互请求。
///
/// 规则的作用域边界（只在沙盒 `on` 时判定、`readonly` 下脱壳被直接拒绝）另由
/// `readonly_mode_rejects_sandbox_bypass` 覆盖；这里钉住「deny 永远优先」这条安全底线。
#[tokio::test]
async fn test_execute_command_rule_does_not_override_deny() {
    for mode in ["on", "readonly", "off"] {
        let dir = std::env::temp_dir()
            .join(format!("virlen_rule_deny_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut sec = test_security(&dir.to_string_lossy());
        sec.sandbox_mode = mode.to_string();
        sec.sandbox_ignore_rules = crate::security::parse_rules(&json!([
            { "id": "r1", "name": "命中项", "enabled": true, "kind": "text",
              "textMode": "prefix", "pattern": "echo RULE_DENY", "caseSensitive": false }
        ]));
        // 命令权限「禁止」→ 决策在运行之前就终止；规则判定在它之前发生，两者互不干扰
        sec.permissions
            .insert(PERM_TERMINAL_NORMAL.to_string(), "deny".to_string());

        let sink = std::sync::Arc::new(TestEventSink::new());
        let bridge = std::sync::Arc::new(AgentBridgeState::default());
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_rule_deny",
            tool_call_id: "tc_rule_deny",
            cancel: &cancel,
            sink: sink.as_ref(),
            bridge: bridge.as_ref(),
            security: &sec,
            repo: crate::agent::native_tools::noop_repo(),
            memory: crate::agent::native_tools::noop_memory(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };
        let args = json!({ "command": "echo RULE_DENY", "timeout": 30 });
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            execute_native_tool(&ctx, "execute_command", &args),
        )
        .await
        .expect("execute_command 不应挂死");

        assert!(
            interaction_types(&sink).is_empty(),
            "mode={mode} 规则判定必须完全在本地完成（零交互请求）"
        );
        let err = outcome.expect_err("命令权限禁止时，命中规则也不得放行");
        assert!(
            err.contains("denied by the permission settings"),
            "mode={mode} err: {err}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
