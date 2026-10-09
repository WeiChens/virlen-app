//! service — 端到端用例（起真进程，验会话隔离 / 输出增量 / 终止 / 容量）。
//!
//! 测试统一用 `sandbox_mode = "off"`（裸跑）：
//! - 沙盒需要 ACL / Landlock / Seatbelt 的真实环境，CI 上不可靠（沙盒本身另有一套测试）；
//! - 本模块要验的是「工具返回后进程还活着、输出还能读到、杀得掉」，与沙盒无关。

use std::time::Duration;

use serde_json::json;

use crate::agent::bridge::AgentBridgeState;
use crate::agent::cancellation::CancellationToken;
use crate::agent::event_sink::TestEventSink;
use crate::agent::native_tools::test_util::test_security_bare;
use crate::agent::native_tools::{execute_native_tool, noop_memory, noop_repo, noop_settings, NativeToolCtx, NativeToolOutcome};

use super::common::status;
use super::registry;

/// 造一个测试上下文（裸跑 + 临时工作目录）。
///
/// ⚠️ 必须在权限表里把 `terminal.background.execute` 设为 `allow`：新权限默认就是 `ask`，
/// 而测试里没人来回执审批交互（`request_user_interaction` 会一直等）—— 不放开就会挂住。
struct TestEnv {
    dir: std::path::PathBuf,
    security: crate::agent::types::NativeToolSecurity,
    sink: TestEventSink,
    bridge: AgentBridgeState,
    cancel: CancellationToken,
}

/// 服务测试用的 security：裸跑 + 后台服务权限放开（见上）。
fn service_security(workspace: &str) -> crate::agent::types::NativeToolSecurity {
    let mut sec = test_security_bare(workspace);
    sec.permissions.insert(
        "terminal.background.execute".to_string(),
        "allow".to_string(),
    );
    sec
}

impl TestEnv {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("virlen_service_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            security: service_security(&dir.to_string_lossy()),
            dir,
            sink: TestEventSink::new(),
            bridge: AgentBridgeState::default(),
            cancel: CancellationToken::new(),
        }
    }

    fn ctx<'a>(
        &'a self,
        session_id: &'a str,
        tool_call_id: &'a str,
        security: &'a crate::agent::types::NativeToolSecurity,
    ) -> NativeToolCtx<'a> {
        NativeToolCtx {
            session_id,
            tool_call_id,
            cancel: &self.cancel,
            sink: &self.sink,
            bridge: &self.bridge,
            security,
            repo: noop_repo(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: noop_settings(),
            memory: noop_memory(),
        }
    }

    /// 默认 security 的上下文（多数用例用它）。
    fn ctx_default<'a>(&'a self, session_id: &'a str, tool_call_id: &'a str) -> NativeToolCtx<'a> {
        let security = &self.security;
        self.ctx(session_id, tool_call_id, security)
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

/// 取结果里的模型侧文本。
fn content_of(outcome: NativeToolOutcome) -> String {
    match outcome {
        NativeToolOutcome::Value { content, .. } | NativeToolOutcome::Error { content, .. } => content,
        other => panic!("expected content, got {other:?}"),
    }
}

fn ui_of(outcome: &NativeToolOutcome) -> &serde_json::Value {
    match outcome {
        NativeToolOutcome::Value { ui_data, .. } | NativeToolOutcome::Error { ui_data, .. } => {
            ui_data.as_ref().expect("应有 uiData")
        }
        other => panic!("expected ui/value with uiData, got {other:?}"),
    }
}

/// 一次性命令（很快退出）—— `defaultWaitTime` 内就会结束，返回 `exited`。
const CMD_QUICK: &str = "echo hello-service";

/// 常驻命令：睡很久（测试结束前由 kill 收掉）。
#[cfg(target_os = "windows")]
const CMD_LONG: &str = "Write-Output started; Start-Sleep -Seconds 600";
#[cfg(not(target_os = "windows"))]
const CMD_LONG: &str = "echo started; sleep 600";

/// 输出里带标记的常驻命令（`waitFor` 用）。
#[cfg(target_os = "windows")]
const CMD_READY: &str = "Write-Output 'booting'; Start-Sleep -Milliseconds 300; Write-Output 'ready on 3000'; Start-Sleep -Seconds 600";
#[cfg(not(target_os = "windows"))]
const CMD_READY: &str = "echo booting; sleep 0.3; echo 'ready on 3000'; sleep 600";

