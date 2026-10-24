//! user_shell — **用户亲手敲的交互终端**（右侧面板的「新建终端」）。
//!
//! 与 `service` 分类的关系：**同一个底层（ConPTY + 同一个句柄类型），不同的归属与语义**。
//!
//! | | 后台服务（`service`） | 用户终端（本模块） |
//! |---|---|---|
//! | 谁在敲 | AI 起命令，用户偶尔接管 | 用户从第一秒起就是操作者 |
//! | 沙盒 | 默认走沙盒（与 `execute_command` 同一条链） | **默认脱壳**（用户亲手敲，与 VS Code 终端一致） |
//! | 身份 | 服务 id（AI 也看得见） | 终端 id（**只给界面**，不进模型上下文） |
//! | 结束 | 发「服务结束」通知给 AI | 不发任何通知（用户自己看着） |
//! | 寿命 | 工具返回后继续活着 | 标签关掉即终止（`kill` 顺手摘条目） |
//!
//! 三条必须守住的：
//! 1. **默认脱壳是一份显式决策**（产品口径）：用户敲的 `npm install` / `git commit` 必须能跑，
//!    所以这里**不**复用 `prepare_sandbox_session`；界面上用「沙盒：关闭」徽标如实标注，
//!    与「AI 执行一定要过沙盒」是两套语义，不能混。
//! 2. **终端 id 不进模型上下文**：它只服务界面（读写 / 尺寸 / 关闭），
//!    因此也不做成原生工具 —— 模型没有入口去操作用户的终端。
//! 3. **关停顺序**：进程真退出 → 落终态 → 关伪控制台（`ClosePseudoConsole` 会终止附着进程树，
//!    提前关等于把还在跑的 `dev server` 杀了）。与 `service/runner.rs::supervise` 同一条。
//!
//! 平台：**只在 Windows 上有交互终端**（ConPTY）。其他平台 `spawn` 直接如实报错 ——
//! 不假装能用，也不退化成「只能看不能敲」的管道 shell（那会让人以为终端坏了）。
//!
//! ## 输出是**推**的，不是轮询出来的
//!
//! 轮询的间隔就是**键入回显的延迟**：ConPTY 把用户输入回显进输出流，而前端只在
//! `read_terminal` 那一跳才看得见 —— 350ms 的轮询意味着「敲一下等一帧」，终端因此不像终端。
//! 所以这里多一条常驻推送任务（[`spawn_pusher`]）：输出一到就发一帧（带 `[from, next)` 绝对偏移，
//! 16ms 前沿节流合并突发），宿主出口由 GUI 注入（[`TerminalOutputHost`]，与 `service::notice`
//! 同一种写法，core 零 `tauri::`）。
//!
//! 续接语议仍然只有一份：客户端发现偏移断档时照旧用 `read_terminal(from)` 补读，
//! 推送只是把「等下一次轮询」变成「立刻」。headless（CLI）不挂出口 → 连推送任务都不起，零开销。

// 非 Windows：没有 ConPTY，`spawn` 恒失败 —— `Spawned` 里的管道 / 等待闭包只被 Windows 路径
// 构造，整模块开 allow(dead_code)（与 `execute/pty_session.rs` 同一处理）。
// ⚠️ 内部属性必须写在**任何 item 之前**（下面两个 `mod` 也算）。
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

mod panel;
mod shells;
mod spawn;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::Notify;

use super::execute::common::{kill_process_tree, Terminator};
use super::service::{LogBuffer, ServicePty};

pub use panel::{
    kill_terminal, list_shells, list_terminals, read_terminal, resize_terminal, start_terminal,
    write_terminal,
};
pub use shells::{ShellInfo, ShellKind};

/// 单个会话内最多同时存在的终端数（含已结束、还没被关掉的）。
///
/// 比服务的 8 略高：终端是用户自己开的，关标签的动作很直观；但仍要有上限，
/// 免得「点了一百次 Ctrl+`」变成一百个 ConPTY。
const MAX_TERMINALS_PER_SESSION: usize = 8;
/// 全局上限（多会话叠加）：与服务的 32 同一量级，防呆用。
const MAX_TERMINALS_TOTAL: usize = 32;

/// 两次推送之间至少隔这么久（ms）：同一帧里的多个读块一起发，`cat` 大文件不会把 WebView 灌爆。
/// **首块不受这个闸门限制**（距上次推送已超过这么久），所以键入回显仍是「立刻」。
const PUSH_GAP_MS: u64 = 16;

