//! PTY 会话注册表 —— `tool_call_id` → 伪控制台输入通道。
//!
//! 用途：让用户在命令执行中「插键盘」（`docs/pty-research.md` §6.3）。
//!
//!   - 运行器建好伪控制台后，把**输入写端**登记到本表；
//!   - 前端 `invoke('pty_write', { toolCallId, data })` 直接写进去 —— 走 Tauri 命令而不是
//!     引擎事件总线，因此**不污染 `AgentEventType` 四方契约**（铁律 2）；
//!   - 命令结束（或超时/取消）时注销，避免写到已关闭的句柄。
//!
//! 会话 key 直接复用 `toolCallId`：前端 `TerminalView` 已持有它，
//! `rust-engine.ts` 也已按它注册 kill 入口 → **无需新增映射事件**，改动量最小的接法。
//!
//! ⚠️ 中断语义（实测结论，§5.6）：`\x03` 只能影响「正在读 stdin 的进程」
//! （shell 提示符 / REPL / `y/n` 提示）。Windows 的控制台控制事件是在**有人读输入缓冲**时
//! 才生成的，`ping` 这类从不读 stdin 的前台程序**不会**被 `\x03` 打断 —— 因此
//! **中断主通道仍然是 Job Object / `agent_kill_command`**，本模块只是补充手段。

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

/// ② 用户干预摘要（Step 2 ②）。
///
/// ⚠️ **只记计数，不记内容**：PTY 里用户敲的往往是密码 / token，
/// 正文一旦进工具结果就会进模型上下文 + 落 SQLite，直接踩 §9 密钥红线（决策点 D4）。
#[derive(Default, Clone, Copy)]
pub struct InterventionCounts {
    /// 写入次数（键击 / 粘贴各算一次）
    pub keys: usize,
    /// 含回车 / 换行的写入次数
    pub enters: usize,
    /// 含 `\x03`（Ctrl+C）的写入次数
    pub ctrl_c: usize,
    /// 接管累计时长（秒）——由运行器按预算心跳填充
    pub held_seconds: u64,
}

/// 伪控制台尺寸去重器。
///
/// ⚠️ 为什么必须去重：ConPTY 在「屏幕已有内容」之后收到 `ResizePseudoConsole`，会
/// **整屏重绘**并按新行数在内容下方补空行（本机实测：补出的空行数 = 新行数 − 内容行数，
/// 见 `docs/pty-research.md` §5.7）。前端 `ResizeObserver` 会重复上报同一尺寸，
/// 若每次都真去 resize，终端里就会白刷出一堆空行。
#[derive(Default)]
pub struct SizeTracker {
    current: Option<(i16, i16)>,
}

impl SizeTracker {
    /// 记录尺寸；返回是否**发生变化**（`false` = 与上次一致 → 调用方应跳过 `ResizePseudoConsole`）。
    pub fn changed(&mut self, cols: i16, rows: i16) -> bool {
        if self.current == Some((cols, rows)) {
            return false;
        }
        self.current = Some((cols, rows));
        true
    }
}

/// 一个运行中的 PTY 会话句柄。
pub struct PtySession {
    /// 伪控制台输入写端。取值时加锁：`pty_write` 可能来自任意 Tauri 命令线程。
    /// `File::write_all` 对管道句柄是同步且无缓冲的，不需要额外 flush。
    input: Mutex<Option<File>>,
    /// Windows：`HPCON` 的副本，供 `pty_resize` 使用；非 Windows 平台暂为 0。
    #[allow(dead_code)]
    hpc: isize,
    /// 伪控制台当前尺寸（列, 行）——用于跳过**没有变化**的 resize（见 `SizeTracker`）。
    size: Mutex<SizeTracker>,
    /// ② 接管标志：`true` 时运行器冻结超时预算（人在慢慢输密码，不该被超时杀掉）。
    held: AtomicBool,
    /// ② 干预计数（只记计数，不记内容）
    keys: AtomicUsize,
    enters: AtomicUsize,
    ctrl_c: AtomicUsize,
}

impl PtySession {
    /// `cols` / `rows`：伪控制台**创建时**的尺寸（写入去重器，使「与初始尺寸相同」的
    /// 首次上报也成为 no-op）。
    pub fn new(input: File, hpc: isize, cols: i16, rows: i16) -> Self {
        let mut tracker = SizeTracker::default();
        tracker.changed(cols, rows);
        Self {
            input: Mutex::new(Some(input)),
            hpc,
            size: Mutex::new(tracker),
            held: AtomicBool::new(false),
            keys: AtomicUsize::new(0),
            enters: AtomicUsize::new(0),
            ctrl_c: AtomicUsize::new(0),
        }
    }

