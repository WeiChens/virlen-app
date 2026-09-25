//! `vision_analyze` 工具（原生）— 端侧视觉分析（UI 元素 + OCR + 图标 + 物体检测）
//!
//! ⚠️ 与 TS 侧 `infrastructure/tools/vision/vision-analyze.ts` **逐字对齐**（铁律 1）：
//!
//! | 场景 | TS 行为 | 本实现 |
//! |---|---|---|
//! | 缺少 `path` | 安全路径解析抛错 → 桥回 `__kind:"error"` | `Err`（原生分发会加 `error: ` 前缀） |
//! | 路径不存在 | **正常返回** `{ content: "Error: source path does not exist — <p>" }` | 同（`Value`，不是错误） |
//! | 模型目录缺失 / 推理失败 | `VisionError` → 桥回 message `Vision Error: <msg>` | 同（`Error` 变体，**不加** `error: ` 前缀） |
//!
//! 为什么失败用 `NativeToolOutcome::error(...)` 而不是 `Err(...)`：`Err` 会被
//! `execute_single_step` 统一前缀成 `error: …`，与桥路径的裸 message 不一致。
//!
//! UI 侧（`VisionAnalyzeMessage`）直接渲染 `content`（tree text 语言无关），故**不下发 uiData**。
//!
//! 推理是秒级 CPU 密集同步调用，必须 `spawn_blocking` —— 聊天流式回传与它共用同一个 runtime。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::vision;
use serde_json::Value;

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

    let result = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&read_path)
            .map_err(|e| format!("Failed to read file '{}': {}", read_path, e))?;
        vision::analyze_at(&models_dir, &bytes, is_web)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    match result {
        Ok(r) => Ok(NativeToolOutcome::Value {
            content: r.combined_text,
            ui_data: None,
        }),
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
        args: Value,
    ) -> Result<NativeToolOutcome, String> {
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s",
            tool_call_id: "tc",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: sec,
            repo: crate::agent::native_tools::noop_repo(),
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
        let r = run_with_host(&host, &sec, json!({})).await;
        assert!(r.is_err(), "缺 path 应为 Err，实得 {r:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 路径不存在 → **正常结果**（与 TS 一致，不是 isError）
    #[tokio::test]
    async fn nonexistent_path_returns_value_with_exact_text() {
        let dir = tmp_dir("missing");
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };

        let r = run_with_host(&host, &sec, json!({ "path": "nope.png" }))
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

        let r = run_with_host(&host, &sec, json!({ "path": "shot.png" }))
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
}