// ==================== 输出推送出口 ====================

/// 一段待推送的终端输出（绝对偏移区间 `[from, next)`）。
///
/// `reset = true` 表示 `from` 已落在环形窗口之外（客户端持有的开头被丢了）：
/// `text` 是**整个窗口**，客户端必须丢掉本地内容整段重放 —— 与 `read_terminal` 的 `reset` 同义。
pub struct ConsoleDelta {
    /// 这段之前的绝对偏移
    pub from: u64,
    /// 这段之后的绝对偏移（客户端据此续接）
    pub next: u64,
    /// 增量正文（`reset` 时是整窗）
    pub text: String,
    /// 客户端需要整段重放
    pub reset: bool,
    /// 此刻 shell 是否还在跑（**终态也走这条推送**，前端不必等下一次轮询才发现退出）
    pub running: bool,
}

/// 输出推送出口（由宿主注入；core 零 `tauri::`）。
///
/// 实现必须是**非阻塞**的：它在推送任务（tokio）里被调用，每帧一次。
pub trait TerminalOutputHost: Send + Sync {
    /// 推送一段新输出。`session_id` / `id` 是归属键（多终端并行，前端按它过滤）。
    fn push_terminal_output(&self, session_id: &str, id: &str, delta: &ConsoleDelta);
}

/// 宿主出口（进程内唯一；未挂载 = headless，读取仍走 `read_terminal` 轮询）。
/// 用 `Mutex<Option<..>>` 而非 `OnceLock`：换 / 卸都要能做（测试与将来多窗口）。
static HOST: LazyLock<Mutex<Option<Arc<dyn TerminalOutputHost>>>> =
    LazyLock::new(|| Mutex::new(None));

/// 挂上输出推送出口（GUI 在引擎初始化时调一次）。重复挂载以最后一次为准。
pub fn attach_output_host(host: Arc<dyn TerminalOutputHost>) {
    *HOST.lock().unwrap() = Some(host);
}

/// 当前宿主出口（未挂载 → `None`）
fn output_host() -> Option<Arc<dyn TerminalOutputHost>> {
    HOST.lock().unwrap().clone()
}

// ==================== 状态 ====================

/// 终端运行态。
#[derive(Debug, Clone)]
pub(crate) enum Status {
    /// 存活
    Running,
    /// 已结束：`code` 为退出码（取不到时为 `None`）；`killed` 区分「自己 exit」与「被关掉」
    Exited { code: Option<i32>, killed: bool },
}

/// 一个终端的共享运行态（读任务、等待任务、命令层三边并发访问）。
pub(crate) struct ShellState {
    status: Mutex<Status>,
    /// 唯一的输出流（ConPTY 下 stdout / stderr 已合并，只有这一条）
    console: Mutex<LogBuffer>,
    /// 伪控制台句柄：`None` = 已关闭 / 从未拿到。**它还在 = 附着进程还活着**。
    pty: Mutex<Option<Arc<ServicePty>>>,
    /// 是否被显式关掉过（`kill` 前落位，供等待任务区分「自己退出」与「被终止」）
    kill_requested: AtomicBool,
    /// 状态或输出发生变化 —— 读取方（测试 / 未来的 `waitFor`）据此醒来
    notify: Notify,
    /// 「有新输出 / 落了终态 / 读任务收尾」—— **推送任务**据此醒来。
    /// 用 `notify_one`（而不是 `notify_waiters`）：permit 会存住，不怕「通知发在 await 之前」。
    dirty: Notify,
    /// 读任务已读到 EOF 并把尾巴推完 —— 推送任务据此退出（否则会永远等下一个通知）。
    reader_done: AtomicBool,
}

impl ShellState {
    fn new() -> Self {
        Self {
            status: Mutex::new(Status::Running),
            console: Mutex::new(LogBuffer::new()),
            pty: Mutex::new(None),
            kill_requested: AtomicBool::new(false),
            notify: Notify::new(),
            dirty: Notify::new(),
            reader_done: AtomicBool::new(false),
        }
    }

    /// 挂上交互控制台（`supervise` 在 spawn 成功后立即调用）。
    fn attach_pty(&self, pty: Arc<ServicePty>) {
        *self.pty.lock().unwrap() = Some(pty);
    }

    /// 取交互控制台（`None` = 没有 / 已关闭）。
    fn pty(&self) -> Option<Arc<ServicePty>> {
        self.pty.lock().unwrap().clone()
    }