    /// 记录尺寸；返回是否**需要真正调用** `ResizePseudoConsole`（未变化 → false）。
    pub fn set_size(&self, cols: i16, rows: i16) -> bool {
        let mut guard = match self.size.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.changed(cols, rows)
    }

    /// 写入数据（用户键入内容或控制字节，如 `\x03`）。返回是否写入成功。
    ///
    /// 空串视为成功（no-op），便于前端无脑转发。写入时顺手累计干预计数（**只记计数**）。
    pub fn write(&self, data: &str) -> bool {
        if data.is_empty() {
            return true;
        }
        // ②：只记计数，不记内容（D4）
        self.keys.fetch_add(1, Ordering::Relaxed);
        if data.contains('\r') || data.contains('\n') {
            self.enters.fetch_add(1, Ordering::Relaxed);
        }
        if data.contains('\x03') {
            self.ctrl_c.fetch_add(1, Ordering::Relaxed);
        }
        // 锁中毒也继续用（内部只是一个 File 句柄，不存在被破坏的不变量）
        let mut guard = match self.input.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(file) = guard.as_mut() else {
            return false;
        };
        file.write_all(data.as_bytes()).is_ok()
    }

    /// ② 设置接管状态，返回之前的状态。
    pub fn set_held(&self, held: bool) -> bool {
        self.held.swap(held, Ordering::SeqCst)
    }

    /// ② 当前是否被用户接管。
    pub fn is_held(&self) -> bool {
        self.held.load(Ordering::SeqCst)
    }

    /// ② 干预摘要快照（`held_seconds` 缺省 0，由运行器按预算心跳填充）。
    pub fn interventions(&self) -> InterventionCounts {
        InterventionCounts {
            keys: self.keys.load(Ordering::Relaxed),
            enters: self.enters.load(Ordering::Relaxed),
            ctrl_c: self.ctrl_c.load(Ordering::Relaxed),
            held_seconds: 0,
        }
    }

    /// 关闭输入通道（命令结束时调用；`File` 的 Drop 会关闭底层句柄）。
    pub fn close_input(&self) {
        let mut guard = match self.input.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = None;
    }

    /// `HPCON` 副本（`0` 表示不可用）。
    #[allow(dead_code)]
    pub fn hpc(&self) -> isize {
        self.hpc
    }
}

/// 运行中的 PTY 会话表：`tool_call_id` → 会话句柄。
static PTY_SESSIONS: LazyLock<Mutex<HashMap<String, Arc<PtySession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 登记一个会话（运行器 spawn 成功后立即调用）。
pub fn register(tool_call_id: &str, session: Arc<PtySession>) {
    PTY_SESSIONS
        .lock()
        .unwrap()
        .insert(tool_call_id.to_string(), session);
}

/// 注销会话并返回句柄（调用方据此关闭输入通道），命令结束时调用。
///
/// 返回而非直接 Drop：调用方需要先关闭输入通道、再关伪控制台（§5.5 的关停顺序）。
pub fn unregister(tool_call_id: &str) -> Option<Arc<PtySession>> {
    PTY_SESSIONS.lock().unwrap().remove(tool_call_id)
}

fn lookup(tool_call_id: &str) -> Option<Arc<PtySession>> {
    PTY_SESSIONS.lock().unwrap().get(tool_call_id).cloned()
}

/// 最近一次客户端上报的终端尺寸（列, 行）。
///
/// 新建伪控制台时用它作初始尺寸：若与客户端实际尺寸一致，随后的 `pty_resize` 就是
/// no-op，ConPTY 不会重绘、也就不会补出多余空行（见 `SizeTracker`）。
static LAST_CLIENT_SIZE: LazyLock<Mutex<Option<(i16, i16)>>> =
    LazyLock::new(|| Mutex::new(None));

/// 新建伪控制台应使用的初始尺寸：优先最近一次客户端上报值，否则用 `fallback`。
pub fn initial_size(fallback: (i16, i16)) -> (i16, i16) {
    LAST_CLIENT_SIZE
        .lock()
        .ok()
        .and_then(|g| *g)
        .unwrap_or(fallback)
}

/// 向指定会话写入数据（`pty_write` 命令入口）。返回是否找到并写入成功。
pub fn pty_write(tool_call_id: &str, data: &str) -> bool {
    match lookup(tool_call_id) {
        Some(session) => session.write(data),
        None => false,
    }
}

