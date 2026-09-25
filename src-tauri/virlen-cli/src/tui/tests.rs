use crate::tui::state::{LineKind, UiEvent};
use crate::{EXIT_ERROR, EXIT_OK};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::mpsc;
use virlen_core::agent::bridge::AgentBridgeState;
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::{AgentEvent, Message, ToolUseContent};

use super::*;
use super::history::{history_preview, resume_hint, HISTORY_PREVIEW};
use super::sink::{first_line, input_preview, text_of, UiEventSink};
use crate::config::{self, ConfigCmd};
use virlen_core::host::CliHost;

fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

fn host(dir: &std::path::Path) -> Arc<dyn HostEnv> {
    Arc::new(CliHost::new(vec![], dir.to_path_buf()))
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("virlen_cli_chat_{}_{}", tag, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 往库里写一份可用的 Provider 配置（否则 `chat` 在装配期就报错退出）
async fn seed_provider(h: &Arc<dyn HostEnv>) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let provider = json!([{
        "id": "p1", "name": "本地", "type": "openai", "apiKey": "k",
        "baseUrl": "http://127.0.0.1:1/v1", "models": ["m1"], "enabled": true
    }]);
    assert_eq!(
        config::run(
            h.as_ref(),
            ConfigCmd::Set {
                key: "providers".into(),
                value: provider
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
    let mut out = Vec::new();
    let mut err = Vec::new();
    assert_eq!(
        config::run(
            h.as_ref(),
            ConfigCmd::Set {
                key: "defaultSelectModel".into(),
                value: json!({ "providerConfigId": "p1", "modelId": "m1" })
            },
            &mut out,
            &mut err
        )
        .await,
        EXIT_OK
    );
}

// ==================== 参数解析 ====================

#[test]
fn parse_defaults_to_new_session() {
    assert_eq!(parse(args(&[])), Ok(ChatCmd::Chat(ChatOptions::default())));
    assert_eq!(
        parse(args(&["--session", "s1", "--workspace", "E:/w", "--no-tui"])),
        Ok(ChatCmd::Chat(ChatOptions {
            session_id: Some("s1".into()),
            workspace: Some("E:/w".into()),
            no_tui: true,
        }))
    );
    assert_eq!(parse(args(&["-h"])), Ok(ChatCmd::Help));
}

#[test]
fn parse_rejects_bad_usage() {
    assert!(parse(args(&["--nope"])).is_err(), "未知选项");
    assert!(parse(args(&["--session"])).is_err(), "缺取值");
    assert!(parse(args(&["--session", ""])).is_err(), "空取值");
    // `chat` 不接受位置参数：一次性提问走 `run`，否则用户会以为 `chat 你好` 是一次性调用
    let e = parse(args(&["你好"])).unwrap_err();
    assert!(e.contains("run"), "应引导到 run: {e}");
}

// ==================== 顺序输出模式（可测的那条路径） ====================

#[tokio::test]
async fn help_prints_usage_and_does_not_touch_database() {
    let dir = tmpdir("help");
    let h = host(&dir);
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut input = Input::Buf(&mut std::io::Cursor::new(Vec::new()));
    let code = run_with(&h, ChatCmd::Help, &mut out, &mut err, &mut input).await;
    assert_eq!(code, EXIT_OK);
    assert!(String::from_utf8_lossy(&out).contains("用法:"));
    assert!(!dir.join("virlen.db").exists(), "help 不得建库");
    std::fs::remove_dir_all(&dir).ok();
}

/// 没配 Provider → 装配期失败、退出码 1、不进入界面（与 `run` 同一条判定）
#[tokio::test]
async fn missing_provider_fails_at_startup() {
    let dir = tmpdir("noprov");
    let h = host(&dir);
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut input = Input::Buf(&mut std::io::Cursor::new(Vec::new()));
    let code = run_with(
        &h,
        ChatCmd::Chat(ChatOptions {
            no_tui: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
        &mut input,
    )
    .await;
    assert_eq!(code, EXIT_ERROR);
    assert!(String::from_utf8_lossy(&err).contains("Provider"));
    std::fs::remove_dir_all(&dir).ok();
}

/// 多轮 REPL：/help → /status → 普通提问（连不上 → 报错但**不退出**）→ /exit
#[tokio::test]
async fn plain_mode_runs_slash_commands_and_survives_a_failed_turn() {
    let dir = tmpdir("repl");
    let h = host(&dir);
    seed_provider(&h).await;

    let script = "/help\n/status\n你好\n/exit\n";
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(script.as_bytes().to_vec());
    let mut input = Input::Buf(&mut cursor);
    let code = run_with(
        &h,
        ChatCmd::Chat(ChatOptions {
            no_tui: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
        &mut input,
    )
    .await;

    assert_eq!(code, EXIT_OK);
    let o = String::from_utf8_lossy(&out);
    assert!(o.contains("/status"), "帮助应被打印: {o}");
    assert!(o.contains("已知与桌面端的差异"), "/status 必须写明缺口: {o}");
    // 连不上 127.0.0.1:1 → 引擎报错，但 REPL 继续（随后处理了 /exit）
    let e = String::from_utf8_lossy(&err);
    assert!(e.contains("[chat] 使用顺序输出模式"), "{e}");
    assert!(e.contains("[error]"), "失败的回合应报错: {e}");
    // 会话与消息必须落库（用户消息由引擎落库）
    let db = virlen_core::session_db::open_session_db(h.as_ref(), &|fut| {
        tokio::spawn(fut);
    })
    .unwrap();
    let sessions = db.repo.list_sessions().await.unwrap_or_default();
    assert_eq!(sessions.len(), 1, "应只建一条会话");
    std::fs::remove_dir_all(&dir).ok();
}

/// `/new` 之后是**另一条**会话，且工作目录被重算（切会话的唯一入口）
#[tokio::test]
async fn plain_mode_new_session_switches() {
    let dir = tmpdir("new");
    let h = host(&dir);
    seed_provider(&h).await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(b"/new\n/exit\n".to_vec());
    let mut input = Input::Buf(&mut cursor);
    let code = run_with(
        &h,
        ChatCmd::Chat(ChatOptions {
            no_tui: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
        &mut input,
    )
    .await;
    assert_eq!(code, EXIT_OK);
    assert!(String::from_utf8_lossy(&err).contains("已新建会话"));
    std::fs::remove_dir_all(&dir).ok();
}

/// 未知斜杠命令：给可读反馈，绝不当作提问发给模型
#[tokio::test]
async fn plain_mode_reports_unknown_slash() {
    let dir = tmpdir("unknown");
    let h = host(&dir);
    seed_provider(&h).await;
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(b"/nope\n/exit\n".to_vec());
    let mut input = Input::Buf(&mut cursor);
    let code = run_with(
        &h,
        ChatCmd::Chat(ChatOptions {
            no_tui: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
        &mut input,
    )
    .await;
    assert_eq!(code, EXIT_OK);
    assert!(String::from_utf8_lossy(&err).contains("未知命令"));
    // 顺序输出模式下每条输入前会打 `> ` 提示符；实质要求是**没有正文/没有把命令发给模型**
    let o = String::from_utf8_lossy(&out);
    assert!(
        o.chars().all(|c| c == '>' || c == ' ' || c == '\n'),
        "不该有正文: {o:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// EOF（管道读完）也要正常退出，不能挂住
#[tokio::test]
async fn plain_mode_exits_on_eof() {
    let dir = tmpdir("eof");
    let h = host(&dir);
    seed_provider(&h).await;
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut input = Input::Buf(&mut cursor);
    assert_eq!(
        run_with(
            &h,
            ChatCmd::Chat(ChatOptions {
                no_tui: true,
                ..Default::default()
            }),
            &mut out,
            &mut err,
            &mut input
        )
        .await,
        EXIT_OK
    );
    std::fs::remove_dir_all(&dir).ok();
}

// ==================== 续连（历史预览 / 退出提示） ====================

fn msg(role: &str, content: &str) -> Message {
    Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: role.to_string(),
        content: json!(content),
        timestamp: 0,
        ..Default::default()
    }
}

/// 预览取**最近 5 条**（用户定案）：更早的消息不得出现，表头要写明「取了几 / 共几条」
#[test]
fn history_preview_keeps_only_the_last_five() {
    let msgs: Vec<Message> = (0..8)
        .map(|i| {
            msg(
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("第 {i} 条"),
            )
        })
        .collect();
    let lines = history_preview(&msgs, HISTORY_PREVIEW);
    assert_eq!(lines.len(), 6, "1 行表头 + 5 条消息");
    assert_eq!(lines[0].kind, LineKind::Notice);
    assert!(lines[0].text.contains("最近 5 条 / 共 8 条"), "{}", lines[0].text);
    assert!(
        !lines[1].text.contains("第 2 条"),
        "更早的消息不该出现: {}",
        lines[1].text
    );
    // 第 3 条是奇数下标 → assistant（时序：user, assistant, user, …）
    assert!(lines[1].text.contains("[AI] 第 3 条"), "{}", lines[1].text);
    assert_eq!(lines[1].kind, LineKind::Assistant);
    assert_eq!(lines[2].kind, LineKind::User);
    assert!(lines[2].text.contains("[你] 第 4 条"), "{}", lines[2].text);
    assert!(
        lines[5].text.contains("第 7 条"),
        "最后一条必须是最新的: {}",
        lines[5].text
    );
}

/// 新会话（没有历史）不该打出空表头
#[test]
fn history_preview_is_empty_without_messages() {
    assert!(history_preview(&[], HISTORY_PREVIEW).is_empty());
    assert!(history_preview(&[msg("user", "hi")], 0).is_empty());
}

/// 正文为空但带工具调用的助手消息（引擎真会落这种）不能渲染成光秃秃的 `[AI]`
#[test]
fn history_preview_falls_back_to_tool_calls() {
    let m = Message {
        id: "m1".into(),
        role: "assistant".into(),
        content: json!(""),
        tool_calls: Some(vec![ToolUseContent {
            type_: "tool_use".into(),
            id: "t1".into(),
            name: "user_choice".into(),
            input: json!({}),
        }]),
        timestamp: 0,
        ..Default::default()
    };
    let lines = history_preview(&[m], HISTORY_PREVIEW);
    assert!(
        lines[1].text.contains("调用工具 user_choice"),
        "{}",
        lines[1].text
    );
}

/// 退出提示：会话 id 必须**完整**（状态行里只显示前 8 位，不足以续连）
#[test]
fn resume_hint_carries_the_full_id_and_a_copyable_command() {
    let h = resume_hint("0123456789abcdef");
    assert!(h.contains("会话 id: 0123456789abcdef"), "{h}");
    assert!(
        h.contains("virlen-cli chat --session 0123456789abcdef"),
        "{h}"
    );
}

/// 续连（`--session`）的端到端（顺序输出模式）：先预览历史，退出时给续连命令
#[tokio::test]
async fn plain_mode_resume_prints_history_preview_and_exit_hint() {
    let dir = tmpdir("resume");
    let h = host(&dir);
    seed_provider(&h).await;

    // 第一次：新会话，提交一条 —— 连不上 127.0.0.1:1（引擎报错），但用户消息**已先落库**
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new("你好\n/exit\n".as_bytes().to_vec());
    let mut input = Input::Buf(&mut cursor);
    assert_eq!(
        run_with(
            &h,
            ChatCmd::Chat(ChatOptions {
                no_tui: true,
                ..Default::default()
            }),
            &mut out,
            &mut err,
            &mut input
        )
        .await,
        EXIT_OK
    );

    let sid = {
        let db = virlen_core::session_db::open_session_db(h.as_ref(), &|fut| {
            tokio::spawn(fut);
        })
        .unwrap();
        db.repo.list_sessions().await.unwrap()[0].id.clone()
    };

    // 第二次：续连同一条会话
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(b"/exit\n".to_vec());
    let mut input = Input::Buf(&mut cursor);
    let code = run_with(
        &h,
        ChatCmd::Chat(ChatOptions {
            session_id: Some(sid.clone()),
            no_tui: true,
            ..Default::default()
        }),
        &mut out,
        &mut err,
        &mut input,
    )
    .await;
    assert_eq!(code, EXIT_OK);

    let o = String::from_utf8_lossy(&out);
    assert!(o.contains("历史预览"), "续连应先打印历史预览: {o}");
    assert!(o.contains("[你] 你好"), "预览里应有上一条用户消息: {o}");

    let e = String::from_utf8_lossy(&err);
    assert!(e.contains("[chat] 已退出"), "{e}");
    assert!(
        e.contains(&format!("virlen-cli chat --session {}", sid)),
        "退出应给出续连命令: {e}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

// ==================== 事件映射（纯函数部分） ====================

#[test]
fn input_preview_prefers_meaningful_fields() {
    assert_eq!(
        input_preview(Some(&json!({ "command": "npm test", "timeout": 30 }))),
        "npm test"
    );
    assert_eq!(
        input_preview(Some(&json!({ "paths": ["C:/a/b.rs"] }))),
        "C:/a/b.rs"
    );
    assert_eq!(input_preview(Some(&json!({ "foo": "bar" }))), "bar");
    assert_eq!(input_preview(Some(&json!({ "n": 1 }))), "");
    assert_eq!(input_preview(None), "");
}

#[test]
fn text_of_handles_string_and_blocks() {
    assert_eq!(text_of(&json!("abc")), "abc");
    assert_eq!(
        text_of(&json!([{ "type": "text", "text": "a" }, { "type": "image_url" }])),
        "a"
    );
    assert_eq!(text_of(&json!(1)), "");
}

#[test]
fn first_line_flattens() {
    assert_eq!(first_line("a\n\nb  c", 100), "a b c");
    assert_eq!(first_line("abcdef", 3), "abc…");
}

/// sink → UI 的事件映射：流式帧**不**用 content（否则与 delta 重复）
#[test]
fn sink_maps_stream_frames_without_duplicating_content() {
    let (tx, mut rx) = mpsc::unbounded_channel::<UiEvent>();
    let sink = UiEventSink::new(tx, Arc::new(AgentBridgeState::default()));

    // 流式帧：正文走 `patch.contentDelta`（带 messageId）；同一帧里的全量 `content` 不送
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m1", "patch": { "content": "你好", "contentDelta": "你好",
                "streaming": true } }),
        ),
    );
    // `stream_event` 带的是同一份 delta —— 必须忽略，否则正文双份
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new("stream_event", json!({ "delta": "你好" })),
    );
    let mut got = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        got.push(ev);
    }
    assert_eq!(got.len(), 1, "同一份增量只应产出一个事件: {got:?}");
    assert!(matches!(
        got[0],
        UiEvent::TextDelta { ref message_id, ref delta }
            if message_id == "m1" && delta == "你好"
    ));

    // 收尾帧（streaming=false）：用全量内容纠正（带 messageId —— UI 靠它找回原块）
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m1", "patch": { "content": "你好，世界", "streaming": false,
                "usage": { "promptTokens": 10, "completionTokens": 5, "totalTokens": 15 } } }),
        ),
    );
    let ev = rx.try_recv().unwrap();
    assert!(matches!(
        ev,
        UiEvent::AssistantContent { ref message_id, ref content }
            if message_id == "m1" && content == "你好，世界"
    ));
    // 用量：同一条消息重复上报不会重复计数
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m1", "patch": { "content": "你好，世界", "streaming": false,
                "usage": { "totalTokens": 15 } } }),
        ),
    );
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m2", "patch": { "content": "x", "streaming": false,
                "usage": { "totalTokens": 7 } } }),
        ),
    );
    let mut totals = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let UiEvent::Usage { total } = ev {
            totals.push(total);
        }
    }
    assert_eq!(totals, vec![15, 15, 22], "按 messageId 求和: {totals:?}");
}