#[tokio::test]
async fn start_returns_exited_when_command_finishes_inside_wait_window() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_quick", "tc_quick");
    let args = json!({ "name": "quick", "cmd": CMD_QUICK, "defaultWaitTime": 10_000 });
    let outcome = execute_native_tool(&ctx, "start_background_service", &args)
        .await
        .expect("工具不应报调用级错误");
    // 退出码 0 → 成功结果 + status=exited
    let content = content_of(outcome.clone());
    assert!(content.contains("already exited"), "content: {content}");
    assert!(content.contains("Exit code: 0"), "content: {content}");
    assert_eq!(ui_of(&outcome)["status"], status::EXITED);
    // 输出可读（等待窗口内的那段）
    assert!(content.contains("hello-service"), "content: {content}");
}

#[tokio::test]
async fn start_keeps_process_alive_after_tool_returns() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_live", "tc_live");
    let args = json!({ "name": "dev", "cmd": CMD_LONG, "defaultWaitTime": 700 });
    let outcome = execute_native_tool(&ctx, "start_background_service", &args)
        .await
        .unwrap();
    let ui = ui_of(&outcome).clone();
    assert_eq!(ui["status"], status::RUNNING);
    let id = ui["id"].as_str().unwrap().to_string();
    assert!(ui["pid"].as_u64().unwrap() > 0, "uiData: {ui}");

    // 工具已经返回了 —— 进程必须还活着，且新输出还能读到
    assert!(
        registry::get("s_live", &id).unwrap().is_running(),
        "工具返回后服务应仍在运行"
    );

    // 读增量输出：第一次应看到启动横幅，第二次应为空
    let got = execute_native_tool(&ctx, "get_background_service", &json!({ "id": id }))
        .await
        .unwrap();
    assert!(content_of(got).contains("started"), "启动输出应可读到");
    let again = execute_native_tool(&ctx, "get_background_service", &json!({ "id": id }))
        .await
        .unwrap();
    assert!(
        content_of(again).contains("No new output"),
        "第二次读应为增量空"
    );

    // 收掉（避免留下孤儿进程）
    let killed = execute_native_tool(&ctx, "kill_background_service", &json!({ "id": id }))
        .await
        .unwrap();
    let content = content_of(killed);
    assert!(content.contains("Stopped"), "content: {content}");
    assert!(
        registry::get("s_live", &id).is_none(),
        "确认退出后应清出注册表"
    );
}

#[tokio::test]
async fn wait_for_matches_streamed_output() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_wait", "tc_wait");
    let started = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "ready", "cmd": CMD_READY, "defaultWaitTime": 100 }),
    )
    .await
    .unwrap();
    let id = ui_of(&started)["id"].as_str().unwrap().to_string();

    // 等到输出里出现 ready（上限 5s）
    let got = execute_native_tool(
        &ctx,
        "get_background_service",
        &json!({ "id": id, "waitMs": 5000, "waitFor": "ready on 3000", "mode": "all" }),
    )
    .await
    .unwrap();
    let content = content_of(got.clone());
    assert!(content.contains("matched"), "content: {content}");
    assert!(ui_of(&got)["waitMatched"].as_bool().unwrap());

    registry::kill_session_services("s_wait");
}

#[tokio::test]
async fn services_are_isolated_per_session() {
    let env = TestEnv::new();
    let ctx_a = env.ctx_default("s_a", "tc_a");
    let ctx_b = env.ctx_default("s_b", "tc_b");

    let started = execute_native_tool(
        &ctx_a,
        "start_background_service",
        &json!({ "name": "a-only", "cmd": CMD_LONG, "defaultWaitTime": 300 }),
    )
    .await
    .unwrap();
    let id = ui_of(&started)["id"].as_str().unwrap().to_string();

    // B 会话：看不到（列表为空）、读不到、也杀不掉
    let list_b = content_of(
        execute_native_tool(&ctx_b, "list_background_services", &json!({}))
            .await
            .unwrap(),
    );
    assert!(list_b.contains("No background services"), "list_b: {list_b}");

    let get_b = execute_native_tool(&ctx_b, "get_background_service", &json!({ "id": id })).await;
    assert!(get_b.is_err(), "跨会话 get 应报错");
    assert!(get_b.unwrap_err().contains("in this conversation"));

    let kill_b = execute_native_tool(&ctx_b, "kill_background_service", &json!({ "id": id })).await;
    assert!(kill_b.is_err(), "跨会话 kill 应报错");

    // A 会话：能看到、能杀
    let list_a = content_of(
        execute_native_tool(&ctx_a, "list_background_services", &json!({}))
            .await
            .unwrap(),
    );
    assert!(list_a.contains(&id), "list_a: {list_a}");
    execute_native_tool(&ctx_a, "kill_background_service", &json!({ "id": id }))
        .await
        .unwrap();
}

