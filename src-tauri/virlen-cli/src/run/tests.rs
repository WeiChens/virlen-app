use super::*;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::AgentEvent;
use crate::{EXIT_ERROR, EXIT_OK};
fn args(v: &[&'static str]) -> Vec<&'static str> {
    v.to_vec()
}

/// 测试用装配入口：不注入「忽略沙盒命令」规则（规则本身有专门用例）
fn build(settings: &Map<String, Value>, cmd: &RunOptions) -> Result<Resources, String> {
    build_resources(settings, Vec::new(), cmd, Path::new("."), None)
}

/// 桌面端典型配置：一个启用的 OpenAI 兼容 Provider + 两个模型
fn settings_with(extra: Value) -> Map<String, Value> {
    let providers = json!([{
        "id": "p1",
        "name": "OpenAI",
        "type": "openai",
        "apiKey": "sk-test",
        "baseUrl": "https://api.openai.com/v1",
        "models": ["gpt-4o", "gpt-4o-mini"],
        "enabled": true
    }]);
    let mut map = json!({ "providers": providers });
    if let (Some(base), Some(extra_map)) = (map.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_map {
            base.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(map).unwrap()
}

// ==================== 参数解析 ====================

#[test]
fn parse_help_variants() {
    for flag in ["-h", "--help"] {
        assert_eq!(parse(args(&[flag])), Ok(RunCmd::Help));
    }
}

#[test]
fn parse_requires_prompt() {
    assert!(parse(args(&[])).is_err());
    // 只有选项、没有位置参数 → 同样是用法错误
    assert!(parse(args(&["--json"])).is_err());
    assert!(parse(args(&["--session", "s1"])).is_err());
}

/// 位置参数以空格连接：不必为整个 prompt 加引号
#[test]
fn parse_joins_positional_words() {
    assert_eq!(
        parse(args(&["解释", "一下", "README"])),
        Ok(RunCmd::Run(RunOptions {
            prompt: "解释 一下 README".to_string(),
            ..Default::default()
        }))
    );
    // 选项可以出现在 prompt 之前 / 之后
    assert_eq!(
        parse(args(&["--json", "hi"])),
        Ok(RunCmd::Run(RunOptions {
            prompt: "hi".to_string(),
            json: true,
            ..Default::default()
        }))
    );
}

#[test]
fn parse_all_options() {
    let parsed = parse(args(&[
        "--session",
        "s1",
        "--provider",
        "p1",
        "--model",
        "gpt-4o",
        "--workspace",
        "E:/tmp",
        "--append-system-prompt",
        "用中文回答",
        "--max-rounds",
        "5",
        "--no-tools",
        "--json",
        "你好",
    ]))
    .unwrap();
    assert_eq!(
        parsed,
        RunCmd::Run(RunOptions {
            prompt: "你好".to_string(),
            session_id: Some("s1".into()),
            provider_id: Some("p1".into()),
            model_id: Some("gpt-4o".into()),
            workspace: Some("E:/tmp".into()),
            append_system_prompt: Some("用中文回答".into()),
            max_rounds: Some(5),
            no_tools: true,
            json: true,
        })
    );
}

#[test]
fn parse_rejects_bad_usage() {
    assert!(parse(args(&["--nope", "hi"])).is_err(), "未知选项");
    assert!(parse(args(&["--session"])).is_err(), "缺取值");
    assert!(parse(args(&["--session", ""])).is_err(), "空取值");
    assert!(parse(args(&["--max-rounds", "abc", "hi"])).is_err());
    assert!(parse(args(&["--max-rounds", "0", "hi"])).is_err());
}

// ==================== 配置装配 ====================

#[test]
fn build_resources_uses_default_model_and_limits() {
    let settings = settings_with(json!({
        "defaultSelectModel": { "providerConfigId": "p1", "modelId": "gpt-4o-mini" },
        "maxTokens": 1234,
        "maxToolRounds": 7,
        "maxIterations": 2,
        "sandboxMode": "off",
        "permissions": { "terminal.normal.execute": "ask" }
    }));
    let res = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(res.provider.provider_type, "openai");
    assert_eq!(res.provider.provider_id, "p1");
    assert_eq!(res.provider.api_key, "sk-test");
    assert_eq!(res.model_id, "gpt-4o-mini", "取 defaultSelectModel");
    assert_eq!(res.max_tokens, 1234);
    assert_eq!(res.max_tool_rounds, 7);
    assert_eq!(res.max_iterations, 2);
    assert!(res.enable_tools);
    assert_eq!(res.tool_defs.len(), 28, "启用工具时必须下发全量定义");
    assert_eq!(res.security.sandbox_mode, "off");
    assert_eq!(
        res.security.permissions.get("terminal.normal.execute"),
        Some(&"ask".to_string())
    );
    assert!(res.system_prompt.contains("# Current Environment"));
    assert!(
        res.system_prompt.starts_with("# Tool Call Specification"),
        "基础规范必须打头（与 TS compose-prompt 同序）"
    );
}

/// 命令行显式给的 provider / model / 轮数优先级最高
#[test]
fn build_resources_command_line_overrides_defaults() {
    let settings = settings_with(json!({
        "defaultSelectModel": { "providerConfigId": "p1", "modelId": "gpt-4o-mini" },
        "maxToolRounds": 7
    }));
    let res = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            model_id: Some("gpt-4o".into()),
            max_rounds: Some(3),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(res.model_id, "gpt-4o");
    assert_eq!(res.max_tool_rounds, 3);
}

#[test]
fn build_resources_no_tools_disables_defs() {
    let settings = settings_with(json!({}));
    let res = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            no_tools: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!res.enable_tools);
    assert!(res.tool_defs.is_empty());
}

/// 「忽略沙盒命令」规则由调用方经 `security` 读好后注入（与 CLI 运行路径同一份解析）
#[test]
fn build_resources_carries_permissions_and_sandbox_rules() {
    let settings = settings_with(json!({
        "permissions": { "terminal.dangerous.execute": "deny" }
    }));
    let rules = virlen_core::security::parse_rules(&json!([
        { "id": "r1", "name": "npm", "enabled": true, "kind": "text", "textMode": "prefix", "pattern": "npm" },
        { "id": "r2", "name": "disabled", "enabled": false, "kind": "text", "pattern": "rm" }
    ]));
    let res = build_resources(
        &settings,
        rules,
        &RunOptions {
            prompt: "hi".into(),
            ..Default::default()
        },
        Path::new("."),
        None,
    )
    .unwrap();
    assert_eq!(
        res.security.permissions.get("terminal.dangerous.execute"),
        Some(&"deny".to_string())
    );
    assert_eq!(res.security.sandbox_ignore_rules.len(), 2);
    assert_eq!(res.security.sandbox_ignore_rules[0].name, "npm");
    assert!(!res.security.sandbox_ignore_rules[1].enabled);
}

#[test]
fn build_resources_without_providers_fails_with_readable_error() {
    let settings: Map<String, Value> = serde_json::from_value(json!({})).unwrap();
    let err = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("Provider"), "err: {err}");
}

/// 未原生化的协议（Gemini 需 JS 桥）必须在装配期就报错，而不是运行期挂住
#[test]
fn build_resources_rejects_bridged_provider_type() {
    let settings: Map<String, Value> = serde_json::from_value(json!({
        "providers": [{
            "id": "g1", "name": "Gemini", "type": "gemini",
            "apiKey": "k", "baseUrl": "https://x", "models": ["gemini-2.0"], "enabled": true
        }],
        "defaultSelectModel": { "providerConfigId": "g1", "modelId": "gemini-2.0" }
    }))
    .unwrap();
    let err = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("gemini"), "err: {err}");
    assert!(err.contains("JS"), "err: {err}");
}

/// 命令行给了不存在的 provider / model → 报错并列出可用值（绝不静默换一个）
#[test]
fn build_resources_reports_unknown_ids_with_choices() {
    let settings = settings_with(json!({}));
    let err = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            provider_id: Some("nope".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("nope") && err.contains("p1"), "err: {err}");

    let err = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            model_id: Some("gpt-9".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("gpt-9") && err.contains("gpt-4o"), "err: {err}");
}

#[test]
fn build_resources_missing_api_key_is_rejected() {
    let settings: Map<String, Value> = serde_json::from_value(json!({
        "providers": [{
            "id": "p1", "type": "openai", "apiKey": "",
            "baseUrl": "https://x", "models": ["m"], "enabled": true
        }],
        "defaultSelectModel": { "providerConfigId": "p1", "modelId": "m" }
    }))
    .unwrap();
    let err = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("apiKey"), "err: {err}");
}