/// 调整指定会话的伪控制台尺寸（`pty_resize` 命令入口）。
///
/// ⚠️ 与上报尺寸**相同**时直接返回 true，**不调用** `ResizePseudoConsole`：
/// ConPTY 在「屏幕已有内容」后 resize 会整屏重绘并在内容下方补空行
/// （空行数 = 新行数 − 内容行数），而前端 `ResizeObserver` 会重复上报同一尺寸。
pub fn pty_resize(tool_call_id: &str, cols: u16, rows: u16) -> bool {
    // ⚠️ 关键：**先**记下客户端尺寸（无论会话是否已注册）。
    //
    // 前端 fit() 往往早于后端 `create`（本机实测：resize 约早 0.9s 到达，此时会话
    // 尚未注册 → lookup 未命中）。若只在命中会话时才写缓存，首次运行时缓存永远是空
    // → `create` 只能退回默认 240×50 → 与真实尺寸（如 109×13）不符
    // → ConPTY 每次重绘都按 50 行补空行（空行数 = 行数 − 内容行数）。
    // 把写入提到 lookup 之前，就能让紧接其后的 `create` 用上正确尺寸（`initial_size`）；
    // 前端另有重试兜底（见 XtermTerminal.sendResize）。
    if let Ok(mut g) = LAST_CLIENT_SIZE.lock() {
        *g = Some((cols as i16, rows as i16));
    }
    let Some(session) = lookup(tool_call_id) else {
        // 会话尚未注册 → 尺寸已写入缓存，紧接其后的 `create` 会用它作初始尺寸；
        // 返回 false 让前端重试兜底。
        return false;
    };
    if !session.set_size(cols as i16, rows as i16) {
        // 尺寸未变 → 跳过（避免无谓的 ConPTY 重绘）
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        return crate::sandbox::pty::resize_raw(session.hpc(), cols as i16, rows as i16);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows 平台尚未实现 PTY（仍在匿名管道路径），尺寸调整无意义。
        let _ = (session, cols, rows);
        false
    }
}

/// 命名控制键 → 发送字节的映射（Step 2 ③）。
///
/// 为什么在 Rust 里做映射：命名 → 字节的映射表**只能有一份**（铁律 1 的同类问题）。
/// 前端只发键名（`"ctrl+c"`），不发裸控制字节 —— 也就不必往 JSON 里塞 `\u0003` 之类的转义。
///
/// - 伪控制台的 Enter 是 **CR**（`\r`），不是 LF；
/// - 方向键 / Home / End / Delete / PageUp / PageDown 用标准 CSI（xterm 序列）；
/// - `ctrl+<a..z>` 有**通用规则**：字母码 − 0x60（`ctrl+c` → `\x03`、`ctrl+d` → `\x04`…）；
/// - ⚠️ `backspace` 发 `\x08`（与 `\x7f` 的取舍**未实测**，见 docs/pty-research.md §7 #18）；
/// - 未知名字返回 `None`（调用方跳过该键，**不**整体失败，便于前端无脑加按钮）。
pub fn key_sequence(name: &str) -> Option<String> {
    let n = name.trim().to_ascii_lowercase();
    match n.as_str() {
        "enter" | "return" => return Some("\r".to_string()),
        "tab" => return Some("\t".to_string()),
        "escape" | "esc" => return Some("\x1b".to_string()),
        "backspace" | "bs" => return Some("\x08".to_string()),
        "space" => return Some(" ".to_string()),
        "up" => return Some("\x1b[A".to_string()),
        "down" => return Some("\x1b[B".to_string()),
        "right" => return Some("\x1b[C".to_string()),
        "left" => return Some("\x1b[D".to_string()),
        "home" => return Some("\x1b[H".to_string()),
        "end" => return Some("\x1b[F".to_string()),
        "delete" | "del" => return Some("\x1b[3~".to_string()),
        "pageup" | "pgup" => return Some("\x1b[5~".to_string()),
        "pagedown" | "pgdn" => return Some("\x1b[6~".to_string()),
        _ => {}
    }
    if let Some(rest) = n.strip_prefix("ctrl+") {
        // `ctrl+[` / `ctrl+backslash` / `ctrl+]`（键名写成 `backslash` 而非符号，
        // 避免 markdown 转义歧义）
        match rest {
            "[" | "bracketleft" => return Some("\x1b".to_string()),
            "backslash" => return Some("\x1c".to_string()),
            "]" | "bracketright" => return Some("\x1d".to_string()),
            _ => {}
        }
        // 通用规则：ctrl+字母 → 字母码 − 0x60
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_alphabetic() {
                let code = c.to_ascii_lowercase() - b'a' + 1;
                return Some((code as char).to_string());
            }
        }
    }
    None
}

