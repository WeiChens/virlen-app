//! 后台服务注册表 —— **会话隔离的唯一落点**。
//!
//! 语义与「运行中命令注册表」（`execute/common/registry.rs`）的区别：那张表以 `tool_call_id` 为键、
//! 工具一返回就注销（只服务「运行中」阶段的前端终止按钮）；本表以**服务 id** 为键、**活到进程结束
//! 或显式清理**，因此每个条目都必须带 `session_id` 归属 —— 四个工具全部只在本会话内查找，
//! 跨会话的 id 一律按「不存在」处理（不泄露其它会话是否真的存在该服务）。
//!
//! 条目以 `Arc<ServiceEntry>` 存放：工具从锁里取出 `Arc` 后立刻放锁，随后读状态 / 输出都不再持全局锁
//! （长耗时读取不会阻塞其它会话的服务）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use super::common::{char_index, slice_from_char, STREAM_CAP_CHARS};
use super::pty::ServicePty;
use super::super::execute::common::{kill_process_tree, Terminator};

// ==================== 状态 ====================

/// 服务运行态。
///
/// ⚠️ 没有「启动失败」变体：spawn 失败时根本不会产生条目（工具直接回 `failed_outcome`，无 pid 可管）。
#[derive(Debug, Clone)]
pub(crate) enum Status {
    /// 存活
    Running,
    /// 已结束：`code` 为退出码（平台取不到时为 `None`）；`killed` 区分「被终止」与「自行退出」
    Exited { code: Option<i32>, killed: bool },
}

/// 服务条目（含状态、输出窗口、终止器）。
pub(crate) struct ServiceEntry {
    pub(super) id: String,
    pub(super) session_id: String,
    pub(super) name: String,
    pub(super) cmd: String,
    pub(super) pid: u32,
    pub(super) started_at: i64,
    /// 本次实际沙盒模式（`uiData.sandbox` 同词表：`write_isolation` / `readonly` / `no_sandbox_*`）
    pub(super) sandbox: String,
    pub(super) state: Arc<ServiceState>,
    /// 终止器 —— 同时**持有 Job / 进程句柄**，drop 它等于放弃「一键杀树」能力
    ///（裸跑路径的 Job 带 KILL_ON_JOB_CLOSE：drop 即杀，见 `process_tree::create_kill_on_close`）。
    terminator: Terminator,
}

impl ServiceEntry {
    /// 组装一个条目（`terminator` 由运行器给出）。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        id: String,
        session_id: String,
        name: String,
        cmd: String,
        pid: u32,
        started_at: i64,
        sandbox: String,
        state: Arc<ServiceState>,
        terminator: Terminator,
    ) -> Self {
        Self {
            id,
            session_id,
            name,
            cmd,
            pid,
            started_at,
            sandbox,
            state,
            terminator,
        }
    }

    /// 终止整棵进程树（幂等）。**只发信号**：状态由常驻等待任务在进程真退出时落定。
    pub(super) fn terminate(&self) {
        self.state.kill_requested.store(true, Ordering::SeqCst);
        (self.terminator)();
        kill_process_tree(self.pid);
    }

    /// 快照档：(status 字符串, 退出码, 是否被终止)
    pub(super) fn snapshot(&self) -> (&'static str, Option<i32>, bool) {
        let status = self.state.status.lock().unwrap();
        match &*status {
            Status::Running => (super::common::status::RUNNING, None, false),
            Status::Exited { code, killed } => (super::common::status::EXITED, *code, *killed),
        }
    }

    /// 进程是否还活着
    pub(super) fn is_running(&self) -> bool {
        matches!(&*self.state.status.lock().unwrap(), Status::Running)
    }

    /// 未读字符数（stdout + stderr）—— 让模型知道「还有没看过的输出」。
    pub(super) fn unread(&self) -> u64 {
        self.state.stdout.lock().unwrap().unread() + self.state.stderr.lock().unwrap().unread()
    }

    /// 按模式取输出：`(stdout, stderr, 是否因环形丢弃而缺了开头)`。
    ///
    /// - `New`（默认）：自上次读取以来的新内容，**推进已读游标**（唯一会消费的模式）；
    /// - `Tail(n)`：两个流各取末尾 n 行，不动游标；
    /// - `All`：两个流的完整窗口（受环形容量限制），不动游标。
    pub(super) fn read_output(&self, mode: &super::common::ReadMode) -> (String, String, bool) {
        use super::common::ReadMode;
        match mode {
            ReadMode::New => {
                let (out, dropped_out) = self.state.stdout.lock().unwrap().read_new();
                let (err, dropped_err) = self.state.stderr.lock().unwrap().read_new();
                (out, err, dropped_out || dropped_err)
            }
            ReadMode::Tail(n) => {
                let stdout = self.state.stdout.lock().unwrap();
                let stderr = self.state.stderr.lock().unwrap();
                (
                    super::common::tail_lines(stdout.window(), *n).to_string(),
                    super::common::tail_lines(stderr.window(), *n).to_string(),
                    false,
                )
            }
            ReadMode::All => {
                let stdout = self.state.stdout.lock().unwrap();
                let stderr = self.state.stderr.lock().unwrap();
                (stdout.window().to_string(), stderr.window().to_string(), false)
            }
        }
    }
}

