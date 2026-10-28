//! MCP 资源工具（2）—— `list_mcp_resources` / `read_mcp_resource`。
//!
//! 为什么这两个是**内置工具**而不是动态 `mcp__*`：它们操作的是「所有服务器」这一层
//! （列资源天然是跨服务器的动作），而动态工具名必须绑定一台具体的服务器与一个具体的工具名。
//! 资源列表本身由服务器在 `resources/list` 里声明，前端不可知，所以只能由模型按需查询。
//!
//! ⚠️ 两个工具都**不经过审批**：读资源与读工具的输入侧（`tools/call` 前的审批）不同 ——
//! 资源是服务器自己声明的只读数据，`read_mcp_resource` 只是取回它。真正的风险在服务器侧
//! （它可能在 `resources/read` 里做副作用），因此默认审批档 `ask` 的服务器仍然对 `tools/call`
//! 逐次确认，而资源读取按其只读语义处理。

use serde_json::Value;

use super::{NativeToolCtx, NativeToolOutcome};
use crate::mcp::resources;

/// 取一个非空字符串参数（去空白；缺失 / 空白 → `None`）
fn arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) async fn list_mcp_resources_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let server = match args.get("server") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.trim().is_empty() => None,
        Some(Value::String(text)) => Some(text.trim().to_string()),
        Some(other) => {
            return Ok(NativeToolOutcome::error(format!(
                "Invalid \"server\": expected a string (MCP server name), got {other}"
            )))
        }
    };

    let listings = crate::mcp::list_resources(server.as_deref(), Some(ctx.cancel)).await;
    let (content, ui) = resources::project_listing(&listings);
    // 指名道姓要某台服务器的资源、结果却是错误 → 必须是失败（红色），不能装成「列出来 0 个」
    if server.is_some() && listings.iter().any(|item| item.error.is_some()) {
        return Ok(NativeToolOutcome::Error {
            content,
            ui_data: Some(ui),
        });
    }
    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(ui),
    })
}

