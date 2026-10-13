//! `vision_analyze` 工具（原生）— 端侧视觉分析（UI 元素 + OCR + 图标 + 物体检测）。
//!
//! ⚠️ 与 TS `vision-analyze.ts` 逐字对齐（铁律 1）：缺 `path` 两侧都失败；路径不存在两侧都正常
//! 返回 `Error: source path does not exist — <p>`；模型目录缺失 / 推理失败两侧都回 `Vision Error: <msg>`。
//! 失败走 `NativeToolOutcome::error(...)` 而非 `Err(...)`（后者会被前缀成 `error: …`，与桥路径不一致）。
//! UI 直接渲染 `content`（tree text 语言无关）故不下发 uiData；推理是秒级同步调用，必须 `spawn_blocking`，
//! 且**必须可取消**（用户点「停止」要立刻有反馈；两层取消的说明见 `vision_analyze_tool` 内注释）。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::heavy;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::vision;
use serde_json::Value;

/// 取消时的统一结果（文案与 `web_fetch` 同口径：`<工具名> was cancelled: <目标>`）
fn cancelled(source_path: &str) -> Result<NativeToolOutcome, String> {
    Ok(NativeToolOutcome::error(format!(
        "vision_analyze was cancelled: {}",
        source_path
    )))
}

pub(crate) async fn vision_analyze_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    if path.is_empty() {
        return Err("Missing required parameter: \"path\"".to_string());
    }

    // 安全路径校验（对齐 `securityService.resolveSafePath(path, 'r', sessionId)`）
    let source_path = resolve_safe_path(&path, "r", ctx.security)?;

    // 取消预检放最前：已经点了停止就不该再产出「路径不存在 / 模型缺失」这类无关结果
    if ctx.cancel.is_cancelled() {
        return cancelled(&source_path);
    }

    // 与 TS 的 `tauriFs.exists` 等价：不存在时**不是错误**，而是一条正常结果
    if !std::path::Path::new(&source_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("Error: source path does not exist — {}", source_path),
            ui_data: None,
        });
    }

    // 模型目录来自宿主（GUI = resource_dir，CLI = exe 同级 / $VIRLEN_RESOURCE_DIR）
    let models_dir = match vision::models_dir(ctx.host) {
        Ok(d) => d,
        Err(e) => return Ok(NativeToolOutcome::error(format!("Vision Error: {}", e))),
    };

    let is_web = vision::is_web_hint(&source_path);
    let read_path = source_path.clone();

    // 统一走 `run_heavy`（并发闸 + 线程降优先级 + 两层取消，见 `native_tools/heavy.rs`）：
    // 端侧模型只有一份，多个视觉分析并跑会把 CPU 抢光 → 闸保证串行；
    // 降优先级让 ONNX 的推理线程池不跟 UI 抢调度；取消时立刻返回、结果丢弃。
    let result = heavy::run_heavy(ctx.cancel, move |flag| {
        std::fs::read(&read_path)
            .map_err(|e| format!("Failed to read file '{}': {}", read_path, e))
            .and_then(|bytes| vision::analyze_at_cancellable(&models_dir, &bytes, is_web, flag))
    })
    .await;

    let result = match result {
        // 被取消：结果按丢弃处理
        heavy::Heavy::Cancelled => return cancelled(&source_path),
        heavy::Heavy::Panicked(e) => {
            return Ok(NativeToolOutcome::error(format!(
                "Vision Error: internal error: {}",
                e
            )))
        }
        heavy::Heavy::Done(v) => v,
    };

    match result {
        Ok(r) => Ok(NativeToolOutcome::Value {
            content: r.combined_text,
            ui_data: None,
        }),
        // 阻塞线程内的检查点先命中：沿用取消文案，不要退化成 `Vision Error: …`
        Err(e) if e == vision::CANCELLED_MSG => cancelled(&source_path),
        Err(e) => Ok(NativeToolOutcome::error(format!("Vision Error: {}", e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::host::HostEnv;
    use crate::agent::native_tools::test_util::test_security;
    use serde_json::json;
    use std::path::PathBuf;

    /// 固定候选目录的假宿主（无模型目录 → 只测「找不到模型」这条分支）
    struct EmptyHost {
        root: PathBuf,
    }
    impl HostEnv for EmptyHost {
        fn resource_candidates(&self) -> Vec<PathBuf> {
            vec![self.root.clone()]
        }
        fn data_dir(&self) -> PathBuf {
            self.root.clone()
        }
    }

    async fn run_with_host(
        host: &dyn HostEnv,
        sec: &crate::agent::types::NativeToolSecurity,
        cancel: &CancellationToken,
        args: Value,
    ) -> Result<NativeToolOutcome, String> {
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let ctx = NativeToolCtx {
            session_id: "s",
            tool_call_id: "tc",
            cancel,
            sink: &sink,
            bridge: &bridge,
            security: sec,
            repo: crate::agent::native_tools::noop_repo(),
            memory: crate::agent::native_tools::noop_memory(),
            skills: None,
            host,
            settings: crate::agent::native_tools::noop_settings(),
        };
        vision_analyze_tool(&ctx, &args).await
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("virlen_vision_tool_{}_{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn missing_path_param_is_an_error() {
        let dir = tmp_dir("nopath");
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };
        let r = run_with_host(&host, &sec, &CancellationToken::new(), json!({})).await;
        assert!(r.is_err(), "缺 path 应为 Err，实得 {r:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 路径不存在 → **正常结果**（与 TS 一致，不是 isError）
    #[tokio::test]
    async fn nonexistent_path_returns_value_with_exact_text() {
        let dir = tmp_dir("missing");
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };

        let r = run_with_host(
            &host,
            &sec,
            &CancellationToken::new(),
            json!({ "path": "nope.png" }),
        )
        .await
        .expect("不应是调用级错误");
        match r {
            NativeToolOutcome::Value { content, ui_data } => {
                // `resolve_safe_path` 不做 canonicalize，只把入参的 `\` 换成 `/` 后拼到 workspace 后；
                // 因此断言「前缀 + 结尾」而不写死整体分隔符风格（跨平台安全）。
                assert!(
                    content.starts_with("Error: source path does not exist — ") && content.ends_with("/nope.png"),
                    "content: {content}"
                );
                assert!(ui_data.is_none(), "与 TS 一致：无 uiData");
            }
            other => panic!("expected Value, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 图片存在但模型目录缺失 → 失败文本与桥路径同形（`Vision Error: …`，无 `error: ` 前缀）
    #[tokio::test]
    async fn missing_models_dir_yields_vision_error_text() {
        let dir = tmp_dir("nomodels");
        std::fs::write(dir.join("shot.png"), b"not-a-real-png").unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };

        let r = run_with_host(
            &host,
            &sec,
            &CancellationToken::new(),
            json!({ "path": "shot.png" }),
        )
        .await
        .expect("不应是调用级错误");
        match r {
            NativeToolOutcome::Error { content, .. } => {
                assert!(
                    content.starts_with("Vision Error: quasivision models directory not found."),
                    "content: {content}"
                );
                assert!(!content.starts_with("error: "), "不应带 error: 前缀: {content}");
            }
            other => panic!("expected Error, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 取消预检：ctx 已取消时，必须在「路径存在性判断 / 模型目录探测」**之前**就返回取消文案。
    /// （EmptyHost 没有模型目录 → 若预检失效，这里会拿到 `Vision Error: … models directory not found`）
    #[tokio::test]
    async fn cancelled_before_start_returns_cancel_text() {
        let dir = tmp_dir("cancelled");
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };
        let cancel = CancellationToken::new();
        cancel.cancel();

        let r = run_with_host(&host, &sec, &cancel, json!({ "path": "nope.png" }))
            .await
            .expect("取消不是调用级错误");
        match r {
            NativeToolOutcome::Error { content, .. } => {
                assert!(
                    content.starts_with("vision_analyze was cancelled:"),
                    "content: {content}"
                );
            }
            other => panic!("expected Error, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