// ==================== 服务运行态 ====================

/// 一个服务的共享运行态（读任务、等待任务、工具三边并发访问）。
pub(crate) struct ServiceState {
    pub(super) status: Mutex<Status>,
    /// stdout 输出窗口（环形，带「已读游标」）
    pub(super) stdout: Mutex<LogBuffer>,
    /// stderr 输出窗口
    pub(super) stderr: Mutex<LogBuffer>,
    /// **合并流**（终端弹窗的数据源，P3）：原样按到达顺序收下每个块 ——
    /// PTY 下它就是那条唯一的控制台流（stdout 窗口与它同源），管道下是 stdout / stderr 的时间顺序合并。
    /// 只读（不消费已读游标），与模型的「增量读」互不影响。
    pub(super) console: Mutex<LogBuffer>,
    /// 交互控制台（伪控制台）：`None` = 没有（非 Windows / 伪控制台不可用 / 已关闭）。
    pty: Mutex<Option<Arc<ServicePty>>>,
    /// 该服务是否**（曾）跑在伪控制台里**（`attach_pty` 置位后不再复位）。
    ///
    /// 与 [`Self::has_pty`]（当前有没有活控制台）是两件事：`ClosePseudoConsole` 会终止附着进程，
    /// 所以进程一退出控制台就被关掉 —— 只问「现在有没有控制台」会把**已结束的终端服务**
    /// 误判成「管道模式」（P3 实测到的显示 bug：Ctrl+C 结束服务后弹窗提示「当前平台不支持交互终端」）。
    had_pty: AtomicBool,
    /// 是否被显式终止过（工具 kill / 会话结束 / 应用退出 / 前端「终止」按钮）
    pub(super) kill_requested: AtomicBool,
    /// **不发「服务结束」通知**（见 `notice.rs`）：AI 自己 kill / 会话删除 / 应用退出 / 引擎销毁 ——
    /// 这些场景「服务结束」这件事已经有别的交代，再插一条消息只会是噪音。
    notice_muted: AtomicBool,
    /// 启动等待窗口是否还开着（`start_background_service` 返回前恒为 `true`）。
    ///
    /// 窗口内就退出的服务，工具结果已经写清「已退出 + 退出码 + 输出」→ 不再另发通知；
    /// 工具返回后才退出的才通知（这才是「AI 以为它在跑、其实已经死了」的那一类）。
    startup_window: AtomicBool,
    /// 状态或输出发生变化 —— 等待方（工具的等待窗口 / `waitFor`）据此醒来
    pub(super) notify: Notify,
    /// 实时输出通道：仅**工具调用进行中**时存在（工具把它挂进 `agent:tool-output` 事件，
    /// 工具返回后置空 —— 之后的输出只进缓冲区，不再往已完成的气泡里推）。
    pub(super) live: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(bool, String)>>>,
}

