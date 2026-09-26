//! `chat` 的**纯状态机** —— 按键与引擎事件进，UI 状态与待执行动作出
//!
//! 为什么单独一个纯模块：可测路径上不能出现真终端，也不能依赖 `bin`（bin 目标不被单测引用）。
//! 本模块**没有任何 I/O**：`view` 读它画帧、`mod` 取它的动作去驱动引擎、`term` 才去碰终端。
//!
//! 收进来的一条约定：**引擎事件的语义解释只在这里做一次**（比如「同一 tool_call 的两帧开始
//! 事件要去重」），`view` / `mod` 都不再各自解释一遍。


pub(crate) mod event;
pub(crate) mod key;
pub(crate) mod line;

// 行模型（`LineKind` / `OutLine` / `expand` / `sanitize`）搬去 `line.rs`，但**路径不变**：
// `crate::tui::state::{OutLine, expand, LineKind}`（`term` / `view` 在用）仍照旧可用。
//
// `impl UiState` 被拆成三段（本文件=构造与访问器 / `event.rs`=引擎事件 / `key.rs`=按键）。
// 同一个类型的多个 `impl` 块分散在不同文件是合法的 —— 而且它们都是 `state` 的**子模块**，
// 因此能直接读写 `UiState` 的私有字段（无需把字段放宽到 `pub(crate)`）。
pub(crate) use self::line::*;

use crate::tui::commands::Slash;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use virlen_core::agent::compress::CompressMode;

/// 归一化按键（`input.rs` 把 crossterm 的 `KeyEvent` 映射到这里 → 本模块可在无终端下单测）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Key {
    Char(char),
    Enter,
    Backspace,
    Delete,
    Left,
    Right,
    Home,
    End,
    Up,
    Down,
    Esc,
    CtrlC,
    CtrlD,
}

/// 引擎 / 宿主 → UI 的事件（`mod.rs` 的事件出口把引擎事件映射成它）
#[derive(Debug, Clone)]
pub(crate) enum UiEvent {
    /// 正文增量（`assistant_message_updated.patch.contentDelta`，唯一被打印的正文来源）
    ///
    /// ⚠️ `stream_event` 里也有同一份 delta —— 两者都取会出现双份正文；这里取**带
    /// `messageId` 的那一条**（多一个 id 才能把「工具行插在同一条消息的正文之后」认对，
    /// 见 `assistant_blocks`）。
    TextDelta {
        message_id: String,
        delta: String,
    },
    /// 助手消息全量内容（`assistant_message_updated.patch.content`）——
    /// 用来**纠正**增量可能出现的偏差（收尾帧一定带它）
    AssistantContent {
        message_id: String,
        content: String,
    },
    /// 工具开始
    ToolStart {
        id: String,
        name: String,
        detail: String,
    },
    /// 工具实时输出（`agent:tool-output`）
    ToolOutput { chunk: String },
    /// 工具结束
    ToolDone {
        ok: bool,
        chars: usize,
        preview: String,
    },
    /// token 用量累计（**本进程累计**：用户一共花了多少 token）
    Usage { total: i64 },
    /// 当前上下文占用 token
    ///
    /// ⚠️ 与 `Usage` 不是一回事：那个是「花了多少」，这个是「当前上下文有多大」——
    /// 状态行的百分比用它。`None` = 本会话还没有用量数据（不显示百分比，而不是显示 0%）。
    /// 口径见 `virlen_core::agent::compress::context_tokens`（与桌面端 token 环同一个）。
    ContextUsage { tokens: Option<i64> },
    /// 正在压缩上下文（AI 摘要要一次模型调用，可能持续数秒）
    Compressing(bool),
    /// 设置里的默认压缩方式（选择面板据此标注「默认」并决定初始高亮）
    DefaultCompressMode(CompressMode),
    /// 需要用户应答的交互（命令授权 / 选择）
    Interaction {
        request_id: String,
        kind: String,
        data: Value,
    },
    /// 提示文本（斜杠命令输出、迭代进度等）
    Notice(String),
    /// 续连时的历史预览（`chat --session <id>` 命中已有会话 → 先把最近几条消息显示出来）
    ///
    /// 与 `Notice` 的差别：这些行**按角色着色**（用户 / 助手 / 工具），像一段真的历史记录，
    /// 而不是一条灰色提示。行文本由 `tui::history::history_preview` 生成（两种模式共用）。
    History(Vec<OutLine>),
    /// 错误提示（不一定是致命错误）
    Error(String),
    /// 一次回合结束
    RunFinished {
        ok: bool,
        error: Option<String>,
        elapsed_ms: i64,
    },
    /// 切了会话（新建 / 跳转）
    SessionChanged {
        session_id: String,
        title: String,
        model: String,
        workspace: String,
        messages: usize,
    },
    /// 退出（主循环要求 UI 线程收摊）
    Shutdown,
}

