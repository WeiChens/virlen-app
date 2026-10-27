//! service — 后台服务「结束通知」：服务一结束（**自行退出**或**被用户终止**），把这件事在正确的时机
//! 告诉 AI，同时让用户在消息流里看得见。
//!
//! 时机（与「任务清单变更」的轮次边界同一套口径）：
//! - **AI 正在这一轮里**（该会话有活跃 run）→ 进本地队列，在**下一次 LLM 请求之前**追加进消息列表
//!   （`bridge::inject_round_boundary_messages` 的本地来源，**不依赖 JS 是否在场** —— CLI / 手机
//!   走同一条路，它们拿不到桌面端的 JS 队列）；
//! - **AI 空闲** → 顺手投递一次宿主出口（GUI：`agent:service-exit` → 前端落进消息列表，用户马上看到，
//!   落库由前端做 —— `cmd_append_messages`，与 todo 落地同一套）。
//!   ⚠️ 投递后通知**仍留在队列**，要等前端 ack（`ack_delivered` / 命令 `cmd_ack_service_notice`）
//!   才出队 —— `emit` 返回成功不代表有人接（前端未挂监听 / webview 重载），按它出队会让这条通知
//!   凭空消失。没人 ack 的就等下一次请求前注入（那时落库由 Rust 做）。
//! - **本轮结束**（run 收尾）也把队列里剩下的交给宿主：否则「最后一轮里结束的服务」要等到
//!   用户下一次发消息才上屏（模型那边不丢，但用户看不到）。
//!
//! 四种情况**不发**通知（都有别的交代，再插一条只会是噪音 / 重复）：
//! 1. **启动等待窗口内**退出 —— `start_background_service` 的结果已经写清「已退出 + 退出码 + 输出」
//!    （`ServiceState::exit_within_startup`，在 `finish()` 时取证）；
//! 2. **AI 自己 kill** / 启动被取消（`kill_background_service` / `start` 的取消分支）—— 结果里已有
//!    收尾状态与输出（`ServiceEntry::terminate_quietly`）；
//! 3. **会话删除 / 应用退出 / 引擎销毁** —— 整批收摊，通知没有落点（同上 + `drop_session`）；
//! 4. 注册表里**已没有这个条目**（会话已删 / 容量清理）—— 同上。
//!
//! 载体是**消息**（与 todo 的 feedback 消息同一套）：Rust 组装「模型侧英文正文 + `uiData`」，
//! 界面按 `uiData` 用界面语言重建（铁律 1）。队列里存的就是要注入 / 落库的那条消息本身 ——
//! 因此「注入」与「上屏」两条路各自只有一次落库，永远不会出现两条不同措辞的通知。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::Value;

use crate::agent::types::Message;
use crate::session_db::SessionRepo;

use super::registry::ServiceEntry;

// ==================== 宿主出口 ====================

/// 宿主出口：AI 空闲时把一条通知**立刻**呈现给用户（GUI 实现 = 发 `agent:service-exit` 事件）。
///
/// 为什么要接口而不是直接 emit：core 零 `tauri::`（宿主差异全收在宿主侧）。
pub trait ServiceNoticeHost: Send + Sync {
    /// 把一条「服务结束」通知**投递**给界面。`message` = 完整消息 JSON
    ///（与将来注入 / 落库的那条逐字相同）。
    ///
    /// ⚠️ 这里**没有返回值**：投递成功不等于界面收到了 —— Tauri `emit` 在没有监听者时
    ///（前端未挂监听 / webview 重载 / 窗口已销毁）**同样成功**。因此「通知已送达」只能由前端
    /// ack 确认（[`ack_delivered`]）；没送达的就留在队列里，下一次 LLM 请求之前注入。
    ///
    /// 落库为什么交给界面而不是在这里做：本条路径发生在 `spawn_blocking` 的等待任务里，
    /// 而 `SessionRepo` 是 async（这里不能 `block_on`）；界面那条路（`cmd_append_messages`，
    /// 与 todo 落地同一套）天然是异步的，因此**持久化的唯一写入点**在那边。
    fn present_service_notice(&self, session_id: &str, message: Value);
}

