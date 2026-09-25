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

use crate::tui::state::{expand, Interaction, LineKind, UiState};
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

/// 交互面板最多占几行（其余空间留给在飞内容）
const INTERACTION_MAX_ROWS: u16 = 6;
/// 工具实时输出在动态区里最多显示几行尾部
const TOOL_TAIL_ROWS: usize = 3;

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
    let it_rows = st
        .interaction()
        .map(|_| interaction_rows(st.interaction().expect("已判空")))
        .unwrap_or(0);
    let rows = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(it_rows),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(f.area());

    render_inflight(f, st, rows[0]);
    if let Some(it) = st.interaction() {
        render_interaction(f, st, it, rows[1]);
    }
    let cursor = render_input(f, st, rows[2]);
    render_status(f, st, rows[3]);
    f.set_cursor_position(cursor);
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

/// 回答行的提示（光标前的那段）
fn answer_prefix(it: &Interaction) -> String {
    if it.is_confirm() {
        "  允许执行？[y/N] ".to_string()
    } else if it.multi() {
        "  选择（序号或文本，逗号分隔可多选）: ".to_string()
    } else {
        "  选择（序号或文本）: ".to_string()
    }
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
    lines.push(Line::from(vec![
        Span::styled(answer_prefix(it), Style::default().fg(Color::Magenta)),
        Span::styled(
            it.input.clone(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
    ]));
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
    // 光标行：有交互时在交互面板的回答行上（那才是此刻在打字的地方）
    let y = match st.interaction() {
        Some(_) => area.y.saturating_sub(1),
        None => area.y,
    };
    Position::new(x, y)
}

fn render_status(f: &mut Frame, st: &UiState, area: ratatui::layout::Rect) {
    let spinner = if st.running() {
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
    if let Some(ms) = st.elapsed_ms() {
        parts.push(format!("{:.1}s", ms as f64 / 1000.0));
    }
    let hint = if st.running() {
        "Esc 取消"
    } else {
        "/help · /exit"
    };
    parts.push(hint.to_string());
    f.render_widget(
        Paragraph::new(parts.join(" · ")).style(Style::default().fg(Color::Cyan)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::state::{Key, OutLine, UiEvent};
    use ratatui::backend::TestBackend;
    use ratatui::{Terminal, TerminalOptions, Viewport};
    use serde_json::json;

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

    #[test]
    fn renders_transcript_input_and_status() {
        let mut st = state();
        st.apply(UiEvent::TextDelta("你好，世界".into()));
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
            st.apply(UiEvent::TextDelta(format!("第 {} 行\n", i + 1)));
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
        assert!(text.contains("Esc 取消"), "运行中状态行: {text}");
    }

    #[test]
    fn confirm_panel_shows_risk_and_cursor_moves_to_answer() {
        let mut st = state();
        st.apply(UiEvent::Interaction {
            request_id: "r1".into(),
            kind: "confirm_command_native".into(),
            data: json!({
                "title": "删除目录", "desc": "rm -rf build", "hint": "不可恢复",
                "risk": "dangerous"
            }),
        });
        let text = draw(&st);
        assert!(text.contains("需要授权"), "{text}");
        assert!(text.contains("删除目录"), "{text}");
        assert!(text.contains("dangerous"), "{text}");
        assert!(text.contains("rm -rf build"), "{text}");
        assert!(text.contains("[y/N]"), "{text}");

        let mut t = term(60, 20);
        t.draw(|f| render(f, &st)).unwrap();
        let pos = t.get_cursor_position().unwrap();
        // 光标应在交互回答行（输入行的上一行）
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
}