impl ServiceState {
    pub(super) fn new() -> Self {
        Self {
            status: Mutex::new(Status::Running),
            stdout: Mutex::new(LogBuffer::new()),
            stderr: Mutex::new(LogBuffer::new()),
            console: Mutex::new(LogBuffer::new()),
            pty: Mutex::new(None),
            had_pty: AtomicBool::new(false),
            kill_requested: AtomicBool::new(false),
            notice_muted: AtomicBool::new(false),
            startup_window: AtomicBool::new(true),
            notify: Notify::new(),
            live: Mutex::new(None),
        }
    }

    /// 抑制「服务结束」通知（幂等）：AI 自己 kill / 会话删除 / 应用退出 / 引擎销毁时调用。
    pub(super) fn mute_notice(&self) {
        self.notice_muted.store(true, Ordering::SeqCst);
    }

    /// 通知是否被抑制
    pub(super) fn notice_muted(&self) -> bool {
        self.notice_muted.load(Ordering::SeqCst)
    }

    /// 关闭「启动等待窗口」（`start_background_service` 的等待窗口结束时调用；幂等）。
    pub(super) fn close_startup_window(&self) {
        self.startup_window.store(false, Ordering::SeqCst);
    }

    /// 启动等待窗口是否还开着（开着时进程退出由 start 工具的结果交代，不另发通知）
    pub(super) fn startup_window(&self) -> bool {
        self.startup_window.load(Ordering::SeqCst)
    }

    /// 挂上交互控制台（`runner::supervise` 在 spawn 成功后立即调用）。
    pub(super) fn attach_pty(&self, pty: Arc<ServicePty>) {
        *self.pty.lock().unwrap() = Some(pty);
        // 置位即「定性」：这个服务是终端服务 —— 之后控制台被关掉也不再改回来。
        self.had_pty.store(true, Ordering::SeqCst);
    }

    /// 取交互控制台（`None` = 这个服务没有控制台 / 已关闭）。
    pub(super) fn pty(&self) -> Option<Arc<ServicePty>> {
        self.pty.lock().unwrap().clone()
    }

    /// 当前是否有**活**控制台（`close_pty` 之后变 `false`）。「现在往里写能不能成功」看它。
    pub(super) fn has_pty(&self) -> bool {
        self.pty.lock().unwrap().is_some()
    }

    /// 该服务是否**（曾）跑在伪控制台里** —— 进程退出、控制台关闭后仍为 `true`。
    ///
    /// 面板 / 弹窗用它把两种「不能输入」分开：`true` = 终端服务（已结束只能回放），
    /// `false` = 管道模式（本次运行就没有交互终端）。`close_pty` **不复位**它。
    pub(super) fn pty_capable(&self) -> bool {
        self.had_pty.load(Ordering::SeqCst)
    }

    /// 关闭控制台（进程退出后调用）：关 `HPCON` 让读任务收到 EOF，并释放输入写端。
    /// 幂等；关掉之后 `pty()` 回 `None`（前端据此禁用输入），但 `pty_capable()` 仍为 `true`
    ///（「它曾是终端服务」是持久事实，见该字段的注释）。
    pub(super) fn close_pty(&self) {
        let taken = self.pty.lock().unwrap().take();
        if let Some(pty) = taken {
            pty.close();
        }
    }

    /// 追加一段输出（读任务调用）：入窗口 + 唤醒等待方 + 尽力转发实时通道。
    ///
    /// `is_stderr` 决定进哪个窗口（两个流分开存：与 `execute_command` 的 `[stderr]` 分段同形，
    /// 合并成一条会丢掉「这行是错误」的信息）。
    pub(super) fn push_output(&self, is_stderr: bool, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        {
            let mut buf = if is_stderr {
                self.stderr.lock().unwrap()
            } else {
                self.stdout.lock().unwrap()
            };
            buf.push(chunk);
        }
        // 合并流（终端弹窗的数据源）：两个流按到达顺序落进同一条带偏移的窗口
        self.console.lock().unwrap().push(chunk);
        // 实时通道：工具调用进行中才有人接（send 失败 = 已结束，忽略即可）
        if let Some(tx) = self.live.lock().unwrap().as_ref() {
            let _ = tx.send((is_stderr, chunk.to_string()));
        }
        self.notify.notify_waiters();
    }

