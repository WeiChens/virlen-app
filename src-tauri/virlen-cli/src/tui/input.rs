//! 终端按键读取与映射
//!
//! **偏离原计划的一处**（`docs/cli-tui-plan.md` §5 里写的是"输入线程 + 通道"）：这里没有单独
//! 起线程，而是由 TUI 线程自己 `poll(60ms)` 读键。理由：状态与绘制都在 TUI 线程，键位处理
//! 又是纯逻辑（`state`），多一个线程只会多一个同步点 —— 而 `poll` 带超时，不会把线程钉死。
//! 唯一的代价是「term 里的退避重试」期间（每次 ≤250ms）按键会晚一拍，可接受。
//!
//! 本模块只做两件事：把 crossterm 的 `KeyEvent` **归一化**成 `state::Key`（纯函数，可单测），
//! 以及把一批待处理事件读出来（含 resize 通知）。

use crate::tui::state::Key;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::time::Duration;

/// crossterm 按键 → 归一化按键；不关心的键返回 `None`
pub(crate) fn map_key(k: &KeyEvent) -> Option<Key> {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    // Alt / Super 组合键不参与（避免把 Alt+G 之类误当普通字符）
    if k.modifiers.contains(KeyModifiers::ALT) || k.modifiers.contains(KeyModifiers::SUPER) {
        return None;
    }
    Some(match k.code {
        KeyCode::Char('c') if ctrl => Key::CtrlC,
        KeyCode::Char('d') if ctrl => Key::CtrlD,
        KeyCode::Char(c) if !ctrl => Key::Char(c),
        KeyCode::Enter => Key::Enter,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Delete => Key::Delete,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Home => Key::Home,
        KeyCode::End => Key::End,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Esc => Key::Esc,
        _ => return None,
    })
}

/// 读一批待处理事件，最多阻塞 `timeout`。返回**收到的 resize 尺寸**（`None` = 没收到）。
///
/// 调用方据此进入去抖窗口（窗口内不碰终端，见 `term.rs` 措施 #1），并把尺寸记进日志 ——
/// 「resize 到底有没有送到」正是排查那类「拖一下就没了」问题时的第一个问号。
pub(crate) fn drain(
    timeout: Duration,
    keys: &mut Vec<Key>,
) -> Result<Option<(u16, u16)>, String> {
    let mut resized = None;
    if !event::poll(timeout).map_err(|e| format!("读取终端事件失败: {}", e))? {
        return Ok(None);
    }
    loop {
        match event::read().map_err(|e| format!("读取终端事件失败: {}", e))? {
            // Release 事件在 Windows 上会跟着 Press 一起来 —— 不滤会变成「按一次出两个字」
            Event::Key(k) if k.kind != KeyEventKind::Release => {
                if let Some(key) = map_key(&k) {
                    keys.push(key);
                }
            }
            Event::Resize(w, h) => resized = Some((w, h)),
            // 未开 bracketed paste 时粘贴会逐字符到 Key 事件；开了这里也只是兜底
            Event::Paste(s) => keys.extend(s.chars().map(Key::Char)),
            _ => {}
        }
        if !event::poll(Duration::ZERO).map_err(|e| format!("读取终端事件失败: {}", e))? {
            break;
        }
    }
    Ok(resized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::KeyEventState;

    fn k(code: KeyCode, m: KeyModifiers) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: m,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }

    #[test]
    fn maps_plain_keys() {
        assert_eq!(
            map_key(&k(KeyCode::Char('中'), KeyModifiers::NONE)),
            Some(Key::Char('中'))
        );
        assert_eq!(map_key(&k(KeyCode::Enter, KeyModifiers::NONE)), Some(Key::Enter));
        assert_eq!(
            map_key(&k(KeyCode::Backspace, KeyModifiers::NONE)),
            Some(Key::Backspace)
        );
        assert_eq!(map_key(&k(KeyCode::Esc, KeyModifiers::NONE)), Some(Key::Esc));
        assert_eq!(map_key(&k(KeyCode::Up, KeyModifiers::NONE)), Some(Key::Up));
        assert_eq!(map_key(&k(KeyCode::Home, KeyModifiers::NONE)), Some(Key::Home));
    }

    #[test]
    fn maps_control_keys() {
        assert_eq!(
            map_key(&k(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(Key::CtrlC)
        );
        assert_eq!(
            map_key(&k(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Some(Key::CtrlD)
        );
        // 其它 Ctrl 组合不产生输入
        assert_eq!(map_key(&k(KeyCode::Char('a'), KeyModifiers::CONTROL)), None);
    }

    #[test]
    fn ignores_alt_and_function_keys() {
        assert_eq!(map_key(&k(KeyCode::Char('g'), KeyModifiers::ALT)), None);
        assert_eq!(map_key(&k(KeyCode::F(1), KeyModifiers::NONE)), None);
        assert_eq!(map_key(&k(KeyCode::Tab, KeyModifiers::NONE)), None);
    }
}