/// UI → 异步侧（引擎 / 库）
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Action {
    /// 普通提问
    Submit(String),
    /// 斜杠命令
    Slash(Slash),
    /// 压缩上下文（方式已在 UI 侧选定：面板选择或 `/compress ai|raw`）
    Compress(CompressMode),
    /// 交互应答（`bridge::handle_user_interaction_response` 的原样载荷）
    Reply { request_id: String, payload: Value },
    /// 取消当前回合（`AgentEngine::cancel`）
    Cancel,
    /// 退出
    Quit,
    /// TUI 线程自己坏了（连续绘制失败）→ 主循环切「顺序输出模式」
    ///
    /// ⚠️ 它不是「UI 动作」，借这条通道只是省一个 select 分支；语义上属于 TUI 线程的**退出报告**。
    Degrade(String),
}

/// 状态行内容（`/status` 与底部状态行共用同一份数据）
#[derive(Debug, Clone, Default)]
pub(crate) struct Status {
    pub session_id: String,
    pub title: String,
    pub model: String,
    pub workspace: String,
    pub messages: usize,
    /// 本进程累计 token（引擎只给单轮 `usage`；这里做加法，拿不到就保持 None）
    pub tokens: Option<i64>,
    /// 当前上下文占用 token（`None` = 本会话还没有用量数据）
    ///
    /// 与 `tokens` 是两个口径：`tokens` 是花掉的总量，这个是**此刻上下文有多大**。
    /// 状态行显示的是它 / 200k 的百分比。
    pub context_tokens: Option<i64>,
}

/// 授权面板的**显式选择项**（`confirm_command_native` 专用）。
///
/// ⚠️ 默认必须是 [`ConfirmChoice::Deny`]。授权是这次工具调用的**唯一人工闸门**：
/// 用户此刻完全可能正在输入框里打字（交互期间按键全部落到交互上），
/// 若「什么都不按 + 回车」＝放行，误触一次 Enter 就等于批准了一条危险命令。
/// 这与 `run/ask.rs` 的 fail-closed 口径（stdin 非 TTY / 空输入一律拒绝）是同一件事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfirmChoice {
    Deny,
    Allow,
}

impl ConfirmChoice {
    /// ← / ↑：选「拒绝」（两项之间的端点，停在原地）
    pub(crate) fn left(self) -> Self {
        Self::Deny
    }

    /// → / ↓：选「允许」
    pub(crate) fn right(self) -> Self {
        Self::Allow
    }

    /// 面板上的选项文案
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Deny => "拒绝",
            Self::Allow => "允许",
        }
    }
}

/// 一次待应答的交互
#[derive(Debug, Clone)]
pub(crate) struct Interaction {
    pub request_id: String,
    pub kind: String,
    pub data: Value,
    /// 用户正在输入的回答（`user_choice` 等行输入类交互使用）
    pub input: String,
    /// 授权面板的显式选择（仅 `confirm_command_native` 使用；**默认拒绝**）
    pub(crate) confirm: ConfirmChoice,
}

impl Interaction {
    /// 新建一次待应答交互（**唯一**的构造入口 —— 显式选择的默认值只在这里定一次）
    pub(crate) fn new(request_id: String, kind: String, data: Value) -> Self {
        Self {
            request_id,
            kind,
            data,
            input: String::new(),
            confirm: ConfirmChoice::Deny,
        }
    }