    /// 落定终态（等待任务调用）。
    pub(super) fn finish(&self, code: Option<i32>, killed: bool) {
        *self.status.lock().unwrap() = Status::Exited { code, killed };
        self.notify.notify_waiters();
    }

    /// 等待进入终态（`timeout_ms` 内）；返回是否已结束。
    ///
    /// 用「轮询 + 通知」而不是单次 `notified()`：`Notify` 只唤醒**已注册**的等待方，
    /// 若通知恰好发在「检查状态」与「注册」之间，单靠它就会漏到超时（进程明明已退出却说还在跑）。
    pub(super) async fn wait_finished(&self, timeout_ms: i64) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.max(0) as u64);
        loop {
            if !self.is_running() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return !self.is_running();
            }
            tokio::select! {
                _ = self.notify.notified() => {}
                _ = tokio::time::sleep(super::runner::STATUS_TICK) => {}
            }
        }
    }

    /// 是否仍在运行
    pub(super) fn is_running(&self) -> bool {
        matches!(&*self.status.lock().unwrap(), Status::Running)
    }
}

// ==================== 输出窗口 ====================

/// 带「已读游标」的环形输出窗口（按**字符**计数，中文安全）。
pub(crate) struct LogBuffer {
    /// 尾部窗口正文
    text: String,
    /// `text` 的字符数（避免每次 `chars().count()`）
    chars: usize,
    /// 累计写入的字符总数（绝对偏移）；窗口起点 = `total - chars`
    total: u64,
    /// 已读到的绝对偏移（`mode="new"` 才推进；`tail` / `all` 只看不消费）
    read_cursor: u64,
}

impl LogBuffer {
    pub(super) fn new() -> Self {
        Self {
            text: String::new(),
            chars: 0,
            total: 0,
            read_cursor: 0,
        }
    }

    pub(super) fn push(&mut self, chunk: &str) {
        let n = chunk.chars().count();
        self.text.push_str(chunk);
        self.chars += n;
        self.total += n as u64;
        if self.chars > STREAM_CAP_CHARS {
            let cut = self.chars - STREAM_CAP_CHARS;
            let idx = char_index(&self.text, cut);
            self.text.drain(..idx);
            self.chars -= cut;
        }
    }

    /// 窗口正文（不消费游标）
    pub(super) fn window(&self) -> &str {
        &self.text
    }

    /// 未读字符数
    pub(super) fn unread(&self) -> u64 {
        self.total - self.read_cursor
    }

    /// 取「自上次读取以来的新内容」并推进游标；返回 `(内容, 是否因环形丢弃而缺了开头)`。
    pub(super) fn read_new(&mut self) -> (String, bool) {
        let window_start = self.total - self.chars as u64;
        let truncated = self.read_cursor < window_start;
        let start = self.read_cursor.max(window_start);
        let from = (start - window_start) as usize;
        let out = slice_from_char(&self.text, from).to_string();
        self.read_cursor = self.total;
        (out, truncated)
    }

    /// 自**绝对偏移** `from` 起取窗口内容（**不消费已读游标** —— 终端弹窗专用，P3）。
    ///
    /// 返回 `(文本, 是否整段重放, 最新绝对偏移, 窗口是否已丢掉开头)`：
    /// - `from` 落在窗口之前（首次读取传 0、或环形已把客户端持有的那截丢掉）→ `reset=true` +
    ///   整个窗口，客户端据此**整段重放**（终端的转义序列必须从完整的一段开始，不能接半截）；
    /// - 否则只回新增部分，客户端按偏移续接。
    pub(super) fn read_from(&self, from: u64) -> (String, bool, u64, bool) {
        let window_start = self.total - self.chars as u64;
        let head_dropped = window_start > 0;
        if from < window_start {
            return (self.text.clone(), true, self.total, head_dropped);
        }
        let offset = (from - window_start) as usize;
        (
            slice_from_char(&self.text, offset).to_string(),
            false,
            self.total,
            head_dropped,
        )
    }
}

// ==================== 全局注册表 ====================