#[tokio::test]
async fn list_reports_running_and_exited() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_list", "tc_list");
    let running = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "long", "cmd": CMD_LONG, "defaultWaitTime": 200 }),
    )
    .await
    .unwrap();
    let running_id = ui_of(&running)["id"].as_str().unwrap().to_string();
    execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "quick2", "cmd": CMD_QUICK, "defaultWaitTime": 5000 }),
    )
    .await
    .unwrap();

    let text = content_of(
        execute_native_tool(&ctx, "list_background_services", &json!({}))
            .await
            .unwrap(),
    );
    assert!(text.contains(&running_id), "text: {text}");
    assert!(text.contains(status::RUNNING), "text: {text}");
    assert!(text.contains(status::EXITED), "text: {text}");

    registry::kill_session_services("s_list");
}

#[tokio::test]
async fn duplicate_running_name_is_rejected() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_dup", "tc_dup");
    let first = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "same", "cmd": CMD_LONG, "defaultWaitTime": 200 }),
    )
    .await
    .unwrap();
    let id = ui_of(&first)["id"].as_str().unwrap().to_string();

    let second = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "same", "cmd": CMD_LONG, "defaultWaitTime": 200 }),
    )
    .await;
    assert!(second.is_err(), "同名运行中服务应被拒");
    assert!(second.unwrap_err().contains(&id), "报错应带上既有 id");

    registry::kill_session_services("s_dup");
}

#[tokio::test]
async fn kill_session_services_stops_everything_in_that_session() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_kill_all", "tc_kill_all");
    let started = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "one", "cmd": CMD_LONG, "defaultWaitTime": 200 }),
    )
    .await
    .unwrap();
    let id = ui_of(&started)["id"].as_str().unwrap().to_string();

    let n = registry::kill_session_services("s_kill_all");
    assert_eq!(n, 1);
    assert!(registry::get("s_kill_all", &id).is_none());
    assert_eq!(registry::session_count("s_kill_all"), 0);
}

#[tokio::test]
async fn missing_params_are_rejected() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_params", "tc_params");
    assert!(execute_native_tool(&ctx, "start_background_service", &json!({ "cmd": "x" }))
        .await
        .is_err());
    assert!(execute_native_tool(&ctx, "start_background_service", &json!({ "name": "x" }))
        .await
        .is_err());
    assert!(execute_native_tool(&ctx, "get_background_service", &json!({}))
        .await
        .is_err());
    assert!(execute_native_tool(&ctx, "kill_background_service", &json!({}))
        .await
        .is_err());
}

#[tokio::test]
async fn spawn_failure_is_reported_as_failed() {
    let env = TestEnv::new();
    // 裸跑路径恒用系统 shell 启动，故「命令不存在」是 shell 自己报错（退出码非 0），
    // 这里改为制造**确定性**的 spawn 失败：工作目录不存在。
    let mut sec = service_security(&env.dir.to_string_lossy());
    sec.workspace = env.dir.join("does-not-exist").to_string_lossy().to_string();
    let ctx = env.ctx("s_fail", "tc_fail", &sec);
    let outcome = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "nope", "cmd": CMD_QUICK, "defaultWaitTime": 500 }),
    )
    .await
    .unwrap();
    assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
    assert_eq!(ui_of(&outcome)["status"], status::FAILED);
}

