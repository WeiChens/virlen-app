//! `chat` 的**纯渲染** —— `&UiState` → 一帧
//!
//! 用 `TestBackend` 就能断言（无需真终端），因此「界面长什么样」这部分是可回归的。
//!
//! 布局（内联视口，高度 `term::VIEWPORT_H` = 10，构造期定死）：
//!
//! ```text
//!  ┌─ 在飞内容尾巴（Min(1)）：本回合尚未固化的正文 / 工具行 / 工具实时输出 ──┐
//!  ├─ 交互面板（仅在有待应答的授权 / 选择时出现，最多 6 行）──────────────┤
//!  ├─ 输入行（1 行，带光标）────────────────────────────────────────────┤
//!  └─ 状态行（1 行）：spinner · 模型 · 会话 · 工作目录 · token · 用时 ────┘
//! ```
//!
//! 已固化的内容不在这里渲染 —— 它已经被 `term::commit` 写进终端**原生滚动区**
//! （因此终端自带的滚动与鼠标选中复制都还在，见 `docs/cli-tui-plan.md` §4）。

use crate::tui::state::{expand, ConfirmChoice, Interaction, LineKind, Picker, UiState};
use virlen_core::agent::compress as agent_compress;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::buffer::CellDiffOption;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// 交互面板最多占几行（其余空间留给在飞内容）
const INTERACTION_MAX_ROWS: u16 = 6;
/// 工具实时输出在动态区里最多显示几行尾部
const TOOL_TAIL_ROWS: usize = 3;

/// 动态区**右侧保留**的列数。
///
/// ⚠️ 这不是审美选择，是**真机实测得出的硬约束**（探针 + 真终端逐帧取屏，见
/// `docs/cli-tui-plan.md` §3.5、`docs/AGENTS.md` §11.19）：
///
/// > 在 conhost（cmd.exe）上，只要某一行的**最后一格**被写过，控制台就会留下一个
/// > **待换行**状态；这个待换行会在随后的光标移动/写入时被兑现，而一旦兑现时行号已在
/// > 屏底，控制台就**把整屏上滚一行**。ratatui 与 crossterm 都不知道这件事。
///
/// 后果（用户实测到的现象）：视口里的正文整体比 ratatui 的模型偏上一行，但光标仍按模型
/// 落位 → **光标压在状态行上、输入的文字直接覆盖状态行**。
///
/// 实测对照（120x30 控制台，视口贴底；「上滚」= 窗口 top +1）：
///
/// | 帧内容 | 画的终端宽度 | 结果 |
/// |---|---|---|
/// | 只画文本（`> ` / 状态文本本身） | ≤ 120 | 不上滚 |
/// | 状态行 + `Paragraph` 级样式把整行空格也涂上色 → 画到行尾 | 120 | **上滚** |
/// | 同上但裁到 118 格（文本里 4 个 `·` 在 CJK 字体下算 2 列 → 实际 122 > 120） | 122 | **上滚** |
/// | 118 个 ASCII 字符（无样式 / 有样式） | 118 | 不上滚 |
/// | 输入行画满 120 格 | 120 | **上滚** |
///
/// ⚠️ 「文本里 4 个 `·` → 实际 122 > 120」不是推测：同一台机器上直接量过**终端对每个字符
/// 推进几列**（写一个字符后读光标列）：`A`=1、**`·`(U+00B7)=2**、`—`(U+2014)=2、`取`=2、
/// `⠧`(U+2827)=1、`─`(U+2500)=1。即 **`·` 这类「歧义宽度」字符在 CJK 字体下由终端按 2 列
/// 推进，而 ratatui 按 1 列排版**——文本实际比模型宽「这类字符的个数」列，就是这个差额把屏底行
/// 顶出了行尾。（`unicode-width` 的 `width_cjk` 口径与实际一致：`·` 算 2 列。）
///
/// ⇒ 结论：**帧里任何一行都不能碰到屏的最后一格**，而且状态行还得把尾部涂满（否则状态行
/// 变短时会留下上一个状态的残字，比如 `/exi**t**`）。因此：
///
/// 1. 整帧往右收 `RIGHT_MARGIN` 列（所有部件的渲染区都窄这么多）；
/// 2. 状态行文本按 `width_cjk`（歧义宽度算 2 列 = 最坏情况）裁好后再用空格补满，
///    这样「格子数」与「终端实际推进的列数」都 ≤ `宽 - RIGHT_MARGIN`。
const RIGHT_MARGIN: u16 = 2;