/// 宿主出口（进程内唯一；未挂载 = headless，通知只走队列）。
///
/// 用 `Mutex<Option<..>>` 而非 `OnceLock`：换 / 卸都要能做（测试与将来多窗口）。
/// ⚠️ 队列是**全局**的（服务注册表本身就是全局的），因此测试必须按会话 id 隔离。
static HOST: LazyLock<Mutex<Option<Arc<dyn ServiceNoticeHost>>>> =
    LazyLock::new(|| Mutex::new(None));

/// 挂上宿主出口（GUI 在引擎初始化时调一次）。重复挂载以最后一次为准。
pub fn attach_host(host: Arc<dyn ServiceNoticeHost>) {
    *HOST.lock().unwrap() = Some(host);
}

/// 当前宿主出口（未挂载 → `None`）
fn global_host() -> Option<Arc<dyn ServiceNoticeHost>> {
    HOST.lock().unwrap().clone()
}

// ==================== 队列 / 会话活跃 ====================

/// 待注入的通知（session_id → 消息，按发生顺序）。
///
/// ⚠️ 新通知**一律进这里**：`emit` 投递只是顺手上屏，出队只认前端 ack（[`ack_delivered`]）——
/// 「发得出去」不等于「界面收到了」，按前者出队会让通知凭空消失。
static PENDING: LazyLock<Mutex<HashMap<String, Vec<Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 已经投给界面的消息 id（**不等于已送达**）：同一条只投一次，避免 ack 迟到 / 丢失时
/// 在多次「回到空闲」中反复上屏（前端不按 id 去重，重复就是两个气泡）。
static PRESENTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// 有活跃 run 的会话集合（引擎在 `send_message` 进出时维护）。
///
/// 为什么不问 JS：CLI / 手机 / 托盘都经引擎，只有引擎这一处的「谁在跑」是权威且人人可见的；
/// 前端那份 `working` 只覆盖桌面端，且是界面态。
static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// 标记会话进入「AI 正在跑」（引擎 `send_message` 起手，与并发闸同一处）。
pub fn mark_session_active(session_id: &str) {
    ACTIVE.lock().unwrap().insert(session_id.to_string());
}

/// 标记会话回到空闲（引擎 `send_message` 收尾），并把本轮攒下的通知交给宿主。
pub fn mark_session_idle(session_id: &str) {
    ACTIVE.lock().unwrap().remove(session_id);
    deliver_pending(session_id, global_host().as_deref());
}

/// 该会话是否有活跃 run。
fn is_session_active(session_id: &str) -> bool {
    ACTIVE.lock().unwrap().contains(session_id)
}

// ==================== 入口 ====================

/// 服务进程真退出后调用（`runner::supervise` 的常驻等待任务；已在终态落定之后）。
///
/// ⚠️ 在 `spawn_blocking` 的后台线程里调用（emit 与锁都是线程安全的），
/// 因此**不能** await：落库统一在「注入」那条路上做（`inject_pending`）。
pub(super) fn on_service_exit(entry: &ServiceEntry) {
    // 抑制（见模块头）：启动窗口内退出（`finish` 时已取证 —— 不能事后读活标记，那样会和
    // start 工具的 `close_startup_window` 竞态，同一件事说两遍）/ AI 自己 kill / 整批收摊
    if entry.state.notice_muted() || entry.state.exit_within_startup() {
        return;
    }
    let message = super::common::exit_notice(entry, crate::telemetry::now_ms());
    route(
        &entry.session_id,
        message,
        is_session_active(&entry.session_id),
        global_host().as_deref(),
    );
}

