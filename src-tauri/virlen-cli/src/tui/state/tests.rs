use crate::tui::commands::{CompressArg, Slash};
use serde_json::json;
use virlen_core::agent::compress::CompressMode;

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

/// 推入一次授权请求（`confirm_command_native`）—— 多处复用
fn push_confirm(st: &mut UiState, request_id: &str) {
    st.apply(UiEvent::Interaction {
        request_id: request_id.to_string(),
        kind: "confirm_command_native".into(),
        data: json!({ "title": "删除目录", "desc": "rm -rf", "risk": "dangerous" }),
    });
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
    st.apply(UiEvent::TextDelta {
        message_id: "m1".into(),
        delta: "你".into(),
    });
    st.apply(UiEvent::TextDelta {
        message_id: "m1".into(),
        delta: "好".into(),
    });
    let inflight = st.inflight().to_vec();
    assert_eq!(inflight.len(), 1, "连续增量合成一块");
    assert_eq!(inflight[0].text, "你好");

    st.apply(UiEvent::AssistantContent {
        message_id: "m1".into(),
        content: "你好，世界".into(),
    });
    assert_eq!(st.inflight()[0].text, "你好，世界", "全量内容整块替换");
}

/// 回归（真机实测：`user_choice` 之后正文整段重复）：
///
/// 引擎的事件顺序是「正文增量 → `tool_call`（工具行）→ 收尾帧（`streaming:false` + 全量正文）」。
/// 收尾帧到达时「正在追加的块」已被工具行清掉；**必须按 `messageId` 找回原块**，
/// 否则会再插一块 → 正文整段重复。
#[test]
fn finalize_frame_after_tool_call_reuses_the_same_block() {
    let mut st = UiState::new();
    st.apply(UiEvent::TextDelta {
        message_id: "m1".into(),
        delta: "你好！我想先确认一下：".into(),
    });
    st.apply(UiEvent::ToolStart {
        id: "tc1".into(),
        name: "user_choice".into(),
        detail: "问题".into(),
    });
    st.apply(UiEvent::AssistantContent {
        message_id: "m1".into(),
        content: "你好！我想先确认一下：".into(),
    });
    let texts: Vec<String> = st.inflight().iter().map(|l| l.text.clone()).collect();
    assert_eq!(
        texts,
        vec![
            "你好！我想先确认一下：".to_string(),
            "⏺ user_choice(问题)".to_string()
        ],
        "收尾帧不得再插一块：{texts:?}"
    );
}