/// 一个逻辑行的颜色（视口与固化区**共用同一份** → 两处颜色不会分叉）
pub(crate) fn style_of(kind: LineKind) -> Style {
    match kind {
        LineKind::User => Style::default().fg(Color::Cyan),
        LineKind::Assistant => Style::default(),
        LineKind::Tool => Style::default().fg(Color::Yellow),
        LineKind::ToolOutput => Style::default().fg(Color::DarkGray),
        LineKind::Notice => Style::default().fg(Color::Gray),
        LineKind::Error => Style::default().fg(Color::Red),
    }
}

/// 画一帧
pub(crate) fn render(f: &mut Frame, st: &UiState) {
    // ⚠️ 整帧往右收 RIGHT_MARGIN 列：任何一行都不去碰屏的最后一格（否则 conhost 会整屏上滚，
    //    见 `RIGHT_MARGIN`）。收窄后各部件拿到的 `rows[i]` 已同步变窄，无需逐个改。
    let outer = f.area();
    let area = Rect {
        width: outer.width.saturating_sub(RIGHT_MARGIN),
        ..outer
    };
    let it_rows = panel_rows(st);
    let rows = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(it_rows),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_inflight(f, st, rows[0]);
    // 面板二选一：引擎交互（必须应答）优先于本地选择面板
    match (st.interaction(), st.picker()) {
        (Some(it), _) => render_interaction(f, st, it, rows[1]),
        (None, Some(p)) => render_picker(f, p, rows[1]),
        (None, None) => {}
    }
    let cursor = render_input(f, st, rows[2]);
    render_status(f, st, rows[3]);

    // ⚠️ Windows conhost 的**中文残影**修复（实测；见 `docs/AGENTS.md` §11.21、`cli-tui-plan.md` §3.7）：
    //
    // ratatui 的 diff 在「宽字符被窄字符替换」时**不会**重发宽字符的 trailing（第 2 列）——
    // 它只在 previous 宽字符带「可见样式」时才强制重发（`ratatui-core/src/buffer/diff.rs` 的
    // `else` 分支注释写着 “standard wide characters (e.g., CJK), which terminals handle well”）。
    // 但这个假设在 conhost 上不成立：conhost 不会在「写窄字符到宽字符起始列」时自动清掉第 2 列，
    // 于是残留半个/整个汉字（长中文回答滚动、或状态行变短时都能复现：`…可能性。␣␣␣洛`）。
    //
    // 把视口内（**除右侧 RIGHT_MARGIN 两列**，那两列绝不能写，否则触发 §11.19 的整屏上滚）
    // 所有 cell 标为 `AlwaysUpdate`（diff 时绕过相等判断）→ 每帧完整重画这些列，残影无处藏身。
    // 视口只有 10×118，这点重画量可忽略。
    let row_w = usize::from(outer.width);
    let keep = usize::from(area.width);
    for (i, cell) in f.buffer_mut().content.iter_mut().enumerate() {
        if keep == 0 || i % row_w < keep {
            cell.set_diff_option(CellDiffOption::AlwaysUpdate);
        }
    }
    // ⚠️ 两个**显式选择**面板（授权 / 本地选择）都没有文本光标：
    //    ratatui 的 `try_draw` 只看 `frame.cursor_position`，为 `None` 时调 `hide_cursor()`
    //    → **不调** `set_cursor_position` 就是隐藏光标。把光标留在选择行会暗示
    //    「这里可以输入文本」，而那正是旧实现（回车即放行）被误触的根源。
    //    选择类交互仍显示行输入光标。
    let explicit_picker = st.interaction().is_some_and(Interaction::is_confirm)
        || st.picker().is_some();
    if !explicit_picker {
        f.set_cursor_position(cursor);
    }
}

/// 在飞内容：只显示**尾部**（视口高度固定，装不下就滚尾部 —— 这是设计的硬约束）
fn render_inflight(f: &mut Frame, st: &UiState, area: ratatui::layout::Rect) {
    let mut items: Vec<(LineKind, String)> = expand(st.inflight())
        .into_iter()
        .map(|(k, s)| (k, s.to_string()))
        .collect();
    // 工具实时输出尾部（长命令的进度看得见，但不会把动态区顶满）
    let tail: Vec<&str> = st.tool_tail().lines().collect();
    for line in tail.iter().rev().take(TOOL_TAIL_ROWS).rev() {
        items.push((LineKind::ToolOutput, format!("  ⎿ {}", line)));
    }
    let cap = area.height as usize;
    let start = items.len().saturating_sub(cap);
    let lines: Vec<Line> = items[start..]
        .iter()
        .map(|(k, s)| Line::from(Span::styled(s.as_str(), style_of(*k))))
        .collect();
    f.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }),
        area,
    );
}