/// 通知去向（纯逻辑，宿主由参数传入 —— 各条路径都能直接测）。
///
/// - 一律**入队**（出队只认前端 ack）；
/// - 会话活跃 → 不投递，等轮次边界注入；
/// - 会话空闲 → 顺手投递一次给宿主，让用户立刻上屏。
pub(super) fn route(
    session_id: &str,
    message: Value,
    active: bool,
    host: Option<&dyn ServiceNoticeHost>,
) {
    PENDING
        .lock()
        .unwrap()
        .entry(session_id.to_string())
        .or_default()
        .push(message.clone());
    if !active {
        if let Some(host) = host {
            present_once(host, session_id, &message);
        }
    }
}

/// 投递给界面（同一条消息只投**一次** —— 见 [`PRESENTED`]）。
fn present_once(host: &dyn ServiceNoticeHost, session_id: &str, message: &Value) {
    let Some(id) = message.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    if !PRESENTED.lock().unwrap().insert(id.to_string()) {
        return;
    }
    host.present_service_notice(session_id, message.clone());
}

/// 本轮结束：把还没投过的通知交给宿主（界面立刻上屏）。
///
/// ⚠️ **不摘队列** —— 出队等前端 ack。没接管的（CLI / headless / 前端还没挂监听）就留在队列里，
/// 下一次 LLM 请求之前注入（AI 侧不丢）。
pub(super) fn deliver_pending(session_id: &str, host: Option<&dyn ServiceNoticeHost>) {
    let Some(host) = host else {
        return;
    };
    let queued: Vec<Value> = PENDING
        .lock()
        .unwrap()
        .get(session_id)
        .cloned()
        .unwrap_or_default();
    for message in &queued {
        present_once(host, session_id, message);
    }
}

/// 前端确认「已上屏并落库」→ 把这条通知从队列里摘掉（按消息 id，跨会话查找）。
///
/// 返回 `false` = 队列里没有它（已注入 / 已 ack）—— 幂等，调用方不必关心。
pub fn ack_delivered(id: &str) -> bool {
    let mut removed = false;
    {
        let mut map = PENDING.lock().unwrap();
        map.retain(|_, queued| {
            if let Some(pos) = queued
                .iter()
                .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(id))
            {
                queued.remove(pos);
                removed = true;
            }
            !queued.is_empty()
        });
    }
    if removed {
        PRESENTED.lock().unwrap().remove(id);
    }
    removed
}

/// 轮次边界：把攒下的通知**追加**进本次请求的消息列表并落库。
///
/// ⚠️ 与 JS 轮次边界注入同一时机（`bridge::inject_round_boundary_messages`），只是来源在本地；
/// 落库失败降级为「只进本轮上下文」（与 todo 草稿注入同一条纪律：只丢一次持久化，绝不影响本轮执行）。
pub async fn inject_pending(
    repo: &dyn SessionRepo,
    session_id: &str,
    messages: &mut Vec<Message>,
) {
    let queued = PENDING
        .lock()
        .unwrap()
        .remove(session_id)
        .unwrap_or_default();
    if queued.is_empty() {
        return;
    }
    let parsed: Vec<Message> = queued
        .iter()
        .filter_map(|v| serde_json::from_value::<Message>(v.clone()).ok())
        .collect();
    if parsed.is_empty() {
        return;
    }
    {
        let mut presented = PRESENTED.lock().unwrap();
        for message in &parsed {
            presented.remove(&message.id);
        }
    }
    // 界面可能已经上屏并落库（ack 还在路上 / 丢了）→ 按 id 去重：库里是主键幂等，
    // 但**上下文里不是** —— 同一段正文不能让模型读两遍。
    let fresh: Vec<Message> = parsed
        .into_iter()
        .filter(|m| !messages.iter().any(|x| x.id == m.id))
        .collect();
    if fresh.is_empty() {
        return;
    }
    if let Err(e) = repo.append_messages_if_alive(session_id, &fresh).await {
        eprintln!("[session_db] 写入后台服务结束通知失败: {}", e);
    }
    messages.extend(fresh);
}

