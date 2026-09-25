use crate::tui::commands::Slash;
use serde_json::json;

use super::*;

fn keys(st: &mut UiState, s: &str) -> Option<Action> {
    let mut last = None;
    for c in s.chars() {
        if let a @ Some(_) = st.apply_key(Key::Char(c)) {
            last = a;
        }
    }
    last
}

#[test]
fn typing_then_enter_submits_and_echoes() {
    let mut st = UiState::new();
    keys(&mut st, "你好");
    assert_eq!(st.input(), "你好");
    assert_eq!(st.cursor(), 2);
    let act = st.apply_key(Key::Enter);
    assert_eq!(act, Some(Action::Submit("你好".into())));
    assert!(st.running(), "提交后应进入运行中");
    assert!(st.input().is_empty(), "提交后输入框清空");
    // 回显 + 未固化
    let inflight = st.inflight().to_vec();
    assert_eq!(inflight.len(), 1);
    assert_eq!(inflight[0].text, "> 你好");
    assert_eq!(inflight[0].kind, LineKind::User);
}

#[test]
fn empty_enter_is_a_noop() {
    let mut st = UiState::new();
    assert_eq!(st.apply_key(Key::Enter), None);
    assert!(!st.running());
    assert!(st.inflight().is_empty());
}

#[test]
fn slash_commands_do_not_start_a_turn() {
    let mut st = UiState::new();
    keys(&mut st, "/help");
    assert_eq!(st.apply_key(Key::Enter), Some(Action::Slash(Slash::Help)));
    assert!(!st.running());

    keys(&mut st, "/nope");
    assert_eq!(
        st.apply_key(Key::Enter),
        Some(Action::Slash(Slash::Unknown("nope".into())))
    );
}

#[test]
fn exit_command_quits() {
    let mut st = UiState::new();
    keys(&mut st, "/exit");
    assert_eq!(st.apply_key(Key::Enter), Some(Action::Quit));
    assert!(st.should_quit);
}

#[test]
fn ctrl_c_cancels_when_running_and_quits_when_idle() {
    let mut st = UiState::new();
    assert_eq!(st.apply_key(Key::CtrlC), Some(Action::Quit));
    assert!(st.should_quit);

    let mut st = UiState::new();
    keys(&mut st, "hi");
    st.apply_key(Key::Enter);
    assert_eq!(st.apply_key(Key::CtrlC), Some(Action::Cancel));
    assert!(!st.should_quit, "运行中第一次 Ctrl+C 只取消，不退出");
    assert_eq!(st.apply_key(Key::Esc), Some(Action::Cancel));
}

#[test]
fn cursor_editing_is_char_based() {
    let mut st = UiState::new();
    keys(&mut st, "中文ab");
    st.apply_key(Key::Left);
    st.apply_key(Key::Left);
    st.apply_key(Key::Backspace); // 删掉 '文'
    assert_eq!(st.input(), "中ab");
    assert_eq!(st.cursor(), 1);
    st.apply_key(Key::Home);
    st.apply_key(Key::Delete); // 删掉 '中'
    assert_eq!(st.input(), "ab");
    st.apply_key(Key::End);
    keys(&mut st, "!");
    assert_eq!(st.input(), "ab!");
}

#[test]
fn history_walks_back_and_forth() {
    let mut st = UiState::new();
    for m in ["one", "two"] {
        keys(&mut st, m);
        st.apply_key(Key::Enter);
        st.apply(UiEvent::RunFinished {
            ok: true,
            error: None,
            elapsed_ms: 1,
        });
    }
    keys(&mut st, "draft");
    st.apply_key(Key::Up);
    assert_eq!(st.input(), "two");
    st.apply_key(Key::Up);
    assert_eq!(st.input(), "one");
    st.apply_key(Key::Up); // 到头不越界
    assert_eq!(st.input(), "one");
    st.apply_key(Key::Down);
    assert_eq!(st.input(), "two");
    st.apply_key(Key::Down);
    assert_eq!(st.input(), "draft", "回到末尾应恢复草稿");
}

#[test]
fn assistant_deltas_accumulate_then_final_content_replaces() {
    let mut st = UiState::new();
    st.apply(UiEvent::TextDelta("你".into()));
    st.apply(UiEvent::TextDelta("好".into()));
    let inflight = st.inflight().to_vec();
    assert_eq!(inflight.len(), 1, "连续增量合成一块");
    assert_eq!(inflight[0].text, "你好");

    st.apply(UiEvent::AssistantContent("你好，世界".into()));
    assert_eq!(st.inflight()[0].text, "你好，世界", "全量内容整块替换");
}