/// 服务条目表：服务 id → 条目。id 全局唯一；**会话隔离靠条目里的 `session_id`**。
static SERVICES: LazyLock<Mutex<HashMap<String, Arc<ServiceEntry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 服务 id 计数（`svc_1` / `svc_2` …；模型与用户都读得懂，且不泄露任何路径/命令信息）。
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 生成一个新服务 id。
pub(super) fn next_id() -> String {
    format!("svc_{}", NEXT_ID.fetch_add(1, Ordering::SeqCst))
}

/// 容量检查（**spawn 之前**调用，避免起完才发现放不下）。
///
/// 规则：先清本会话里已结束的条目（它们只是留给 AI 读收尾输出的，读不完也不该挡住新服务），
/// 再按「本会话上限 / 全局上限」拒绝。返回的错误文案给模型看（英文，含怎么办）。
pub(super) fn ensure_capacity(session_id: &str) -> Result<(), String> {
    let mut map = SERVICES.lock().unwrap();
    let finished: Vec<String> = map
        .values()
        .filter(|e| e.session_id == session_id && !e.is_running())
        .map(|e| e.id.clone())
        .collect();
    for id in finished {
        map.remove(&id);
    }
    let session_count = map.values().filter(|e| e.session_id == session_id).count();
    if session_count >= super::common::MAX_SERVICES_PER_SESSION {
        return Err(format!(
            "This conversation already has {session_count} background services running (limit {}). \
             Stop one first with kill_background_service (list_background_services shows the ids).",
            super::common::MAX_SERVICES_PER_SESSION
        ));
    }
    if map.len() >= super::common::MAX_SERVICES_TOTAL {
        return Err(format!(
            "Too many background services across all conversations (limit {}). \
             Stop some first with kill_background_service.",
            super::common::MAX_SERVICES_TOTAL
        ));
    }
    Ok(())
}

/// 本会话内是否已有同名**存活**服务（防「AI 反复起同一个 dev server」抢端口）。
pub(super) fn find_running_by_name(session_id: &str, name: &str) -> Option<Arc<ServiceEntry>> {
    SERVICES
        .lock()
        .unwrap()
        .values()
        .find(|e| e.session_id == session_id && e.name == name && e.is_running())
        .cloned()
}

/// 登记一个服务条目。
pub(super) fn insert(entry: Arc<ServiceEntry>) {
    SERVICES
        .lock()
        .unwrap()
        .insert(entry.id.clone(), entry);
}

/// 按 id 取本会话的服务（跨会话 / 不存在 → `None`）。
pub(super) fn get(session_id: &str, id: &str) -> Option<Arc<ServiceEntry>> {
    SERVICES
        .lock()
        .unwrap()
        .get(id)
        .filter(|e| e.session_id == session_id)
        .cloned()
}

/// 列出本会话的服务（按启动时间升序 —— 与创建顺序一致，便于「第几个」的口径）。
pub(super) fn list(session_id: &str) -> Vec<Arc<ServiceEntry>> {
    let mut out: Vec<Arc<ServiceEntry>> = SERVICES
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.session_id == session_id)
        .cloned()
        .collect();
    out.sort_by_key(|e| e.started_at);
    out
}

/// 列出**所有会话**的服务（按启动时间升序）—— 聊天页处于「新对话」（未选中会话）时的全局面板用。
///
/// ⚠️ 只服务**界面**（`panel::list_all_service_snapshots`）：模型侧四个工具依旧严格按会话隔离 ——
/// 用户在自己的界面上看得见自家所有服务，模型不行，那层边界不因为这里放开而放宽。
pub(super) fn list_all() -> Vec<Arc<ServiceEntry>> {
    let mut out: Vec<Arc<ServiceEntry>> = SERVICES.lock().unwrap().values().cloned().collect();
    out.sort_by_key(|e| e.started_at);
    out
}

/// 移除一个条目（只做登记表清理；杀进程由 [`ServiceEntry::terminate`] 负责）。
pub(super) fn remove(id: &str) {
    SERVICES.lock().unwrap().remove(id);
}