/// 沙盒路径的**模式标记**：把沙盒打开时结果必须如实标 `write_isolation`（哪怕随后降级）。
/// 只验标记与文案，不依赖 ACL / Landlock 是否真的可用。
#[tokio::test]
async fn sandbox_mode_is_reflected_in_result() {
    let env = TestEnv::new();
    let mut sec = service_security(&env.dir.to_string_lossy());
    sec.sandbox_mode = "readonly".to_string();
    let ctx = env.ctx("s_sandbox", "tc_sandbox", &sec);
    // readonly 下申请脱壳 → 直接拒绝（与 execute_command 同一条红线）
    let err = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "x", "cmd": CMD_QUICK, "sandbox": "off" }),
    )
    .await
    .unwrap_err();
    assert!(err.contains("read-only mode"), "err: {err}");
}

/// 前端「终止」按钮（`agent_kill_command` 走的注册表）在等待窗口内必须能杀掉服务。
#[tokio::test]
async fn frontend_kill_button_stops_the_service_during_wait() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_stop", "tc_stop");
    let args = json!({ "name": "stopme", "cmd": CMD_LONG, "defaultWaitTime": 5000 });
    let tool = execute_native_tool(&ctx, "start_background_service", &args);
    // 等一会儿（工具正卡在等待窗口里），再按「终止」——等价于前端点击
    let clicker = async {
        tokio::time::sleep(Duration::from_millis(600)).await;
        crate::agent::native_tools::kill_running_command("tc_stop")
    };
    let (outcome, hit) = tokio::join!(tool, clicker);
    assert!(hit, "等待窗口内应能在运行中命令表里找到该 tool_call_id");
    let outcome = outcome.unwrap();
    // 用户终止 → 不能报「running」（否则模型会一直去 get 一个已死的服务）
    let content = content_of(outcome.clone());
    assert!(
        content.contains("terminated before the wait finished"),
        "content: {content}"
    );
    assert_eq!(ui_of(&outcome)["killed"], serde_json::Value::Bool(true));
    registry::kill_session_services("s_stop");
}

// ==================== 结束通知（`notice.rs`） ====================

/// 端到端：**工具返回后才退出**的服务必须攒下一条通知，并在轮次边界注入进下一次请求（并落库）。
///
/// 时机：`defaultWaitTime = 100ms` → 工具报告 running 并返回（启动窗口关闭）；300ms 后进程自己退出。
/// 无人挂宿主出口（测试环境）→ 通知留在 Rust 队列里，等轮次边界注入 —— 这正是 CLI / 手机的那条路。
///
/// ⚠️ 反向对照：启动窗口**内**就退出的服务不发通知（那一件事已由 start 工具的结果交代，
/// 见 `notice.rs::tests::startup_window_and_muted_exits_are_silent`）。
#[cfg(target_os = "windows")]
const CMD_EXIT_LATER: &str = "Start-Sleep -Milliseconds 300; Write-Output bye";
#[cfg(not(target_os = "windows"))]
const CMD_EXIT_LATER: &str = "sleep 0.3; echo bye";

#[tokio::test]
async fn service_exit_after_the_tool_returned_is_notified_at_the_next_boundary() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_notice_e2e", "tc_notice_e2e");
    let started = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "oneshot", "cmd": CMD_EXIT_LATER, "defaultWaitTime": 100 }),
    )
    .await
    .unwrap();
    let ui = ui_of(&started).clone();
    assert_eq!(ui["status"], status::RUNNING, "工具返回时服务应还在跑");
    let id = ui["id"].as_str().unwrap().to_string();
    // 启动窗口已关闭（= 此后退出要发通知）
    assert!(
        !registry::get("s_notice_e2e", &id).unwrap().state.startup_window(),
        "工具返回后启动窗口必须已关闭"
    );

    // 等进程自己退出（最多 5s）—— 退出后通知应已入队
    let mut queued = 0;
    for _ in 0..100 {
        queued = super::notice::pending_count("s_notice_e2e");
        if queued > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(queued, 1, "进程自行退出后应攒下一条通知");

    // 轮次边界：注入进本次请求的消息列表（role=feedback，正文带 id 与退出码）
    let mut messages: Vec<crate::agent::types::Message> = Vec::new();
    crate::agent::native_tools::inject_service_notices(noop_repo(), "s_notice_e2e", &mut messages)
        .await;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "feedback");
    let content = messages[0].text_content();
    assert!(content.contains(&id), "content: {content}");
    assert!(content.contains("Exit code: 0"), "content: {content}");
    // 注入过就不再注入（幂等）
    crate::agent::native_tools::inject_service_notices(noop_repo(), "s_notice_e2e", &mut messages)
        .await;
    assert_eq!(messages.len(), 1);

    registry::kill_session_services("s_notice_e2e");
}

