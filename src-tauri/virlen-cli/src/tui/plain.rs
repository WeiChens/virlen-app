//! **顺序输出模式** —— 纯文本顺序打印 + 行输入（管道 / CI / 排障，以及 TUI 的降级形态）
//!
//! 为什么值得单独一个文件：它是**两条路径里唯一被保证可用的那条**（无 TTY 时自动走它、
//! 终端连续失败时降级到它），而且它复用 `run` 的渲染与交互应答 —— 这份「不能坏」的逻辑
//! 混在 TUI 线程编排里最难被审视。

use crate::run::{self, CliEventSink};
use crate::session_rt::{
    compress_session, context_line, current_context_tokens, default_compress_mode, report_line,
    CompressError, SessionRuntime, UNTITLED,
};
use crate::tui::commands::{CompressArg, Slash};
use crate::EXIT_OK;
use std::io::{IsTerminal, Write};
use std::sync::Arc;
use tokio::sync::mpsc;
use virlen_core::agent::bridge::AgentBridgeState;
use virlen_core::agent::engine::AgentEngine;
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::provider::DefaultProviderFactory;

use super::commands;
use super::history::{history_preview, resume_hint, HISTORY_PREVIEW};
use super::Input;
use virlen_core::agent::compress as agent_compress;

// ==================== 顺序输出模式 ====================

/// 顺序输出模式：纯文本顺序打印 + 行输入。
///
/// 它是「管道 / CI / 排障」以及**降级**的落地形态，并且**复用 `run` 的渲染与交互应答**
/// （`run::CliEventSink` + `flush_rendered`）：同一份「引擎事件 → 文本」逻辑只有一处。
pub(crate) async fn run_plain(
    host: &Arc<dyn HostEnv>,
    mut rt: SessionRuntime,
    out: &mut dyn Write,
    err: &mut dyn Write,
    input: &mut Input<'_>,
    reason: Option<String>,
) -> i32 {
    if let Some(r) = reason {
        let _ = writeln!(err, "[chat] 使用顺序输出模式：{}", r);
    }
    let _ = writeln!(
        err,
        "[chat] session={} model={} workspace={}（/help 看命令，/exit 退出）",
        rt.session.id, rt.resources.model_id, rt.resources.workspace
    );
    // 续连（`--session`）时先把历史显示出来 —— 与 TUI 同一份格式化（`history_preview`），
    // 差别只在「这里直接打印，TUI 送去按角色上色」。
    print_history_preview(&rt, &mut *out);

    let interactive = std::io::stdin().is_terminal();
    let (tx, mut rx) = mpsc::unbounded_channel::<run::Rendered>();
    let bridge = Arc::new(AgentBridgeState::default());
    let sink: Arc<dyn EventSink> = Arc::new(CliEventSink::new(bridge.clone(), tx, false, interactive));
    let engine = AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        rt.db.repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
        host.clone(),
        rt.db.settings.clone(),
    );

    loop {
        let _ = write!(out, "> ");
        let _ = out.flush();
        let mut line = String::new();
        if input.read_line(&mut line) == 0 {
            // EOF（管道读完 / Ctrl+Z）：与 /exit 同一条退出路径；补一个换行让提示符不粘行
            let _ = writeln!(err);
            break;
        }
        let text = line.trim().to_string();
        if text.is_empty() {
            continue;
        }
        match commands::parse_slash(&text) {
            Some(Slash::Exit) => break,
            Some(Slash::Help) => {
                let _ = writeln!(out, "{}", commands::help_text());
                let _ = out.flush();
                continue;
            }
            Some(Slash::Status) => {
                let ctx = current_context_tokens(&rt).await;
                let _ = writeln!(out, "{}", status_text(&rt, ctx));
                let _ = out.flush();
                continue;
            }
            // 压缩上下文（与 TUI 同一条执行链 `session_rt::compress_session`，只是没有面板）
            Some(Slash::Compress(arg)) => {
                let mode = match arg {
                    CompressArg::Mode(m) => Some(m),
                    // 顺序输出模式没有选择面板：用设置里的默认方式；
                    // 设置里也没配就**不猜**，直接告诉用户要写明
                    CompressArg::Ask => default_compress_mode(&rt.settings),
                    CompressArg::Invalid(name) => {
                        let _ = writeln!(err, "[chat] 未知压缩方式: {}（可用：ai / raw）", name);
                        continue;
                    }
                };
                let Some(mode) = mode else {
                    let _ = writeln!(
                        err,
                        "[chat] 顺序输出模式没有选择面板，请指定方式：/compress ai 或 /compress raw"
                    );
                    continue;
                };
                match compress_session(&mut rt, mode).await {
                    Ok(report) => {
                        let _ = writeln!(out, "{}", report_line(&report));
                        let _ = out.flush();
                    }
                    Err(CompressError::Skipped(m)) => {
                        let _ = writeln!(err, "[chat] {}", m);
                    }
                    Err(e @ CompressError::Failed(_)) => {
                        let _ = writeln!(err, "[chat] 压缩失败: {}", e.message());
                    }
                }
                continue;
            }
            Some(Slash::New) => {
                match rt.activate(None).await {
                    Ok(()) => {
                        let _ = writeln!(err, "[chat] 已新建会话 {}", rt.session.id);
                    }
                    Err(e) => {
                        let _ = writeln!(err, "[chat] 新建会话失败: {}", e);
                    }
                }
                continue;
            }
            Some(Slash::Unknown(c)) => {
                let _ = writeln!(err, "[chat] 未知命令 /{}（/help 查看）", c);
                continue;
            }
            None => {}
        }

        // 一次回合：消息列表每回合现读库（引擎先把用户消息落库，库里那份才是权威历史）
        let messages = match rt.turn_messages(&text).await {
            Ok(m) => m,
            Err(e) => {
                let _ = writeln!(err, "错误: {}", e);
                continue;
            }
        };
        let options = rt.send_options(messages);
        let started = virlen_core::telemetry::now_ms();
        let mut fut = Box::pin(engine.send_message(options));
        let result = loop {
            tokio::select! {
                res = &mut fut => break res,
                maybe = rx.recv() => {
                    match maybe {
                        Some(r) => run::flush_rendered(out, err, r),
                        None => break Ok(()),
                    }
                }
            }
        };
        while let Ok(r) = rx.try_recv() {
            run::flush_rendered(out, err, r);
        }
        let _ = out.flush();
        let _ = err.flush();
        match result {
            Ok(()) => {
                // 顺手报一下上下文占用（用户不用敲 /status 就知道该不该压）
                let ctx = current_context_tokens(&rt).await;
                let _ = writeln!(
                    err,
                    "[done] 用时 {} ms · 上下文 {}",
                    virlen_core::telemetry::now_ms() - started,
                    context_line(ctx)
                );
            }
            Err(e) => {
                let _ = writeln!(err, "[error] {}", e);
            }
        }
    }
    let _ = writeln!(err, "[chat] 已退出（会话已保存在库里，可随时续跑）");
    // 会话 id 必须**完整**打出来（状态行里那个只显示前 8 位，不足以续连）
    let _ = writeln!(err, "{}", resume_hint(&rt.session.id));
    EXIT_OK
}