/// 终止某会话的全部服务并清表（**会话删除**时调用）。返回终止的条目数。
pub fn kill_session_services(session_id: &str) -> usize {
    let entries: Vec<Arc<ServiceEntry>> = {
        let mut map = SERVICES.lock().unwrap();
        let ids: Vec<String> = map
            .values()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.id.clone())
            .collect();
        ids.into_iter().filter_map(|id| map.remove(&id)).collect()
    };
    let n = entries.len();
    for e in entries {
        // 会话删除：整批收摊 —— 通知没有落点（会话都没了），全部抑制
        e.state.mute_notice();
        if e.is_running() {
            e.terminate();
        }
    }
    super::notice::drop_session(session_id);
    n
}

/// 终止全部会话的服务并清表（**应用退出 / 引擎销毁 / CLI 结束**时调用）。返回终止的条目数。
pub fn kill_all_services() -> usize {
    let entries: Vec<Arc<ServiceEntry>> = {
        let mut map = SERVICES.lock().unwrap();
        std::mem::take(&mut *map).into_values().collect()
    };
    let n = entries.len();
    for e in entries {
        // 应用退出 / 引擎销毁：没人会收到通知 → 全部抑制
        e.state.mute_notice();
        if e.is_running() {
            e.terminate();
        }
    }
    super::notice::clear_all();
    n
}