// ==================== 面板 API（`panel.rs`，P2） ====================

/// 面板看到的就是工具那张表：会话隔离一致、字段同形、终止后**条目留在原地**（「已结束」页要看得见）。
#[tokio::test]
async fn panel_snapshot_is_session_scoped_and_survives_kill() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_panel", "tc_panel");
    let started = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "panel-dev", "cmd": CMD_LONG, "defaultWaitTime": 400 }),
    )
    .await
    .unwrap();
    let id = ui_of(&started)["id"].as_str().unwrap().to_string();

    // 本会话：看得到，且字段与 `list_background_services` 的 uiData 同形（前端复用同一套解析）
    let rows = super::panel::list_service_snapshots("s_panel");
    assert_eq!(rows.len(), 1, "rows: {rows:?}");
    assert_eq!(rows[0]["id"], id.as_str());
    assert_eq!(rows[0]["status"], status::RUNNING);
    assert_eq!(rows[0]["name"], "panel-dev");
    assert!(rows[0]["pid"].as_u64().unwrap() > 0);
    assert!(rows[0]["unreadChars"].is_u64());
    assert!(!rows[0]["sandbox"].as_str().unwrap_or_default().is_empty());

    let listed = execute_native_tool(&ctx, "list_background_services", &json!({}))
        .await
        .unwrap();
    let tool_row = &ui_of(&listed)["services"][0];
    let mut panel_keys: Vec<&String> = rows[0].as_object().unwrap().keys().collect();
    let mut tool_keys: Vec<&String> = tool_row.as_object().unwrap().keys().collect();
    panel_keys.sort();
    tool_keys.sort();
    assert_eq!(
        panel_keys, tool_keys,
        "面板快照必须与 list 工具同形（否则前端要维护两套字段名）"
    );

    // 其它会话：一条都看不到，也杀不掉（与四个工具同一句「本会话没有它」）
    assert!(super::panel::list_service_snapshots("s_panel_other").is_empty());
    assert!(super::panel::kill_service_snapshot("s_panel_other", &id)
        .await
        .is_none());

    // 面板终止：置位「被终止」+ 有界等待状态落定；⚠️ 与工具 kill 不同 —— **不摘条目**
    let killed = super::panel::kill_service_snapshot("s_panel", &id)
        .await
        .expect("本会话应可见");
    assert_eq!(killed["status"], status::EXITED);
    assert_eq!(killed["killed"], serde_json::Value::Bool(true));
    assert!(
        registry::get("s_panel", &id).is_some(),
        "面板终止后条目必须留在注册表（「已结束」页靠它显示）"
    );
    // 幂等：再杀一次只回报现状
    let again = super::panel::kill_service_snapshot("s_panel", &id).await.unwrap();
    assert_eq!(again["status"], status::EXITED);
    assert!(super::panel::kill_service_snapshot("s_panel", "svc_missing")
        .await
        .is_none());

    registry::kill_session_services("s_panel");
}