    /// 追加一段输出（读任务调用）。
    fn push_output(&self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        self.console.lock().unwrap().push(chunk);
        self.notify.notify_waiters();
        self.dirty.notify_one();
    }

    /// 落定终态（等待任务调用）。
    fn finish(&self, code: Option<i32>, killed: bool) {
        *self.status.lock().unwrap() = Status::Exited { code, killed };
        self.notify.notify_waiters();
        // 终态也走推送：前端不必等到下一次轮询才知道 shell 退了
        self.dirty.notify_one();
    }

    /// 关闭控制台（**只能在进程真退出之后调用**）。
    fn close_pty(&self) {
        let taken = self.pty.lock().unwrap().take();
        if let Some(pty) = taken {
            pty.close();
        }
    }

    fn is_running(&self) -> bool {
        matches!(&*self.status.lock().unwrap(), Status::Running)
    }

    /// `(状态串, 退出码, 是否被终止)` —— 状态串与服务的 `running` / `exited` 同词表。
    fn snapshot(&self) -> (&'static str, Option<i32>, bool) {
        match &*self.status.lock().unwrap() {
            Status::Running => ("running", None, false),
            Status::Exited { code, killed } => ("exited", *code, *killed),
        }
    }
}

/// 一个终端条目。
pub(crate) struct ShellEntry {
    pub(crate) id: String,
    pub(crate) session_id: String,
    /// 实际使用的 shell 类型 id（`powershell` / `cmd` / `pwsh` / `gitbash`，见 [`ShellKind`]）
    pub(crate) shell: String,
    /// 工作目录（会话工作区；纯展示 + 诊断）
    pub(crate) cwd: String,
    pub(crate) pid: u32,
    pub(crate) started_at: i64,
    pub(crate) state: Arc<ShellState>,
    /// 终止器 —— 同时**持有**裸跑路径的 Job（带 `KILL_ON_JOB_CLOSE`）：
    /// 条目被摘掉时即连带杀树，应用崩溃也不会留孤儿 shell。
    terminator: Terminator,
}

impl ShellEntry {
    #[allow(clippy::too_many_arguments)]
    fn new(
        id: String,
        session_id: String,
        shell: String,
        cwd: String,
        pid: u32,
        started_at: i64,
        state: Arc<ShellState>,
        terminator: Terminator,
    ) -> Self {
        Self {
            id,
            session_id,
            shell,
            cwd,
            pid,
            started_at,
            state,
            terminator,
        }
    }

    /// 终止整棵进程树（幂等）。**只发信号**：状态由常驻等待任务在进程真退出时落定。
    fn terminate(&self) {
        self.state.kill_requested.store(true, Ordering::SeqCst);
        (self.terminator)();
        kill_process_tree(self.pid);
    }

    fn is_running(&self) -> bool {
        self.state.is_running()
    }
}

// ==================== 注册表 ====================

/// 终端表：终端 id → 条目。id 全局唯一；**会话隔离靠条目里的 `session_id`**。
static SHELLS: LazyLock<Mutex<HashMap<String, Arc<ShellEntry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 终端 id 计数（`term_1` / `term_2` …；只给人看，不编进任何路径）。
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> String {
    format!("term_{}", NEXT_ID.fetch_add(1, Ordering::SeqCst))
}

/// 容量检查（**spawn 之前**调用，避免起完才发现放不下）。
///
/// 先摘本会话里已结束的条目（它们只是留给用户看的最后一屏），再按会话 / 全局上限拒绝。
fn ensure_capacity(session_id: &str) -> Result<(), String> {
    let mut map = SHELLS.lock().unwrap();
    let finished: Vec<String> = map
        .values()
        .filter(|e| e.session_id == session_id && !e.is_running())
        .map(|e| e.id.clone())
        .collect();
    for id in finished {
        map.remove(&id);
    }
    let session_count = map.values().filter(|e| e.session_id == session_id).count();
    if session_count >= MAX_TERMINALS_PER_SESSION {
        return Err(format!(
            "这个会话已经开了 {session_count} 个终端（上限 {MAX_TERMINALS_PER_SESSION}）。先关掉不用的终端再开新的。"
        ));
    }
    if map.len() >= MAX_TERMINALS_TOTAL {
        return Err(format!(
            "所有会话加起来已经有 {} 个终端（上限 {MAX_TERMINALS_TOTAL}）。先关掉不用的终端。",
            map.len()
        ));
    }
    Ok(())
}