/// 会话内服务条数（测试 / 诊断用）。
#[cfg(test)]
pub(super) fn session_count(session_id: &str) -> usize {
    SERVICES
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.session_id == session_id)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_buffer_tracks_delta_and_drops_oldest() {
        let mut buf = LogBuffer::new();
        buf.push("第一行\n");
        buf.push("第二行\n");
        assert_eq!(buf.unread(), 8);

        let (new, truncated) = buf.read_new();
        assert_eq!(new, "第一行\n第二行\n");
        assert!(!truncated);
        assert_eq!(buf.unread(), 0);

        // 再读 → 空（增量语义）
        let (new, _) = buf.read_new();
        assert!(new.is_empty());

        // 窗口装得下的追加：只回新内容，不报截断
        let half = "x".repeat(STREAM_CAP_CHARS / 2);
        buf.push(&half);
        let (new, truncated) = buf.read_new();
        assert!(!truncated, "游标还在窗口内时不该报截断");
        assert_eq!(new.chars().count(), STREAM_CAP_CHARS / 2);
        assert_eq!(buf.unread(), 0);

        // 一次写入超过容量上限 → 窗口只剩末尾，游标落到窗口之前 → 必须如实标注截断
        let big = "y".repeat(STREAM_CAP_CHARS + 100);
        buf.push(&big);
        assert_eq!(buf.window().chars().count(), STREAM_CAP_CHARS);
        let (new, truncated) = buf.read_new();
        assert!(truncated, "窗口外的未读内容已被丢弃 → 必须标注");
        assert_eq!(new.chars().count(), STREAM_CAP_CHARS);
        assert_eq!(buf.unread(), 0);
    }

    #[test]
    fn log_buffer_reports_truncation_when_cursor_falls_behind() {
        let mut buf = LogBuffer::new();
        buf.push("old");
        let big = "x".repeat(STREAM_CAP_CHARS + 10);
        buf.push(&big);
        let (new, truncated) = buf.read_new();
        assert!(truncated, "窗口外的未读内容已被丢弃 → 必须如实标注");
        assert_eq!(buf.unread(), 0);
        assert!(buf.read_new().0.is_empty());
        let _ = new;
    }

    #[test]
    fn entry_terminate_is_idempotent_and_marks_kill() {
        let killed = Arc::new(AtomicBool::new(false));
        let k2 = killed.clone();
        let state = Arc::new(ServiceState::new());
        let entry = ServiceEntry::new(
            "svc_t".into(),
            "s1".into(),
            "n".into(),
            "cmd".into(),
            0, // pid=0 → kill_process_tree 直接 return（测试不真的杀进程）
            0,
            "no_sandbox".into(),
            state.clone(),
            Arc::new(move || {
                k2.store(true, Ordering::SeqCst);
            }),
        );
        entry.terminate();
        assert!(killed.load(Ordering::SeqCst));
        assert!(state.kill_requested.load(Ordering::SeqCst));
        entry.terminate();
    }

    #[test]
    fn registry_is_session_scoped() {
        let state = Arc::new(ServiceState::new());
        let entry = Arc::new(ServiceEntry::new(
            "svc_scope".into(),
            "s_a".into(),
            "n".into(),
            "cmd".into(),
            0,
            0,
            "no_sandbox".into(),
            state,
            Arc::new(|| {}),
        ));
        insert(entry);
        assert!(get("s_a", "svc_scope").is_some());
        assert!(get("s_b", "svc_scope").is_none(), "跨会话不可见");
        assert!(list("s_b").is_empty());
        assert_eq!(session_count("s_a"), 1);
        remove("svc_scope");
        assert!(get("s_a", "svc_scope").is_none());
    }

    /// 终端弹窗的读协议（P3）：按**绝对偏移**续接、环形丢弃后要求整段重放，且**不消费已读游标**。
    #[test]
    fn log_buffer_read_from_is_offset_based_and_leaves_the_cursor_alone() {
        let mut buf = LogBuffer::new();
        buf.push("abc");
        // 首次读取（客户端偏移 0）：整个窗口，无需 reset（客户端本地也是空的，直接接上）
        let (text, reset, next, head) = buf.read_from(0);
        assert_eq!((text.as_str(), reset, next, head), ("abc", false, 3, false));

        // 续接：客户端已持有 3 个字符 → 只回新增部分
        buf.push("de");
        let (text, reset, next, _) = buf.read_from(3);
        assert_eq!((text.as_str(), reset, next), ("de", false, 5));
        // 偏移已在末尾 → 空增量，并且**不消费已读游标**（模型侧仍看到未读）
        let (text, _, _, _) = buf.read_from(5);
        assert_eq!(text, "");
        assert_eq!(buf.unread(), 5, "终端弹窗的读不得推进模型侧的已读游标");

        // 环形丢弃开头 → 客户端偏移落在窗口之前 → reset=true + 整个窗口（只能整段重放）
        let big = "x".repeat(STREAM_CAP_CHARS + 10);
        buf.push(&big);
        let (text, reset, next, head) = buf.read_from(3);
        assert!(reset, "偏移落在窗口之前必须要求整段重放");
        assert!(head, "窗口开头已被丢弃要如实上报");
        assert_eq!(text.chars().count(), STREAM_CAP_CHARS);
        assert_eq!(next, 5 + STREAM_CAP_CHARS as u64 + 10);
        assert_eq!(buf.unread(), 5 + STREAM_CAP_CHARS as u64 + 10);
    }

    /// 合并流（终端弹窗的数据源）：两个流按到达顺序落进同一条窗口；没有控制台时写 / 尺寸一律拒绝。
    #[test]
    fn service_state_feeds_the_console_stream_and_refuses_without_a_pty() {
        let state = ServiceState::new();
        state.push_output(false, "out");
        state.push_output(true, "err");
        let (text, reset, next, _) = state.console.lock().unwrap().read_from(0);
        assert_eq!((text.as_str(), reset, next), ("outerr", false, 6));
        // 分窗口仍然各管各的（模型侧 `[stderr]` 分段靠它）
        assert!(state.stderr.lock().unwrap().window().contains("err"));
        assert!(!state.stdout.lock().unwrap().window().contains("err"));
        // 管道模式：没有控制台 → 没有可交互的东西（关闭也是幂等的 no-op）
        assert!(!state.has_pty());
        assert!(!state.pty_capable());
        assert!(state.pty().is_none());
        state.close_pty();

        // 「（曾）是终端服务」是**持久事实**（P3 显示 bug 的回归）：控制台随进程退出被关掉之后
        // 不得复位 —— 否则界面会把「已结束的终端服务」误报成「管道模式（平台不支持交互）」。
        // 真实的 attach 由 Windows 端到端测试覆盖；这里直接置位模拟。
        state.had_pty.store(true, Ordering::SeqCst);
        assert!(state.pty_capable());
        state.close_pty();
        assert!(state.pty_capable(), "控制台关闭后仍应记得它曾是终端服务");
        assert!(!state.has_pty(), "关闭后就没有活控制台了");
        // 合并流的读取不影响模型侧增量读
        let (new, _) = state.stdout.lock().unwrap().read_new();
        assert_eq!(new, "out");
    }
}