#[test]
fn sink_maps_tool_frames() {
    let (tx, mut rx) = mpsc::unbounded_channel::<UiEvent>();
    let sink = UiEventSink::new(tx, Arc::new(AgentBridgeState::default()));
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "tool_call",
            json!({ "type": "tool_use", "id": "tc1", "name": "execute_command",
                    "input": { "command": "npm test" } }),
        ),
    );
    let ev = rx.try_recv().unwrap();
    assert!(
        matches!(ev, UiEvent::ToolStart { ref name, ref detail, .. }
            if name == "execute_command" && detail == "npm test")
    );
    // 结束帧（带 result）不产出开始事件
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new("tool_call", json!({ "id": "tc1", "name": "x", "result": "ok" })),
    );
    assert!(rx.try_recv().is_err());

    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "tool_result_created",
            json!({ "message": { "content": "line1\nline2", "isError": true } }),
        ),
    );
    let ev = rx.try_recv().unwrap();
    assert!(
        matches!(ev, UiEvent::ToolDone { ok: false, chars: 11, ref preview } if preview == "line1 line2")
    );
}

/// 交互请求必须**只**送进 UI（不得同步读 stdin），且带 requestId
#[test]
fn sink_routes_interaction_to_ui() {
    let (tx, mut rx) = mpsc::unbounded_channel::<UiEvent>();
    let sink = UiEventSink::new(tx, Arc::new(AgentBridgeState::default()));
    sink.emit_raw(
        "agent:user-interaction-request",
        json!({ "requestId": "r1", "type": "confirm_command_native", "data": { "title": "t" } }),
    );
    let ev = rx.try_recv().unwrap();
    assert!(
        matches!(ev, UiEvent::Interaction { ref request_id, ref kind, .. }
            if request_id == "r1" && kind == "confirm_command_native")
    );
}

/// 实时输出带的是 toolCallId（没有 requestId）→ 当作「输出尾部」渲染，不当桥请求
#[test]
fn sink_treats_tool_output_as_live_output() {
    let (tx, mut rx) = mpsc::unbounded_channel::<UiEvent>();
    let sink = UiEventSink::new(tx, Arc::new(AgentBridgeState::default()));
    sink.emit_raw(
        "agent:tool-output",
        json!({ "sessionId": "s1", "toolCallId": "tc1", "stream": "stdout", "chunk": "hi\n" }),
    );
    let ev = rx.try_recv().unwrap();
    assert!(matches!(ev, UiEvent::ToolOutput { ref chunk } if chunk == "hi\n"));
}