fn insert(entry: Arc<ShellEntry>) {
    SHELLS.lock().unwrap().insert(entry.id.clone(), entry);
}

/// 按 id 取本会话的终端（跨会话 / 不存在 → `None`）。
fn get(session_id: &str, id: &str) -> Option<Arc<ShellEntry>> {
    SHELLS
        .lock()
        .unwrap()
        .get(id)
        .filter(|e| e.session_id == session_id)
        .cloned()
}

/// 列出本会话的终端（按启动时间升序）。
fn list(session_id: &str) -> Vec<Arc<ShellEntry>> {
    let mut out: Vec<Arc<ShellEntry>> = SHELLS
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.session_id == session_id)
        .cloned()
        .collect();
    out.sort_by_key(|e| e.started_at);
    out
}

/// 移除一个条目（登记表清理；杀进程由 [`ShellEntry::terminate`] 负责）。
///
/// ⚠️ 摘掉条目 = 放下 `Terminator` = 关闭那个带 `KILL_ON_JOB_CLOSE` 的 Job：
/// 即使调用方忘了 `terminate`，进程树也会跟着结束（这正是「关标签 = 关终端」的兜底）。
fn remove(id: &str) {
    SHELLS.lock().unwrap().remove(id);
}

/// 终止某会话的全部终端并清表（**会话删除**时调用）。返回处理的条目数。
pub fn kill_session_shells(session_id: &str) -> usize {
    let entries: Vec<Arc<ShellEntry>> = {
        let mut map = SHELLS.lock().unwrap();
        let ids: Vec<String> = map
            .values()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.id.clone())
            .collect();
        ids.into_iter().filter_map(|id| map.remove(&id)).collect()
    };
    let n = entries.len();
    for e in entries {
        if e.is_running() {
            e.terminate();
        }
    }
    n
}

/// 终止全部会话的终端并清表（**应用退出 / 引擎销毁**时调用）。返回处理的条目数。
pub fn kill_all_shells() -> usize {
    let entries: Vec<Arc<ShellEntry>> = {
        let mut map = SHELLS.lock().unwrap();
        std::mem::take(&mut *map).into_values().collect()
    };
    let n = entries.len();
    for e in entries {
        if e.is_running() {
            e.terminate();
        }
    }
    n
}

/// 会话内终端条数（测试 / 诊断用）
#[cfg(test)]
fn session_count(session_id: &str) -> usize {
    SHELLS
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.session_id == session_id)
        .count()
}

// ==================== 生命周期 ====================

/// 一次成功 spawn 的结果（交给 [`supervise`] 长期接管）。
pub(super) struct Spawned {
    pub(super) pid: u32,
    /// shell 类型 id（`powershell` / `cmd` / `pwsh` / `gitbash`）
    pub(super) shell: String,
    /// 实际执行的可执行文件绝对路径（诊断 / 界面提示用：同一台机器上可能装了两个 pwsh）
    pub(super) command: String,
    pub(super) stdout: Option<Box<dyn std::io::Read + Send>>,
    pub(super) terminator: Terminator,
    /// 阻塞等待退出码（在常驻任务里跑一次）
    pub(super) wait: Box<dyn FnOnce() -> Option<i32> + Send>,
    /// 交互控制台（输入写端 + `HPCON`）
    pub(super) console: Option<Arc<ServicePty>>,
}

/// 长期接管：一条常驻读任务 + 一条常驻等待任务。
///
/// 传的是已经拆开的几块（而不是整个 [`Spawned`]）：`terminator` 要进注册表条目，
/// 剩下三块归这里 —— 一个结构体两个所有者，拆开最省事。
///
/// ⚠️ 必须在 tokio 运行时内调用（命令层都是 async）。
/// ⚠️ 关停顺序（定死）：**进程退出 → 落终态 → 关伪控制台**。读任务在关控制台后把剩余输出
/// 排空并自然收到 EOF（输出管道要等 `ClosePseudoConsole` 才断开，先等 EOF 会死等）。
pub(super) fn supervise(
    reader: Option<Box<dyn std::io::Read + Send>>,
    wait: Box<dyn FnOnce() -> Option<i32> + Send>,
    console: Option<Arc<ServicePty>>,
    state: Arc<ShellState>,
    session_id: &str,
    id: &str,
) {
    if let Some(pty) = console {
        state.attach_pty(pty);
    }
    // 先起推送任务：它的起始偏移是「此刻已有内容的末尾」（客户端挂载时会自己读整窗），
    // 之后的新输出才需要它。
    spawn_pusher(session_id.to_string(), id.to_string(), state.clone());
    if let Some(reader) = reader {
        spawn_reader(reader, state.clone());
    }
    tokio::task::spawn_blocking(move || {
        let code = wait();
        let killed = state.kill_requested.load(Ordering::SeqCst);
        state.finish(code, killed);
        // 进程已经退出 —— 此时才能关伪控制台（提前关会把还在跑的东西杀掉）。
        state.close_pty();
    });
}