/// 回归（真机实测：工具结果跑到了下一轮正文后面）：
///
/// 工具行之后的**下一轮**正文必须新起一块（落在工具行 / 答案回显之后），
/// 不得接着上一条消息的块继续长 —— 否则它在屏幕上会跑到工具结果**前面**。
#[test]
fn next_message_text_starts_a_new_block_after_the_tool_line() {
    let mut st = UiState::new();
    st.apply(UiEvent::TextDelta {
        message_id: "m1".into(),
        delta: "第一轮".into(),
    });
    st.apply(UiEvent::ToolStart {
        id: "tc1".into(),
        name: "user_choice".into(),
        detail: "q".into(),
    });
    st.apply(UiEvent::ToolDone {
        ok: true,
        chars: 2,
        preview: "答案".into(),
    });
    st.apply(UiEvent::TextDelta {
        message_id: "m2".into(),
        delta: "第二轮".into(),
    });
    let texts: Vec<String> = st.inflight().iter().map(|l| l.text.clone()).collect();
    assert_eq!(texts.len(), 4, "{texts:?}");
    assert_eq!(texts[0], "第一轮");
    assert!(texts[1].starts_with('⏺'), "{}", texts[1]);
    assert!(texts[2].contains("ok"), "{}", texts[2]);
    assert_eq!(texts[3], "第二轮", "下一轮正文必须新起一块（排在工具结果之后）");
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

/// 续连的历史预览：**整批**进动态区并立刻固化，且**保留每行的角色**（上色靠它）。
///
/// 为什么必须立刻固化：预览不属于任何回合，留在动态区会被随后第一个回合的输出挤掉。
#[test]
fn history_preview_commits_immediately_with_roles() {
    let mut st = UiState::new();
    st.apply(UiEvent::History(vec![
        OutLine::new(LineKind::Notice, "—— 历史预览 ——"),
        OutLine::new(LineKind::User, "[你] 你好"),
        OutLine::new(LineKind::Assistant, "[AI] 你好，有什么可以帮你？"),
    ]));
    let committed = st.take_commit();
    assert_eq!(committed.len(), 3);
    assert_eq!(committed[1].kind, LineKind::User);
    assert_eq!(committed[2].kind, LineKind::Assistant);
    assert_eq!(committed[2].text, "[AI] 你好，有什么可以帮你？");
    assert!(st.inflight().is_empty(), "固化后动态区应清空");
}

/// 空的历史（新会话）：连表头都不该出现
#[test]
fn empty_history_is_ignored() {
    let mut st = UiState::new();
    st.apply(UiEvent::History(Vec::new()));
    assert!(st.take_commit().is_empty());
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

    // 授权面板：显式选择 —— 普通字符**不参与**（用户此刻可能在打字），也不进输入框
    keys(&mut st, "y");
    assert_eq!(st.input(), "");
    // → 把高亮移到「允许」，再回车才放行
    assert_eq!(st.apply_key(Key::Right), None);
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

    // 选择类仍是行输入（序号 / 文本都可用）
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

/// 回归（fail-open → fail-closed）：授权面板的**默认项是「拒绝」**。
///
/// 旧实现把空白输入当作「允许」（提示写着 `[y/N]` 却回车即放行）：用户正在打下一句
/// 消息时的一次误触 Enter，就等于批准了一条危险命令（`execute_command` 会真的跑）。
/// 这里钉住：**不主动移动高亮 + 回车 = 拒绝**。
#[test]
fn confirm_defaults_to_deny_so_a_stray_enter_never_approves() {
    let mut st = UiState::new();
    push_confirm(&mut st, "r1");

    // 先把输入框写满（模拟「用户正在打字」），再误触 Enter
    keys(&mut st, "帮我看看");
    let act = st.apply_key(Key::Enter).unwrap();
    assert_eq!(
        act,
        Action::Reply {
            request_id: "r1".into(),
            payload: json!({ "__kind": "cancelled" }),
        },
        "误触 Enter 绝不能放行"
    );
    // 结果行按「实际发出的载荷」回显
    let texts: Vec<String> = st.inflight().iter().map(|l| l.text.clone()).collect();
    assert!(texts.iter().any(|t| t == "✘ 已拒绝"), "{texts:?}");
}

/// 授权必须**主动**把高亮移到「允许」：→/↓ 选中、←/↑ 撤回
#[test]
fn confirm_requires_moving_the_highlight_to_allow() {
    let mut st = UiState::new();
    push_confirm(&mut st, "r1");

    // → 选「允许」→ 回车放行
    st.apply_key(Key::Right);
    let act = st.apply_key(Key::Enter).unwrap();
    assert_eq!(
        act,
        Action::Reply {
            request_id: "r1".into(),
            payload: json!({ "__kind": "value", "value": "approved" }),
        }
    );
    let texts: Vec<String> = st.inflight().iter().map(|l| l.text.clone()).collect();
    assert!(texts.iter().any(|t| t == "✔ 已允许"), "{texts:?}");

    // ↓ 同向；← 撤回后回车又是拒绝（两端不越界）
    let mut st = UiState::new();
    push_confirm(&mut st, "r2");
    st.apply_key(Key::Down);
    st.apply_key(Key::Up);
    st.apply_key(Key::Left);
    st.apply_key(Key::Left);
    assert_eq!(
        st.apply_key(Key::Enter).unwrap(),
        Action::Reply {
            request_id: "r2".into(),
            payload: json!({ "__kind": "cancelled" }),
        }
    );
}

/// 授权面板**不吃普通字符**：`y` / `YES` / 回车组合都不能绕过显式选择，
/// 也不会污染输入框（用户打的字不该被当成对授权的表态）
#[test]
fn confirm_ignores_letter_keys_and_keeps_input_clean() {
    let mut st = UiState::new();
    push_confirm(&mut st, "r1");

    keys(&mut st, "y");
    keys(&mut st, "YES");
    assert_eq!(st.input(), "", "授权期间的字符不得进输入框");
    // 连 Backspace 也不改变选择
    st.apply_key(Key::Backspace);
    assert_eq!(
        st.apply_key(Key::Enter).unwrap(),
        Action::Reply {
            request_id: "r1".into(),
            payload: json!({ "__kind": "cancelled" }),
        },
        "只有 →/↓ 才能把选择挪到「允许」"
    );
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

// ==================== 上下文占用与压缩 ====================

/// 上下文占用与「本进程累计 token」是两个口径，各走各的字段
#[test]
fn context_usage_event_updates_status() {
    let mut st = UiState::new();
    assert_eq!(st.status.context_tokens, None);
    st.apply(UiEvent::ContextUsage {
        tokens: Some(40_000),
    });
    assert_eq!(st.status.context_tokens, Some(40_000));
    st.apply(UiEvent::Usage { total: 12_345 });
    assert_eq!(st.status.tokens, Some(12_345));
    assert_eq!(st.status.context_tokens, Some(40_000), "两个字段互不影响");
    // 切到没有用量数据的会话 → 回到 None（界面上不显示百分比，而不是 0%）
    st.apply(UiEvent::ContextUsage { tokens: None });
    assert_eq!(st.status.context_tokens, None);
}

/// `/compress` 不带参数：只弹面板，**不产生动作**（选择由面板完成后才产生）
#[test]
fn compress_without_mode_opens_picker_and_produces_no_action() {
    let mut st = UiState::new();
    st.apply(UiEvent::DefaultCompressMode(CompressMode::Raw));
    keys(&mut st, "/compress");
    assert_eq!(st.apply_key(Key::Enter), None, "不带参数不得直接开压");
    let p = st.picker().expect("应打开选择面板");
    assert_eq!(p.options.len(), 2);
    assert_eq!(p.index, 1, "初始高亮 = 设置里的默认方式");
    // 命令回显立即固化（不属于任何回合）
    assert!(st.inflight().iter().any(|l| l.text == "> /compress"));
}

/// ↑↓ 移动 + Enter 确认 → 产生压缩动作；两端停在原地（不回绕）
#[test]
fn picker_moves_and_confirms_a_mode() {
    let mut st = UiState::new();
    keys(&mut st, "/compress");
    st.apply_key(Key::Enter);
    assert_eq!(st.picker().unwrap().index, 0, "没配默认时高亮第一项");
    assert_eq!(st.apply_key(Key::Down), None);
    assert_eq!(st.picker().unwrap().index, 1);
    st.apply_key(Key::Down);
    assert_eq!(st.picker().unwrap().index, 1, "到了底就停住");
    assert_eq!(
        st.apply_key(Key::Enter),
        Some(Action::Compress(CompressMode::Raw))
    );
    assert!(st.picker().is_none(), "确认后面板关闭");
    // 结果回显在滚动区：用户看得见自己选了什么
    assert!(st.inflight().iter().any(|l| l.text.contains("正文压缩")));
}

/// 面板开着时**普通字符不参与**（与授权面板同一条 fail-closed 口径）：
/// 用户此刻很可能在盲打下一句消息，那些字符既不该改变高亮，也不该落进输入框。
#[test]
fn picker_ignores_letter_keys_and_esc_cancels() {
    let mut st = UiState::new();
    keys(&mut st, "/compress");
    st.apply_key(Key::Enter);
    for c in ['a', 'i', 'r', 'a', 'w'] {
        assert_eq!(st.apply_key(Key::Char(c)), None);
    }
    assert!(st.input().is_empty(), "面板开着时字符不得落进输入框");
    assert_eq!(st.picker().unwrap().index, 0, "字符不得改变高亮");
    assert_eq!(st.apply_key(Key::Esc), None);
    assert!(st.picker().is_none());
    assert!(st.inflight().iter().any(|l| l.text == "→ 已取消压缩"));
}

/// 带参数走命令分派（直接压）；认不出的方式名**不得**静默退化成默认
#[test]
fn compress_mode_arg_goes_straight_through() {
    let mut st = UiState::new();
    keys(&mut st, "/compress ai");
    assert_eq!(
        st.apply_key(Key::Enter),
        Some(Action::Compress(CompressMode::Ai))
    );
    assert!(st.picker().is_none(), "带参数不弹面板");
    keys(&mut st, "/compress 全文");
    assert_eq!(
        st.apply_key(Key::Enter),
        Some(Action::Slash(Slash::Compress(CompressArg::Invalid(
            "全文".into()
        ))))
    );
}

/// 压缩期间：拦住新输入与固化，但 spinner 继续转（用户在等一次模型调用）
#[test]
fn compressing_blocks_input_and_commit_but_keeps_ticking() {
    let mut st = UiState::new();
    st.apply(UiEvent::Compressing(true));
    assert!(st.busy() && !st.running(), "压缩中算忙，但不是回合");

    keys(&mut st, "等一下");
    assert_eq!(st.apply_key(Key::Enter), None, "压缩中不得再提交");
    assert_eq!(st.input(), "等一下", "输入内容保留，压缩结束后可直接回车");
    st.apply(UiEvent::Notice("提示".into()));
    assert!(st.take_commit().is_empty(), "压缩中不得把在飞内容撕开固化");

    assert_eq!(st.frame(), 0);
    st.tick();
    assert_eq!(st.frame(), 1, "压缩中也要推进 spinner");

    st.apply(UiEvent::Compressing(false));
    assert!(!st.busy());
    assert!(!st.take_commit().is_empty(), "结束后恢复固化");
}
