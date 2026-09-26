//! 终端接管与恢复 —— raw mode、内联视口、**四条健壮性措施**、降级判定
//!
//! ## 为什么这里写得这么"怂"（每处都要重试）
//!
//! 实测结论（`docs/cli-tui-plan.md` §3.2）：Windows 上**改窗口尺寸期间，conhost 会让
//! `CONOUT$` 相关查询/写入短暂失败**（`os error 233`，`ERROR_PIPE_NOT_CONNECTED`），
//! 约 0.25–5 s 后自愈 —— 而 `Terminal::draw` / `size()` / `insert_before` 都会走这条路径。
//!
//! 真正让用户看到「崩溃退出」的是**我们自己的写法**：把瞬时失败当致命错误 →
//! 退出路径 `println!` 又失败 → `std` panic → abort（`0xC0000409`）。因此：
//!
//! 1. **resize 去抖**：收到 resize 后 300ms 内不碰终端（`note_resize` / `in_debounce`），
//!    且调用方必须**把读事件排在绘制之前**；
//! 2. **退避重试**：`draw` / `commit` / `size` 失败先记日志 + 退避 250ms 重试；
//! 3. **禁止 `println!`**：一切输出走 `writeln!` 且忽略错误；自装 panic 钩子先把消息与
//!    backtrace 落盘（终端会被 restore 冲掉，屏幕上的字留不住）；
//! 4. **降级**：连续失败超阈值（20 × 250ms ≈ 5s）→ 返回 `Err`，调用方切「顺序输出模式」。

use crate::tui::state::{expand, OutLine, UiState};
use crate::tui::view;
use ratatui::backend::CrosstermBackend;
use ratatui::buffer::{Buffer, CellWidth};
use ratatui::crossterm::cursor;
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use ratatui::{DefaultTerminal, Terminal, TerminalOptions, Viewport};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Once;
use std::time::{Duration, Instant};

/// 内联视口高度。
///
/// ⚠️ `ratatui-core` 的 `Terminal.viewport` 是私有字段，`Terminal::resize(area)` 对内联视口只用
/// 「构造期的高度」重算原点 → 运行期改不了高度（除非重建 Terminal）。因此这个常量就是「在飞内容
/// 尾巴 + 交互面板 + 输入行 + 状态行」的硬上限。
pub(crate) const VIEWPORT_H: u16 = 10;

/// resize 去抖窗口：这段时间内完全不碰终端
const DEBOUNCE: Duration = Duration::from_millis(300);
/// 单次失败后的退避
const BACKOFF: Duration = Duration::from_millis(250);
/// 连续失败上限（20 × 250ms ≈ 5s）→ 降级
const MAX_FAILS: u32 = 20;

/// 诊断日志（崩溃 / 失败 / 恢复都记这里）。
///
/// 放**临时目录**而不是数据目录：数据目录可能不可写，而这条日志恰恰要在"什么都可能坏"的时候可用。
pub(crate) fn log_path() -> PathBuf {
    std::env::temp_dir().join("virlen-cli-tui.log")
}

/// 记一行日志（**永远忽略错误** —— 日志写不进去也不能影响主流程）
pub(crate) fn log(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

/// 措施 #3：自装 panic 钩子。
///
/// 装在最外层（`ratatui::init` 的前面也没关系：它在恢复终端后会调用**上一层**钩子），
/// 这样无论谁 panic：先恢复终端 → 再把消息 + backtrace 落盘。
///
/// 只装一次（进程级）：重复装会把自己的钩子串成一条链，日志重复且难读。
fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // ⚠️ 这里绝对不能 println!/eprintln!（stdout 可能正是坏掉的那个）→ 一律 writeln! + 忽略错误
            let _ = disable_raw_mode();
            let mut out = io::stdout();
            let _ = execute!(out, cursor::Show);
            log(&format!(
                "!!! PANIC: {info}\n!!! BACKTRACE:\n{}",
                std::backtrace::Backtrace::force_capture()
            ));
            prev(info);
        }));
    });
}

/// 终端句柄（进入 = 开 raw mode + 内联视口；离开 = 恢复）
pub(crate) struct Tui {
    terminal: DefaultTerminal,
    quiet_until: Option<Instant>,
    fails: u32,
    commits: usize,
}

