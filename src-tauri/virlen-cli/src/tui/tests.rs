use crate::tui::state::UiEvent;
use crate::{EXIT_ERROR, EXIT_OK};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::mpsc;
use virlen_core::agent::bridge::AgentBridgeState;
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::AgentEvent;

use super::*;
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

    // 流式帧：content 与随后的 delta 是同一份正文 → 只取 delta
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m1", "patch": { "content": "你好", "streaming": true } }),
        ),
    );
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new("stream_event", json!({ "delta": "你好" })),
    );
    let mut got = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        got.push(ev);
    }
    assert_eq!(got.len(), 1, "流式帧不得产出内容事件: {got:?}");
    assert!(matches!(got[0], UiEvent::TextDelta(ref s) if s == "你好"));

    // 收尾帧（streaming=false）：用全量内容纠正
    sink.emit_agent_event(
        "s1",
        &AgentEvent::new(
            "assistant_message_updated",
            json!({ "messageId": "m1", "patch": { "content": "你好，世界", "streaming": false,
                "usage": { "promptTokens": 10, "completionTokens": 5, "totalTokens": 15 } } }),
        ),
    );
    let ev = rx.try_recv().unwrap();
    assert!(matches!(ev, UiEvent::AssistantContent(ref s) if s == "你好，世界"));
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