#[test]
fn build_resources_appends_extra_system_prompt() {
    let settings = settings_with(json!({ "allowEnvPrompt": false }));
    let res = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            append_system_prompt: Some("只回答一个字".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!res.system_prompt.contains("# Current Environment"));
    assert!(res.system_prompt.ends_with("只回答一个字"));
}

/// 技能目录：存在才注入（目录规则 = `<data_dir>/skills`，与前端 `skillStore` 一致）
#[test]
fn skills_dir_is_derived_from_data_dir_when_present() {
    let dir = std::env::temp_dir().join(format!("virlen_cli_skills_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("skills").join("demo")).unwrap();
    let host: Arc<dyn HostEnv> = Arc::new(virlen_core::host::CliHost::new(vec![], dir.clone()));

    let got = existing_skills_dir(&host).expect("目录存在时应注入路径");
    assert!(got.ends_with("skills"), "got={got}");

    // 目录不在 → 不注入（工具按「无技能」处理，与桌面端首次启动一致）
    std::fs::remove_dir_all(dir.join("skills")).ok();
    assert!(existing_skills_dir(&host).is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn build_resources_rejects_missing_workspace() {
    let settings = settings_with(json!({}));
    let err = build(
        &settings,
        &RunOptions {
            prompt: "hi".into(),
            workspace: Some("E:/definitely/missing/dir".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("工作目录"), "err: {err}");
}

// ==================== 工作目录：会话记录是权威（曾经的真实 bug） ====================

/// 续用会话时工作目录取**会话记录**，cwd 不参与
#[test]
fn resolve_workspace_prefers_session_record_over_cwd() {
    let cmd = RunOptions {
        prompt: "hi".into(),
        session_id: Some("s1".into()),
        ..Default::default()
    };
    assert_eq!(
        resolve_workspace(&cmd, Path::new("E:/cwd"), Some("C:/Users/wei/Desktop/test"), None).unwrap(),
        "C:/Users/wei/Desktop/test"
    );
}

/// 会话没记录工作目录（桌面端建会话时未选）→ 才回退到 cwd
#[test]
fn resolve_workspace_falls_back_when_record_is_missing_or_blank() {
    let cmd = RunOptions {
        prompt: "hi".into(),
        session_id: Some("s1".into()),
        ..Default::default()
    };
    assert_eq!(
        resolve_workspace(&cmd, Path::new("E:/cwd"), None, None).unwrap(),
        "E:/cwd"
    );
    assert_eq!(
        resolve_workspace(&cmd, Path::new("E:/cwd"), Some("   "), None).unwrap(),
        "E:/cwd"
    );
}

/// `--workspace` 与会话记录指向同一目录（大小写 / 结尾分隔符不同）→ 放行，且返回记录值
#[test]
fn resolve_workspace_accepts_same_path_written_differently() {
    let dir = std::env::temp_dir().join(format!("virlen_cli_ws_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let recorded = dir.to_string_lossy().to_string();
    let spelling = if cfg!(windows) {
        format!("{}\\", recorded.to_uppercase())
    } else {
        format!("{}/", recorded)
    };
    let cmd = RunOptions {
        prompt: "hi".into(),
        session_id: Some("s1".into()),
        workspace: Some(spelling),
        ..Default::default()
    };
    assert_eq!(
        resolve_workspace(&cmd, Path::new("."), Some(&recorded), None).unwrap(),
        recorded
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// 同一目录的两种写法：**符号链接** vs 真实路径（macOS 的 `/var` → `/private/var` 正是这一形）
/// —— 必须判成同一目录，否则续跑被无辜拦下（ci.yml 的 macos 用例踩到过）。
#[cfg(unix)]
#[test]
fn same_path_resolves_symlink_to_same_dir() {
    let base = std::env::temp_dir().join(format!("virlen_cli_ws_l_{}", uuid::Uuid::new_v4()));
    let real = base.join("real");
    let other = base.join("other");
    let link = base.join("link");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // 软链写法 ↔ 真实路径 → 同一目录
    assert!(same_path(&link.to_string_lossy(), &real.to_string_lossy()));
    // 真不同的目录仍必须判成不同（防止 canonicalize 被写成「永远相等」）
    assert!(!same_path(&link.to_string_lossy(), &other.to_string_lossy()));

    std::fs::remove_dir_all(&base).ok();
}

/// 记录里的目录**已被删掉** → 两侧 canonicalize 都失败，必须退回字符串比较
/// （不能因为「拿不到真身」就判成换个目录：那会让「续跑一个旧会话」直接失败）
#[test]
fn same_path_falls_back_to_string_when_dir_is_missing() {
    let missing = std::env::temp_dir().join(format!("virlen_cli_ws_g_{}", uuid::Uuid::new_v4()));
    let plain = missing.to_string_lossy().to_string();
    let with_sep = format!("{}{}", plain, std::path::MAIN_SEPARATOR);
    assert!(same_path(&with_sep, &plain), "缺失目录应退回字符串比较（忽略结尾分隔符）");
    assert!(!same_path(&plain, &format!("{}x", plain)));
}

/// 续用时 `--workspace` 与会话记录冲突 → 明确报错（会话的工作目录不可变更）
#[test]
fn resolve_workspace_rejects_conflicting_workspace_on_resume() {
    let a = std::env::temp_dir().join(format!("virlen_cli_ws_a_{}", uuid::Uuid::new_v4()));
    let b = std::env::temp_dir().join(format!("virlen_cli_ws_b_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();

    let cmd = RunOptions {
        prompt: "hi".into(),
        session_id: Some("s1".into()),
        workspace: Some(b.to_string_lossy().to_string()),
        ..Default::default()
    };
    let err = resolve_workspace(&cmd, Path::new("."), Some(&a.to_string_lossy()), None).unwrap_err();
    assert!(err.contains("不可变更"), "err: {err}");

    std::fs::remove_dir_all(&a).ok();
    std::fs::remove_dir_all(&b).ok();
}

/// 新建会话（无 --session）→ `--workspace` 生效（不受任何会话记录影响）
#[test]
fn resolve_workspace_uses_flag_for_new_sessions() {
    let dir = std::env::temp_dir().join(format!("virlen_cli_ws_n_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let cmd = RunOptions {
        prompt: "hi".into(),
        workspace: Some(dir.to_string_lossy().to_string()),
        ..Default::default()
    };
    assert_eq!(
        resolve_workspace(&cmd, Path::new("E:/cwd"), None, None).unwrap(),
        dunce::canonicalize(&dir).unwrap().to_string_lossy().to_string()
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// 记录为空时的回退链：`--workspace` → 设置里的 defaultWorkspace → cwd
#[test]
fn resolve_workspace_falls_back_to_default_workspace_then_cwd() {
    let base = RunOptions {
        prompt: "hi".into(),
        session_id: Some("s1".into()),
        ..Default::default()
    };
    // 有默认工作目录 → 用它（与桌面端 `getWorkspace` 同一条兵底链）
    assert_eq!(
        resolve_workspace(&base, Path::new("E:/cwd"), None, Some("D:/default")).unwrap(),
        "D:/default"
    );
    assert_eq!(
        resolve_workspace(&base, Path::new("E:/cwd"), Some("  "), Some("D:/default")).unwrap(),
        "D:/default"
    );
    // 显式 --workspace 优先于默认工作目录
    let dir = std::env::temp_dir().join(format!("virlen_cli_ws_p_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let with_flag = RunOptions {
        workspace: Some(dir.to_string_lossy().to_string()),
        ..base
    };
    assert_eq!(
        resolve_workspace(&with_flag, Path::new("E:/cwd"), None, Some("D:/default")).unwrap(),
        dunce::canonicalize(&dir).unwrap().to_string_lossy().to_string()
    );
    std::fs::remove_dir_all(&dir).ok();
}

// ==================== 事件渲染 ====================

#[test]
fn render_streams_text_then_newline_at_end() {
    let mut state = RenderState::default();
    let ev = AgentEvent::new("stream_event", json!({ "delta": "你好" }));
    assert_eq!(render_event(&ev, false, &mut state).stdout, "你好");

    let ev = AgentEvent::new("stream_event", json!({ "delta": "世界" }));
    assert_eq!(render_event(&ev, false, &mut state).stdout, "世界");

    // 结束帧补换行（正文没以换行结尾时）
    let end = AgentEvent::new("stream_end", json!({}));
    assert_eq!(render_event(&end, false, &mut state).stdout, "\n");
    // 已经换过行则不再重复补
    assert_eq!(render_event(&end, false, &mut state).stdout, "");
}

#[test]
fn render_ignores_assistant_message_updated() {
    // contentDelta 与 stream_event 是同一份正文 —— 重复打印会出现双份
    let mut state = RenderState::default();
    let ev = AgentEvent::new(
        "assistant_message_updated",
        json!({ "messageId": "m1", "patch": { "contentDelta": "x" } }),
    );
    let out = render_event(&ev, false, &mut state);
    assert!(out.is_empty());
}

#[test]
fn render_tool_lines_go_to_stderr() {
    let mut state = RenderState::default();
    let start = AgentEvent::new(
        "tool_call",
        json!({ "type": "tool_use", "id": "tc1", "name": "read_file", "input": {} }),
    );
    let out = render_event(&start, false, &mut state);
    assert!(out.stdout.is_empty(), "工具进度不进 stdout");
    assert!(out.stderr.contains("read_file"));

    let result = AgentEvent::new(
        "tool_result_created",
        json!({ "message": {
            "id": "m1", "role": "tool",
            "content": "line1\nline2", "isError": false
        } }),
    );
    let out = render_event(&result, false, &mut state);
    assert!(out.stderr.contains("ok"));
    assert!(out.stderr.contains("line1 line2"), "预览压成单行: {}", out.stderr);
}

/// 同一次工具调用的两帧「开始」事件只打一行（GUI 靠 id 去重，CLI 也要）
#[test]
fn render_dedupes_repeated_tool_call_starts() {
    let mut state = RenderState::default();
    let ev = AgentEvent::new(
        "tool_call",
        json!({ "type": "tool_use", "id": "tc1", "name": "read_file", "input": {} }),
    );
    assert!(!render_event(&ev, false, &mut state).stderr.is_empty());
    assert!(
        render_event(&ev, false, &mut state).is_empty(),
        "同一 id 的后续开始帧必须被去重"
    );
    // 新 id 仍然要打
    let other = AgentEvent::new(
        "tool_call",
        json!({ "type": "tool_use", "id": "tc2", "name": "write_file", "input": {} }),
    );
    assert!(render_event(&other, false, &mut state)
        .stderr
        .contains("write_file"));
}

/// 结束帧（带 result）不重复报名字
#[test]
fn render_tool_call_end_frame_is_ignored() {
    let mut state = RenderState::default();
    let ev = AgentEvent::new(
        "tool_call",
        json!({ "type": "tool_use", "id": "tc1", "name": "read_file", "result": "ok" }),
    );
    assert!(render_event(&ev, false, &mut state).is_empty());
}

#[test]
fn render_error_and_json_mode() {
    let mut state = RenderState::default();
    let out = render_event(&AgentEvent::error("boom"), false, &mut state);
    assert!(out.stderr.contains("boom"));

    let ev = AgentEvent::new("stream_event", json!({ "delta": "x" }));
    let out = render_event(&ev, true, &mut state);
    assert!(out.stderr.is_empty());
    let parsed: Value = serde_json::from_str(out.stdout.trim()).unwrap();
    assert_eq!(parsed["type"], "stream_event");
    assert_eq!(parsed["data"]["delta"], "x");
}

// ==================== 交互 ====================

#[test]
fn resolve_choice_by_index_text_and_custom() {
    let options = vec!["A".to_string(), "B".to_string()];
    assert_eq!(resolve_choice("2", &options, false), Some("B".into()));
    assert_eq!(resolve_choice("A", &options, false), Some("A".into()));
    assert_eq!(resolve_choice("a", &options, false), Some("A".into()));
    // 非选项文本 = 自定义回复（对应 GUI 的 customReply）
    assert_eq!(resolve_choice("都不要", &options, false), Some("都不要".into()));
    // 空输入 = 取消
    assert_eq!(resolve_choice("   ", &options, false), None);
    // 越界序号不能命中选项 → 按自定义文本处理
    assert_eq!(resolve_choice("9", &options, false), Some("9".into()));
}

#[test]
fn resolve_choice_multi_joins_by_comma() {
    let options = vec!["A".to_string(), "B".to_string(), "C".to_string()];
    assert_eq!(resolve_choice("1,3", &options, true), Some("A, C".into()));
    assert_eq!(resolve_choice("A、B", &options, true), Some("A, B".into()));
    // 选项 + 自定义混合：都能带上
    assert_eq!(resolve_choice("1,自定义", &options, true), Some("A, 自定义".into()));
    assert_eq!(resolve_choice(" , ", &options, true), None);
}

/// 非 TTY 一律拒绝（方案 A 的安全底线）
#[test]
fn ask_user_is_fail_closed_without_tty() {
    let mut input = std::io::Cursor::new(b"y\n".to_vec());
    let answer = ask_user(
        "confirm_command_native",
        &json!({ "title": "危险命令", "desc": "rm -rf /", "risk": "dangerous" }),
        false,
        &mut input,
    );
    assert_eq!(answer["__kind"], "cancelled");

    let answer = ask_user(
        "user_choice",
        &json!({ "question": "选哪个？", "options": ["A", "B"] }),
        false,
        &mut input,
    );
    assert_eq!(answer["__kind"], "cancelled");
}

/// 交互式（TTY）下 `y` 放行、其余拒绝；`user_choice` 回选项文本
#[test]
fn ask_user_reads_stdin_when_interactive() {
    let mut input = std::io::Cursor::new(b"y\n".to_vec());
    let answer = ask_user("confirm_command_native", &json!({}), true, &mut input);
    assert_eq!(answer["__kind"], "value");
    assert_eq!(answer["value"], "approved");

    let mut input = std::io::Cursor::new(b"n\n".to_vec());
    let answer = ask_user("confirm_command_native", &json!({}), true, &mut input);
    assert_eq!(answer["__kind"], "cancelled");

    let mut input = std::io::Cursor::new(b"2\n".to_vec());
    let answer = ask_user(
        "user_choice",
        &json!({ "question": "q", "options": ["A", "B"], "multi": false }),
        true,
        &mut input,
    );
    assert_eq!(answer["value"], "B");
}

/// 未知交互类型也必须应答（否则引擎会一直等回执）
#[test]
fn ask_user_answers_unknown_interaction_types() {
    let mut input = std::io::Cursor::new(Vec::new());
    let answer = ask_user("something_new", &json!({}), true, &mut input);
    assert_eq!(answer["__kind"], "cancelled");
}

// ==================== 端到端（不触碰网络） ====================

/// 空库 + 无 Provider → 可读错误 + 退出码 1（不 panic、不挂起）
#[tokio::test]
async fn run_without_providers_fails_cleanly() {
    let dir = std::env::temp_dir().join(format!("virlen_cli_run_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let host: Arc<dyn HostEnv> = Arc::new(virlen_core::host::CliHost::new(vec![], dir.clone()));

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = run(
        &host,
        RunCmd::Run(RunOptions {
            prompt: "你好".into(),
            ..Default::default()
        }),
        &mut out,
        &mut err,
    )
    .await;

    assert_eq!(code, EXIT_ERROR);
    assert!(out.is_empty(), "出错时 stdout 不应有正文: {}", String::from_utf8_lossy(&out));
    assert!(
        String::from_utf8_lossy(&err).contains("Provider"),
        "err: {}",
        String::from_utf8_lossy(&err)
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// `run --help` 只打印帮助、不碰数据库
#[tokio::test]
async fn run_help_does_not_touch_database() {
    let dir = std::env::temp_dir().join(format!("virlen_cli_help_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let host: Arc<dyn HostEnv> = Arc::new(virlen_core::host::CliHost::new(vec![], dir.clone()));

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    assert_eq!(run(&host, RunCmd::Help, &mut out, &mut err).await, EXIT_OK);
    assert!(String::from_utf8_lossy(&out).contains("用法:"));
    assert!(!dir.join("virlen.db").exists(), "help 不得建库");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn title_from_prompt_takes_first_line_and_clamps() {
    assert_eq!(title_from_prompt("第一行\n第二行"), "第一行");
    assert_eq!(title_from_prompt("  短标题  "), "短标题");
    let long = "啊".repeat(80);
    let title = title_from_prompt(&long);
    assert_eq!(title.chars().count(), 61, "60 字符 + 省略号");
    assert!(title.ends_with('…'));
}

#[test]
fn one_line_preview_flattens_and_truncates() {
    assert_eq!(one_line_preview("a\n\nb   c", 100), "a b c");
    assert_eq!(one_line_preview("abcdef", 3), "abc…");
}
