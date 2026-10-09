//! service — 后台服务「结束通知」：服务一结束（**自行退出**或**被用户终止**），把这件事在正确的时机
//! 告诉 AI，同时让用户在消息流里看得见。
//!
//! 时机（与「任务清单变更」的轮次边界同一套口径）：
//! - **AI 正在这一轮里**（该会话有活跃 run）→ 进本地队列，在**下一次 LLM 请求之前**追加进消息列表
//!   （`bridge::inject_round_boundary_messages` 的本地来源，**不依赖 JS 是否在场** —— CLI / 手机
//!   走同一条路，它们拿不到桌面端的 JS 队列）；
//! - **AI 空闲** → 立刻交给宿主出口（GUI：`agent:service-exit` → 前端落进消息列表，用户马上看到，
//!   下一次请求天然带上，落库由前端做 —— `cmd_append_messages`，与 todo 落地同一套）；
//!   宿主不接管（CLI / headless）→ 留在队列里，等下一次请求前注入（那时落库由 Rust 做）。
//! - **本轮结束**（run 收尾）也把队列里剩下的交给宿主：否则「最后一轮里结束的服务」要等到
//!   用户下一次发消息才上屏（模型那边不丢，但用户看不到）。
//!
//! 四种情况**不发**通知（都有别的交代，再插一条只会是噪音 / 重复）：
//! 1. **启动等待窗口内**退出 —— `start_background_service` 的结果已经写清「已退出 + 退出码 + 输出」
//!    （`ServiceState::startup_window`）；
//! 2. **AI 自己 kill**（`kill_background_service` 工具）—— 工具结果里已有收尾状态与输出
//!    （`ServiceState::mute_notice`）；
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
/// 为什么要接口而不是直接 emit：core 零 `tauri::`（宿主差异全收在宿主侧），
/// 且「有没有界面接管」决定通知的去向（见 [`ServiceNoticeHost::present_service_notice`]）。
pub trait ServiceNoticeHost: Send + Sync {
    /// 呈现一条「服务结束」通知。`message` = 完整消息 JSON（与将来注入 / 落库的那条逐字相同）。
    ///
    /// 返回 `true` = 界面已接管（通知**出队**，**由界面落库 + 上屏**）；
    /// 返回 `false` = 没人接管（CLI / headless）→ 通知**留在队列**，下一次 LLM 请求之前注入。
    ///
    /// ⚠️ 落库为什么交给界面而不是在这里做：本条路径发生在 `spawn_blocking` 的等待任务里，
    /// 而 `SessionRepo` 是 async（这里不能 `block_on`）；界面那条路（`cmd_append_messages`，
    /// 与 todo 落地同一套）天然是异步的，因此**持久化的唯一写入点**在那边。
    fn present_service_notice(&self, session_id: &str, message: Value) -> bool;
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
static PENDING: LazyLock<Mutex<HashMap<String, Vec<Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
    // 抑制（见模块头）：启动窗口内 / AI 自己 kill / 整批收摊
    if entry.state.notice_muted() || entry.state.startup_window() {
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
/// - 会话活跃 → 只入队（等轮次边界）；
/// - 空闲且宿主接管 → 交给宿主（+ 前端落库），不入队；
/// - 空闲而没人接管 → 入队（等下一次请求前注入）。
pub(super) fn route(
    session_id: &str,
    message: Value,
    active: bool,
    host: Option<&dyn ServiceNoticeHost>,
) {
    if !active && host.is_some_and(|h| h.present_service_notice(session_id, message.clone())) {
        return;
    }
    PENDING
        .lock()
        .unwrap()
        .entry(session_id.to_string())
        .or_default()
        .push(message);
}

/// 把队列里的通知交给宿主；**没接管的留回队首**（顺序不变），等下一次请求前注入。
pub(super) fn deliver_pending(session_id: &str, host: Option<&dyn ServiceNoticeHost>) {
    let Some(host) = host else {
        return;
    };
    let queued = PENDING
        .lock()
        .unwrap()
        .remove(session_id)
        .unwrap_or_default();
    if queued.is_empty() {
        return;
    }
    let mut keep: Vec<Value> = Vec::new();
    for message in queued {
        if !host.present_service_notice(session_id, message.clone()) {
            keep.push(message);
        }
    }
    if keep.is_empty() {
        return;
    }
    let mut map = PENDING.lock().unwrap();
    let slot = map.entry(session_id.to_string()).or_default();
    // 保留的排在更早的位置：刚 push 进来的（更晚发生）留在后面
    keep.append(slot);
    *slot = keep;
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
    if let Err(e) = repo.append_messages_if_alive(session_id, &parsed).await {
        eprintln!("[session_db] 写入后台服务结束通知失败: {}", e);
    }
    messages.extend(parsed);
}

/// 会话被删除：丢掉它还没注入的通知（会话都没了，通知没有落点）。
pub(super) fn drop_session(session_id: &str) {
    PENDING.lock().unwrap().remove(session_id);
    ACTIVE.lock().unwrap().remove(session_id);
}

/// 整批收摊（应用退出 / 引擎销毁）：队列里剩下的通知一并丢掉。
pub(super) fn clear_all() {
    PENDING.lock().unwrap().clear();
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

    /// 记录被呈现过的通知的宿主出口（验「空闲 → 立刻上屏」/「没接管 → 留队列」两条路）。
    struct RecordingHost {
        seen: Mutex<Vec<(String, Value)>>,
        /// false = 模拟 CLI / headless（没有界面接管）
        accept: bool,
    }

    impl RecordingHost {
        fn accepting() -> Self {
            Self {
                seen: Mutex::new(Vec::new()),
                accept: true,
            }
        }

        fn taking() -> Self {
            Self {
                seen: Mutex::new(Vec::new()),
                accept: false,
            }
        }

        fn count(&self) -> usize {
            self.seen.lock().unwrap().len()
        }

        fn first(&self) -> (String, Value) {
            self.seen.lock().unwrap().first().cloned().expect("应已呈现过一条")
        }

        fn last(&self) -> (String, Value) {
            self.seen.lock().unwrap().last().cloned().expect("应已呈现过一条")
        }
    }

    impl ServiceNoticeHost for RecordingHost {
        fn present_service_notice(&self, session_id: &str, message: Value) -> bool {
            self.seen
                .lock()
                .unwrap()
                .push((session_id.to_string(), message));
            self.accept
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
        let host = RecordingHost::accepting();
        let sid = "s_notice_active";
        mark_session_active(sid);
        route(sid, json!({ "id": "m1" }), is_session_active(sid), Some(&host));
        assert_eq!(host.count(), 0, "在跑时不得直接上屏");
        assert_eq!(pending_count(sid), 1);

        // 本轮结束 → 回到空闲：队列交给宿主（界面立刻上屏），队列清空
        deliver_pending(sid, Some(&host));
        assert_eq!(host.count(), 1);
        assert_eq!(pending_count(sid), 0);
        // 宿主记录里能拿到会话归属与消息本体
        let (got_sid, message) = host.first();
        assert_eq!(got_sid, sid);
        assert_eq!(message["id"], "m1");
        mark_session_idle(sid);
    }

    /// **AI 空闲**时结束：有界面接管 → 交给它（不入队）；没人接管（CLI）→ 留队列等下一次请求前注入。
    #[test]
    fn idle_session_prefers_the_host_and_falls_back_to_the_queue() {
        let accepting = RecordingHost::accepting();
        let sid = "s_notice_idle_host";
        route(sid, json!({ "id": "m1" }), false, Some(&accepting));
        assert_eq!(accepting.count(), 1);
        assert_eq!(pending_count(sid), 0, "界面接管了就不该再排队（否则会重复）");

        let taking = RecordingHost::taking();
        let sid2 = "s_notice_idle_cli";
        route(sid2, json!({ "id": "m2" }), false, Some(&taking));
        assert_eq!(taking.count(), 1, "试过但没接管");
        assert_eq!(pending_count(sid2), 1, "没接管 → 留在队列里");

        // 无宿主（headless / 测试）同理
        let sid3 = "s_notice_idle_nohost";
        route(sid3, json!({ "id": "m3" }), false, None);
        assert_eq!(pending_count(sid3), 1);

        // 顺序：没接管的放回队首（早发生的在前）
        deliver_pending(sid2, Some(&taking));
        assert_eq!(pending_count(sid2), 1, "仍无人接管 → 仍留在队列");
        deliver_pending(sid2, Some(&accepting));
        assert_eq!(pending_count(sid2), 0);
        assert_eq!(accepting.last().1["id"], "m2");
    }

    /// 抑制两条：**启动等待窗口内**退出（start 工具的结果已经交代了）与**整批收摊**（会话删除 /
    /// 应用退出 / AI 自己 kill）。
    #[test]
    fn startup_window_and_muted_exits_are_silent() {
        let state = Arc::new(ServiceState::new());
        let sid = "s_notice_silent";
        let e = entry(sid, "svc_silent", &state);
        state.finish(Some(1), false);

        // 默认：启动窗口还开着 → 不发
        assert!(state.startup_window());
        on_service_exit(&e);
        assert_eq!(pending_count(sid), 0, "启动窗口内退出由 start 工具的结果交代");

        // 窗口关闭（start 工具返回）后退出 → 正常发
        state.close_startup_window();
        on_service_exit(&e);
        assert_eq!(pending_count(sid), 1);

        // 抑制位（AI 自己 kill / 会话删除 / 应用退出）→ 不再发
        let state2 = Arc::new(ServiceState::new());
        let e2 = entry(sid, "svc_silent2", &state2);
        state2.finish(None, true);
        state2.close_startup_window();
        state2.mute_notice();
        on_service_exit(&e2);
        assert_eq!(pending_count(sid), 1, "被抑制时不得新增通知");

        deliver_pending(sid, None);
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
        state.finish(Some(0), false);
        state.close_startup_window();
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
}