/// 全局面板（新对话页的入口，P4）：**跨会话可见**、每行带 `sessionId` 归属；
/// 本会话视图保持原样（只含本会话、且**不带** `sessionId` —— 与 list 工具同形）。
///
/// 用 pid=0 的登记条目（不真起进程）：验的是注册表遍历与快照组装，不是进程行为；
/// 断言一律按 id 过滤 —— 全局注册表里还有其它并行测试的条目。
#[test]
fn all_sessions_snapshot_marks_ownership_and_keeps_the_scoped_view_in_shape() {
    use std::sync::Arc;

    let mk = |sid: &str, id: &str, name: &str, started: i64| {
        Arc::new(super::registry::ServiceEntry::new(
            id.to_string(),
            sid.to_string(),
            name.to_string(),
            "sleep 600".to_string(),
            0,
            started,
            "no_sandbox".to_string(),
            Arc::new(super::registry::ServiceState::new()),
            Arc::new(|| {}),
        ))
    };
    super::registry::insert(mk("s_all_a", "svc_all_a", "dev-a", 100));
    super::registry::insert(mk("s_all_b", "svc_all_b", "dev-b", 200));

    let all = super::panel::list_all_service_snapshots();
    let mine: Vec<&serde_json::Value> = all
        .iter()
        .filter(|r| matches!(r["id"].as_str(), Some("svc_all_a") | Some("svc_all_b")))
        .collect();
    assert_eq!(mine.len(), 2, "两个会话的服务都要出现在全局视图里");
    assert_eq!(mine[0]["sessionId"], "s_all_a", "归属随行给出");
    assert_eq!(mine[0]["id"], "svc_all_a");
    assert_eq!(mine[1]["sessionId"], "s_all_b");
    assert_eq!(mine[1]["id"], "svc_all_b", "按启动时间升序");

    // 本会话视图不受影响：看不到别的会话，也不带 sessionId（同形由下方已有用例守）
    let scoped = super::panel::list_service_snapshots("s_all_a");
    let a = scoped
        .iter()
        .find(|r| r["id"] == "svc_all_a")
        .expect("本会话应可见");
    assert!(
        !a.as_object().unwrap().contains_key("sessionId"),
        "本会话快照不加字段（前端仍只维护一套解析）"
    );
    assert!(scoped.iter().all(|r| r["id"] != "svc_all_b"));

    super::registry::remove("svc_all_a");
    super::registry::remove("svc_all_b");
}

/// 面板的读操作**不得消费已读游标**：用户刷一眼 / 在面板里杀服务之后，模型仍要能读到那段输出。
#[tokio::test]
async fn panel_kill_leaves_the_models_unread_output_intact() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_panel_read", "tc_panel_read");
    // 等待窗口 100ms：`booting` 被 start 工具读走，`ready on 3000`（300ms 后）留在缓冲里没人读
    let started = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "reader", "cmd": CMD_READY, "defaultWaitTime": 100 }),
    )
    .await
    .unwrap();
    let id = ui_of(&started)["id"].as_str().unwrap().to_string();
    let entry = registry::get("s_panel_read", &id).unwrap();
    assert_eq!(entry.unread(), 0, "start 工具返回时应已把自己的等待窗口读干净");

    // 等那行新输出落进窗口（最多 3s）
    for _ in 0..60 {
        if entry.unread() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(entry.unread() > 0, "应已收到 `ready on 3000`（之后一直没人读）");

    // 面板刷一遍 + 在面板里终止（两者都是只读快照，不得消费游标）
    let rows = super::panel::list_service_snapshots("s_panel_read");
    assert!(
        rows[0]["unreadChars"].as_u64().unwrap() > 0,
        "面板要能如实显示「AI 还没读过的输出」有多少"
    );
    super::panel::kill_service_snapshot("s_panel_read", &id)
        .await
        .unwrap();

    // 模型侧增量读（默认 mode=new）仍拿得到那行 —— 面板没把它抹掉；同时能看出是「被终止」
    let got = execute_native_tool(
        &ctx,
        "get_background_service",
        &json!({ "id": id, "waitMs": 0 }),
    )
    .await
    .unwrap();
    let content = content_of(got.clone());
    assert!(
        content.contains("ready on 3000"),
        "面板不能消费模型的未读输出，content: {content}"
    );
    assert_eq!(ui_of(&got)["killed"], serde_json::Value::Bool(true));

    registry::kill_session_services("s_panel_read");
}

// ==================== 终端弹窗（P3） ====================