/// 常驻推送任务：把 `console` 里还没推送的部分按帧发给宿主出口。
///
/// 四条口径：
/// 1. **起始偏移 = 起任务那一刻的末尾**：客户端挂载时会自己 `read_terminal(0)` 取整窗，
///    这里不必把整窗再推一遍；
/// 2. **前沿节流**：距上次推送不足 [`PUSH_GAP_MS`] 就等够（期间的输出下一帧合并发）——
///    首帧不等，所以键入回显仍然是「立刻」；
/// 3. **断档由客户端补读**：每帧带 `[from, next)`，客户端发现 `from` 对不上就 `read_terminal(from)`；
///    环形窗口把 `from` 丢掉时 `reset = true`（`text` 是整个窗口，客户端整段重放）；
/// 4. **终态也推**：`running` 一变就发一帧，前端不必等下一次轮询才知道 shell 退了。
///
/// 退出条件：读任务 EOF（`reader_done`）之后那一轮发完就收 —— 那时终态与尾巴都已发出。
/// 关终端同样会 EOF（`close_pty` 之后读管道才断），所以不会遗留任务。
fn spawn_pusher(session_id: String, id: String, state: Arc<ShellState>) {
    let Some(host) = output_host() else {
        // headless（CLI / 测试）：没有出口就不起任务，一条路都不多跑
        return;
    };
    // 起始偏移必须在**这里**取（同步）：若放进 async 块里，任务首次被调度之前到达的输出
    // 会被当成「客户端自己读的那段」而永远不推（推送任务与读任务抢跑 —— 单元测试里稳定复现）。
    let mut emitted = state.console.lock().unwrap().total();
    tokio::spawn(async move {
        let mut last_running = true;
        let mut last: Option<std::time::Instant> = None;
        loop {
            state.dirty.notified().await;
            // 先看 drained 再读缓冲：读任务一定是「推完尾巴 → 置位 → 通知」，
            // 所以观察到 drained 之后读到的一定是全部输出（不会截掉最后一帧）。
            let drained = state.reader_done.load(Ordering::SeqCst);
            let (text, reset, next, _head) = state.console.lock().unwrap().read_from(emitted);
            let running = state.is_running();
            if !text.is_empty() || reset || running != last_running {
                if let Some(gap) = last
                    .and_then(|t| std::time::Duration::from_millis(PUSH_GAP_MS).checked_sub(t.elapsed()))
                {
                    tokio::time::sleep(gap).await;
                }
                let frame = ConsoleDelta {
                    from: emitted,
                    next,
                    text,
                    reset,
                    running,
                };
                emitted = next;
                last_running = running;
                last = Some(std::time::Instant::now());
                host.push_terminal_output(&session_id, &id, &frame);
            }
            if drained {
                break;
            }
        }
    });
}