/// ② 设置指定会话的接管状态（`pty_set_held` 命令入口）。
///
/// 返回是否命中会话（命令已结束 / 不存在 → false，前端据此复位按钮）。
/// 接管**不等于**取消：终止按钮 / `agent_cancel` 在接管期间仍可用。
pub fn pty_set_held(tool_call_id: &str, held: bool) -> bool {
    match lookup(tool_call_id) {
        Some(session) => {
            session.set_held(held);
            true
        }
        None => false,
    }
}

/// 按命名控制键向指定会话写入（`pty_key` 命令入口，Step 2 ③）。
///
/// 逐个键顺序写入；未知键名跳过（不视为失败）。返回是否**至少写入了一个**有效键
/// （会话不存在或全部键名无效时返回 false，前端据此复位按键状态）。
pub fn pty_key(tool_call_id: &str, keys: &[String]) -> bool {
    let Some(session) = lookup(tool_call_id) else {
        return false;
    };
    let mut wrote_any = false;
    for key in keys {
        if let Some(seq) = key_sequence(key) {
            if session.write(&seq) {
                wrote_any = true;
            }
        }
    }
    wrote_any
}

#[cfg(test)]
mod tests {
    use super::{key_sequence, SizeTracker};

    /// ConPTY 尺寸去重：只有**真正变化**时才允许调用 `ResizePseudoConsole`
    /// （否则会白刷出一堆空行，见 SizeTracker 的说明）。
    #[test]
    fn test_size_tracker_dedup() {
        let mut t = SizeTracker::default();
        assert!(t.changed(80, 24)); // 首次 → 需要 resize
        assert!(!t.changed(80, 24)); // 同尺寸重复上报 → 跳过
        assert!(!t.changed(80, 24));
        assert!(t.changed(80, 25)); // 行数变了 → 需要 resize
        assert!(t.changed(81, 25)); // 列数变了 → 需要 resize
        assert!(!t.changed(81, 25));
    }

    /// Step 2 ③：命名控制键 → 字节逐条对齐（纯函数，零副作用）。
    #[test]
    fn test_pty_key_named_sequences() {
        // 基本控制键
        assert_eq!(key_sequence("enter").as_deref(), Some("\r"));
        assert_eq!(key_sequence("return").as_deref(), Some("\r"));
        assert_eq!(key_sequence("tab").as_deref(), Some("\t"));
        assert_eq!(key_sequence("escape").as_deref(), Some("\x1b"));
        assert_eq!(key_sequence("esc").as_deref(), Some("\x1b"));
        // backspace：先发 \x08（\x7f 的取舍未实测，见 §7 #18）
        assert_eq!(key_sequence("backspace").as_deref(), Some("\x08"));
        assert_eq!(key_sequence("space").as_deref(), Some(" "));
        // 方向键 / 编辑键
        assert_eq!(key_sequence("up").as_deref(), Some("\x1b[A"));
        assert_eq!(key_sequence("down").as_deref(), Some("\x1b[B"));
        assert_eq!(key_sequence("right").as_deref(), Some("\x1b[C"));
        assert_eq!(key_sequence("left").as_deref(), Some("\x1b[D"));
        assert_eq!(key_sequence("home").as_deref(), Some("\x1b[H"));
        assert_eq!(key_sequence("end").as_deref(), Some("\x1b[F"));
        assert_eq!(key_sequence("delete").as_deref(), Some("\x1b[3~"));
        assert_eq!(key_sequence("pageup").as_deref(), Some("\x1b[5~"));
        assert_eq!(key_sequence("pagedown").as_deref(), Some("\x1b[6~"));
        // ctrl+字母 通用规则（字母码 − 0x60）
        assert_eq!(key_sequence("ctrl+c").as_deref(), Some("\x03"));
        assert_eq!(key_sequence("ctrl+d").as_deref(), Some("\x04"));
        assert_eq!(key_sequence("ctrl+z").as_deref(), Some("\x1a"));
        assert_eq!(key_sequence("ctrl+a").as_deref(), Some("\x01"));
        // ctrl+符号
        assert_eq!(key_sequence("ctrl+[").as_deref(), Some("\x1b"));
        assert_eq!(key_sequence("ctrl+backslash").as_deref(), Some("\x1c"));
        assert_eq!(key_sequence("ctrl+]").as_deref(), Some("\x1d"));
        // 大小写 / 前后空白不敏感
        assert_eq!(key_sequence("  Ctrl+C ").as_deref(), Some("\x03"));
        // 未知名字 → None（调用方跳过，不整体失败）
        assert_eq!(key_sequence("f13"), None);
        assert_eq!(key_sequence("ctrl+1"), None);
        assert_eq!(key_sequence(""), None);
    }
}