    fn str_field(&self, k: &str) -> String {
        self.data
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// 命令授权类交互（`title/desc/hint/risk` 全部由 Rust 侧下发，这里只展示）
    pub(crate) fn is_confirm(&self) -> bool {
        self.kind == "confirm_command_native"
    }

    pub(crate) fn question(&self) -> String {
        if self.is_confirm() {
            self.str_field("title")
        } else {
            self.str_field("question")
        }
    }

    pub(crate) fn desc(&self) -> String {
        self.str_field("desc")
    }

    pub(crate) fn hint(&self) -> String {
        self.str_field("hint")
    }

    pub(crate) fn risk(&self) -> String {
        self.str_field("risk")
    }

    pub(crate) fn multi(&self) -> bool {
        self.data
            .get("multi")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub(crate) fn options(&self) -> Vec<String> {
        self.data
            .get("options")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 由当前状态生成桥协议载荷（**每种交互类型都必须给出应答**，否则引擎会一直等回执）
    ///
    /// 授权（`confirm`）：看**显式选择** `self.confirm`，与输入框里的文字无关
    /// —— 用户此刻可能正在打下一句消息，那些字符不得被当作用户对授权的表态。
    /// 选择（`user_choice` 等）：解析复用 `run.rs::resolve_choice` —— 与 `virlen-cli run`
    /// 同一份语义（序号 / 选项文本 / 大小写 / 多选逗号 / 非选项文本按自定义回复）。
    pub(crate) fn answer(&self) -> Value {
        if self.is_confirm() {
            return match self.confirm {
                // 与桌面端弹窗同一条路径（`Rust 侧 parse_approval` 认 `approved` 文本）
                ConfirmChoice::Allow => json!({ "__kind": "value", "value": "approved" }),
                // ⚠️ 拒绝走 `cancelled`：与 Esc / 非 TTY 同一条路径 ——
                // `execute_command` 收到 `Cancelled` 时命令**一行都没跑**（不是「跑了但报失败」）
                ConfirmChoice::Deny => json!({ "__kind": "cancelled" }),
            };
        }
        if self.kind == "user_choice" {
            return match crate::run::resolve_choice(self.input.trim(), &self.options(), self.multi())
            {
                Some(v) => json!({ "__kind": "value", "value": v }),
                None => json!({ "__kind": "cancelled" }),
            };
        }
        // 未知类型也要答（见 `run.rs` 文件头：不回就等于把引擎挂死）
        json!({ "__kind": "cancelled" })
    }

    /// 面板上回显的**结果行**（交互关闭前把用户的表态固化进滚动区）。
    ///
    /// 判定依据是**实际发出的载荷**而不是内部状态：这样「界面上写了什么」与
    /// 「引擎收到了什么」不可能分叉。
    pub(crate) fn answer_line(&self, payload: &Value) -> String {
        if self.is_confirm() {
            return match payload.get("__kind").and_then(Value::as_str) {
                Some("value") => "✔ 已允许".to_string(),
                _ => "✘ 已拒绝".to_string(),
            };
        }
        format!(
            "→ {}",
            payload
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("（取消）")
        )
    }
}

/// TUI **本地**选择面板（目前只有「压缩方式」一种用途）
///
/// 为什么复用不了 [`Interaction`]：那是**引擎发起**的交互（必须回执 `request_id`），
/// 且它的选择类交互是「行输入序号 / 文本」。压缩方式是 TUI 自己发起的，要的是与授权面板
/// 同款的**显式选择器**（↑↓ + Enter）—— 不经过桥、也不需要回执。
#[derive(Debug, Clone)]
pub(crate) struct Picker {
    pub(crate) purpose: PickerPurpose,
    pub(crate) options: Vec<PickerOption>,
    /// 当前高亮项
    pub(crate) index: usize,
}

/// 面板用途 —— 它同时是**标题的唯一来源**（加一种用途就只改这里）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PickerPurpose {
    CompressMode,
}

impl PickerPurpose {
    /// 面板标题
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::CompressMode => "压缩上下文：选择方式",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PickerOption {
    pub(crate) label: String,
    pub(crate) action: PickerAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PickerAction {
    Compress(CompressMode),
}

impl Picker {
    /// 上下移动（两端停在原地，不回绕）：误触不会直接跳到另一端
    pub(crate) fn moved(&self, delta: isize) -> usize {
        if self.options.is_empty() {
            return 0;
        }
        let last = self.options.len() - 1;
        let next = self.index as isize + delta;
        next.clamp(0, last as isize) as usize
    }

    pub(crate) fn selected(&self) -> Option<&PickerOption> {
        self.options.get(self.index)
    }
}

/// UI 状态
#[derive(Debug)]
pub(crate) struct UiState {
    /// 本轮**尚未固化**的输出（回合结束时整块交给 `term` 写进终端原生滚动区）
    inflight: Vec<OutLine>,
    /// 各条助手消息的正文块在 `inflight` 里的下标（key = `messageId`）
    ///
    /// ⚠️ 必须**按 id 认块**，不能用「当前正在追加的那一块」（旧写法就是后者，已踩坑）：
    /// 一次工具调用的两个事件是**交错**到达的 —— `tool_call`（工具行）先到，
    /// `assistant_message_updated{streaming:false}`（收尾帧，带全量正文）后到。
    /// 只记「当前块」的话，收尾帧会被当成**新消息**再插一块 → 正文整段重复，
    /// 而且下一轮的增量会接着写进那一块，于是**下一轮正文长在工具结果之前**，
    /// 看着就像「工具输出来到了下一轮回复后面」（真机实测，见 `docs/AGENTS.md` §11.22）。
    assistant_blocks: HashMap<String, usize>,
    /// 已经打过「工具开始行」的 tool_call id（同一次调用会来两帧，必须去重）
    started_tools: HashSet<String>,
    /// 工具实时输出尾部（只留尾部：长命令的输出可以无限长，不能全留在内存里）
    tool_tail: String,

    input: String,
    /// 光标在 `input` 里的**字符**下标（不是字节）
    cursor: usize,
    history: Vec<String>,
    /// 正在浏览历史时的下标；`None` = 不在浏览
    history_pos: Option<usize>,
    /// 进入历史浏览前的草稿（↓ 回到末尾时恢复）
    draft: String,

    running: bool,
    /// 正在压缩上下文（与「回合进行中」互斥；两者都算「忙」，见 [`Self::busy`]）
    compressing: bool,
    /// 本回合开始时间（状态行显示已用时；回合结束后清空）
    turn_started_ms: Option<i64>,
    frame: u64,
    dirty: bool,
    /// 有内容等待固化（回合结束 / 提示产生）
    commit_pending: bool,
    pub should_quit: bool,
    /// 当前交互 + 排队等着的（同一时刻可能来多个）
    interaction: Option<Interaction>,
    queue: VecDeque<Interaction>,
    /// 本地选择面板（TUI 自己发起的，与引擎交互无关）
    picker: Option<Picker>,
    /// 设置里的默认压缩方式（`app_settings.contextCompressMode`；由主循环启动时下发）
    default_compress_mode: Option<CompressMode>,
    pub status: Status,
}

/// 工具实时输出在内存里保留的最大字符数（超出丢头部）
const TOOL_TAIL_MAX: usize = 4000;

impl Default for UiState {
    fn default() -> Self {
        Self::new()
    }
}

impl UiState {
    pub(crate) fn new() -> Self {
        Self {
            inflight: Vec::new(),
            assistant_blocks: HashMap::new(),
            started_tools: HashSet::new(),
            tool_tail: String::new(),
            input: String::new(),
            cursor: 0,
            history: Vec::new(),
            history_pos: None,
            draft: String::new(),
            running: false,
            compressing: false,
            turn_started_ms: None,
            frame: 0,
            dirty: true,
            commit_pending: false,
            should_quit: false,
            interaction: None,
            queue: VecDeque::new(),
            picker: None,
            default_compress_mode: None,
            status: Status::default(),
        }
    }

    // ==================== 只读视图（给 view / mod 用） ====================

    pub(crate) fn inflight(&self) -> &[OutLine] {
        &self.inflight
    }
    pub(crate) fn input(&self) -> &str {
        &self.input
    }
    pub(crate) fn cursor(&self) -> usize {
        self.cursor
    }
    pub(crate) fn running(&self) -> bool {
        self.running
    }
    /// 是否「忙」：回合在跑**或**正在压缩上下文。
    ///
    /// 两者都必须拦住新输入与「固化在飞内容」：压缩会替换上下文，
    /// 与正在进行的一回合并行会让消息列表错乱（与 `submit_input` 的理由相同）。
    pub(crate) fn busy(&self) -> bool {
        self.running || self.compressing
    }
    pub(crate) fn compressing(&self) -> bool {
        self.compressing
    }
    /// 当前本地选择面板（无则 `None`）
    pub(crate) fn picker(&self) -> Option<&Picker> {
        self.picker.as_ref()
    }
    /// 本回合已用时（未在跑时为 `None`）
    pub(crate) fn elapsed_ms(&self) -> Option<i64> {
        self.turn_started_ms
            .map(|t| (virlen_core::telemetry::now_ms() - t).max(0))
    }
    pub(crate) fn frame(&self) -> u64 {
        self.frame
    }
    pub(crate) fn tool_tail(&self) -> &str {
        &self.tool_tail
    }
    pub(crate) fn interaction(&self) -> Option<&Interaction> {
        self.interaction.as_ref()
    }
    pub(crate) fn clear_dirty(&mut self) {
        self.dirty = false;
    }
    pub(crate) fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// 取走待固化的内容（拿走后 `inflight` 清空）。
    ///
    /// 只在「没有回合在跑」时给内容：回合中途固化会把「正在流式输出的正文」撕成两半
    /// （上半在滚动区、下半还在视口里）。
    pub(crate) fn take_commit(&mut self) -> Vec<OutLine> {
        if !self.commit_pending || self.busy() {
            return Vec::new();
        }
        self.commit_pending = false;
        self.assistant_blocks.clear();
        self.tool_tail.clear();
        std::mem::take(&mut self.inflight)
    }

    /// spinner / 计时用：只在有回合在跑时推进帧号
    ///
    /// ⚠️ 不置 `dirty`：重绘的「时机」由调用方按 `100ms` 节流决定
    /// （这里置 dirty 会变成「每轮都画」= 无节制重绘）。
    pub(crate) fn tick(&mut self) {
        if self.busy() {
            self.frame = self.frame.wrapping_add(1);
        }
    }

    // ==================== 本地选择面板 ====================

    /// 打开「压缩方式」选择面板（`/compress` 不带参数时）—— 唯一的构造入口
    ///
    /// 初始高亮 = 设置里的默认方式（与桌面端右键菜单标「默认」同口径）；
    /// 设置里没配时高亮第一项（`[CompressMode::ALL]` 的顺序即展示顺序）。
    pub(crate) fn open_compress_picker(&mut self) {
        let default = self.default_compress_mode;
        let options = CompressMode::ALL
            .iter()
            .map(|m| PickerOption {
                label: if Some(*m) == default {
                    format!("{}（默认）", m.label())
                } else {
                    m.label().to_string()
                },
                action: PickerAction::Compress(*m),
            })
            .collect();
        self.picker = Some(Picker {
            purpose: PickerPurpose::CompressMode,
            options,
            index: default
                .and_then(|d| CompressMode::ALL.iter().position(|m| *m == d))
                .unwrap_or(0),
        });
    }

    /// 移动选择（返回是否真的移动了；面板不在时什么也不做）
    pub(crate) fn picker_move(&mut self, delta: isize) {
        if let Some(p) = self.picker.as_ref() {
            let next = p.moved(delta);
            if let Some(p) = self.picker.as_mut() {
                p.index = next;
            }
        }
    }

    /// 关掉面板（Esc / Ctrl+C）：不产生任何动作
    pub(crate) fn close_picker(&mut self) {
        self.picker = None;
    }

    /// 确认当前高亮项 → 动作（面板随即关闭，回显选择结果）
    pub(crate) fn picker_confirm(&mut self) -> Option<Action> {
        let action = self.picker.as_ref()?.selected()?.action.clone();
        let line = match &action {
            PickerAction::Compress(m) => format!("→ 压缩方式: {}", m.label()),
        };
        self.inflight.push(OutLine::new(LineKind::Notice, line));
        self.picker = None;
        Some(match action {
            PickerAction::Compress(m) => Action::Compress(m),
        })
    }
}

#[cfg(test)]
mod tests;