#[test]
fn tool_start_dedupes_two_frames_and_keeps_output_tail() {
    let mut st = UiState::new();
    st.apply(UiEvent::ToolStart {
        id: "tc1".into(),
        name: "execute_command".into(),
        detail: "npm test".into(),
    });
    st.apply(UiEvent::ToolStart {
        id: "tc1".into(),
        name: "execute_command".into(),
        detail: "npm test".into(),
    });
    assert_eq!(st.inflight().len(), 1, "同一 id 的第二次开始帧必须去重");
    assert!(st.inflight()[0].text.contains("npm test"));

    st.apply(UiEvent::ToolOutput {
        chunk: "running…\n".into(),
    });
    st.apply(UiEvent::ToolOutput { chunk: "ok\n".into() });
    assert_eq!(st.tool_tail(), "running…\nok\n");

    st.apply(UiEvent::ToolDone {
        ok: true,
        chars: 12,
        preview: "ok".into(),
    });
    assert!(st.tool_tail().is_empty());
    let last = st.inflight().last().unwrap();
    assert!(last.text.contains("ok"), "{}", last.text);

    // 新 id 仍要显示
    st.apply(UiEvent::ToolStart {
        id: "tc2".into(),
        name: "read_file".into(),
        detail: "a.rs".into(),
    });
    assert_eq!(st.inflight().len(), 3);
}

#[test]
fn control_chars_and_ansi_are_stripped() {
    let mut st = UiState::new();
    st.apply(UiEvent::ToolOutput {
        chunk: "\x1b[31mred\x1b[0m\r\n".into(),
    });
    assert_eq!(st.tool_tail(), "red\n", "ANSI 转义序列要整段剥掉，不能留下 [31m");
    // OSC（设置标题之类）也不能漏
    st.apply(UiEvent::ToolOutput {
        chunk: "\x1b]0;title\x07ok".into(),
    });
    assert_eq!(st.tool_tail(), "red\nok");
    let l = OutLine::new(LineKind::Notice, "a\x07b");
    assert_eq!(l.text, "ab");
}

#[test]
fn commit_waits_until_the_turn_ends() {
    let mut st = UiState::new();
    keys(&mut st, "hi");
    st.apply_key(Key::Enter);
    assert!(st.take_commit().is_empty(), "回合进行中不固化");

    st.apply(UiEvent::RunFinished {
        ok: true,
        error: None,
        elapsed_ms: 7,
    });
    let committed = st.take_commit();
    assert!(!committed.is_empty());
    assert!(committed.iter().any(|l| l.text.contains("用时 7 ms")));
    assert!(st.inflight().is_empty(), "固化后动态区清空");
    assert!(st.take_commit().is_empty(), "同一批不会固化两次");
}

/// 提示（/help 之类）应能立刻固化（此时没有回合在跑）
#[test]
fn notice_commits_immediately_when_idle() {
    let mut st = UiState::new();
    st.apply(UiEvent::Notice("帮助".into()));
    let committed = st.take_commit();
    assert_eq!(committed.len(), 1);
    assert_eq!(committed[0].text, "帮助");
}

#[test]
fn run_finished_reports_errors_and_clears_running() {
    let mut st = UiState::new();
    keys(&mut st, "hi");
    st.apply_key(Key::Enter);
    st.apply(UiEvent::RunFinished {
        ok: false,
        error: Some("boom".into()),
        elapsed_ms: 3,
    });
    assert!(!st.running());
    st.apply(UiEvent::RunFinished {
        ok: false,
        error: None,
        elapsed_ms: 1,
    });
    let committed = st.take_commit();
    assert!(committed.iter().any(|l| l.text.contains("boom")));
    assert!(committed.iter().any(|l| l.text.contains("[failed]")));
}

#[test]
fn confirm_interaction_answers_and_queues_next() {
    let mut st = UiState::new();
    st.apply(UiEvent::Interaction {
        request_id: "r1".into(),
        kind: "confirm_command_native".into(),
        data: json!({ "title": "删除目录", "desc": "rm -rf", "risk": "dangerous" }),
    });
    // 第二个请求排队等待
    st.apply(UiEvent::Interaction {
        request_id: "r2".into(),
        kind: "user_choice".into(),
        data: json!({ "question": "选哪个", "options": ["A", "B"] }),
    });
    assert_eq!(st.interaction().unwrap().request_id, "r1");

    // 交互期间按键只进交互，不进输入框
    keys(&mut st, "y");
    assert_eq!(st.input(), "");
    let act = st.apply_key(Key::Enter);
    assert_eq!(
        act,
        Some(Action::Reply {
            request_id: "r1".into(),
            payload: json!({ "__kind": "value", "value": "approved" }),
        })
    );
    // 队列里的下一个顶上
    assert_eq!(st.interaction().unwrap().request_id, "r2");

    keys(&mut st, "2");
    let act = st.apply_key(Key::Enter);
    assert_eq!(
        act,
        Some(Action::Reply {
            request_id: "r2".into(),
            payload: json!({ "__kind": "value", "value": "B" }),
        })
    );
    assert!(st.interaction().is_none());
}

