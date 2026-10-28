//! stdio 传输的**端到端**回归（真子进程）。
//!
//! 与 `src/mcp/**` 里的单测分工：单测用假 Transport 测协议语义，这里测「真的起一个进程」
//! 才能暴露的东西 —— 管道读写、行帧半包、stderr 归类、退出检测、关闭幂等。
//!
//! 夹具服务器是 `src/bin/mcp_fixture.rs`（`CARGO_BIN_EXE_mcp-fixture` 由 cargo 提供）。

use std::collections::BTreeMap;
use std::time::Duration;

use virlen_core::mcp::config::StdioSpec;
use virlen_core::mcp::transport::StdioTransport;
use virlen_core::mcp::{Client, Incoming};

/// 夹具可执行文件的绝对路径（cargo 在集成测试里注入）
fn fixture_path() -> String {
    env!("CARGO_BIN_EXE_mcp-fixture").to_string()
}

fn fixture_spec() -> StdioSpec {
    StdioSpec {
        command: fixture_path(),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
    }
}

#[tokio::test]
async fn handshake_list_and_call_over_a_real_process() {
    let transport = StdioTransport::spawn(&fixture_spec())
        .await
        .expect("夹具服务器应能启动");
    let client = Client::connect(transport.clone(), Duration::from_secs(15))
        .await
        .expect("握手应成功");

    let info = client.info().expect("握手信息已写入");
    assert_eq!(info.server_name, "mcp-fixture");
    assert!(info.supports_tools);
    assert!(info.tools_list_changed);
    assert_eq!(info.instructions.as_deref(), Some("fixture server"));
    assert_eq!(client.transport_kind(), "stdio");

    // 分页：第一页 2 个 + nextCursor，第二页 1 个
    let tools = client
        .list_tools(Duration::from_secs(10))
        .await
        .expect("tools/list 应成功");
    assert_eq!(
        tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        vec!["echo", "structured", "fail"]
    );
    assert_eq!(tools[0].input_schema["required"], serde_json::json!(["text"]));

    // 普通结果
    let echo = client
        .call_tool(
            "echo",
            serde_json::json!({ "text": "hello" }),
            Duration::from_secs(10),
        )
        .await
        .expect("tools/call 应成功");
    assert!(!echo.is_error);
    let text = echo.content[0]["text"].as_str().unwrap_or_default();
    assert!(text.contains("\"hello\""), "应回显参数，实际：{text}");

    // 结构化结果
    let structured = client
        .call_tool("structured", serde_json::json!({}), Duration::from_secs(10))
        .await
        .expect("structured 应成功");
    assert_eq!(structured.structured, Some(serde_json::json!({ "sum": 3 })));

    // 业务失败必须原样上报（不许被吞成成功）
    let failed = client
        .call_tool("fail", serde_json::json!({}), Duration::from_secs(10))
        .await
        .expect("isError 不是协议失败");
    assert!(failed.is_error);
    assert!(failed.content[0]["text"]
        .as_str()
        .unwrap_or_default()
        .contains("boom"));

    // 未知工具 → JSON-RPC 错误（而不是空结果）
    let error = client
        .call_tool("nope", serde_json::json!({}), Duration::from_secs(10))
        .await
        .expect_err("未知工具应报错");
    assert!(format!("{error}").contains("32601"), "{error}");

    // stderr 尾部要能拿到（UI 诊断靠它）
    let tail = transport.stderr_tail();
    assert!(tail.contains("ready"), "stderr 尾部应抓到启动日志：{tail:?}");

    client.close().await;
    let closed = tokio::time::timeout(Duration::from_secs(10), client.wait_closed()).await;
    assert!(closed.is_ok(), "关闭后应能观察到连接已结束");
    assert!(client.is_closed());
    // 关闭后再发请求必须立刻失败，不能等到超时
    let after = client
        .ping(Duration::from_secs(5))
        .await
        .expect_err("已关闭的连接不能再发请求");
    assert!(format!("{after}").contains("closed"), "{after}");
}

