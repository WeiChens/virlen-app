//! TUI 模式 —— 内联视口的线程编排（主循环 + 它与引擎的通道）
//!
//! 三件事收在这里，因为它们的生命周期是**同一个**（`run_tui` 进、`tui_loop` 出、`Chat` 常驻）：
//!
//! | 角色 | 线程 | 职责 |
//! |---|---|---|
//! | `tui_loop` | TUI 线程 | **读事件 → 状态机 → 固化 → 绘制**（顺序不能反，见 `term.rs` 措施 #1） |
//! | `Chat` | 主循环 | 引擎 + 桥 + 通道；一次回合一个 spawned 任务 |
//! | `run_tui` | 调用方 | 接管终端、起线、receive 结果；失败超阈值则**降级**回顺序输出模式 |

use crate::session_rt::{
    compress_session, current_context_tokens, default_compress_mode, report_line, CompressError,
    SessionRuntime, UNTITLED,
};
use crate::tui::commands::{CompressArg, Slash};
use crate::tui::state::{Action, Key, UiEvent, UiState};
use crate::EXIT_OK;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use virlen_core::agent::bridge::{self, AgentBridgeState};
use virlen_core::agent::compress::CompressMode;
use virlen_core::agent::engine::AgentEngine;
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::provider::DefaultProviderFactory;

use super::history::{history_preview, resume_hint, HISTORY_PREVIEW};
use super::plain::{run_plain, status_text};
use super::sink::UiEventSink;
use super::{commands, input, term, Input, POLL, REDRAW_EVERY};

// ==================== TUI 模式 ====================

/// 一次回合的结果（由 spawned 任务发回主循环）
struct TurnOutcome {
    result: Result<(), String>,
    elapsed_ms: i64,
}

/// TUI 线程的退出报告
///
/// ⚠️ 退化的**原因**不在这里传：它走 `Action::Degrade(String)` 这条既有通道
/// （主循环是从那里读到原因并决定切模式的）。本枚举只是「怎么退的」的自述。
enum TuiExit {
    /// 用户主动退出（或收到 Shutdown）
    Quit,
    /// 终端连续失败 → 主循环切顺序输出模式
    Degrade,
}

/// 主循环的动作处理结果
enum Flow {
    Continue,
    Quit,
    Degrade(String),
}

