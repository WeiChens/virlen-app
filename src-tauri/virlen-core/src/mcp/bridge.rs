//! MCP 调用的**审批闸门** —— `ask` 档先问人，`allow` 直通，`deny` 直接拒。
//!
//! 为什么审批放在这里而不是 `McpManager::call` 里：`mcp` 的协议层与管理器都不认识引擎的
//! 用户交互桥（那要 `EventSink` + `AgentBridgeState` + 取消令牌），而「谁有权问用户」本来就
//! 属于引擎。于是分工是：管理器只回答「这台服务器什么档」，闸门负责问人，`tool_executor`
//! 负责把结论映射成 run 的状态。
//!
//! 三条纪律（对应 `docs/mcp-plan.md` §7.2）：
//! 1. **复用既有通道，不发明新通道**：`type = "confirm_mcp_call"`，`risk` 恒 `dangerous`
//!    （MCP 不在本机权限模型内，手机侧对未知 `permName` 判 high 正是我们要的从严）。
//! 2. **拒绝 == `[User cancelled]`**（与 `execute_command` 逐字一致）：绝不渲染成绿色成功。
//! 3. **不记参数正文**：埋点只有 server / tool / action / 耗时。
//!
//! ⚠️ 服务器已被删掉（`approval_for` 返回 `None`）时**不弹窗**：先弹一次审批再告诉用户「工具
//! 不可用」是纯粹的骚扰，直接调下去让管理器给出如实错误（方案 §14 风险 5）。

use serde_json::{json, Value};

use crate::agent::bridge::{AgentBridgeState, BridgeInteractionResult};
use crate::agent::cancellation::CancellationToken;
use crate::agent::event_sink::EventSink;
use super::config::McpApproval;
use super::host::{call_tool, host, McpCallOutcome};
use super::naming::split_mcp_tool_name;

/// 审批弹窗里参数正文的上限（字符数，4 KB）。
///
/// 参数可能很大（往 MCP 服务器写文件），但用户只需要看清「它要干什么」；
/// 正文本来就不是给机器看的，截断比让弹窗滚十屏好。模型侧拿到的是完整结果，不受此限。
pub const MAX_DESC_CHARS: usize = 4 * 1024;

/// 交互类型（前端 `services/tool-service/index.ts` 按它路由；CLI 在 `run/ask.rs` 应答）
pub const CONFIRM_TYPE: &str = "confirm_mcp_call";

/// 一次 MCP 调用的引擎侧上下文 —— 审批要用到的四样东西（都在 `execute_single_step` 手上）。
pub struct McpApprovalCtx<'a> {
    pub session_id: &'a str,
    /// 让审批卡片能落回具体的工具块
    pub tool_call_id: &'a str,
    pub sink: &'a dyn EventSink,
    pub bridge: &'a AgentBridgeState,
    pub cancel: &'a CancellationToken,
}

/// 带审批的调用结论。
///
/// `Shelved` 必须能一路传回 `execute_tool_steps`（由它把 run 标成 `paused` 并保存快照），
/// 所以不能挤进 [`McpCallOutcome`] 的 `content` 里用魔法字符串表达。
pub enum McpGatedCall {
    Done(McpCallOutcome),
    Shelved,
}

impl McpGatedCall {
    /// 给埋点用的状态词（与 `rust.tool.mcp` 的既有词表一致）
    pub fn status(&self) -> &'static str {
        match self {
            Self::Shelved => "shelved",
            Self::Done(outcome) if outcome.is_error => "fail",
            Self::Done(_) => "success",
        }
    }
}

/// 调一个 MCP 工具：`ask` 档先经用户审批，其余档直通。
pub async fn call_with_approval(
    tool_name: &str,
    arguments: Value,
    ctx: &McpApprovalCtx<'_>,
) -> McpGatedCall {
    // 名字形状残缺（手工拼出来的 `mcp__x`）：不问人，直接调 —— 管理器会回一条「不可用」
    let Some((server, raw)) = split_mcp_tool_name(tool_name) else {
        return McpGatedCall::Done(call_tool(tool_name, arguments, Some(ctx.cancel)).await);
    };

    match host().approval_for(server) {
        // `allow` 与「服务器已经不在了」都直通（后者的错误由管理器如实给出）
        Some(McpApproval::Allow) | None => {
            McpGatedCall::Done(call_tool(tool_name, arguments, Some(ctx.cancel)).await)
        }
        Some(McpApproval::Deny) => McpGatedCall::Done(McpCallOutcome::error(format!(
            // 正常情况下 deny 的服务器根本不下发工具（连都不连），这里是「配置刚改成 deny」的兜底
            "Operation denied by the MCP server approval settings: mcp.{}.call",
            server
        ))),
        Some(McpApproval::Ask) => ask_then_call(tool_name, server, raw, arguments, ctx).await,
    }
}