/// 常驻读任务（阻塞读到 EOF；边读边解码边入窗口）。
fn spawn_reader(mut reader: Box<dyn std::io::Read + Send>, state: Arc<ShellState>) {
    tokio::task::spawn_blocking(move || {
        // 与命令 / 服务路径共用同一份流式解码器（跨块多字节 / GBK 兜底都在里面）
        let mut decoder = super::execute::common::TerminalDecoder::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decoder.push(&chunk[..n]);
                    state.push_output(&text);
                }
                Err(_) => break,
            }
        }
        let tail = decoder.finish();
        state.push_output(&tail);
        // 尾巴推完才置位：推送任务据此判断「不会再有新输出」
        state.reader_done.store(true, Ordering::SeqCst);
        state.dirty.notify_one();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_entry(id: &str, session_id: &str, pid: u32) -> Arc<ShellEntry> {
        Arc::new(ShellEntry::new(
            id.to_string(),
            session_id.to_string(),
            "powershell".to_string(),
            "C:/tmp".to_string(),
            pid,
            0,
            Arc::new(ShellState::new()),
            Arc::new(|| {}),
        ))
    }

    /// 注册表按会话隔离：跨会话的 id 一律按「本会话没有它」处理。
    #[test]
    fn registry_is_session_scoped() {
        insert(fake_entry("term_scope", "s_a", 0));
        assert!(get("s_a", "term_scope").is_some());
        assert!(get("s_b", "term_scope").is_none(), "跨会话不可见");
        assert!(list("s_b").is_empty());
        assert_eq!(session_count("s_a"), 1);
        assert_eq!(kill_session_shells("s_a"), 1);
        assert!(get("s_a", "term_scope").is_none());
        assert_eq!(session_count("s_a"), 0);
    }

    /// 容量：已结束的条目先让位；会话上限按「还活着 + 已结束」一起数。
    #[test]
    fn ensure_capacity_prunes_finished_and_enforces_limits() {
        for i in 0..MAX_TERMINALS_PER_SESSION {
            insert(fake_entry(&format!("term_cap_{i}"), "s_cap", 0));
        }
        assert!(ensure_capacity("s_cap").is_err(), "到上限必须拒绝");

        // 全都没结束 → 上面已经拒绝；把它们逐个落成「已结束」后应能继续开
        {
            let map = SHELLS.lock().unwrap();
            for i in 0..MAX_TERMINALS_PER_SESSION {
                let entry = map.get(&format!("term_cap_{i}")).unwrap();
                entry.state.finish(Some(0), false);
            }
        }
        assert!(ensure_capacity("s_cap").is_ok(), "已结束的条目要先让位");
        // 让位之后那批「已结束」必须已经被摘掉（否则界面会看到幽灵标签）
        assert_eq!(session_count("s_cap"), 0);
        let _ = kill_session_shells("s_cap");
    }

    /// 终态快照：`running` / `exited` + 退出码 + 是否被终止（词表与服务的 panel 同源）。
    #[test]
    fn snapshot_reports_running_and_exit_code() {
        let state = ShellState::new();
        assert_eq!(state.snapshot(), ("running", None, false));
        state.finish(Some(3), true);
        assert_eq!(state.snapshot(), ("exited", Some(3), true));
        assert!(!state.is_running());
    }

    /// 输出窗口与终端面板的续接协议共用一份 `LogBuffer`：按绝对偏移取增量，且不消费已读游标。
    #[test]
    fn console_stream_is_offset_based() {
        let state = ShellState::new();
        state.push_output("abc");
        let (text, reset, next, head) = state.console.lock().unwrap().read_from(0);
        assert_eq!((text.as_str(), reset, next, head), ("abc", false, 3, false));
        state.push_output("de");
        let (text, reset, next, _) = state.console.lock().unwrap().read_from(3);
        assert_eq!((text.as_str(), reset, next), ("de", false, 5));
    }

    /// 推送任务：起始偏移 = 起任务那一刻的末尾（那段由客户端 `read_terminal` 自己取），
    /// 之后的新输出带 `[from, next)` 推出去，**终态（`running` 翻转）也走同一路** ——
    /// 「键入回显不等轮询」的地基就在这里。
    #[tokio::test]
    async fn pusher_pushes_new_output_and_final_state() {
        /// 一帧：(from, next, text, reset, running)
        type Frame = (u64, u64, String, bool, bool);
        struct Recorder(Mutex<Vec<Frame>>);
        impl TerminalOutputHost for Recorder {
            fn push_terminal_output(&self, session_id: &str, id: &str, d: &ConsoleDelta) {
                if session_id == "s_push" && id == "term_push" {
                    self.0
                        .lock()
                        .unwrap()
                        .push((d.from, d.next, d.text.clone(), d.reset, d.running));
                }
            }
        }
        let rec = Arc::new(Recorder(Mutex::new(Vec::new())));
        attach_output_host(rec.clone());

        let state = Arc::new(ShellState::new());
        // 起任务之前就有的内容：不推（客户端挂载时会自己读整窗）
        state.push_output("ab");
        spawn_pusher("s_push".into(), "term_push".into(), state.clone());
        state.push_output("cd");

        let mut frames = Vec::new();
        for _ in 0..200 {
            frames = rec.0.lock().unwrap().clone();
            if !frames.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            frames.first().cloned(),
            Some((2, 4, "cd".to_string(), false, true)),
            "只推起任务之后的增量，并带上绝对偏移：{frames:?}"
        );

        // 落终态 + 读任务收尾：最后一帧带 `running = false`，然后任务自己退出
        state.finish(Some(0), false);
        state.reader_done.store(true, Ordering::SeqCst);
        state.dirty.notify_one();

        let mut ended = false;
        for _ in 0..200 {
            if rec.0.lock().unwrap().iter().any(|f| !f.4) {
                ended = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(ended, "终态必须推出去，前端不必等下一次轮询");
    }

    /// 工作目录只认「存在的绝对路径」：空串（没工作区）/ 相对路径 / 不存在的目录都必须被拒 ——
    /// 悄悄退到进程当前目录会让人以为终端开在项目里，实际开在安装目录。
    #[test]
    fn start_rejects_bad_working_directory() {
        assert!(panel::start_terminal("s_cwd", "", 80, 24, None).is_err());
        assert!(panel::start_terminal("s_cwd", "   ", 80, 24, None).is_err());
        assert!(panel::start_terminal("s_cwd", "relative/path", 80, 24, None).is_err());
        assert!(panel::start_terminal(
            "s_cwd",
            "C:/virlen/no/such/dir/for/test",
            80,
            24,
            None
        )
        .is_err());
    }

    /// 认不出的 shell id 必须报错，且**在起进程之前**就失败（不能留下一个空标签 / 一条注册表条目）。
    #[test]
    fn start_rejects_unknown_shell_id() {
        let dir = std::env::temp_dir().join(format!("virlen_shell_id_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create cwd");
        let session = format!("s_shell_id_{}", uuid::Uuid::new_v4());
        let err = panel::start_terminal(&session, &dir.to_string_lossy(), 80, 24, Some("zsh"))
            .unwrap_err();
        assert!(err.contains("zsh"), "要说清是哪个 id：{err}");
        assert_eq!(session_count(&session), 0, "失败了不该留下条目");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 界面菜单拿到的列表：四种都有，可用的一定带绝对路径，默认标在首选那个上。
    #[test]
    fn list_shells_reports_availability_and_default() {
        let shells = panel::list_shells();
        assert_eq!(shells.len(), ShellKind::ALL.len());
        assert_eq!(
            shells.iter().filter(|s| s["default"] == true).count(),
            1,
            "默认项只能有一个：{shells:?}"
        );
        for item in &shells {
            let id = item["id"].as_str().expect("id");
            assert!(ShellKind::from_id(id).is_some(), "未知 id：{id}");
            if item["available"] == true {
                let command = item["command"].as_str().expect("command");
                assert!(!command.is_empty(), "可用的必须回路径：{item}");
                assert!(std::path::Path::new(command).is_absolute(), "{command}");
            }
        }
    }

    /// 起一个 shell → 写一条命令 → 读到「真的执行了」的证据 → 关掉。
    ///
    /// 判据统一是「拼出来的字符串」：伪控制台会把键入的字符回显一遍，回显里带着命令原文，
    /// 只有**执行结果**才长成 `VIRLEN_OK` 的样子。
    #[cfg(target_os = "windows")]
    async fn probe_shell(shell: &str, typed: &str) {
        let dir = std::env::temp_dir().join(format!("virlen_shell_{shell}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create cwd");
        let session = format!("s_shell_{shell}_{}", uuid::Uuid::new_v4());
        let info = panel::start_terminal(&session, &dir.to_string_lossy(), 120, 30, Some(shell))
            .unwrap_or_else(|e| panic!("{shell} 起不来：{e}"));
        let id = info["id"].as_str().expect("id").to_string();
        assert_eq!(info["shell"].as_str(), Some(shell), "要回报真实用的类型");
        assert!(info["pid"].as_u64().unwrap_or(0) > 0, "应回真实 pid：{info}");

        assert!(panel::write_terminal(&session, &id, typed), "键击应写进去");

        let mut offset = 0u64;
        let mut all = String::new();
        let mut seen = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            let chunk = panel::read_terminal(&session, &id, offset).expect("终端不该消失");
            offset = chunk["next"].as_u64().unwrap_or(offset);
            if chunk["reset"].as_bool().unwrap_or(false) {
                all.clear();
            }
            all.push_str(chunk["text"].as_str().unwrap_or(""));
            if all.contains("VIRLEN_OK") {
                seen = true;
                break;
            }
            assert!(
                chunk["running"].as_bool().unwrap_or(false),
                "{shell} 意外退出：{all}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(seen, "{shell} 没读到命令输出：{all}");

        assert!(panel::kill_terminal(&session, &id));
        assert_eq!(session_count(&session), 0, "{shell} 关掉后条目必须摘掉");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Windows 端到端：起 shell → 写一条命令 → 读到真实执行结果 → 关掉（条目随之摘掉）。
    ///
    /// 用 `Write-Output ('VIRLEN' + '_OK')` 而不是 `echo VIRLEN_OK`：伪控制台会把键入的字符
    /// 回显一遍，回显里带着命令原文 —— 只有「拼出来的结果」才能证明命令**真的执行了**。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_end_to_end_write_read_and_kill() {
        let dir = std::env::temp_dir().join(format!("virlen_user_shell_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create cwd");
        let session = format!("s_e2e_{}", uuid::Uuid::new_v4());

        let info = panel::start_terminal(&session, &dir.to_string_lossy(), 120, 30, None)
            .expect("起终端不应失败");
        let id = info["id"].as_str().expect("id").to_string();
        assert!(info["pid"].as_u64().unwrap_or(0) > 0, "应回真实 pid：{info}");
        assert_eq!(info["shell"].as_str(), Some("powershell"), "默认就是 powershell");
        assert_eq!(session_count(&session), 1);

        assert!(
            panel::write_terminal(&session, &id, "Write-Output ('VIRLEN' + '_OK')\r"),
            "键击应写进伪控制台"
        );

        let mut offset = 0u64;
        let mut all = String::new();
        let mut seen = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            let chunk = panel::read_terminal(&session, &id, offset).expect("终端不该消失");
            offset = chunk["next"].as_u64().unwrap_or(offset);
            if chunk["reset"].as_bool().unwrap_or(false) {
                all.clear();
            }
            all.push_str(chunk["text"].as_str().unwrap_or(""));
            if all.contains("VIRLEN_OK") {
                seen = true;
                break;
            }
            assert!(
                chunk["running"].as_bool().unwrap_or(false),
                "shell 意外退出：{all}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(seen, "没读到命令输出：{all}");

        // 关掉：进程树结束 + 条目摘掉（关标签 = 关终端，不靠调用方记性）
        assert!(panel::kill_terminal(&session, &id));
        assert!(
            panel::read_terminal(&session, &id, 0).is_none(),
            "关掉后条目必须摘掉"
        );
        assert_eq!(session_count(&session), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `cmd.exe`：`^` 是转义符，所以回显里看到的是 `echo VIRLEN^_OK`，
    /// 而执行结果才是 `VIRLEN_OK` —— 只有真执行了才会出现后者。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_cmd_shell_executes_commands() {
        probe_shell("cmd", "echo VIRLEN^_OK\r").await;
    }

    /// Git Bash：本机没装就跳过（探测已经会把它标成「未安装」）。
    /// 装了就必须真能起来并执行命令 —— ConPTY 下 `-li` 的 prompt / 编码都要正常。
    ///
    /// ⚠️ **在沙盒化的环境里跑不了**：msys2 运行时启动时要创建「信号管道」，
    /// 受限令牌下会 `couldn't create signal pipe (Win32 error 5)` —— 而实测（直接跑 bash）
    /// 同样失败，可见是环境限制而不是代码问题。所以先用 `std::process` 探一下，探测不了就如实跳过
    /// （应用自身跑在正常用户令牌下，终端里的 Git Bash 不受影响）。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_git_bash_executes_commands_if_installed() {
        let Some(info) = super::shells::detect_all()
            .into_iter()
            .find(|i| i.kind == ShellKind::GitBash && i.available())
        else {
            eprintln!("[skip] 本机没装 Git Bash");
            return;
        };
        let command = info.command.expect("available 就应该有路径");
        match std::process::Command::new(&command)
            .args(["-c", "exit 0"])
            .output()
        {
            Ok(out) if out.status.success() => {}
            other => {
                let detail = match &other {
                    Ok(out) => String::from_utf8_lossy(&out.stderr).to_string(),
                    Err(e) => e.to_string(),
                };
                eprintln!("[skip] 当前环境的受限令牌跑不了 msys2：{detail}");
                return;
            }
        }
        probe_shell("gitbash", "printf 'VIRLEN''_OK\\n'\r").await;
    }

    /// PowerShell 7：没装就跳过（大多数用户机器上都没有）。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_pwsh_executes_commands_if_installed() {
        if !super::shells::detect_all()
            .iter()
            .any(|i| i.kind == ShellKind::Pwsh && i.available())
        {
            eprintln!("[skip] 本机没装 PowerShell 7");
            return;
        }
        probe_shell("pwsh", "Write-Output ('VIRLEN' + '_OK')\r").await;
    }
}
