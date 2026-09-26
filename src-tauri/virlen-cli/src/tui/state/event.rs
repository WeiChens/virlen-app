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
            UiEvent::TextDelta { message_id, delta } => {
                self.append_assistant(&message_id, &delta)
            }
            UiEvent::AssistantContent {
                message_id,
                content,
            } => self.set_assistant(&message_id, &content),
            UiEvent::ToolStart { id, name, detail } => {
                if !id.is_empty() && !self.started_tools.insert(id) {
                    return; // 同一次调用的第二帧
                }
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
                let it = Interaction::new(request_id, kind, data);
                match self.interaction {
                    None => self.interaction = Some(it),
                    Some(_) => self.queue.push_back(it),
                }
            }
            UiEvent::Notice(t) => {
                self.inflight.push(OutLine::new(LineKind::Notice, t));
                self.commit_pending = true;
            }
            // 历史预览：整批进动态区并**立刻固化**（它不属于任何回合，留在动态区会被
            // 随后开始的回合挤掉；见 `take_commit` 的「运行中不固化」约定）
            UiEvent::History(lines) => {
                if lines.is_empty() {
                    return; // 新会话没有历史：连表头都不打
                }
                self.inflight.extend(lines);
                self.commit_pending = true;
            }
            UiEvent::Error(t) => {
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

    /// 正文增量：接着**这条消息**的块写；该消息还没有块就新起一块
    fn append_assistant(&mut self, msg_id: &str, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let Some(idx) = self.assistant_idx(msg_id, true) else {
            return;
        };
        // 用 take/放回避免每次增量都 clone 一整块正文（长回复下是 O(n²)）
        let mut text = std::mem::take(&mut self.inflight[idx].text);
        text.push_str(delta);
        self.inflight[idx].text = sanitize(&text);
    }

    /// 全量内容：**整块替换这条消息的块**（收尾帧用它纠正增量偏差）
    fn set_assistant(&mut self, msg_id: &str, content: &str) {
        let clean = sanitize(content);
        if let Some(idx) = self.assistant_idx(msg_id, false) {
            self.inflight[idx].text = clean;
            return;
        }
        if clean.is_empty() {
            return;
        }
        // 该消息还没有块（只有收尾帧、没收到过增量）→ 新起一块并记账
        self.inflight
            .push(OutLine::new(LineKind::Assistant, clean));
        if !msg_id.is_empty() {
            self.assistant_blocks
                .insert(msg_id.to_string(), self.inflight.len() - 1);
        }
    }

    /// 让「这条消息的块」在 `inflight` 里就位：有就返回下标，没有就（可选）新起一块。
    ///
    /// 事件里没带 `messageId` 时（异常/老路径）退化成「追加到最后一个助手块」——
    /// 这正是旧行为，保留它只是为了不把正文弄丢。
    fn assistant_idx(&mut self, msg_id: &str, create: bool) -> Option<usize> {
        if !msg_id.is_empty() {
            if let Some(&i) = self.assistant_blocks.get(msg_id) {
                if i < self.inflight.len() {
                    return Some(i);
                }
            }
            if !create {
                return None;
            }
            self.inflight
                .push(OutLine::new(LineKind::Assistant, String::new()));
            let i = self.inflight.len() - 1;
            self.assistant_blocks.insert(msg_id.to_string(), i);
            return Some(i);
        }
        if let Some(i) = self
            .inflight
            .iter()
            .rposition(|l| l.kind == LineKind::Assistant)
        {
            return Some(i);
        }
        if !create {
            return None;
        }
        self.inflight
            .push(OutLine::new(LineKind::Assistant, String::new()));
        Some(self.inflight.len() - 1)
    }
}