/// 面板行数（0 = 不显示）
///
/// 交互面板（引擎发起）优先于本地选择面板：两者不会同时开，真同时开时以引擎那条为准
/// —— 它必须被应答，否则引擎会一直等回执。
fn panel_rows(st: &UiState) -> u16 {
    if let Some(it) = st.interaction() {
        interaction_rows(it)
    } else if let Some(p) = st.picker() {
        picker_rows(p)
    } else {
        0
    }
}

/// 本地选择面板的行数：标题 + 选项 + 键位提示
fn picker_rows(p: &Picker) -> u16 {
    (p.options.len() as u16)
        .saturating_add(2)
        .min(INTERACTION_MAX_ROWS)
}

/// 交互面板：提示行数（0 = 不显示）
fn interaction_rows(it: &Interaction) -> u16 {
    let body = body_lines(it).len() as u16;
    // +1 = 回答行
    (body + 1).min(INTERACTION_MAX_ROWS)
}

/// 交互面板的正文行（回答行单独渲染，因为那里要放光标）
fn body_lines(it: &Interaction) -> Vec<String> {
    let mut out = Vec::new();
    if it.is_confirm() {
        out.push(format!(
            "⚠ 需要授权: {}（风险: {}）",
            it.question(),
            if it.risk().is_empty() {
                "unknown".to_string()
            } else {
                it.risk()
            }
        ));
        if !it.desc().is_empty() {
            out.push(format!("  内容: {}", it.desc()));
        }
        if !it.hint().is_empty() {
            out.push(format!("  {}", it.hint()));
        }
    } else {
        out.push(format!("? {}", it.question()));
        for (i, o) in it.options().iter().enumerate() {
            out.push(format!("  {}. {}", i + 1, o));
        }
    }
    out
}

/// 回答行的提示（选项 / 输入区之前的那段）
fn answer_prefix(it: &Interaction) -> String {
    if it.is_confirm() {
        // 不再写 `[y/N]`：授权不再是「回车即放行」的行输入，而是二选一（见 `answer_row`）
        "  允许执行？".to_string()
    } else if it.multi() {
        "  选择（序号或文本，逗号分隔可多选）: ".to_string()
    } else {
        "  选择（序号或文本）: ".to_string()
    }
}