#[test]
fn interaction_esc_cancels_and_unknown_kind_is_answered() {
    let mut st = UiState::new();
    st.apply(UiEvent::Interaction {
        request_id: "r1".into(),
        kind: "user_choice".into(),
        data: json!({ "question": "q", "options": ["A"] }),
    });
    assert_eq!(
        st.apply_key(Key::Esc),
        Some(Action::Reply {
            request_id: "r1".into(),
            payload: json!({ "__kind": "cancelled" }),
        })
    );

    // 未知类型也必须应答（否则引擎永久等待）
    st.apply(UiEvent::Interaction {
        request_id: "r2".into(),
        kind: "something_new".into(),
        data: json!({}),
    });
    let it = st.interaction().unwrap().clone();
    assert_eq!(it.answer(), json!({ "__kind": "cancelled" }));
    assert_eq!(
        st.apply_key(Key::Enter).unwrap(),
        Action::Reply {
            request_id: "r2".into(),
            payload: json!({ "__kind": "cancelled" }),
        }
    );
}

#[test]
fn empty_answer_to_confirm_means_allow_and_other_text_denies() {
    let mk = |input: &str| Interaction {
        request_id: "r".into(),
        kind: "confirm_command_native".into(),
        data: json!({}),
        input: input.to_string(),
    };
    assert_eq!(
        mk("").answer(),
        json!({ "__kind": "value", "value": "approved" })
    );
    assert_eq!(
        mk("YES").answer(),
        json!({ "__kind": "value", "value": "approved" })
    );
    assert_eq!(mk("n").answer(), json!({ "__kind": "cancelled" }));
    assert_eq!(mk("随便").answer(), json!({ "__kind": "cancelled" }));
}

#[test]
fn session_changed_updates_status() {
    let mut st = UiState::new();
    st.apply(UiEvent::SessionChanged {
        session_id: "s1".into(),
        title: "t".into(),
        model: "m".into(),
        workspace: "E:/w".into(),
        messages: 3,
    });
    assert_eq!(st.status.session_id, "s1");
    assert_eq!(st.status.messages, 3);
    assert!(st.is_dirty(), "切会话至少要让状态行重绘");
    // 切会话本身不产生正文（提示行由调用方另发 `Notice`）
    assert!(st.take_commit().is_empty());
}

/// 斜杠命令的回显属于「通知」：应立即固化，不搅进下一个回合
#[test]
fn slash_echo_commits_immediately() {
    let mut st = UiState::new();
    keys(&mut st, "/status");
    st.apply_key(Key::Enter);
    let committed = st.take_commit();
    assert_eq!(committed.len(), 1);
    assert_eq!(committed[0].text, "> /status");
}

#[test]
fn shutdown_sets_quit() {
    let mut st = UiState::new();
    st.apply(UiEvent::Shutdown);
    assert!(st.should_quit);
}

#[test]
fn expand_splits_embedded_newlines() {
    let lines = vec![
        OutLine::new(LineKind::Assistant, "a\nb"),
        OutLine::new(LineKind::User, "c"),
    ];
    assert_eq!(
        expand(&lines),
        vec![
            (LineKind::Assistant, "a"),
            (LineKind::Assistant, "b"),
            (LineKind::User, "c"),
        ]
    );
}

#[test]
fn tick_only_advances_while_running() {
    let mut st = UiState::new();
    st.clear_dirty();
    st.tick();
    assert_eq!(st.frame(), 0);
    assert!(!st.is_dirty(), "tick 不该触发重绘（重绘节流由调用方管）");

    keys(&mut st, "hi");
    st.apply_key(Key::Enter);
    st.clear_dirty();
    st.tick();
    assert_eq!(st.frame(), 1);
    assert!(!st.is_dirty());
}

/// 回合进行中再回车：不能发第二个回合（输入框内容保留）
#[test]
fn submit_is_rejected_while_running() {
    let mut st = UiState::new();
    keys(&mut st, "first");
    assert_eq!(st.apply_key(Key::Enter), Some(Action::Submit("first".into())));
    keys(&mut st, "second");
    assert_eq!(st.apply_key(Key::Enter), None, "回合进行中不得再提交");
    assert_eq!(st.input(), "second", "输入内容应保留，回合结束后可直接回车");
}
