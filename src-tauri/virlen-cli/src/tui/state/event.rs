//! 引擎事件 → UI 状态的**唯一解释点**（`impl UiState` 的事件处理段）
//!
//! 为什么独立一个文件：事件语义只在这里解释一次 —— 比如「同一次工具调用会来两帧开始事件，
//! 必须按 id 去重」「助手正文先增量、最后用最终内容整体替换」。`view` / `app` 都不再各自解释。

use super::*;

impl UiState {
    // ==================== 事件 ====================

    pub(crate) fn apply(&mut self, ev: UiEvent) {
        self.dirty = true;
        match ev {
            UiEvent::TextDelta(d) => self.append_assistant(&d),
            UiEvent::AssistantContent(c) => self.set_assistant(&c),
            UiEvent::ToolStart { id, name, detail } => {
                if !id.is_empty() && !self.started_tools.insert(id) {
                    return; // 同一次调用的第二帧
                }
                self.assistant_at = None;
                self.tool_tail.clear();
                let line = if detail.is_empty() {
                    format!("⏺ {}", name)
                } else {
                    format!("⏺ {}({})", name, detail)
                };
                self.inflight.push(OutLine::new(LineKind::Tool, line));
            }
            UiEvent::ToolOutput { chunk } => {
                self.tool_tail.push_str(&sanitize(&chunk));
                if self.tool_tail.chars().count() > TOOL_TAIL_MAX {
                    let keep: String = self
                        .tool_tail
                        .chars()
                        .rev()
                        .take(TOOL_TAIL_MAX)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    self.tool_tail = keep;
                }
            }
            UiEvent::ToolDone {
                ok,
                chars,
                preview,
            } => {
                self.tool_tail.clear();
                self.inflight.push(OutLine::new(
                    LineKind::ToolOutput,
                    format!(
                        "  ⎿ {} · {} 字符{}",
                        if ok { "ok" } else { "failed" },
                        chars,
                        if preview.is_empty() {
                            String::new()
                        } else {
                            format!(" · {}", preview)
                        }
                    ),
                ));
            }
            UiEvent::Usage { total } => {
                self.status.tokens = Some(total);
            }
            UiEvent::Interaction {
                request_id,
                kind,
                data,
            } => {
                let it = Interaction {
                    request_id,
                    kind,
                    data,
                    input: String::new(),
                };
                match self.interaction {
                    None => self.interaction = Some(it),
                    Some(_) => self.queue.push_back(it),
                }
            }
            UiEvent::Notice(t) => {
                self.assistant_at = None;
                self.inflight.push(OutLine::new(LineKind::Notice, t));
                self.commit_pending = true;
            }
            UiEvent::Error(t) => {
                self.assistant_at = None;
                self.inflight.push(OutLine::new(LineKind::Error, t));
                self.commit_pending = true;
            }
            UiEvent::RunFinished {
                ok,
                error,
                elapsed_ms,
            } => {
                self.running = false;
                self.turn_started_ms = None;
                self.assistant_at = None;
                self.tool_tail.clear();
                if let Some(e) = error {
                    self.inflight
                        .push(OutLine::new(LineKind::Error, format!("[error] {}", e)));
                }
                self.inflight.push(OutLine::new(
                    LineKind::Notice,
                    format!(
                        "{} 用时 {} ms",
                        if ok { "[done]" } else { "[failed]" },
                        elapsed_ms
                    ),
                ));
                self.commit_pending = true;
            }
            UiEvent::SessionChanged {
                session_id,
                title,
                model,
                workspace,
                messages,
            } => {
                self.status.session_id = session_id;
                self.status.title = title;
                self.status.model = model;
                self.status.workspace = workspace;
                self.status.messages = messages;
            }
            UiEvent::Shutdown => {
                self.should_quit = true;
            }
        }
    }

    /// 正文增量：接着当前助手块写；没有就新起一块
    fn append_assistant(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let idx = match self.assistant_at {
            Some(i) if i < self.inflight.len() => i,
            _ => {
                self.inflight
                    .push(OutLine::new(LineKind::Assistant, String::new()));
                self.assistant_at = Some(self.inflight.len() - 1);
                self.inflight.len() - 1
            }
        };
        // 用 take/放回避免每次增量都 clone 一整块正文（长回复下是 O(n²)）
        let mut text = std::mem::take(&mut self.inflight[idx].text);
        text.push_str(delta);
        self.inflight[idx].text = sanitize(&text);
    }

    /// 全量内容：**整块替换**当前助手块（收尾帧用它纠正增量偏差）
    fn set_assistant(&mut self, content: &str) {
        let idx = match self.assistant_at {
            Some(i) if i < self.inflight.len() => i,
            _ if !content.is_empty() => {
                self.inflight
                    .push(OutLine::new(LineKind::Assistant, String::new()));
                self.assistant_at = Some(self.inflight.len() - 1);
                self.inflight.len() - 1
            }
            _ => return,
        };
        self.inflight[idx].text = sanitize(content);
    }
}
