//! 取消令牌 — 用于中止引擎循环 / LLM 请求 / 工具执行
//!
//! 基于 `AtomicBool` + `Notify`，支持克隆，可在异步任务间共享。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub struct CancellationToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// 请求取消
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// 等待取消发生；已被取消则立即返回
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn not_cancelled_by_default() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());
    }

    #[tokio::test]
    async fn cancel_flips_flag() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_await_resolves() {
        let token = CancellationToken::new();
        let token2 = token.clone();
        let handle = tokio::spawn(async move {
            token2.cancelled().await;
            true
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        token.cancel();
        assert!(handle.await.unwrap());
    }

    #[tokio::test]
    async fn cancelled_returns_immediately() {
        let token = CancellationToken::new();
        token.cancel();
        let token2 = token.clone();
        let start = std::time::Instant::now();
        token2.cancelled().await;
        assert!(start.elapsed() < Duration::from_millis(50));
    }
}