pub(crate) async fn run_tui(
    host: &Arc<dyn HostEnv>,
    rt: SessionRuntime,
    out: &mut dyn Write,
    err: &mut dyn Write,
    input: &mut Input<'_>,
) -> i32 {
    let (evt_tx, evt_rx) = mpsc::unbounded_channel::<UiEvent>();
    let (act_tx, mut act_rx) = mpsc::unbounded_channel::<Action>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let handle = std::thread::Builder::new()
        .name("virlen-cli-tui".to_string())
        .spawn(move || {
            let entered = term::Tui::enter();
            match entered {
                Ok(tui) => {
                    let _ = ready_tx.send(Ok(()));
                    tui_loop(tui, evt_rx, act_tx)
                }
                Err(e) => {
                    // 终端接管失败 → 主循环改用顺序输出模式（不 panic、不留半接管状态）
                    let _ = ready_tx.send(Err(e.to_string()));
                    TuiExit::Degrade
                }
            }
        })
        .expect("起 TUI 线程失败");

    // 等接管结果（只在这一处阻塞：终端 init 是几个系统调用，TUI 线程已经起来了）
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = handle.join();
            let _ = writeln!(err, "[chat] 终端接管失败: {}", e);
            return run_plain(host, rt, out, err, input, None).await;
        }
        // TUI 线程没送出接管结果就没了（init 里 panic）—— 同样退回顺序输出模式
        Err(_) => {
            let _ = handle.join();
            let _ = writeln!(
                err,
                "[chat] 终端线程异常退出（详见 {}）",
                term::log_path().display()
            );
            return run_plain(host, rt, out, err, input, None).await;
        }
    }

    let bridge = Arc::new(AgentBridgeState::default());
    let sink: Arc<dyn EventSink> = Arc::new(UiEventSink::new(evt_tx.clone(), bridge.clone()));
    let engine = Arc::new(AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        rt.db.repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
        host.clone(),
        rt.db.settings.clone(),
    ));
    let (turn_tx, mut turn_rx) = mpsc::unbounded_channel::<TurnOutcome>();

    let mut chat = Chat {
        rt,
        engine,
        bridge,
        evt: evt_tx.clone(),
        turns: turn_tx.clone(),
        running: false,
        compressing: false,
        context_tokens: None,
    };
    // 续连（`chat --session <id>`）时先把最近几条消息显示出来，方便用户预览历史。
    // 顺序在「已就绪」**之前**：先看见历史，再看见就绪；新会话没有历史 → 什么也不显示。
    let resumed = chat.rt.opts.session_id.is_some();
    chat.preview_history();
    chat.announce(if resumed { "已续连会话" } else { "已就绪" });
    // 设置里的默认压缩方式（`app_settings.contextCompressMode`）→ 选择面板据此标「默认」
    if let Some(m) = default_compress_mode(&chat.rt.settings) {
        let _ = chat.evt.send(UiEvent::DefaultCompressMode(m));
    }
    // 一上来就把上下文占用推给状态行（续连已有会话时立刻能看到百分比）
    chat.refresh_context().await;
    let _ = chat.evt.send(UiEvent::Notice(
        "Ctrl+C（空闲时）= 退出 · Esc = 取消当前回合 · /help 看命令".to_string(),
    ));

    let mut degraded: Option<String> = None;
    loop {
        tokio::select! {
            act = act_rx.recv() => {
                match act {
                    // TUI 线程没了（panic / 被关掉）→ 收摊
                    None => break,
                    Some(a) => match chat.handle(a).await {
                        Flow::Continue => {}
                        Flow::Quit => break,
                        Flow::Degrade(why) => { degraded = Some(why); break }
                    },
                }
            }
            outcome = turn_rx.recv() => {
                if let Some(o) = outcome {
                    chat.finish_turn(o).await;
                }
            }
        }
    }

    // 让 TUI 线程收摊（它自己会恢复终端）；已经在退出路上的情况下这句是无害的空操作
    let _ = chat.evt.send(UiEvent::Shutdown);
    match handle.join() {
        Ok(TuiExit::Quit) => term::log("TUI 线程退出：用户退出"),
        Ok(TuiExit::Degrade) => term::log("TUI 线程退出：降级"),
        // panic 已经把原因写进日志（自装的 panic 钩子）——这里只留一条时间线
        Err(_) => term::log("TUI 线程异常结束（panic），详见本文件上方日志"),
    }

    // 降级：把还在跑的回合**取消**再切模式 —— 否则那个回合的输出会随 TUI 线程一起丢掉
    if degraded.is_some() && chat.running {
        chat.engine.cancel(&chat.rt.session.id);
    }
    let rt = chat.rt;
    match degraded {
        None => {
            let _ = writeln!(err, "[chat] 已退出（会话已保存在库里，可随时续跑）");
            // 会话 id 必须**完整**打出来（状态行里那个只显示前 8 位，不足以续连）
            let _ = writeln!(err, "{}", resume_hint(&rt.session.id));
            EXIT_OK
        }
        Some(why) => {
            let _ = writeln!(
                err,
                "[chat] 终端界面不可用（{}）→ 改用顺序输出模式，会话继续",
                why
            );
            run_plain(host, rt, out, err, input, None).await
        }
    }
}