impl Tui {
    /// 接管终端。失败时已经把 raw mode 回滚（不留"半接管"状态）。
    pub(crate) fn enter() -> io::Result<Self> {
        install_panic_hook();
        enable_raw_mode()?;
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = match Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(VIEWPORT_H),
            },
        ) {
            Ok(t) => t,
            Err(e) => {
                let _ = disable_raw_mode();
                return Err(e);
            }
        };
        log(&format!(
            "TUI 启动: viewport=Inline({VIEWPORT_H}) size={:?}",
            terminal.size().map(|s| (s.width, s.height))
        ));
        Ok(Self {
            terminal,
            quiet_until: None,
            fails: 0,
            commits: 0,
        })
    }

    /// 收到 resize：进入去抖窗口（窗口内调用方不得绘制）
    pub(crate) fn note_resize(&mut self) {
        self.quiet_until = Some(Instant::now() + DEBOUNCE);
    }

    pub(crate) fn in_debounce(&self) -> bool {
        matches!(self.quiet_until, Some(t) if Instant::now() < t)
    }

    /// 恢复终端（消费 self：恢复后不能再画）
    ///
    /// 退出前先清掉**动态区**（视口）：`ratatui` 的 `restore` 只关 raw mode / 显光标，不会擦掉
    /// 已经画在屏幕上的输入框与状态行 —— 不清的话它们会与退出提示、shell 提示符叠在一起。
    /// `Terminal::clear()` 对内联视口是「从视口原点往下清」，**上方已固化的正文不受影响**。
    pub(crate) fn restore(mut self) {
        let _ = self.terminal.clear();
        ratatui::restore();
        log(&format!("TUI 退出: 已 restore，累计固化 {} 批", self.commits));
    }

    /// 画一帧；瞬时失败自动退避重试，连续失败超阈值 → `Err`（调用方切顺序输出模式）
    pub(crate) fn draw(&mut self, st: &UiState) -> Result<(), String> {
        loop {
            // autoresize 与 draw 分开调（draw 内部也会 autoresize）——分开只为把失败点记清楚
            let r = self
                .terminal
                .autoresize()
                .and_then(|()| self.terminal.draw(|f| view::render(f, st)).map(|_| ()));
            match r {
                Ok(()) => {
                    if self.fails > 0 {
                        log(&format!("绘制已恢复（连续失败 {} 次后）", self.fails));
                    }
                    self.fails = 0;
                    return Ok(());
                }
                Err(e) => {
                    self.fails += 1;
                    log(&format!("绘制失败 #{}: {}", self.fails, e));
                    if self.fails >= MAX_FAILS {
                        return Err(format!(
                            "终端连续 {} 次绘制失败（最后一次: {}）",
                            self.fails, e
                        ));
                    }
                    std::thread::sleep(BACKOFF);
                }
            }
        }
    }

    /// 把内容**分块**固化进终端原生滚动区（D9：一次性灌入会被上限截断）
    pub(crate) fn commit(&mut self, lines: &[OutLine]) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }
        let (width, height) = self.size()?;
        // 单次上限 = 终端高 − 视口高（再减去一点余量，避免刚好卡在边界）
        let max_h = (height.saturating_sub(VIEWPORT_H)).max(1) as usize;
        let chunks = chunk(lines, width, max_h);
        for c in chunks {
            let h = out_lines_height(&c, width).clamp(1, max_h) as u16;
            self.insert_before(&c, h)?;
            self.commits += 1;
        }
        log(&format!(
            "固化 {} 行 / {} 批（尺寸 {width}x{height}，单批上限 {max_h} 行）",
            lines.len(),
            self.commits
        ));
        Ok(())
    }

    /// 取终端尺寸（同样要重试：resize 期间 `size()` 正是最先坏的那个）
    fn size(&mut self) -> Result<(u16, u16), String> {
        let mut fails = 0;
        loop {
            match self.terminal.size() {
                Ok(s) => return Ok((s.width.max(1), s.height.max(1))),
                Err(e) => {
                    fails += 1;
                    log(&format!("取终端尺寸失败 #{fails}: {e}"));
                    if fails >= MAX_FAILS {
                        return Err(format!("无法获取终端尺寸（最后一次: {}）", e));
                    }
                    std::thread::sleep(BACKOFF);
                }
            }
        }
    }

    fn insert_before(&mut self, lines: &[OutLine], h: u16) -> Result<(), String> {
        let text = to_text(lines);
        let mut fails = 0;
        loop {
            let para = Paragraph::new(text.clone()).wrap(Wrap { trim: false });
            let r = self.terminal.insert_before(h, |buf| {
                Widget::render(para.clone(), buf.area, buf);
                strip_wide_continuations(buf);
            });
            match r {
                Ok(()) => return Ok(()),
                Err(e) => {
                    fails += 1;
                    log(&format!("insert_before 失败 #{fails}: {e}"));
                    if fails >= MAX_FAILS {
                        return Err(format!("写入滚动区失败（最后一次: {}）", e));
                    }
                    std::thread::sleep(BACKOFF);
                }
            }
        }
    }
}

