//! 管理器（P1）的**端到端**回归 —— 真子进程 + 快照 + 世代 + 调用投影。
//!
//! 与 `mcp_stdio.rs` 的分工：那边测协议层（握手 / 分页 / 断链），这边测「接进引擎之后」的语义：
//!
//! - 一台服务器连上后，工具以**服务器自己的名字**（必要时带哈希后缀）出现在快照里，
//!   名字里不含服务器名（改服务器名不能影响白名单与历史）；
//! - 世代（epoch）只在**工具集合**变化时前进，`list_changed` 重同步不会抖；
//! - `tools/call` 的结果按 `results.rs` 的规则投影（模型文本 + 界面块）；
//! - 工具名不存在 / 服务器被移除时给的是**明确错误**，不是静默成功；
//! - `kill_all()` 之后工具注销、进程树收干净。
//!
//! 夹具服务器是 `src/bin/mcp_fixture.rs`（`CARGO_BIN_EXE_mcp-fixture` 由 cargo 提供）。

use std::time::{Duration, Instant};

use serde_json::json;
use virlen_core::mcp::{
    probe, McpCallRequest, McpHost, McpManager, McpServerConfig, McpServerState,
};

fn fixture_config(name: &str) -> McpServerConfig {
    serde_json::from_value(json!({
        "id": format!("id-{name}"),
        "name": name,
        "transport": "stdio",
        "command": env!("CARGO_BIN_EXE_mcp-fixture"),
        // 测试里不重连：失败就是失败，别让用例等退避
        "reconnect": { "enabled": false },
        "startupTimeoutMs": 20_000,
        "toolCallTimeoutMs": 20_000,
    }))
    .expect("测试配置应能反序列化")
}

/// 等到某台服务器进入 `ready`（超时就返回 false，由调用方断言）
async fn wait_ready(manager: &McpManager, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = manager.statuses().first() {
            if status.state == McpServerState::Ready {
                return true;
            }
            if matches!(status.state, McpServerState::Failed | McpServerState::Error) {
                return false;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn manager_publishes_calls_and_tears_down_a_real_server() {
    let manager = McpManager::new(vec![fixture_config("fixture")], None);
    manager.start().await;

    assert!(wait_ready(&manager, Duration::from_secs(30)).await, "夹具服务器应能就绪");

    // 1) 工具以公开名出现在快照里（按公开名排序，提示词前缀稳定）
    let names: Vec<String> = manager
        .definitions()
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    assert_eq!(
        names,
        vec!["echo", "fail", "structured"]
    );
    assert!(manager.epoch() >= 1, "有工具就应有世代");
    assert!(manager.is_ready());

    // 2) 状态快照带上服务器自称的 serverInfo 与工具数
    let status = manager.statuses().remove(0);
    assert_eq!(status.transport, "stdio");
    assert_eq!(status.tool_count, 3);
    assert_eq!(status.server_name.as_deref(), Some("mcp-fixture"));

    // 3) 调通一个工具：模型侧文本 + 界面侧块
    let echo = manager
        .call(McpCallRequest {
            tool_name: "echo",
            arguments: json!({ "text": "hello" }),
            cancel: None,
        })
        .await;
    assert!(!echo.is_error, "{}", echo.content);
    assert!(echo.content.contains("hello"), "{}", echo.content);
    let ui = echo.ui_data.expect("应有 uiData");
    assert_eq!(ui["type"], "mcp_tool");
    assert_eq!(ui["server"], "fixture");
    assert_eq!(ui["rawName"], "echo");
    assert_eq!(ui["blocks"][0]["type"], "text");

    // 4) 服务器报的业务失败必须走失败通道（红色卡片），不能渲染成成功
    let failed = manager
        .call(McpCallRequest {
            tool_name: "fail",
            arguments: json!({}),
            cancel: None,
        })
        .await;
    assert!(failed.is_error, "isError:true 必须映射成失败");
    assert!(failed.ui_data.is_some(), "失败也要有 uiData");

    // 5) 不存在的工具：明确说「不可用」，且不改状态
    let missing = manager
        .call(McpCallRequest {
            tool_name: "nope",
            arguments: json!({}),
            cancel: None,
        })
        .await;
    assert!(missing.is_error);
    assert!(missing.content.contains("not available"), "{}", missing.content);

    // 6) 拆掉之后工具必须注销（模型不该再看到一台已经不在的服务器）
    let before = manager.epoch();
    manager.kill_all().await;
    assert!(manager.definitions().is_empty());
    assert!(manager.statuses().is_empty());
    assert!(manager.epoch() > before, "注销工具也是一次世代变化");
}

/// `probe`（设置页「获取工具列表」）走的是同一条连接链：不落库、不影响正在跑的服务器
#[tokio::test]
async fn probe_reports_tools_without_leaving_a_server_behind() {
    let config = fixture_config("probe");
    let tools = probe(&config).await.expect("探针应连上夹具服务器");
    assert_eq!(
        tools.iter().map(|tool| tool.raw_name.as_str()).collect::<Vec<_>>(),
        vec!["echo", "fail", "structured"]
    );
    assert_eq!(tools[0].name, "echo");
}

/// 配置非法时不建连，直接给出可读错误（设置页能原样显示）
#[tokio::test]
async fn probe_rejects_invalid_config_before_connecting() {
    let mut config = fixture_config("bad");
    config.name = "has space".to_string();
    let error = probe(&config).await.expect_err("非法服务器名应被拒绝");
    assert!(error.contains("下划线") || error.contains("字母"), "{error}");
}