/// 续连时把历史预览打到 stdout。
///
/// 为什么走 stdout 而不是 stderr：顺序输出模式的 stdout 就是「对话记录」
/// （`> ` 提示符、`/status`、`/help` 都在它上面），历史预览是同一类东西。
fn print_history_preview(rt: &SessionRuntime, out: &mut dyn Write) {
    for l in history_preview(&rt.messages, HISTORY_PREVIEW) {
        let _ = writeln!(out, "{}", l.text);
    }
    let _ = out.flush();
}

/// `/status` 的文本（两种模式共用；**必须**写明与桌面端的已知差异，红线 #6）
///
/// `context_tokens` = 当前上下文占用（两种界面各自已取到，避免这里再异步读库）。
pub(crate) fn status_text(rt: &SessionRuntime, context_tokens: Option<i64>) -> String {
    let s = &rt.session;
    let r = &rt.resources;
    format!(
        "会话    : {}（{}）\n\
         模型    : {} · Provider {}（{}）\n\
         工作目录: {}\n\
         消息数  : {}（本进程累计）\n\
         上下文  : {}（100% = {}）\n\
         沙盒    : {} · 权限项 {} 条 · 工具 {}\n\
         已知与桌面端的差异:\n\
         \x20 - 不显示费用（价目表在前端 TS）\n\
         \x20 - 上下文占用优先取供应商回报的真实用量；**压缩后的占用是本地粗估**\n\
         \x20   （桌面端用 DeepSeek tokenizer 精确计数）\n\
         \x20 - 技能启用状态 / 路径黑白名单仍在桌面端 localStorage，CLI 读不到\n\
         \x20 - Gemini 等需前端 JS 桥的 Provider 不支持（装配期已拒绝；压缩同理）",
        s.id,
        if s.title.trim().is_empty() { UNTITLED } else { s.title.trim() },
        r.model_id,
        r.provider.provider_id,
        r.provider.provider_type,
        r.workspace,
        rt.messages.len(),
        context_line(context_tokens),
        agent_compress::format_tokens(agent_compress::CONTEXT_WINDOW_TOKENS),
        r.security.sandbox_mode,
        r.security.permissions.len(),
        if r.enable_tools {
            format!("{} 个", r.tool_defs.len())
        } else {
            "关闭".to_string()
        }
    )
}
