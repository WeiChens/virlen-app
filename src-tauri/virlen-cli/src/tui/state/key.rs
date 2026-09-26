//! 按键 → 动作（`impl UiState` 的按键处理段）
//!
//! 输入行编辑（按**字符**下标而非字节）、历史上下翻、交互应答的键位、以及 `Ctrl+C` 的两义性
//! （运行中 = 取消，空闲 = 退出）都在这里；`input.rs` 只负责把 crossterm 的按键归一化成 `Key`。

use super::*;
use crate::tui::commands::{CompressArg, Slash};
use serde_json::json;

impl UiState {
    // ==================== 按键 ====================

    /// 处理一个按键；需要异步侧配合时返回动作
    pub(crate) fn apply_key(&mut self, key: Key) -> Option<Action> {
        self.dirty = true;
        // 面板优先：本地选择面板（TUI 自己发起）> 引擎交互（授权 / 选择）> 正常输入
        if self.picker.is_some() {
            return self.key_for_picker(key);
        }
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

    /// 本地选择面板期间的按键。
    ///
    /// 与授权面板同一套安全口径：**只认方向键 + Enter + Esc**，普通字符一律不参与 ——
    /// 用户此刻很可能在盲打下一句消息，那些字符不该被当成一次「选择」。
    fn key_for_picker(&mut self, key: Key) -> Option<Action> {
        match key {
            Key::Up | Key::Left => {
                self.picker_move(-1);
                None
            }
            Key::Down | Key::Right => {
                self.picker_move(1);
                None
            }
            Key::Enter => self.picker_confirm(),
            Key::Esc | Key::CtrlC => {
                self.close_picker();
                self.inflight.push(OutLine::new(LineKind::Notice, "→ 已取消压缩"));
                self.commit_pending = true;
                None
            }
            // 其余键（含字符 / Backspace）：不参与选择，也不落进输入框
            _ => None,
        }
    }

    /// 交互待答期间的按键。
    ///
    /// 两种交互的键盘模型刻意不同：授权（`confirm_command_native`）是显式二选一（←/↑ = 拒绝、→/↓ =
    /// 允许、Enter 确认当前高亮项，默认「拒绝」；普通字符一律不接受 —— 用户此刻很可能正在打下一句
    /// 消息）；选择（`user_choice` 等）仍是行输入（不是安全闸门，序号 / 文本都可用）。
    ///
    /// ⚠️ 历史实现把授权也做成「行输入 + 回车放行」（空白 = 允许）：用户打字时的一次误触 Enter 就直接
    /// 批准了危险命令。这条 fail-open 已被移除，回归用例见
    /// `state/tests.rs::confirm_defaults_to_deny_so_a_stray_enter_never_approves`。
    fn key_for_interaction(&mut self, key: Key) -> Option<Action> {
        // ① 只影响「交互内部状态」的键（选择移动 / 行编辑）：吞掉，不产生动作
        if let Some(it) = self.interaction.as_mut() {
            match (it.is_confirm(), key) {
                (true, Key::Left) | (true, Key::Up) => {
                    it.confirm = it.confirm.left();
                    return None;
                }
                (true, Key::Right) | (true, Key::Down) => {
                    it.confirm = it.confirm.right();
                    return None;
                }
                // 授权面板不吃普通字符（含 Backspace / Delete）：不污染输入框，也不改变选择
                (true, _) => {}
                (false, Key::Char(c)) => {
                    it.input.push(c);
                    return None;
                }
                (false, Key::Backspace) => {
                    it.input.pop();
                    return None;
                }
                (false, _) => {}
            }
        }
        // ② 结束这次交互的键（其余键在此被忽略）
        match key {
            Key::Enter => self.answer_interaction(),
            Key::Esc | Key::CtrlC => self.cancel_interaction(),
            _ => None,
        }
    }

    /// 确认当前交互：授权 = **高亮项**，选择 = 已输入的文本
    fn answer_interaction(&mut self) -> Option<Action> {
        let (request_id, payload, line) = {
            let it = self.interaction.as_ref()?;
            let payload = it.answer();
            let line = it.answer_line(&payload);
            (it.request_id.clone(), payload, line)
        };
        self.inflight.push(OutLine::new(LineKind::Notice, line));
        self.close_interaction();
        Some(Action::Reply {
            request_id,
            payload,
        })
    }

    /// 取消当前交互（Esc / Ctrl+C）—— 与授权面板选「拒绝」是同一条回执
    fn cancel_interaction(&mut self) -> Option<Action> {
        let request_id = self.interaction.as_ref()?.request_id.clone();
        self.inflight
            .push(OutLine::new(LineKind::Notice, "→ 已取消"));
        self.close_interaction();
        Some(Action::Reply {
            request_id,
            payload: json!({ "__kind": "cancelled" }),
        })
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
        // 忙时不接受新输入（回合进行中或正在压缩上下文）：**状态机自己拦住**，
        // 别让「UI 认为空闲、引擎还在跑」分叉（分叉的后果是同一会话上并发两个回合 —— 消息列表会乱）。
        // 输入框内容保留，等它结束再回车即可。
        if self.busy() {
            self.inflight.push(OutLine::new(
                LineKind::Notice,
                if self.running {
                    "（上一个回合还没结束：Esc 取消）"
                } else {
                    "（正在压缩上下文，请稍候）"
                },
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
            // `/compress <mode>`：方式已定 → **直接发执行动作**（不必绕 `Action::Slash` 再转发一次）
            Some(Slash::Compress(CompressArg::Mode(m))) => {
                self.echo_command(&text);
                Some(Action::Compress(m))
            }
            // `/compress` 不带参数 → 弹选择面板：本回合**不产生动作**
            // （等用户在面板里选定后再由 `picker_confirm` 产生 `Action::Compress`）
            Some(Slash::Compress(CompressArg::Ask)) => {
                self.echo_command(&text);
                self.open_compress_picker();
                None
            }
            Some(cmd) => {
                self.echo_command(&text);
                Some(Action::Slash(cmd))
            }
            None => {
                // 用户提问：先回显（引擎不会为「用户消息」发事件），并进入「运行中」
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

    /// 回显一条斜杠命令。
    ///
    /// 立即固化（`commit_pending`）：命令回显及其随后的提示不属于任何回合，
    /// 留在动态区会和下一个回合的输出混在一起。
    fn echo_command(&mut self, text: &str) {
        self.inflight
            .push(OutLine::new(LineKind::User, format!("> {}", text)));
        self.commit_pending = true;
    }

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