#[tokio::test]
async fn resources_are_listed_and_read_over_a_real_process() {
    let transport = StdioTransport::spawn(&fixture_spec())
        .await
        .expect("夹具服务器应能启动");
    let client = Client::connect(transport.clone(), Duration::from_secs(15))
        .await
        .expect("握手应成功");
    assert!(
        client.info().expect("握手信息已写入").supports_resources,
        "夹具声明了 resources 能力，客户端必须记住"
    );

    // 分页：第一页 2 个 + nextCursor，第二页空
    let resources = client
        .list_resources(Duration::from_secs(10))
        .await
        .expect("resources/list 应成功");
    assert_eq!(
        resources.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        vec!["notes", "blob"]
    );
    assert_eq!(resources[0].mime_type.as_deref(), Some("text/markdown"));
    assert_eq!(resources[0].size, Some(12));
    assert_eq!(resources[0].description.as_deref(), Some("示例笔记"));

    // 文本资源
    let text = client
        .read_resource("file://notes.md", Duration::from_secs(10))
        .await
        .expect("resources/read 应成功");
    assert_eq!(text.contents.len(), 1);
    assert_eq!(text.contents[0].text.as_deref(), Some("# notes"));
    assert_eq!(text.contents[0].mime_type.as_deref(), Some("text/markdown"));

    // 二进制资源：base64 原样交给上层（上层只算字节数，不进模型上下文）
    let blob = client
        .read_resource("file://blob.bin", Duration::from_secs(10))
        .await
        .expect("resources/read 应成功");
    assert!(blob.contents[0].blob.is_some());
    assert!(blob.contents[0].text.is_none());

    // 未知 uri → JSON-RPC 错误（不是空内容）
    let error = client
        .read_resource("file://nope", Duration::from_secs(10))
        .await
        .expect_err("未知 uri 应报错");
    assert!(format!("{error}").contains("32602"), "{error}");

    client.close().await;
}

#[tokio::test]
async fn server_notifications_and_reverse_requests_are_visible() {
    let transport = StdioTransport::spawn(&fixture_spec())
        .await
        .expect("夹具服务器应能启动");
    let client = Client::connect(transport.clone(), Duration::from_secs(15))
        .await
        .expect("握手应成功");

    // 夹具在 `notifications/initialized` 之后主动发两条：一条通知 + 一条反向请求
    let mut methods = Vec::new();
    for _ in 0..2 {
        let event = tokio::time::timeout(Duration::from_secs(10), client.next_event())
            .await
            .expect("应在超时前收到事件")
            .expect("连接未关闭");
        match event {
            Incoming::Notification { method, .. } => methods.push(method),
            Incoming::ServerRequest { id, method, .. } => {
                // 反向请求必须应答（P0 统一 MethodNotFound）
                client.reject_server_request(&id, &method).await;
                methods.push(method);
            }
            Incoming::Response { .. } => panic!("不该出现应答"),
        }
    }
    methods.sort();
    assert_eq!(
        methods,
        vec![
            "notifications/tools/list_changed".to_string(),
            "sampling/createMessage".to_string()
        ]
    );

    // 应答之后连接仍然可用（回错误不等于断链）
    assert!(client.ping(Duration::from_secs(10)).await.is_ok());
    client.close().await;
}

#[tokio::test]
async fn spawn_failure_is_reported_with_the_command_name() {
    let spec = StdioSpec {
        command: "virlen-definitely-not-a-real-command-xyz".to_string(),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
    };
    let error = StdioTransport::spawn(&spec)
        .await
        .expect_err("不存在的命令必须报错");
    let text = format!("{error}");
    assert!(
        text.contains("virlen-definitely-not-a-real-command-xyz"),
        "错误里要带命令名（用户才知道改哪一条）：{text}"
    );
}

#[tokio::test]
async fn child_crash_is_detected_as_closed() {
    let mut spec = fixture_spec();
    spec.env.insert(
        "VIRLEN_MCP_FIXTURE_CRASH_AFTER_MS".to_string(),
        "300".to_string(),
    );
    let transport = StdioTransport::spawn(&spec)
        .await
        .expect("夹具服务器应能启动");
    let client = Client::connect(transport.clone(), Duration::from_secs(15))
        .await
        .expect("握手应成功");

    // 进程 300ms 后自杀 → 读任务 EOF → 连接关闭
    tokio::time::timeout(Duration::from_secs(10), client.wait_closed())
        .await
        .expect("应在超时前观察到断链");
    assert!(client.is_closed());
}
