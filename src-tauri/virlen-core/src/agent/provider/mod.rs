//! Provider 层 — 原生 HTTP 实现 + JS 桥接实现。
//!
//! 本文件是模块入口：只放 `Provider` / `ProviderFactory` trait 与默认工厂，实现按厂商拆到子模块：
//! - `openai` / `anthropic`：原生 HTTP 实现（DeepSeek / Moonshot / Ollama 等走 openai 兼容协议）
//! - `bridged`：转发到 JS 侧 provider（如 Gemini），走双向事件桥
//! - `blocks`：内容块降级（file / quote / skill → 文本、vision 处理）
//! - `sse`：流式响应逐行读取
//! - `models`：模型列表拉取（配置向导 / 连通性检查）
//! - `catalog`：供应商目录（模板表 + 推理档位表）的唯一权威源（数据在同名 json）

use super::bridge::AgentBridgeState;
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::types::{ChatRequest, Message, ProviderConnection, StreamEvent};
use async_trait::async_trait;
use std::sync::Arc;

mod blocks;
mod bridged;
mod anthropic;
mod openai;
mod sse;
mod models;

// `pub mod`（不是 `mod` + `pub use`）：供应商目录是配置侧数据，与运行时 `Provider` trait 无关，
// 调用方按路径取更清楚（`agent::provider::catalog`）。
pub mod catalog;

#[cfg(test)]
mod tests;

pub use anthropic::NativeAnthropicProvider;
pub use bridged::BridgedProvider;
pub use openai::NativeOpenAiProvider;
pub use models::{list_models, verify_connection};

// ⚠️ 附件 / 引用 / 技能的「块 → 文本」降级函数要被 `agent::compress::raw` 复用：压缩渲染出的历史必须与
// 「消息直接发给模型时」是同一套文本形式（铁律 1）。因此这里收窄为 `pub(crate)` 转出（`blocks` 仍不对外）。
pub(crate) use blocks::{file_block_to_text, quote_block_to_text, skill_block_to_text};

/// 一次请求的**传输侧事实**（轨迹检查器「请求」页用）。
///
/// 与 `usage_ledger.duration_ms` 的分工：`duration_ms` 是整段请求（含完整流式回复），
/// 这里拆出「请求体多大 / 等响应头多久 / 等首个字节多久」—— 才能区分「请求重」与「模型慢」。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestMetrics {
    /// 实际发出的请求体字节数（JSON 序列化后的 UTF-8 长度）；0 = 未采集（桥接协议 / 非 JSON body）
    pub request_bytes: usize,
    /// 发出请求 → 收到响应头（ms）；`None` = 未采集
    pub response_start_ms: Option<i64>,
    /// 发出请求 → 收到首个响应字节（ms）；`None` = 未采集（非流式无法把等待与读取分开）
    pub first_byte_ms: Option<i64>,
}

/// 请求体实际字节数 —— 与 reqwest `.json()` 同一个序列化器，所以就是线上发出的长度。
pub(crate) fn json_body_bytes(body: &serde_json::Value) -> usize {
    serde_json::to_vec(body).map(|b| b.len()).unwrap_or(0)
}

// ==================== Provider trait ====================

#[async_trait]
pub trait Provider: Send + Sync {
    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String>;
    async fn chat_stream(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String>;

    /// 取走**最近一次**请求的传输侧事实（只有原生 HTTP provider 提供）。
    ///
    /// 「取走」而非「读取」：同一个 provider 实例会服务多轮请求，残留的旧值会被
    /// 记到下一次请求头上。默认 `None`（桥接 / 测试替身不提供 → UI 显示破折号，不猜）。
    fn take_request_metrics(&self) -> Option<RequestMetrics> {
        None
    }
}

// ==================== Provider 工厂 ====================

/// Provider 工厂 — 根据连接信息创建 Provider 实例
pub trait ProviderFactory: Send + Sync {
    fn create(&self, conn: &ProviderConnection) -> Box<dyn Provider>;
}

/// 默认工厂：openai/anthropic 原生 HTTP，其余（gemini 等）桥接 JS
pub struct DefaultProviderFactory {
    pub bridge: Arc<AgentBridgeState>,
    pub sink: Arc<dyn EventSink>,
}

/// 按连接信息创建**原生** Provider（openai 兼容 / anthropic）—— headless 环境专用。
///
/// 与 [`DefaultProviderFactory`] 的差别：后者对非 openai/anthropic 会返回
/// [`BridgedProvider`]（需要 JS 宿主 + 双向事件桥）。headless 环境（CLI）**没有** JS 宿主，
/// 调它只会永久挂起（引擎侧真实踩过的挂死）；因此这里对桥接协议直接**报错**，
/// 让调用方在装配期就能给出可读提示。
///
/// 用在「不与对话消息列表打交道的一次性调用」上，典型是上下文压缩的 `ai` 摘要。
pub fn create_native_provider(conn: &ProviderConnection) -> Result<Box<dyn Provider>, String> {
    match conn.provider_type.as_str() {
        "anthropic" => Ok(Box::new(NativeAnthropicProvider::new(
            &conn.provider_id,
            &conn.api_key,
            &conn.base_url,
        ))),
        "openai" => Ok(Box::new(NativeOpenAiProvider::new(
            &conn.provider_id,
            &conn.api_key,
            &conn.base_url,
        ))),
        other => Err(format!(
            "Provider 协议 \"{}\" 需要前端 JS 桥，headless 环境不支持（可用：openai 兼容 / anthropic）",
            other
        )),
    }
}

impl ProviderFactory for DefaultProviderFactory {
    fn create(&self, conn: &ProviderConnection) -> Box<dyn Provider> {
        match conn.provider_type.as_str() {
            "anthropic" => Box::new(NativeAnthropicProvider::new(
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
            )),
            "openai" => Box::new(NativeOpenAiProvider::new(
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
            )),
            _ => Box::new(BridgedProvider::new(
                &conn.provider_id,
                &conn.provider_type,
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
                self.bridge.clone(),
                self.sink.clone(),
            )),
        }
    }
}