/// `ask` 档：弹一次 `confirm_mcp_call`，允许才真的调。
async fn ask_then_call(
    tool_name: &str,
    server: &str,
    raw: &str,
    arguments: Value,
    ctx: &McpApprovalCtx<'_>,
) -> McpGatedCall {
    let data = json!({
        // 稳定 key：UI / 手机侧据此 i18n 与分级（未登记 → 手机侧从严，正是我们要的）
        "permName": format!("mcp.{}.call", server),
        // 弹窗的 title / hint 是 i18n 的 key（中文即 key）：前端 `mcp_confirm.ts` 会过一遍 t()
        "title": "MCP 工具调用",
        "subTitle": format!("{} · {}", server, raw),
        "desc": describe(&arguments),
        "hint": "该调用会交给外部 MCP 服务器执行，可能读写文件或访问网络",
        // 恒判高风险：MCP 服务器不受本应用沙盒约束（方案 §7.4）
        "risk": "dangerous",
        "toolCallId": ctx.tool_call_id,
        "serverName": server,
        "toolName": raw,
    });

    let started = crate::telemetry::now_ms();
    let payload = ctx
        .bridge
        .request_user_interaction(ctx.sink, ctx.session_id, CONFIRM_TYPE, data, ctx.cancel)
        .await;

    let payload = match payload {
        Ok(payload) => payload,
        Err(e) => {
            // 桥断了（前端没装监听器 / 回执通道没了）：如实报错，不假装「用户拒绝」
            return McpGatedCall::Done(McpCallOutcome::error(format!("error: {}", e)));
        }
    };

    let outcome = match BridgeInteractionResult::parse(&payload) {
        BridgeInteractionResult::Value { content, .. } => {
            if is_approved(&content) {
                McpGatedCall::Done(call_tool(tool_name, arguments, Some(ctx.cancel)).await)
            } else if content.trim().is_empty() {
                McpGatedCall::Done(McpCallOutcome::cancelled())
            } else {
                // 前端回的其它文本（例如 `[error] ...`）原样上报，别改写成「用户取消」
                McpGatedCall::Done(McpCallOutcome::error(content))
            }
        }
        BridgeInteractionResult::Error { content, .. } => {
            McpGatedCall::Done(McpCallOutcome::error(content))
        }
        BridgeInteractionResult::Shelved => McpGatedCall::Shelved,
        // 用户拒绝 / Esc / 运行被取消 → 一次都没调
        BridgeInteractionResult::Cancelled => McpGatedCall::Done(McpCallOutcome::cancelled()),
    };

    crate::telemetry::track(
        "mcp.tool.approval",
        json!({
            "server": server,
            // 只记「问了什么档 / 结论如何」，**不记参数与结果正文**（方案 §7.1 第 6 条）
            "tool": raw,
            "action": match &outcome {
                McpGatedCall::Shelved => "shelve",
                McpGatedCall::Done(o) if o.is_error => "reject",
                McpGatedCall::Done(_) => "allow",
            },
            "latency_ms": crate::telemetry::now_ms() - started,
        }),
    );

    outcome
}

/// 参数正文：美化后的 JSON，超长按字符截断（不切坏 UTF-8）
fn describe(arguments: &Value) -> String {
    let rendered = serde_json::to_string_pretty(arguments).unwrap_or_else(|_| "{}".to_string());
    let total = rendered.chars().count();
    if total <= MAX_DESC_CHARS {
        return rendered;
    }
    let head: String = rendered.chars().take(MAX_DESC_CHARS).collect();
    format!("{}\n… [truncated, {} chars omitted]", head, total - MAX_DESC_CHARS)
}