/// TUI 线程的主循环：**读事件 → 状态机 → 固化 → 绘制**（顺序不能反，见 `term.rs` 措施 #1）
fn tui_loop(
    mut tui: term::Tui,
    mut evt_rx: mpsc::UnboundedReceiver<UiEvent>,
    act_tx: mpsc::UnboundedSender<Action>,
) -> TuiExit {
    let mut st = UiState::new();
    let mut keys: Vec<Key> = Vec::new();
    let mut last_draw = Instant::now() - REDRAW_EVERY;
    // resize 后必须**强制重绘一次**：`Terminal::resize` 会清空视口区域（`clear_viewport`），
    // 不在去抖结束时重绘就会在底部留下一块空白。
    let mut need_redraw = true;

    let exit = loop {
        // ① 引擎 / 宿主事件（非阻塞全取）
        while let Ok(ev) = evt_rx.try_recv() {
            st.apply(ev);
        }
        // ② 终端事件 —— ⚠️ 必须排在绘制之前：resize 那一下的 `draw` 正是会撞上故障的那次
        keys.clear();
        match input::drain(POLL, &mut keys) {
            Ok(Some((w, h))) => {
                // 诊断日志（%TEMP%\virlen-cli-tui.log）：先记「收到了 resize」再进去抖
                term::log(&format!("resize {w}x{h} → 进入 300ms 去抖（此期间不碰终端）"));
                tui.note_resize();
                need_redraw = true;
            }
            Ok(None) => {}
            Err(e) => {
                // 读事件失败也算瞬时故障：记日志 + 退避，不退出
                term::log(&format!("读取终端事件失败: {e}"));
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        for k in keys.drain(..) {
            if let Some(a) = st.apply_key(k) {
                let _ = act_tx.send(a);
            }
        }
        st.tick();
        if st.should_quit {
            break TuiExit::Quit;
        }
        // ③ 尺寸还在变（去抖窗口内）：整轮不碰终端
        if tui.in_debounce() {
            continue;
        }
        // ④ 固化（回合结束 / 提示）：分块写进原生滚动区
        let commit = st.take_commit();
        if !commit.is_empty() {
            if let Err(e) = tui.commit(&commit) {
                let _ = act_tx.send(Action::Degrade(e.clone()));
                break TuiExit::Degrade;
            }
        }
        // ⑤ 绘制（有变化就画；resize 后强制一帧；运行中按 100ms 节流画 spinner 与用时）
        let due = st.is_dirty()
            || need_redraw
            || (st.running() && last_draw.elapsed() >= REDRAW_EVERY);
        if due {
            if let Err(e) = tui.draw(&st) {
                let _ = act_tx.send(Action::Degrade(e.clone()));
                break TuiExit::Degrade;
            }
            st.clear_dirty();
            need_redraw = false;
            last_draw = Instant::now();
        }
    };

    // 退出前把还没固化的内容交给滚动区（失败就算了：终端可能已经不可用）
    let rest = st.take_commit();
    if !rest.is_empty() {
        let _ = tui.commit(&rest);
    }
    tui.restore();
    exit
}

/// 长驻会话的主循环状态：引擎 + 桥 + 与 UI / 回合任务的通道
struct Chat {
    rt: SessionRuntime,
    engine: Arc<AgentEngine>,
    bridge: Arc<AgentBridgeState>,
    evt: mpsc::UnboundedSender<UiEvent>,
    turns: mpsc::UnboundedSender<TurnOutcome>,
    running: bool,
    /// 正在压缩上下文（AI 摘要要一次模型调用，可能持续数秒）
    compressing: bool,
    /// 当前上下文占用（供 `/status` 显示；状态行那份由 UI 侧持有）
    context_tokens: Option<i64>,
}

impl Chat {
    fn note(&self, s: impl Into<String>) {
        let _ = self.evt.send(UiEvent::Notice(s.into()));
    }

    fn error(&self, s: impl Into<String>) {
        let _ = self.evt.send(UiEvent::Error(s.into()));
    }

    /// 把会话元信息推给状态行（会话 / 模型 / 工作目录 / 消息数）
    fn push_session(&self, messages: usize) {
        let s = &self.rt.session;
        let _ = self.evt.send(UiEvent::SessionChanged {
            session_id: s.id.clone(),
            title: if s.title.trim().is_empty() {
                UNTITLED.to_string()
            } else {
                s.title.clone()
            },
            model: self.rt.resources.model_id.clone(),
            workspace: self.rt.resources.workspace.clone(),
            messages,
        });
    }

    /// 把当前会话状态推给 UI（状态行 + 提示）
    fn announce(&self, prefix: &str) {
        self.push_session(self.rt.messages.len());
        self.note(format!(
            "{} · 会话 {} · 模型 {} · 工作目录 {}",
            prefix,
            self.rt.session.id,
            self.rt.resources.model_id,
            self.rt.resources.workspace
        ));
    }

    /// 刷新「当前上下文占用」（读数尾窗；口径在 core `compress::context_tokens`）
    ///
    /// 为什么读库而不是用事件里的 usage：引擎是「先落库再 emit」，所以回合结束时库里
    /// 已经有带 `usage` 的助手消息 —— 与桌面端 token 环是同一个口径。
    async fn refresh_context(&mut self) {
        let tokens = current_context_tokens(&self.rt).await;
        self.context_tokens = tokens;
        let _ = self.evt.send(UiEvent::ContextUsage { tokens });
    }

    /// 续连时先展示历史预览（`chat --session <id>` 命中已有会话）。
    ///
    /// 消息为空（新会话）时 `history_preview` 返回空 → 什么都不发，界面上不会多出空表头。
    fn preview_history(&self) {
        let lines = history_preview(&self.rt.messages, HISTORY_PREVIEW);
        if !lines.is_empty() {
            let _ = self.evt.send(UiEvent::History(lines));
        }
    }

    async fn finish_turn(&mut self, o: TurnOutcome) {
        self.running = false;
        let (ok, error) = match o.result {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };
        let _ = self.evt.send(UiEvent::RunFinished {
            ok,
            error,
            elapsed_ms: o.elapsed_ms,
        });
        // 回合结束后刷新上下文占用（此时库里已有本轮的 usage）
        self.refresh_context().await;
    }

    /// 压缩上下文（方式已选定）。
    ///
    /// 为什么直接 `await`（不 spawn）：压缩是「一次性、无中间事件」的操作，
    /// 主循环等它即可 —— TUI 线程是独立的，照样在画 spinner 与「正在压缩」提示；
    /// 期间的按键会排在通道里，压缩结束后按原语义处理（输入已被状态机拦住）。
    async fn compress(&mut self, mode: CompressMode) {
        if self.running || self.compressing {
            self.error("正在运行或压缩中，请稍候");
            return;
        }
        self.compressing = true;
        let _ = self.evt.send(UiEvent::Compressing(true));
        self.note(format!(
            "正在压缩上下文（{}）…（AI 摘要需一次模型调用，请稍候）",
            mode.label()
        ));
        let result = compress_session(&mut self.rt, mode).await;
        self.compressing = false;
        let _ = self.evt.send(UiEvent::Compressing(false));
        match result {
            Ok(report) => {
                // 消息条数变了（多了一条 summary）→ 同步状态行
                self.push_session(report.message_count);
                self.context_tokens = Some(report.after);
                let _ = self.evt.send(UiEvent::ContextUsage {
                    tokens: Some(report.after),
                });
                self.note(report_line(&report));
            }
            // 被闸拦下（上下文充裕 / 没有用量数据）：**提示**而不是报错
            Err(CompressError::Skipped(m)) => {
                self.note(m);
                self.refresh_context().await;
            }
            Err(e @ CompressError::Failed(_)) => {
                self.error(format!("压缩失败: {}", e.message()));
                self.refresh_context().await;
            }
        }
    }

    async fn handle(&mut self, a: Action) -> Flow {
        match a {
            Action::Quit => {
                if self.running {
                    self.engine.cancel(&self.rt.session.id);
                }
                Flow::Quit
            }
            Action::Degrade(why) => Flow::Degrade(why),
            Action::Cancel => {
                if self.running {
                    self.engine.cancel(&self.rt.session.id);
                    self.note("[cancel] 已请求取消当前回合");
                }
                Flow::Continue
            }
            Action::Reply {
                request_id,
                payload,
            } => {
                // 交互回执必须发（未知类型也答过；见文件头）
                bridge::handle_user_interaction_response(&self.bridge, &request_id, payload).await;
                Flow::Continue
            }
            Action::Submit(text) => {
                self.submit(text).await;
                Flow::Continue
            }
            Action::Slash(cmd) => {
                self.slash(cmd).await;
                Flow::Continue
            }
            Action::Compress(mode) => {
                self.compress(mode).await;
                Flow::Continue
            }
        }
    }

    async fn submit(&mut self, prompt: String) {
        if self.running {
            // UI 侧也会拦（`state::submit_input`）—— 这里只是兜底，不改变状态
            self.error("上一个回合还没结束（Esc 可取消），该输入已忽略");
            return;
        }
        let messages = match self.rt.turn_messages(&prompt).await {
            Ok(m) => m,
            Err(e) => {
                self.error(format!("错误: {}", e));
                // 回合没起来：让 UI 回到空闲（它提交时已把自己标成「运行中」）
                let _ = self.evt.send(UiEvent::RunFinished {
                    ok: false,
                    error: None,
                    elapsed_ms: 0,
                });
                return;
            }
        };
        let options = self.rt.send_options(messages);
        self.running = true;
        let engine = self.engine.clone();
        let tx = self.turns.clone();
        // 回合 spawn 出去：主循环还要继续处理 Esc / 新输入（见文件头「线程与任务」）
        tokio::spawn(async move {
            let started = virlen_core::telemetry::now_ms();
            let result = engine.send_message(options).await;
            let _ = tx.send(TurnOutcome {
                result,
                elapsed_ms: virlen_core::telemetry::now_ms() - started,
            });
        });
    }

    async fn slash(&mut self, cmd: Slash) {
        match cmd {
            Slash::Help => self.note(commands::help_text()),
            Slash::Exit => {} // 退出由 UI 侧直接处理（它已经发了 Action::Quit）
            Slash::Status => self.note(status_text(&self.rt, self.context_tokens)),
            Slash::Unknown(c) => self.note(format!("未知命令: /{}（/help 查看）", c)),
            Slash::Compress(arg) => match arg {
                // 防御分支：正常路径下「方式已定」由状态机直接发 `Action::Compress`，
                // 不会绕到这里（`submit_input`）。留着它不影响正确性，也避免将来多一个
                // 生产者时静默丢动作。
                CompressArg::Mode(m) => self.compress(m).await,
                CompressArg::Ask => {
                    self.note("用法: /compress [ai|raw]（不带参数会弹出选择面板）")
                }
                CompressArg::Invalid(name) => self.note(format!(
                    "未知压缩方式: {}（可用：ai = AI 摘要 / raw = 正文压缩）",
                    name
                )),
            },
            Slash::New => {
                if self.running || self.compressing {
                    self.error("忙时不能切会话（等当前操作结束）");
                    return;
                }
                match self.rt.activate(None).await {
                    Ok(()) => {
                        self.announce("已新建会话");
                        self.refresh_context().await;
                    }
                    Err(e) => self.error(format!("新建会话失败: {}", e)),
                }
            }
        }
    }
}
