//! Provider 层 — 原生 HTTP 实现 + JS 桥接实现
//!
//! - `NativeOpenAiProvider`：OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / Ollama / 自定义）
//! - `NativeAnthropicProvider`：Anthropic Messages API
//! - `BridgedProvider`：转发到 JS 侧已有 provider（如 Gemini），通过双向事件桥
//!
//! 本文件是模块入口：只放 `Provider` / `ProviderFactory` 两个 trait 与默认工厂，
//! 具体实现按厂商拆到子模块，对外 API 在此统一重导出（调用方路径不变）：
//!
//! - `blocks`   内容块降级（file / quote / skill → 文本、vision 处理）
//! - `openai`   OpenAI 兼容协议
//! - `anthropic` Anthropic Messages API
//! - `bridged`  转发到 JS（Gemini 等）
//! - `sse`      流式响应逐行读取
//! - `models`   模型列表拉取（配置向导 / 连通性检查用；不属于运行时 `Provider` trait）
//! - `catalog`  **供应商目录（模板表 + 推理档位表）的唯一权威源**（数据在同名 json 里）

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

// ⚠️ `pub mod`（不是 `mod` + `pub use`）：供应商目录是**配置侧数据**，
//    与运行时 `Provider` trait 无关，调用方按路径取更清楚（`agent::provider::catalog`）。
pub mod catalog;

#[cfg(test)]
mod tests;

pub use anthropic::NativeAnthropicProvider;
pub use bridged::BridgedProvider;
pub use openai::NativeOpenAiProvider;
pub use models::{list_models, verify_connection};

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
