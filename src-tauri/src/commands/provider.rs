//! 「获取模型」「测试连接」的后端出口。
//!
//! 为什么必须走后端：这两个请求打的是**第三方网关**（自建 / 内网 / 中转站 / 自定义 Base URL），
//! 其中相当一部分不返回 `Access-Control-Allow-Origin` —— webview 里的 fetch 会被 CORS 拦成
//! 「Failed to fetch」，而 key 和地址其实是好的。Rust 侧的 reqwest 没有同源策略，请求能正常发出。
//!
//! 语义一行都不在这里：全部转发给 `virlen-core` 的 `provider::{list_models, verify_connection}`，
//! 与 CLI 的 `virlen-cli config verify` 是同一份实现（口径不会漂）。
//!
//! ⚠️ 桥接协议（gemini）在 core 里明确报「需要前端 JS 桥」—— 前端据此回落 TS 实现（见
//! `src/services/provider-backend.ts`），不要在这里悄悄返回空表。

use virlen_core::agent::provider::{list_models, verify_connection};
use virlen_core::agent::types::ProviderConnection;

/// 拉取供应商模型列表（前端「📋 获取模型」）。
#[tauri::command]
pub async fn list_provider_models(conn: ProviderConnection) -> Result<Vec<String>, String> {
    list_models(&conn.provider_type, &conn.api_key, &conn.base_url).await
}

/// 验证连接（前端「🔗 测试连接」）：发一条最小真实请求，成功返回助手回答的纯文本（可能为空串）。
///
/// 返回 `Result` 而不是 `bool`：调用方要能把 401 / 404 / 额度不足的**原文**展示出来，
/// 吞成 `false` 会让用户只看到「测试失败」而不知道该改哪里。
#[tauri::command]
pub async fn verify_provider_connection(
    conn: ProviderConnection,
    model: String,
) -> Result<String, String> {
    verify_connection(&conn, &model).await
}