/// 回执是不是「允许」——与 `execute_command::parse_approval` 的白名单同一口径
/// （桌面弹窗回 `approved`、终端 / CLI 也回 `approved`；留 `允许` / `ok` 是为了容忍旧客户端）。
fn is_approved(content: &str) -> bool {
    let trimmed = content.trim();
    let normalized = trimmed.to_lowercase();
    normalized == "approved" || normalized == "允许" || trimmed == "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 参数描述：短 JSON 原样美化，超长按字符截断并留标记
    #[test]
    fn describe_pretty_prints_and_truncates() {
        let small = json!({ "path": "/tmp/a.txt" });
        let rendered = describe(&small);
        assert!(rendered.contains("\"path\""), "{}", rendered);

        let huge = json!({ "text": "x".repeat(MAX_DESC_CHARS + 10) });
        let rendered = describe(&huge);
        assert!(rendered.chars().count() < MAX_DESC_CHARS + 100);
        assert!(rendered.contains("chars omitted"));
        assert!(rendered.is_char_boundary(rendered.len()));
    }

    /// 多字节字符只在字符边界截断
    #[test]
    fn describe_respects_char_boundaries() {
        let huge = json!({ "text": "汉".repeat(MAX_DESC_CHARS + 5) });
        let rendered = describe(&huge);
        assert!(rendered.is_char_boundary(rendered.len()));
    }

    /// 放行白名单与 `execute_command` 同口径（大小写 / 空白宽容）
    #[test]
    fn approval_whitelist_matches_command_path() {
        for ok in ["approved", " Approved ", "ok", "允许"] {
            assert!(is_approved(ok), "{ok} 应当被当成放行");
        }
        for bad in ["", "cancelled", "approved!", "[error] boom", "no"] {
            assert!(!is_approved(bad), "{bad:?} 不该被当成放行");
        }
    }

    /// 名字残缺（没有 `__` 分隔）时不问人：直接调，让管理器给「不可用」
    #[tokio::test]
    async fn malformed_name_goes_straight_to_host() {
        let _guard = lock().lock().await;
        // 未挂载宿主 → Noop 回一条明确错误；这条路径上不该有任何审批交互
        super::super::host::detach();
        let bridge = AgentBridgeState::default();
        let sink = crate::agent::event_sink::TestEventSink::new();
        let cancel = CancellationToken::new();
        let ctx = McpApprovalCtx {
            session_id: "s1",
            tool_call_id: "t1",
            sink: &sink,
            bridge: &bridge,
            cancel: &cancel,
        };
        match call_with_approval("mcp__broken", json!({}), &ctx).await {
            McpGatedCall::Done(outcome) => {
                assert!(outcome.is_error);
                assert!(outcome.content.contains("not available"), "{}", outcome.content);
            }
            McpGatedCall::Shelved => panic!("残缺名字不该产生暂存"),
        }
    }

    /// `deny` 档（配置刚改）不弹窗、不调用，直接给一条可读的拒绝
    #[tokio::test]
    async fn deny_short_circuits_without_asking() {
        use std::sync::Arc;

        struct DenyHost;
        #[async_trait::async_trait]
        impl crate::mcp::McpHost for DenyHost {
            fn approval_for(&self, server: &str) -> Option<McpApproval> {
                (server == "fs").then_some(McpApproval::Deny)
            }
            async fn call(
                &self,
                req: crate::mcp::McpCallRequest<'_>,
            ) -> McpCallOutcome {
                // 走到这里说明 deny 没拦住
                McpCallOutcome::value(format!("called {}", req.tool_name), None)
            }
        }

        let _guard = lock().lock().await;
        super::super::host::attach(Arc::new(DenyHost));

        let bridge = AgentBridgeState::default();
        let sink = crate::agent::event_sink::TestEventSink::new();
        let cancel = CancellationToken::new();
        let ctx = McpApprovalCtx {
            session_id: "s1",
            tool_call_id: "t1",
            sink: &sink,
            bridge: &bridge,
            cancel: &cancel,
        };
        match call_with_approval("mcp__fs__read", json!({}), &ctx).await {
            McpGatedCall::Done(outcome) => {
                assert!(outcome.is_error);
                assert!(
                    outcome.content.contains("Operation denied"),
                    "{}",
                    outcome.content
                );
            }
            McpGatedCall::Shelved => panic!("deny 不该产生暂存"),
        }
        super::super::host::detach();
    }

    /// `allow` 档：不弹窗，直接调
    #[tokio::test]
    async fn allow_skips_approval() {
        use std::sync::Arc;

        struct AllowHost;
        #[async_trait::async_trait]
        impl crate::mcp::McpHost for AllowHost {
            fn approval_for(&self, _server: &str) -> Option<McpApproval> {
                Some(McpApproval::Allow)
            }
            async fn call(&self, req: crate::mcp::McpCallRequest<'_>) -> McpCallOutcome {
                McpCallOutcome::value(format!("called {}", req.tool_name), None)
            }
        }

        let _guard = lock().lock().await;
        super::super::host::attach(Arc::new(AllowHost));

        let bridge = AgentBridgeState::default();
        let sink = crate::agent::event_sink::TestEventSink::new();
        let cancel = CancellationToken::new();
        let ctx = McpApprovalCtx {
            session_id: "s1",
            tool_call_id: "t1",
            sink: &sink,
            bridge: &bridge,
            cancel: &cancel,
        };
        match call_with_approval("mcp__fs__read", json!({}), &ctx).await {
            McpGatedCall::Done(outcome) => {
                assert!(!outcome.is_error);
                assert_eq!(outcome.content, "called mcp__fs__read");
            }
            McpGatedCall::Shelved => panic!("allow 不该产生暂存"),
        }
        super::super::host::detach();
    }

    /// `HOST` 是进程级全局：挂载 / 卸载它的用例必须排队（与 `mcp::host` 的用例**共用同一把锁**）
    fn lock() -> &'static tokio::sync::Mutex<()> {
        super::super::host::test_lock()
    }

    // ==================== ask 档的端到端（真跑一次桥往返） ====================

    /// 把 `emit_raw` 丢进通道的 sink：用例可以「看见」桥到底发了什么
    struct ChannelSink(tokio::sync::mpsc::UnboundedSender<(String, Value)>);

    impl EventSink for ChannelSink {
        fn emit_agent_event(&self, _session_id: &str, _event: &crate::agent::types::AgentEvent) {}
        fn emit_raw(&self, event_name: &str, payload: Value) {
            let _ = self.0.send((event_name.to_string(), payload));
        }
    }

    struct AskHost;

    #[async_trait::async_trait]
    impl crate::mcp::McpHost for AskHost {
        fn approval_for(&self, _server: &str) -> Option<McpApproval> {
            Some(McpApproval::Ask)
        }
        async fn call(&self, req: crate::mcp::McpCallRequest<'_>) -> McpCallOutcome {
            McpCallOutcome::value(format!("called {}", req.tool_name), None)
        }
    }

    /// 跑一次 `ask` 档调用，把交互请求交给 `answer` 生成的回执。
    ///
    /// 返回 `(结论, 交互载荷)`：载荷用于断言「发给前端的东西是什么形状」。
    async fn run_ask(
        answer: Value,
    ) -> (McpGatedCall, Value) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = ChannelSink(tx);
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = McpApprovalCtx {
            session_id: "s1",
            tool_call_id: "call-1",
            sink: &sink,
            bridge: &bridge,
            cancel: &cancel,
        };

        let call = call_with_approval("mcp__fs__read", json!({ "path": "/tmp/a.txt" }), &ctx);
        let responder = async {
            let (event_name, payload) = rx.recv().await.expect("应当发出一条交互请求");
            assert_eq!(event_name, "agent:user-interaction-request");
            let request_id = payload["requestId"].as_str().unwrap().to_string();
            crate::agent::bridge::handle_user_interaction_response(
                &bridge,
                &request_id,
                answer,
            )
            .await;
            payload
        };
        let (gated, payload) = tokio::join!(call, responder);
        (gated, payload)
    }

    /// `ask` 档：交互载荷形状固定（前端 / 手机侧靠这些字段），允许后真的调到服务器
    #[tokio::test]
    async fn ask_payload_shape_and_allow_path() {
        use std::sync::Arc;
        let _guard = lock().lock().await;
        super::super::host::attach(Arc::new(AskHost));

        let (gated, payload) = run_ask(json!({ "__kind": "value", "value": "approved" })).await;

        assert_eq!(payload["type"], "confirm_mcp_call");
        assert_eq!(payload["sessionId"], "s1");
        let data = &payload["data"];
        assert_eq!(data["permName"], "mcp.fs.call", "稳定 key，UI / 手机靠它分级");
        assert_eq!(data["risk"], "dangerous", "MCP 不在本机权限模型内，恒判高危");
        assert_eq!(data["toolCallId"], "call-1");
        assert_eq!(data["serverName"], "fs");
        assert_eq!(data["toolName"], "read");
        assert_eq!(data["subTitle"], "fs · read");
        assert!(data["desc"].as_str().unwrap().contains("/tmp/a.txt"), "参数正文要给用户看");

        match gated {
            McpGatedCall::Done(outcome) => {
                assert!(!outcome.is_error);
                assert_eq!(outcome.content, "called mcp__fs__read");
            }
            McpGatedCall::Shelved => panic!("允许后不该是暂存"),
        }
        super::super::host::detach();
    }

    /// 用户拒绝：一次都不调，按既有的 `[User cancelled]` 失败上报（与 execute_command 同文）
    #[tokio::test]
    async fn ask_reject_is_user_cancelled() {
        use std::sync::Arc;
        let _guard = lock().lock().await;
        super::super::host::attach(Arc::new(AskHost));

        let (gated, _) = run_ask(json!({ "__kind": "cancelled" })).await;
        match gated {
            McpGatedCall::Done(outcome) => {
                assert!(outcome.is_error, "拒绝必须走红色通道");
                assert_eq!(outcome.content, "[User cancelled]");
            }
            McpGatedCall::Shelved => panic!("拒绝不是暂存"),
        }
        super::super::host::detach();
    }

    /// 用户暂存：拿 `Shelved` 回去，由 run 暂停（绝不当成失败）
    #[tokio::test]
    async fn ask_shelve_returns_shelved() {
        use std::sync::Arc;
        let _guard = lock().lock().await;
        super::super::host::attach(Arc::new(AskHost));

        let (gated, _) = run_ask(json!({ "__kind": "shelved" })).await;
        assert!(matches!(gated, McpGatedCall::Shelved));
        super::super::host::detach();
    }
}