/// 回答行：
/// - 授权（`confirm`）= **显式二选一**，选中的那个加方括号 + 反白加粗，默认选中「拒绝」；
/// - 其它 = 行输入（提示 + 已输入文本）。
///
/// ⚠️ 方括号不是装饰：它让「当前选中的是哪一项」在**纯文本上也可断言**
/// （`view/tests.rs` 直接断言 `[拒绝]` / `[允许]`），不必逐格去读 `REVERSED`。
fn answer_row(it: &Interaction) -> Line<'static> {
    let prefix = Span::styled(answer_prefix(it), Style::default().fg(Color::Magenta));
    if !it.is_confirm() {
        return Line::from(vec![
            prefix,
            Span::styled(
                it.input.clone(),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
        ]);
    }

    let mut spans = vec![prefix];
    for choice in [ConfirmChoice::Deny, ConfirmChoice::Allow] {
        let selected = it.confirm == choice;
        let style = if selected {
            let color = if choice == ConfirmChoice::Allow {
                Color::Green
            } else {
                Color::Red
            };
            Style::default()
                .fg(color)
                .add_modifier(Modifier::REVERSED | Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        };
        spans.push(Span::styled(
            format!(
                "{}{}{}",
                if selected { "[" } else { " " },
                choice.label(),
                if selected { "]" } else { " " }
            ),
            style,
        ));
        spans.push(Span::raw(" "));
    }
    // 分隔符用 ASCII `|`（不用 `·`）：`·` 是「歧义宽度」字符 —— ratatui 算 1 列、
    // conhost 在 CJK 字体下推进 2 列，同一行里会累积错位（见本文件 `RIGHT_MARGIN`）
    spans.push(Span::styled(
        "（←/→ 选择 | Enter 确认）",
        Style::default().fg(Color::DarkGray),
    ));
    Line::from(spans)
}

/// 本地选择面板（TUI 自己发起的，如「压缩方式」）。
///
/// 与授权面板同款的**显式选择器**：选中项加方括号 + 反白加粗（方括号让「选了哪一项」
/// 在纯文本上也可断言，`view/tests.rs` 直接断言 `[AI 摘要]`），分隔符用 ASCII `|`
/// （`·` 是歧义宽度字符，同一行里会累积错位，见本文件 `RIGHT_MARGIN`）。
fn render_picker(f: &mut Frame, p: &Picker, area: ratatui::layout::Rect) {
    let mut lines = vec![Line::from(Span::styled(
        format!("? {}", p.purpose.title()),
        Style::default().fg(Color::Magenta),
    ))];
    for (i, opt) in p.options.iter().enumerate() {
        let selected = i == p.index;
        let style = if selected {
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::REVERSED | Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        };
        lines.push(Line::from(Span::styled(
            format!(
                "  {}{}{}",
                if selected { "[" } else { " " },
                opt.label,
                if selected { "]" } else { " " }
            ),
            style,
        )));
    }
    lines.push(Line::from(Span::styled(
        "  （↑/↓ 选择 | Enter 确认 | Esc 取消）",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn render_interaction(f: &mut Frame, _st: &UiState, it: &Interaction, area: ratatui::layout::Rect) {
    let body = body_lines(it);
    // 行数不够时丢掉中间的正文行（保留第一行与回答行）
    let keep = area.height.saturating_sub(1) as usize;
    let shown: Vec<String> = if body.len() <= keep {
        body
    } else {
        body[..keep].to_vec()
    };
    let mut lines: Vec<Line> = shown
        .iter()
        .map(|s| {
            Line::from(Span::styled(
                s.as_str(),
                Style::default().fg(Color::Magenta),
            ))
        })
        .collect();
    lines.push(answer_row(it));
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

/// 输入行（返回光标位置）
fn render_input(f: &mut Frame, st: &UiState, area: ratatui::layout::Rect) -> Position {
    let input = st.input();
    let line = Line::from(vec![
        Span::styled("> ", Style::default().fg(Color::Cyan)),
        Span::raw(input),
    ]);
    f.render_widget(Paragraph::new(line), area);
    // 光标按**显示列宽**定位（中文占 2 列；按字符数算会偏）
    let prefix: String = input.chars().take(st.cursor()).collect();
    let x = area
        .x
        .saturating_add(2)
        .saturating_add(UnicodeWidthStr::width(prefix.as_str()) as u16)
        .min(area.right().saturating_sub(1));
    // 光标行：有面板时在面板的最后一行附近（输入行上移了一行）
    let y = if st.interaction().is_some() || st.picker().is_some() {
        area.y.saturating_sub(1)
    } else {
        area.y
    };
    Position::new(x, y)
}

fn render_status(f: &mut Frame, st: &UiState, area: ratatui::layout::Rect) {
    let spinner = if st.busy() {
        ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"][(st.frame() as usize) % 8]
    } else {
        "·"
    };
    let s = &st.status;
    let short_id: String = s.session_id.chars().take(8).collect();
    let ws = s
        .workspace
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string();
    let mut parts = vec![format!("{} {}", spinner, if s.model.is_empty() { "-" } else { &s.model })];
    if !short_id.is_empty() {
        parts.push(short_id);
    }
    if !ws.is_empty() {
        parts.push(ws);
    }
    if let Some(t) = s.tokens {
        parts.push(format!("{} tok", t));
    }
    // 上下文占用（用户要求：显示百分比；100% 对应 200k，口径与桌面端 token 环一致）。
    // 没有用量数据时**不显示**这一项（而不是显示 0% —— 那会让人以为上下文是空的）。
    if let Some(used) = s.context_tokens {
        parts.push(format!(
            "{}% ({}/{})",
            agent_compress::context_percent(used),
            agent_compress::format_tokens(used),
            agent_compress::format_tokens(agent_compress::CONTEXT_WINDOW_TOKENS)
        ));
    }
    if let Some(ms) = st.elapsed_ms() {
        parts.push(format!("{:.1}s", ms as f64 / 1000.0));
    }
    let hint = if st.compressing() {
        "正在压缩上下文…"
    } else if st.running() {
        "Esc 取消"
    } else {
        "/help | /exit"
    };
    parts.push(hint.to_string());
    // ⚠️ 状态行有两处「看着多余、删了就出 bug」的处理（实测见 `RIGHT_MARGIN`）：
    //
    //   1. 颜色只落在 **Span** 上：`Paragraph::new(x).style(s)` 会把文本之后的空格格也
    //      涂上样式 → 这些格在 diff 里「变了」→ 被逐格重画到行尾；而画到屏底行的最后一格
    //      会触发控制台**整屏上滚一行**（ratatui 不知道）→ 正文比模型偏上一行、光标压在
    //      状态行上、输入的文字覆盖状态行（就是用户实测到的那个现象）。
    //   2. 文本裁到 `width_cjk ≤ 区宽 - RIGHT_MARGIN` 后再**用空格补满**：
    //      · 补满是必需的 —— 不补，状态行变短时上一个状态的残字会留在屏上（如 `/exi t`）；
    //      · 用 `width_cjk` 是因为 `·`、`—` 这类「歧义宽度」字符在 CJK 字体/区域下由终端
    //        按 2 列推进，按 1 列算会低估（实测：低估 4 列就把画出的宽度顶到了 122 > 120）；
    //      · 再退 RIGHT_MARGIN 列：实测「空格尾」比「文字尾」敏感 —— 同样画到 118 格，
    //        文字尾不上滚（`long_spanstyle`），空格尾上滚（`t2`）。文本与补白用同一个上限，
    //        所有帧就都只画 `[0, 上限)`，残字无处藏身。
    //   3. **分隔符用 ASCII `|`，不用 `·`**：`·`(U+00B7) 是「歧义宽度」字符 —— ratatui 按
    //      1 列排版、而 conhost 在 CJK 字体下按 2 列推进，两边不一致；一旦整帧重绘（§11.21 的
    //      `AlwaysUpdate`）就会累积错位、把尾部顶乱（实测：运行中状态行会变成 `… Documents1.1s · Es消`）。
    //      ASCII 字符两边宽度一致，不会错位。
    let text = status_line(&parts.join(" | "), area.width.saturating_sub(RIGHT_MARGIN));
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            text,
            Style::default().fg(Color::Cyan),
        ))),
        area,
    );
}

/// 状态行的最终文本：按**最坏情况显示宽度**（`width_cjk`：歧义宽度算 2 列）截断，再用空格补满
/// 到 `max_cols`。
///
/// 两个保证（状态行落在屏底行上，必须成立；见 `RIGHT_MARGIN`）：
/// * 终端实际推进的列数 ≤ `max_cols`（含 CJK 字体把 `·` 当宽字符的情况）；
/// * 行的整段都被涂过 —— 状态行变短不会留下上一帧的残字。
fn status_line(s: &str, max_cols: u16) -> String {
    let max = usize::from(max_cols);
    let mut out = String::new();
    let mut used = 0usize;
    for ch in s.chars() {
        let w = UnicodeWidthChar::width_cjk(ch).unwrap_or(0);
        if used + w > max {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.extend(std::iter::repeat_n(' ', max - used));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::state::{Key, OutLine, UiEvent};
    use ratatui::backend::TestBackend;
    use ratatui::{Terminal, TerminalOptions, Viewport};
    use serde_json::json;
    use virlen_core::agent::compress::CompressMode;

    const H: u16 = crate::tui::term::VIEWPORT_H;

    fn term(w: u16, h: u16) -> Terminal<TestBackend> {
        Terminal::with_options(
            TestBackend::new(w, h),
            TerminalOptions {
                viewport: Viewport::Inline(H),
            },
        )
        .unwrap()
    }

    /// 把整屏转成文本（内联视口在屏幕底部，所以断言用 `contains`，不假设偏移）
    ///
    /// ⚠️ 必须**跳过宽字符后面的填充格**：`TestBackend` 给每个宽字符（中文/emoji）后面补一个
    /// 空格格，逐格取 `symbol()` 会得到 `你 好`，任何中文断言都会假失败。
    fn text_of(t: &Terminal<TestBackend>) -> String {
        let buf = t.backend().buffer();
        let mut out = String::new();
        for y in 0..buf.area.height {
            let mut x = 0u16;
            while x < buf.area.width {
                let sym = buf[(x, y)].symbol();
                out.push_str(sym);
                x += UnicodeWidthStr::width(sym).max(1) as u16;
            }
            out.push('\n');
        }
        out
    }

    /// 提交一条输入（让状态机进入「运行中」）
    fn submit(st: &mut UiState, text: &str) {
        for c in text.chars() {
            st.apply_key(Key::Char(c));
        }
        st.apply_key(Key::Enter);
    }

    fn state() -> UiState {
        let mut st = UiState::new();
        st.apply(UiEvent::SessionChanged {
            session_id: "0123456789abcdef".into(),
            title: "t".into(),
            model: "deepseek-chat".into(),
            workspace: "E:/code/virlen".into(),
            messages: 2,
        });
        let _ = st.take_commit();
        st
    }

    fn draw(st: &UiState) -> String {
        let mut t = term(60, 20);
        t.draw(|f| render(f, st)).unwrap();
        text_of(&t)
    }

    /// 推入一次授权请求（`confirm_command_native`）—— 多处复用
    fn push_confirm(st: &mut UiState) {
        st.apply(UiEvent::Interaction {
            request_id: "r1".into(),
            kind: "confirm_command_native".into(),
            data: json!({
                "title": "删除目录", "desc": "rm -rf build", "hint": "不可恢复",
                "risk": "dangerous"
            }),
        });
    }

    #[test]
    fn renders_transcript_input_and_status() {
        let mut st = state();
        st.apply(UiEvent::TextDelta {
            message_id: "m1".into(),
            delta: "你好，世界".into(),
        });
        let text = draw(&st);
        assert!(text.contains("你好，世界"), "{text}");
        assert!(text.contains("> "), "输入框提示: {text}");
        assert!(text.contains("deepseek-chat"), "状态行: {text}");
        assert!(text.contains("virlen"), "工作目录短名: {text}");
        assert!(text.contains("/help"), "空闲提示: {text}");
    }

    #[test]
    fn input_and_cursor_survive_cjk() {
        let mut st = state();
        for c in "帮我看看".chars() {
            st.apply_key(Key::Char(c));
        }
        let text = draw(&st);
        assert!(text.contains("> 帮我看看"), "{text}");
        // 光标在中文之后：视觉列宽 = 2（"> "） + 8（四个汉字）
        let mut t = term(60, 20);
        t.draw(|f| render(f, &st)).unwrap();
        let pos = t.get_cursor_position().unwrap();
        assert_eq!(pos.x, 10);
    }

    #[test]
    fn in_flight_tail_keeps_the_last_rows_only() {
        let mut st = state();
        for i in 0..40 {
            st.apply(UiEvent::TextDelta {
                message_id: "m1".into(),
                delta: format!("第 {} 行\n", i + 1),
            });
        }
        let text = draw(&st);
        assert!(text.contains("第 40 行"), "{text}");
        assert!(text.contains("第 39 行"), "尾部若干行应在: {text}");
        assert!(!text.contains("第 1 行\n"), "最上面的行应被滚掉: {text}");
    }

    #[test]
    fn tool_lines_and_live_output_are_visible() {
        let mut st = state();
        submit(&mut st, "hi");
        st.apply(UiEvent::ToolStart {
            id: "tc1".into(),
            name: "execute_command".into(),
            detail: "npm test".into(),
        });
        st.apply(UiEvent::ToolOutput {
            chunk: "PASS src/a.test.ts\n".into(),
        });
        let text = draw(&st);
        assert!(text.contains("execute_command(npm test)"), "{text}");
        assert!(text.contains("PASS src/a.test.ts"), "实时输出尾部: {text}");
        assert!(text.contains("> hi"), "用户输入应回显: {text}");
        // 用宽一点的终端断言「运行中提示」：窄终端（60 列）下状态行会按最坏情况（CJK）宽度
        // 截断，`取消` 会被裁掉——那是设计行为（见 `RIGHT_MARGIN`），不是要在这里断言的。
        let mut t = term(120, 20);
        t.draw(|f| render(f, &st)).unwrap();
        let text = text_of(&t);
        assert!(text.contains("Esc 取消"), "运行中状态行: {text}");
    }

    /// 回归（conhost 实测，见 `docs/AGENTS.md` §11.21）：状态行**不能**用「歧义宽度」字符
    /// （如 `·` U+00B7）当分隔符 —— ratatui 按 1 列排版、终端按 2 列推进，两边不一致，在
    /// 「整帧重绘」时会累积错位、把尾部顶乱。这里断言状态行里没有这类字符。
    #[test]
    fn status_line_has_no_ambiguous_width_chars() {
        let mut st = state();
        submit(&mut st, "hi");
        let mut t = term(120, 20);
        t.draw(|f| render(f, &st)).unwrap();
        let text = text_of(&t);
        let status = text
            .lines()
            .find(|l| l.contains("deepseek-chat"))
            .expect("应有状态行");
        for ch in ['\u{00B7}', '\u{2014}', '\u{00D7}'] {
            assert!(!status.contains(ch), "状态行含歧义宽度字符 {ch:?}: {status:?}");
        }
    }

    /// 授权面板是**显式二选一**：两个选项都可见、默认高亮「拒绝」、**不显示文本光标**。
    ///
    /// 回归背景（fail-open → fail-closed）：旧实现是「行输入 + 回车放行」，提示写着 `[y/N]`
    /// 但空白输入会被当作「允许」，光标还停在回答行暗示「这里可以打字」—— 用户正在打
    /// 下一句消息时误触一次 Enter，就等于批准了一条危险命令。
    #[test]
    fn confirm_panel_is_an_explicit_picker_with_deny_preselected() {
        let mut st = state();
        push_confirm(&mut st);
        let text = draw(&st);
        assert!(text.contains("需要授权"), "{text}");
        assert!(text.contains("删除目录"), "{text}");
        assert!(text.contains("dangerous"), "{text}");
        assert!(text.contains("rm -rf build"), "{text}");
        // 显式选择：默认选中「拒绝」，「允许」未被选中
        assert!(text.contains("[拒绝]"), "默认应高亮拒绝: {text}");
        assert!(!text.contains("[允许]"), "默认不得高亮允许: {text}");
        // 「回车即放行」的暗示必须消失
        assert!(!text.contains("[y/N]"), "{text}");

        let mut t = term(60, 20);
        t.draw(|f| render(f, &st)).unwrap();
        assert!(
            !t.backend().cursor_visible(),
            "授权面板没有文本输入，不应显示光标"
        );
    }

    /// → / ↓ 把高亮移到「允许」；← / ↑ 移回「拒绝」（两端不越界）
    #[test]
    fn confirm_panel_highlight_follows_arrow_keys() {
        let mut st = state();
        push_confirm(&mut st);

        st.apply_key(Key::Right);
        let text = draw(&st);
        assert!(text.contains("[允许]"), "{text}");
        assert!(!text.contains("[拒绝]"), "{text}");

        st.apply_key(Key::Down);
        assert!(draw(&st).contains("[允许]"), "↓ 与 → 同向");

        st.apply_key(Key::Left);
        let text = draw(&st);
        assert!(text.contains("[拒绝]"), "← 应移回拒绝: {text}");
        assert!(!text.contains("[允许]"), "{text}");

        st.apply_key(Key::Up);
        assert!(draw(&st).contains("[拒绝]"), "↑ 与 ← 同向");
    }

    /// 选择类交互（`user_choice`）仍是行输入：光标显示在回答行上
    #[test]
    fn choice_panel_keeps_the_line_input_cursor() {
        let mut st = state();
        st.apply(UiEvent::Interaction {
            request_id: "r1".into(),
            kind: "user_choice".into(),
            data: json!({ "question": "q", "options": ["A"] }),
        });
        let mut t = term(60, 20);
        t.draw(|f| render(f, &st)).unwrap();
        assert!(t.backend().cursor_visible(), "行输入类交互应显示光标");
        let pos = t.get_cursor_position().unwrap();
        assert!(pos.y >= H - 3, "光标应在底部区域: {pos:?}");
    }

    #[test]
    fn choice_panel_lists_options() {
        let mut st = state();
        st.apply(UiEvent::Interaction {
            request_id: "r1".into(),
            kind: "user_choice".into(),
            data: json!({ "question": "用哪个方案？", "options": ["方案 A", "方案 B"], "multi": true }),
        });
        let text = draw(&st);
        assert!(text.contains("用哪个方案？"), "{text}");
        assert!(text.contains("1. 方案 A"), "{text}");
        assert!(text.contains("2. 方案 B"), "{text}");
        assert!(text.contains("可多选"), "{text}");
    }

    /// 极小终端（比视口还矮）不能 panic —— 用户拖窗口时会真的发生
    #[test]
    fn tiny_terminal_does_not_panic() {
        let mut st = state();
        st.apply(UiEvent::Interaction {
            request_id: "r1".into(),
            kind: "user_choice".into(),
            data: json!({ "question": "q", "options": ["A", "B", "C", "D", "E", "F"] }),
        });
        for (w, h) in [(20u16, 3u16), (10, 2), (5, 1), (1, 1)] {
            let mut t = term(w, h);
            t.draw(|f| render(f, &st)).unwrap();
        }
    }

    /// `/status` 那种长提示在视口里也只显示尾部
    #[test]
    fn long_notice_scrolls() {
        let mut st = state();
        let long: String = (1..=30).map(|i| format!("第 {} 行\n", i)).collect();
        st.apply(UiEvent::Notice(long));
        let text = draw(&st);
        assert!(text.contains("第 30 行"), "{text}");
        assert!(!text.contains("第 1 行"), "开头应被滚掉: {text}");
    }

    #[test]
    fn expand_and_styles_are_wired() {
        let l = OutLine::new(LineKind::Error, "boom");
        assert_eq!(style_of(l.kind).fg, Some(Color::Red));
    }

    /// 找状态行在 TestBackend 里的 y（按内容找，不假设视口原点）
    fn status_row(t: &Terminal<TestBackend>, needle: &str) -> u16 {
        let buf = t.backend().buffer();
        for y in 0..buf.area.height {
            let row: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
            if row.contains(needle) {
                return y;
            }
        }
        panic!("找不到状态行（找不到 {needle}）");
    }

    /// 回归（真机实测：cmd.exe 里“输入的文字覆盖状态行”）：
    ///
    /// 状态行有两条必须同时成立的性质 —— 左边不够会留残字，过了头就会把 conhost 整屏顶上去：
    ///
    /// 1. **涂满动态区**（文本 + 空格补白）：否则状态行变短时（如 `Esc 取消` → `/help · /exit`）
    ///    上一帧的残字会留在屏上；
    /// 2. **绝不碰屏的最后两列**：写到行尾会让 conhost 留下「待换行」，一旦兑现时已在屏底就
    ///    **整屏上滚一行**（ratatui 不知道）→ 正文比模型偏上一行、光标压到状态行上。
    #[test]
    fn status_row_is_fully_painted_but_never_touches_the_screen_edge() {
        let st = state();
        let mut t = term(60, 20);
        t.draw(|f| render(f, &st)).unwrap();
        let buf = t.backend().buffer();
        let w = buf.area.width;
        let y = status_row(&t, "/exit");
        let row: String = (0..w).map(|x| buf[(x, y)].symbol()).collect();
        // 歧义宽度字符（`·` 等）在 CJK 字体/区域下由终端按 2 列推进，而 ratatui 只画 1 格
        // → 补白的格子数会少这么多（补白是按 width_cjk 算的）。
        let amb = row
            .chars()
            .filter(|c| UnicodeWidthChar::width_cjk(*c) != UnicodeWidthChar::width(*c))
            .count();
        let styled = (0..w).filter(|&x| buf[(x, y)].fg != Color::Reset).count();
        assert_eq!(
            styled + amb,
            usize::from(w - RIGHT_MARGIN - RIGHT_MARGIN),
            "状态行没涂满（残字风险）或越过了右侧保留列：styled={styled} amb={amb} w={w}"
        );
        assert_eq!(buf[(w - 1, y)].fg, Color::Reset, "最后一列绝不能写");
        assert_eq!(buf[(w - 2, y)].fg, Color::Reset, "倒数第二列绝不能写");
    }

    /// 窄终端 + 超长状态文本：按 `width_cjk` 截断，绝不越界；且仍保持上面那两条性质
    #[test]
    fn status_text_is_clipped_away_from_the_last_cells() {
        let mut st = state();
        st.apply(UiEvent::SessionChanged {
            session_id: "0123456789abcdef".into(),
            title: "t".into(),
            model: "a-very-long-model-name-aaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            workspace: "E:/code/virlen/virlen-app".into(),
            messages: 2,
        });
        let _ = st.take_commit();
        let mut t = term(40, 12);
        t.draw(|f| render(f, &st)).unwrap();
        let buf = t.backend().buffer();
        let w = buf.area.width;
        let y = status_row(&t, "a-very-long");
        for x in (w - 2)..w {
            assert_eq!(buf[(x, y)].fg, Color::Reset, "窄终端下第 {x} 格也不该被写");
        }
        let styled = (0..w).filter(|&x| buf[(x, y)].fg != Color::Reset).count();
        assert!(
            styled > 0 && styled + usize::from(RIGHT_MARGIN) * 2 <= usize::from(w),
            "{styled}/{w}"
        );
        // 文本被截断：超长模型名不会完整出现
        let row: String = (0..w).map(|x| buf[(x, y)].symbol()).collect();
        assert!(!row.contains("aaaaaaaaaaaaaaaaaaaa"), "{row}");
    }

    /// 状态行显示上下文占用百分比（100% = 200k；口径与桌面端 token 环一致）
    #[test]
    fn status_line_shows_context_percent() {
        let mut st = state();
        submit(&mut st, "hi");
        st.apply(UiEvent::ContextUsage {
            tokens: Some(40_000),
        });
        let text = draw(&st);
        assert!(text.contains("20%"), "应有百分比: {text}");
        assert!(text.contains("40k"), "应带上绝对 token: {text}");
        assert!(text.contains("200k"), "应写明 100% 对应的窗口: {text}");
    }

    /// 没有用量数据时**不显示**百分比：`0%` 会被读成「上下文是空的」
    #[test]
    fn status_line_hides_percent_without_usage_data() {
        let mut st = state();
        submit(&mut st, "hi");
        let text = draw(&st);
        assert!(!text.contains('%'), "无用量时不应出现百分比: {text}");
    }

    /// 压缩方式选择面板：两项都可见、选中项加方括号（纯文本可断言）、**不显示文本光标**
    #[test]
    fn compress_picker_lists_modes_without_cursor() {
        let mut st = state();
        st.apply(UiEvent::DefaultCompressMode(CompressMode::Raw));
        for c in "/compress".chars() {
            st.apply_key(Key::Char(c));
        }
        st.apply_key(Key::Enter);
        let text = draw(&st);
        assert!(text.contains("压缩上下文：选择方式"), "{text}");
        assert!(text.contains("AI 摘要"), "{text}");
        assert!(text.contains("正文压缩"), "{text}");
        assert!(text.contains("[正文压缩（默认）]"), "默认方式应预选: {text}");

        let mut t = term(60, 20);
        t.draw(|f| render(f, &st)).unwrap();
        assert!(
            !t.backend().cursor_visible(),
            "显式选择面板没有文本输入，不应显示光标"
        );
    }

    /// 压缩中：状态行给提示（用户在等一次模型调用，得知道在发生什么）
    #[test]
    fn status_line_says_compressing() {
        let mut st = state();
        st.apply(UiEvent::Compressing(true));
        let text = draw(&st);
        assert!(text.contains("正在压缩上下文"), "{text}");
    }
}