/// 端到端：Windows 上服务跑在**伪控制台**里 —— 面板能读合并流、能敲键盘、能改尺寸；
/// 进程退出后控制台随之关闭（写 / 改尺寸一律 false），但输出仍能回放。
///
/// 字段语义（P3 显示 bug 的回归）：退出后 `interactive` 落 `false`、**`terminal` 仍是 `true`**
///（「曾是终端服务」是持久事实）—— 弹窗据此报「服务已结束」而不是「管道模式」。
///
/// 口径（与 P2 的三条并列）：读合并流**不消费已读游标**（模型仍读得到）；写 / 改尺寸**只认
/// 「跑在伪控制台里且仍在运行」**；会话隔离同一道边界。
#[cfg(target_os = "windows")]
#[tokio::test]
async fn console_is_interactive_while_running_and_closed_after_exit() {
    let env = TestEnv::new();
    let ctx = env.ctx_default("s_console", "tc_console");
    let started = execute_native_tool(
        &ctx,
        "start_background_service",
        &json!({ "name": "console-dev", "cmd": CMD_READY, "defaultWaitTime": 100 }),
    )
    .await
    .unwrap();
    let ui = ui_of(&started);
    let id = ui["id"].as_str().unwrap().to_string();
    // 快照如实告诉界面：这个服务有终端（能开弹窗交互）
    assert_eq!(ui["terminal"], serde_json::Value::Bool(true), "uiData: {ui}");
    assert_eq!(ui["interactive"], serde_json::Value::Bool(true), "uiData: {ui}");
    assert!(registry::get("s_console", &id).unwrap().state.has_pty());

    // 键击 / 尺寸：进程活着 → 接受（空串是 no-op 的成功；同尺寸重复上报去重后仍回 true）
    assert!(super::panel::write_service_console("s_console", &id, ""));
    assert!(super::panel::write_service_console("s_console", &id, "\r"));
    assert!(super::panel::resize_service_console("s_console", &id, 100, 30));
    assert!(super::panel::resize_service_console("s_console", &id, 100, 30));
    // 跨会话：一律拒绝（与四个工具同一句「本会话没有它」）
    assert!(!super::panel::write_service_console("s_console_other", &id, "x"));
    assert!(!super::panel::resize_service_console(
        "s_console_other",
        &id,
        80,
        24
    ));
    assert!(super::panel::read_service_console("s_console_other", &id, 0).is_none());

    // 等 `ready on 3000` 落进合并流（最多 3s）：读到的就是服务的控制台输出
    let mut offset = 0u64;
    let mut all = String::new();
    for _ in 0..60 {
        let chunk = super::panel::read_service_console("s_console", &id, offset)
            .expect("本会话应可见");
        offset = chunk["next"].as_u64().unwrap();
        all.push_str(chunk["text"].as_str().unwrap());
        if all.contains("ready on 3000") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        all.contains("booting") && all.contains("ready on 3000"),
        "console stream: {all:?}"
    );
    // 偏移续接：同一偏移再读 → 空增量；且不消费模型的未读游标
    let again = super::panel::read_service_console("s_console", &id, offset).unwrap();
    assert_eq!(again["text"], "");
    assert!(!again["reset"].as_bool().unwrap());
    let got = execute_native_tool(
        &ctx,
        "get_background_service",
        &json!({ "id": id, "waitMs": 0 }),
    )
    .await
    .unwrap();
    assert!(
        content_of(got).contains("ready on 3000"),
        "终端弹窗读合并流不得消费模型的未读输出"
    );

    // 终止（面板路径，不摘条目）→ 控制台随即关闭；输出仍可回放，但不能再输入
    super::panel::kill_service_snapshot("s_console", &id)
        .await
        .unwrap();
    let mut closed = false;
    for _ in 0..40 {
        if !registry::get("s_console", &id).unwrap().state.has_pty() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(closed, "进程退出后控制台应被关闭（读线程随后 EOF）");
    assert!(!super::panel::write_service_console("s_console", &id, "x"));
    assert!(!super::panel::resize_service_console("s_console", &id, 120, 40));
    let after = super::panel::read_service_console("s_console", &id, 0).unwrap();
    assert!(
        after["text"].as_str().unwrap().contains("ready on 3000"),
        "已结束的服务仍可回放输出（「已结束」页的终端）"
    );
    assert_eq!(after["running"], serde_json::Value::Bool(false));
    assert_eq!(after["interactive"], serde_json::Value::Bool(false));
    // 「（曾）是终端服务」是持久事实：控制台随退出关闭，但 terminal 不得回落到 false ——
    // 否则弹窗会把「服务已结束，只能查看输出」误报成「管道模式，无法输入」（P3 实测 bug）。
    assert_eq!(after["terminal"], serde_json::Value::Bool(true));

    registry::kill_session_services("s_console");
}