/// 会话被删除：丢掉它还没注入的通知（会话都没了，通知没有落点）。
pub(super) fn drop_session(session_id: &str) {
    PENDING.lock().unwrap().remove(session_id);
    ACTIVE.lock().unwrap().remove(session_id);
}

/// 整批收摊（应用退出 / 引擎销毁）：队列里剩下的通知一并丢掉。
pub(super) fn clear_all() {
    PENDING.lock().unwrap().clear();
    PRESENTED.lock().unwrap().clear();
    ACTIVE.lock().unwrap().clear();
}

// ==================== 测试辅助 ====================

/// 某会话待注入的通知条数（测试用）。
#[cfg(test)]
pub(super) fn pending_count(session_id: &str) -> usize {
    PENDING
        .lock()
        .unwrap()
        .get(session_id)
        .map(Vec::len)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native_tools::service::registry::{ServiceEntry, ServiceState};
    use serde_json::json;

    /// 记录被投递过的通知的宿主出口（验「空闲 → 立刻上屏」与「ack ≠ 投递」两条路）。
    struct RecordingHost {
        seen: Mutex<Vec<(String, Value)>>,
    }

    impl RecordingHost {
        fn new() -> Self {
            Self {
                seen: Mutex::new(Vec::new()),
            }
        }

        fn count(&self) -> usize {
            self.seen.lock().unwrap().len()
        }

        fn first(&self) -> (String, Value) {
            self.seen.lock().unwrap().first().cloned().expect("应已投递过一条")
        }
    }

    impl ServiceNoticeHost for RecordingHost {
        fn present_service_notice(&self, session_id: &str, message: Value) {
            self.seen
                .lock()
                .unwrap()
                .push((session_id.to_string(), message));
        }
    }

    /// 造一个已结束的注册表条目（pid=0 → 不真起 / 杀进程，只验通知路由）。
    fn entry(session_id: &str, id: &str, state: &Arc<ServiceState>) -> ServiceEntry {
        ServiceEntry::new(
            id.to_string(),
            session_id.to_string(),
            "dev".to_string(),
            "npm run dev".to_string(),
            0,
            1_000,
            "no_sandbox".to_string(),
            state.clone(),
            Arc::new(|| {}),
        )
    }

    /// **AI 在跑**时结束 → 只入队（等轮次边界），绝不现在就塞给界面
    ///（否则界面与模型会看到两次：一次是上屏的那条，一次是下一次请求里注入的那条）。
    #[test]
    fn active_session_queues_and_never_presents() {
        // ⚠️ 消息 id 必须跨用例唯一：`ack_delivered` 按 id 跨会话查找（真实链路里 id 是 uuid）
        let host = RecordingHost::new();
        let sid = "s_notice_active";
        mark_session_active(sid);
        route(
            sid,
            json!({ "id": "notice_active_1" }),
            is_session_active(sid),
            Some(&host),
        );
        assert_eq!(host.count(), 0, "在跑时不得直接上屏");
        assert_eq!(pending_count(sid), 1);

        // 本轮结束 → 回到空闲：队列交给宿主（界面立刻上屏）—— ⚠️ 出队仍等前端 ack
        deliver_pending(sid, Some(&host));
        assert_eq!(host.count(), 1);
        assert_eq!(pending_count(sid), 1, "投递成功不等于送达（emit 无监听者也成功）");
        // 重复投递不会二次上屏（同一条只投一次，否则界面会叠两个气泡）
        deliver_pending(sid, Some(&host));
        assert_eq!(host.count(), 1);

        // 宿主记录里能拿到会话归属与消息本体
        let (got_sid, message) = host.first();
        assert_eq!(got_sid, sid);
        assert_eq!(message["id"], "notice_active_1");

        // 前端确认已上屏 + 落库 → 这才出队
        assert!(ack_delivered("notice_active_1"));
        assert_eq!(pending_count(sid), 0);
        assert!(
            !ack_delivered("notice_active_1"),
            "重复 ack 幂等（回 false，不影响任何东西）"
        );
        mark_session_idle(sid);
    }

    /// **AI 空闲**时结束：立刻投递（不入队也不对 —— 否则没人 ack 就丢）/ 没有宿主（CLI）就只入队；
    /// 投递后队列内容不变，直到 ack。
    #[test]
    fn idle_session_presents_immediately_but_keeps_the_notice_until_ack() {
        let host = RecordingHost::new();
        let sid = "s_notice_idle_host";
        route(sid, json!({ "id": "notice_idle_1" }), false, Some(&host));
        assert_eq!(host.count(), 1, "空闲时立刻上屏");
        assert_eq!(pending_count(sid), 1, "ack 之前仍留在队列里（丢 emit 不能丢消息）");
        assert!(ack_delivered("notice_idle_1"));
        assert_eq!(pending_count(sid), 0);

        // 无宿主（headless / 前端还没挂上监听）：只入队，等下一次请求前注入
        let sid2 = "s_notice_idle_cli";
        route(sid2, json!({ "id": "notice_idle_2" }), false, None);
        assert_eq!(pending_count(sid2), 1);
        // 之后挂上了宿主：投递一次而已（队列不动，仍得 ack）
        deliver_pending(sid2, Some(&host));
        assert_eq!(host.count(), 2);
        assert_eq!(pending_count(sid2), 1);
        assert!(ack_delivered("notice_idle_2"));
    }

    /// 抑制两条：**启动等待窗口内**退出（start 工具的结果已经交代了）与**整批收摊**（会话删除 /
    /// 应用退出 / AI 自己 kill）。
    ///
    /// ⚠️ 「窗口内退出」在 `finish()` 时**取证**：`finish` 与 `close_startup_window` 跑在两个任务上，
    /// 先后无保证 —— 先取证、后关窗口也必须静默（否则同一件事会被 start 结果 + 结束通知说两遍）。
    #[test]
    fn startup_window_and_muted_exits_are_silent() {
        let sid = "s_notice_silent";

        // ① 窗口内退出：finish 时取证 → 之后窗口被关掉（start 工具的正常收尾）也不得发
        let state = Arc::new(ServiceState::new());
        let e = entry(sid, "svc_silent", &state);
        state.finish(Some(1), false);
        assert!(state.startup_window());
        state.close_startup_window();
        on_service_exit(&e);
        assert_eq!(pending_count(sid), 0, "窗口内退出由 start 工具的结果交代（与关窗口的先后无关）");

        // ② 窗口关闭后才退出（工具已返回 running）→ 正常发
        let state2 = Arc::new(ServiceState::new());
        state2.close_startup_window();
        let e2 = entry(sid, "svc_after", &state2);
        state2.finish(Some(0), false);
        on_service_exit(&e2);
        assert_eq!(pending_count(sid), 1);

        // ③ 抑制位（AI 自己 kill / 会话删除 / 应用退出）→ 不再发
        let state3 = Arc::new(ServiceState::new());
        state3.close_startup_window();
        let e3 = entry(sid, "svc_silent3", &state3);
        state3.finish(None, true);
        state3.mute_notice();
        on_service_exit(&e3);
        assert_eq!(pending_count(sid), 1, "被抑制时不得新增通知");

        drop_session(sid);
        assert_eq!(pending_count(sid), 0);
    }

    /// 通知本体：模型侧英文正文（含 id / 退出码 / 怎么结束的都写清）+ `uiData` 给界面重建。
    #[test]
    fn exit_notice_carries_enough_for_both_sides() {
        let state = Arc::new(ServiceState::new());
        let mut e = entry("s_notice_body", "svc_body", &state);
        state.finish(Some(3), false);
        e.started_at = 0;
        let message = super::super::common::exit_notice(&e, 61_000);

        assert_eq!(message["role"], "feedback");
        assert!(!message["id"].as_str().unwrap().is_empty());
        let content = message["content"].as_str().unwrap();
        assert!(content.contains("svc_body"), "content: {content}");
        assert!(content.contains("npm run dev"), "content: {content}");
        assert!(content.contains("exited on its own"), "content: {content}");
        assert!(content.contains("Exit code: 3"), "content: {content}");
        assert!(content.contains("do not wait on it"), "content: {content}");
        assert!(content.contains("get_background_service"), "content: {content}");
        let ui = &message["uiData"];
        assert_eq!(ui["type"], "service");
        assert_eq!(ui["id"], "svc_body");
        assert_eq!(ui["name"], "dev");
        assert_eq!(ui["returnCode"], 3);
        assert_eq!(ui["killed"], json!(false));

        // 被终止：说法必须与「自行退出」分开（对模型与用户含义完全不同）
        let killed_state = Arc::new(ServiceState::new());
        let mut e2 = entry("s_notice_body", "svc_body2", &killed_state);
        killed_state.finish(None, true);
        e2.started_at = 0;
        let message2 = super::super::common::exit_notice(&e2, 61_000);
        let content2 = message2["content"].as_str().unwrap();
        assert!(content2.contains("was terminated"), "content: {content2}");
        assert!(content2.contains("null (terminated)"), "content: {content2}");
    }

    /// 轮次边界注入：消息进本次请求的列表（幂等：注入过就不再注入）。
    #[tokio::test]
    async fn inject_pending_appends_once() {
        let sid = "s_notice_inject";
        let state = Arc::new(ServiceState::new());
        let e = entry(sid, "svc_inj", &state);
        // 工具已返回（窗口关闭）之后才退出 → 应当生成通知
        state.close_startup_window();
        state.finish(Some(0), false);
        on_service_exit(&e);

        let repo = crate::agent::native_tools::noop_repo();
        let mut messages: Vec<Message> = Vec::new();
        inject_pending(repo, sid, &mut messages).await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "feedback");
        assert!(messages[0].text_content().contains("svc_inj"));
        assert_eq!(pending_count(sid), 0);

        // 再注入一次：什么都不发生（队列已空，不得重复注入）
        inject_pending(repo, sid, &mut messages).await;
        assert_eq!(messages.len(), 1);

        drop_session(sid);
        clear_all();
        assert_eq!(pending_count(sid), 0);
    }

    /// 界面已上屏并落库、但 ack 丢了 → 注入时必须按 id 去重（库里主键幂等，上下文里不是）。
    #[tokio::test]
    async fn inject_pending_skips_notices_already_in_the_context() {
        let sid = "s_notice_inject_dup";
        let state = Arc::new(ServiceState::new());
        let e = entry(sid, "svc_dup", &state);
        state.close_startup_window();
        state.finish(Some(0), false);
        on_service_exit(&e);

        let repo = crate::agent::native_tools::noop_repo();
        // 历史里已经有这条（前端 `cmd_append_messages` 落过库，引擎把它读回来了）
        let queued_id = PENDING.lock().unwrap()[sid][0]["id"].as_str().unwrap().to_string();
        let mut messages: Vec<Message> = vec![serde_json::from_value(json!({
            "id": queued_id,
            "role": "feedback",
            "content": "[Background service ended] svc_dup",
            "timestamp": 1,
        }))
        .unwrap()];

        inject_pending(repo, sid, &mut messages).await;
        assert_eq!(messages.len(), 1, "同一 id 不得在上下文里出现两次");
        assert_eq!(pending_count(sid), 0, "队列照常排空（否则会反复重试）");
        drop_session(sid);
        clear_all();
    }
}