pub(crate) async fn read_mcp_resource_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let Some(server) = arg_string(args, "server") else {
        return Ok(NativeToolOutcome::error(
            "read_mcp_resource requires a non-empty \"server\" (the MCP server name that owns the resource)",
        ));
    };
    let Some(uri) = arg_string(args, "uri") else {
        return Ok(NativeToolOutcome::error(
            "read_mcp_resource requires a non-empty \"uri\" (as returned by list_mcp_resources)",
        ));
    };

    match crate::mcp::read_resource(&server, &uri, Some(ctx.cancel)).await {
        Ok(read) => {
            let (content, ui) = resources::project_read(&server, &read);
            Ok(NativeToolOutcome::Value {
                content,
                ui_data: Some(ui),
            })
        }
        Err(error) => Ok(NativeToolOutcome::error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::EventSink;
    use crate::agent::types::{AgentEvent, NativeToolSecurity};
    use crate::mcp::host::{McpHost, McpServerState, McpServerStatus};
    use crate::mcp::McpCallOutcome;
    use async_trait::async_trait;
    use serde_json::json;

    struct NullSink;
    impl EventSink for NullSink {
        fn emit_agent_event(&self, _session_id: &str, _event: &AgentEvent) {}
        fn emit_raw(&self, _event_name: &str, _payload: Value) {}
    }

    /// 假宿主：只实现资源两个方法（其余走 trait 默认实现）
    struct ResourceHost {
        fail: bool,
    }

    #[async_trait]
    impl McpHost for ResourceHost {
        fn statuses(&self) -> Vec<McpServerStatus> {
            Vec::new()
        }
        async fn list_resources(
            &self,
            server: Option<&str>,
            _cancel: Option<&CancellationToken>,
        ) -> Vec<crate::mcp::McpResourceListing> {
            if self.fail {
                return vec![crate::mcp::McpResourceListing::failed(
                    server.unwrap_or("fs"),
                    "failed",
                    "MCP server \"fs\" is not connected (failed)",
                )];
            }
            vec![crate::mcp::McpResourceListing {
                server: server.unwrap_or("fs").to_string(),
                state: McpServerState::Ready.as_str().to_string(),
                resources: vec![crate::mcp::McpResource {
                    uri: "file:///a.md".into(),
                    name: "a".into(),
                    title: None,
                    description: None,
                    mime_type: Some("text/markdown".into()),
                    size: None,
                }],
                error: None,
            }]
        }
        async fn read_resource(
            &self,
            server: &str,
            uri: &str,
            _cancel: Option<&CancellationToken>,
        ) -> Result<crate::mcp::McpResourceRead, String> {
            let _ = server;
            if self.fail {
                return Err("MCP resource read failed (fs): boom".to_string());
            }
            Ok(crate::mcp::McpResourceRead {
                uri: uri.to_string(),
                mime_type: Some("text/markdown".into()),
                text: Some("# hi".into()),
                blob_bytes: 0,
                content_count: 1,
            })
        }
        async fn call(&self, _req: crate::mcp::McpCallRequest<'_>) -> McpCallOutcome {
            McpCallOutcome::error("unused")
        }
    }

    /// 跑一个用例体：持全局锁（`HOST` 是进程级单例）+ 挂上假宿主 + 收尾卸下。
    ///
    /// 写成宏而不是「接异步闭包」的辅助函数：`NativeToolCtx` 借的是局部变量，
    /// 用闭包传递会碰上「life­time 不够一般」的烦人错误，宏里内联展开最直白。
    macro_rules! with_host {
        ($fail:expr, |$ctx:ident| $body:expr) => {{
            let _guard = crate::mcp::host::test_lock().lock().await;
            crate::mcp::host::attach(std::sync::Arc::new(ResourceHost { fail: $fail }));
            let cancel = CancellationToken::new();
            let bridge = AgentBridgeState::default();
            let sink = NullSink;
            let security = NativeToolSecurity::default();
            let $ctx = &NativeToolCtx {
                session_id: "s1",
                tool_call_id: "t1",
                cancel: &cancel,
                sink: &sink,
                bridge: &bridge,
                security: &security,
                repo: crate::agent::native_tools::noop_repo(),
                skills: None,
                host: crate::host::default_host().as_ref(),
                settings: crate::agent::native_tools::noop_settings(),
                memory: crate::agent::native_tools::noop_memory(),
            };
            let out = $body;
            crate::mcp::host::detach();
            out
        }};
    }

    #[tokio::test]
    async fn list_tool_returns_ui_and_text() {
        let (content, ui) = with_host!(false, |ctx| {
            match list_mcp_resources_tool(ctx, &json!({ "server": "fs" }))
                .await
                .unwrap()
            {
                NativeToolOutcome::Value { content, ui_data } => {
                    (content, ui_data.expect("应有 uiData"))
                }
                other => panic!("应是成功结果：{other:?}"),
            }
        });
        assert!(content.contains("file:///a.md"), "{content}");
        assert_eq!(ui["type"], "mcp_resources");
        assert_eq!(ui["servers"][0]["server"], "fs");
    }

    /// 指名某台服务器却失败 → 必须红色（否则模型会以为「该服务器没有资源」）
    #[tokio::test]
    async fn list_tool_reports_explicit_server_failures_as_errors() {
        let outcome = with_host!(true, |ctx| {
            list_mcp_resources_tool(ctx, &json!({ "server": "fs" }))
                .await
                .unwrap()
        });
        assert!(matches!(outcome, NativeToolOutcome::Error { .. }), "{outcome:?}");
    }

    #[tokio::test]
    async fn read_tool_validates_arguments() {
        let outcome = with_host!(false, |ctx| {
            read_mcp_resource_tool(ctx, &json!({ "server": "fs" }))
                .await
                .unwrap()
        });
        match outcome {
            NativeToolOutcome::Error { content, .. } => assert!(content.contains("uri"), "{content}"),
            other => panic!("缺 uri 应报错：{other:?}"),
        }
    }

    #[tokio::test]
    async fn read_tool_projects_text_and_errors() {
        let (content, ui) = with_host!(false, |ctx| {
            match read_mcp_resource_tool(ctx, &json!({ "server": "fs", "uri": "file:///a.md" }))
                .await
                .unwrap()
            {
                NativeToolOutcome::Value { content, ui_data } => {
                    (content, ui_data.expect("应有 uiData"))
                }
                other => panic!("应是成功结果：{other:?}"),
            }
        });
        assert_eq!(content, "# hi");
        assert_eq!(ui["uri"], "file:///a.md");

        let outcome = with_host!(true, |ctx| {
            read_mcp_resource_tool(ctx, &json!({ "server": "fs", "uri": "file:///a.md" }))
                .await
                .unwrap()
        });
        match outcome {
            NativeToolOutcome::Error { content, .. } => assert!(content.contains("boom"), "{content}"),
            other => panic!("读失败应报错：{other:?}"),
        }
    }
}