/// 一批 `OutLine` 的**视觉**行高（按 `width` 换行后）。
///
/// ⚠️ 必须与渲染时用同一套参数（`Wrap { trim: false }`），否则「算 3 行、画 5 行」→ 丢内容。
fn out_lines_height(lines: &[OutLine], width: u16) -> usize {
    expand(lines)
        .iter()
        .map(|(_, s)| {
            Paragraph::new(Line::from(*s))
                .wrap(Wrap { trim: false })
                .line_count(width)
                .max(1)
        })
        .sum()
}

/// 按「视觉高度不超过 max_h」贪心分块（D9）
fn chunk(lines: &[OutLine], width: u16, max_h: usize) -> Vec<Vec<OutLine>> {
    let mut out: Vec<Vec<OutLine>> = Vec::new();
    let mut cur: Vec<OutLine> = Vec::new();
    let mut cur_h = 0usize;
    for l in lines {
        let h = out_lines_height(std::slice::from_ref(l), width);
        if cur_h + h > max_h && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            cur_h = 0;
        }
        cur_h += h;
        cur.push(l.clone());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 修复 ratatui `insert_before`（无 `scrolling-regions` 时）的 continuation 空格 bug。
///
/// 背景（实测，见 `docs/AGENTS.md` §11.19）：
///
/// - 视口内渲染走 `diff_iter`，会跳过宽字符（中文/emoji）后面的 continuation cell；
/// - 但 `insert_before` 在 Windows 上走 `insert_before_no_scrolling_regions`（`scrolling-regions`
///   feature 的 `ScrollUpInRegion` 在 winapi 下直接返回 `Unsupported`，不可用），其 `draw_lines`
///   直接遍历 buffer 的每个 cell，不跳过 continuation —— 而 continuation cell 的 symbol 是空格，
///   于是固化的正文每个宽字符后面多出一个空格（`我 是 你 的`）。
///
/// 这里在交给 `insert_before` 前，把 continuation cell 的 symbol 清成空串：`draw_lines` 输出
/// `Print("")` 就不再有空格。判断口径与 ratatui 内部 diff 的 skip 一致：宽字符（`cell_width ≥ 2`）
/// 后面紧跟的 `(w-1)` 个 cell 就是 continuation。
///
/// ⚠️ 必须 `set_symbol("")` 而不是 `reset()`：`reset` 回到 `symbol = None`，而 `Cell::symbol()`
/// 对 `None` 返回 `" "`（空格），等于没清。
fn strip_wide_continuations(buf: &mut Buffer) {
    let width = buf.area.width as usize;
    for row in buf.content.chunks_mut(width) {
        let mut skip = 0usize;
        for cell in row.iter_mut() {
            if skip > 0 {
                cell.set_symbol("");
                skip -= 1;
            } else {
                skip = (cell.cell_width() as usize).saturating_sub(1);
            }
        }
    }
}

/// `OutLine` → 带样式的 `Text`（颜色与视口里**同一份** `view::style_of`）
fn to_text(lines: &[OutLine]) -> Text<'static> {
    let rows: Vec<Line<'static>> = expand(lines)
        .iter()
        .map(|(k, s)| Line::from(Span::styled(s.to_string(), view::style_of(*k))))
        .collect();
    Text::from(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::state::LineKind;
    use ratatui::layout::Rect;
    use ratatui::style::Style;

    fn ol(kind: LineKind, s: &str) -> OutLine {
        OutLine::new(kind, s)
    }

    #[test]
    fn height_counts_wrapped_lines() {
        // 20 列宽下，30 个 ASCII 字符 = 2 行
        let lines = vec![ol(LineKind::Assistant, &"x".repeat(30))];
        assert_eq!(out_lines_height(&lines, 20), 2);
        // 空行也算 1 行（否则 insert_before 的高度会算少）
        let lines = vec![ol(LineKind::Assistant, "")];
        assert_eq!(out_lines_height(&lines, 20), 1);
        // 内嵌换行按逻辑行分开算
        let lines = vec![ol(LineKind::Assistant, "a\nb")];
        assert_eq!(out_lines_height(&lines, 20), 2);
    }

    /// D9 的回归点：一次性固化超长内容必须被切成多批
    #[test]
    fn chunking_respects_the_height_cap() {
        let lines: Vec<OutLine> = (0..30)
            .map(|i| ol(LineKind::Assistant, &format!("第 {} 行", i + 1)))
            .collect();
        let chunks = chunk(&lines, 40, 4);
        assert!(chunks.len() >= 8, "30 行 / 每批 4 行 → 至少 8 批: {}", chunks.len());
        for c in &chunks {
            assert!(out_lines_height(c, 40) <= 4);
        }
        // 一行都不丢
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), 30);
    }

    /// 单行本身超过上限时也必须能出去（否则会死循环或丢内容）
    #[test]
    fn oversized_single_line_still_gets_a_chunk() {
        let lines = vec![ol(LineKind::Assistant, &"y".repeat(200))];
        let chunks = chunk(&lines, 20, 3);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 1);
    }

    #[test]
    fn to_text_keeps_styles() {
        let t = to_text(&[ol(LineKind::Error, "boom")]);
        assert_eq!(t.lines.len(), 1);
        let span = &t.lines[0].spans[0];
        assert_eq!(span.style.fg, Some(ratatui::style::Color::Red));
        assert_eq!(span.content, "boom");
    }

    #[test]
    fn log_path_is_in_temp_dir() {
        assert!(log_path().to_string_lossy().contains("virlen-cli-tui.log"));
        log("单元测试写日志（应当成功且不 panic）");
        let content = std::fs::read_to_string(log_path()).unwrap_or_default();
        assert!(content.contains("单元测试写日志"));
    }

    /// 回归（真机实测：固化进滚动区的中文正文每个字后多一个空格）：
    /// `strip_wide_continuations` 必须只清宽字符的 continuation，真实空格与 ASCII 不受影响。
    #[test]
    fn strip_wide_continuations_removes_only_the_filler() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 12, 1));
        buf.set_string(0, 0, "你好 世界", Style::default());
        strip_wide_continuations(&mut buf);

        // 宽字符后面的 continuation cell 被清空（不再是空格）
        assert_eq!(buf[(1, 0)].symbol(), "", "「你」的 continuation");
        assert_eq!(buf[(3, 0)].symbol(), "", "「好」的 continuation");
        assert_eq!(buf[(6, 0)].symbol(), "", "「世」的 continuation");
        assert_eq!(buf[(8, 0)].symbol(), "", "「界」的 continuation");

        // 真实空格保留
        assert_eq!(buf[(4, 0)].symbol(), " ");

        // 宽字符本身不受影响
        assert_eq!(buf[(0, 0)].symbol(), "你");
        assert_eq!(buf[(2, 0)].symbol(), "好");
        assert_eq!(buf[(5, 0)].symbol(), "世");
        assert_eq!(buf[(7, 0)].symbol(), "界");
    }

    #[test]
    fn strip_wide_continuations_leaves_ascii_untouched() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 1));
        buf.set_string(0, 0, "AB CD", Style::default());
        strip_wide_continuations(&mut buf);

        let flat: String = (0..5).map(|x| buf[(x, 0)].symbol()).collect();
        assert_eq!(flat, "AB CD");
    }
}
