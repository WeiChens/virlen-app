//! 按键 → 动作（`impl UiState` 的按键处理段）
//!
//! 输入行编辑（按**字符**下标而非字节）、历史上下翻、交互应答的键位、以及 `Ctrl+C` 的两义性
//! （运行中 = 取消，空闲 = 退出）都在这里；`input.rs` 只负责把 crossterm 的按键归一化成 `Key`。

use super::*;
use crate::tui::commands::Slash;
use serde_json::{json, Value};

impl UiState {
    // ==================== 按键 ====================

    /// 处理一个按键；需要异步侧配合时返回动作
    pub(crate) fn apply_key(&mut self, key: Key) -> Option<Action> {
        self.dirty = true;
        if self.interaction.is_some() {
            return self.key_for_interaction(key);
        }
        match key {
            Key::Char(c) => {
                self.insert_char(c);
                None
            }
            Key::Enter => self.submit_input(),
            Key::Backspace => {
                self.backspace();
                None
            }
            Key::Delete => {
                self.delete();
                None
            }
            Key::Left => {
                self.cursor = self.cursor.saturating_sub(1);
                None
            }
            Key::Right => {
                if self.cursor < self.input.chars().count() {
                    self.cursor += 1;
                }
                None
            }
            Key::Home => {
                self.cursor = 0;
                None
            }
            Key::End => {
                self.cursor = self.input.chars().count();
                None
            }
            Key::Up => {
                self.history_prev();
                None
            }
            Key::Down => {
                self.history_next();
                None
            }
            Key::Esc => {
                // 空闲时 Esc 没有可取消的东西（不当成退出，避免误触）
                if self.running {
                    Some(Action::Cancel)
                } else {
                    None
                }
            }
            Key::CtrlC => {
                if self.running {
                    Some(Action::Cancel)
                } else {
                    self.should_quit = true;
                    Some(Action::Quit)
                }
            }
            Key::CtrlD => {
                self.should_quit = true;
                Some(Action::Quit)
            }
        }
    }

    /// 交互待答期间的按键：全部送给交互，不落到输入框
    fn key_for_interaction(&mut self, key: Key) -> Option<Action> {
        let it = self.interaction.as_mut()?;
        match key {
            Key::Char(c) => {
                it.input.push(c);
                None
            }
            Key::Backspace => {
                it.input.pop();
                None
            }
            Key::Enter => {
                let payload = it.answer();
                let line = if it.is_confirm() {
                    if matches!(payload.get("__kind").and_then(Value::as_str), Some("value")) {
                        "✔ 已允许".to_string()
                    } else {
                        "✘ 已拒绝".to_string()
                    }
                } else {
                    format!(
                        "→ {}",
                        payload.get("value").and_then(Value::as_str).unwrap_or("（取消）")
                    )
                };
                let request_id = it.request_id.clone();
                self.inflight.push(OutLine::new(LineKind::Notice, line));
                self.close_interaction();
                Some(Action::Reply { request_id, payload })
            }
            Key::Esc | Key::CtrlC => {
                let request_id = it.request_id.clone();
                self.inflight
                    .push(OutLine::new(LineKind::Notice, "→ 已取消"));
                self.close_interaction();
                Some(Action::Reply {
                    request_id,
                    payload: json!({ "__kind": "cancelled" }),
                })
            }
            _ => None,
        }
    }

    fn close_interaction(&mut self) {
        self.interaction = self.queue.pop_front();
    }

    /// 提交输入框：斜杠命令 / 普通提问 / 退出
    fn submit_input(&mut self) -> Option<Action> {
        let text = self.input.trim().to_string();
        if text.is_empty() {
            return None;
        }
        // 回合进行中不接受新输入：**状态机自己拦住**，别让「UI 认为空闲、引擎还在跑」分叉
        // （分叉的后果是同一会话上并发两个回合 —— 消息列表会乱）。输入框内容保留，
        // 等回合结束再回车即可。
        if self.running {
            self.inflight.push(OutLine::new(
                LineKind::Notice,
                "（上一个回合还没结束：Esc 取消）",
            ));
            self.commit_pending = true;
            return None;
        }
        self.input.clear();
        self.cursor = 0;
        self.history_pos = None;
        // 历史里不留重复的相邻项
        if self.history.last() != Some(&text) {
            self.history.push(text.clone());
        }
        match crate::tui::commands::parse_slash(&text) {
            Some(Slash::Exit) => {
                self.should_quit = true;
                Some(Action::Quit)
            }
            Some(cmd) => {
                self.inflight
                    .push(OutLine::new(LineKind::User, format!("> {}", text)));
                // 斜杠命令的回显（及其随后由异步侧发来的提示）应立即进滚动区：
                // 它们不属于任何回合，留在动态区会和下一个回合的输出混在一起
                self.commit_pending = true;
                Some(Action::Slash(cmd))
            }
            None => {
                // 用户提问：先回显（引擎不会为「用户消息」发事件），并进入「运行中」
                self.assistant_at = None;
                self.inflight
                    .push(OutLine::new(LineKind::User, format!("> {}", text)));
                self.running = true;
                self.turn_started_ms = Some(virlen_core::telemetry::now_ms());
                self.tool_tail.clear();
                Some(Action::Submit(text))
            }
        }
    }

    // ==================== 输入框编辑 ====================

    /// 字符下标 → 字节下标
    fn byte_at(&self, char_idx: usize) -> usize {
        self.input
            .char_indices()
            .nth(char_idx)
            .map(|(b, _)| b)
            .unwrap_or(self.input.len())
    }

    fn insert_char(&mut self, c: char) {
        let b = self.byte_at(self.cursor);
        self.input.insert(b, c);
        self.cursor += 1;
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let (from, to) = (self.byte_at(self.cursor - 1), self.byte_at(self.cursor));
        self.input.replace_range(from..to, "");
        self.cursor -= 1;
    }

    fn delete(&mut self) {
        if self.cursor >= self.input.chars().count() {
            return;
        }
        let (from, to) = (self.byte_at(self.cursor), self.byte_at(self.cursor + 1));
        self.input.replace_range(from..to, "");
    }

    fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let pos = match self.history_pos {
            None => {
                self.draft = self.input.clone();
                self.history.len() - 1
            }
            Some(0) => 0,
            Some(p) => p - 1,
        };
        self.history_pos = Some(pos);
        self.input = self.history[pos].clone();
        self.cursor = self.input.chars().count();
    }

    fn history_next(&mut self) {
        match self.history_pos {
            None => {}
            Some(p) if p + 1 < self.history.len() => {
                self.history_pos = Some(p + 1);
                self.input = self.history[p + 1].clone();
                self.cursor = self.input.chars().count();
            }
            Some(_) => {
                // 回到末尾 = 恢复进入历史前的草稿
                self.history_pos = None;
                self.input = std::mem::take(&mut self.draft);
                self.cursor = self.input.chars().count();
            }
        }
    }
}
