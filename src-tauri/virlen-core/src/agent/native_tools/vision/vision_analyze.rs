//! `vision_analyze` 工具（原生）— 端侧视觉分析（UI 元素 + OCR + 图标 + 物体检测）。
//!
//! ⚠️ 与 TS `vision-analyze.ts` 逐字对齐（铁律 1）：缺 `path` 两侧都失败；路径不存在两侧都正常
//! 返回 `Error: source path does not exist — <p>`；模型目录缺失 / 推理失败两侧都回 `Vision Error: <msg>`。
//! 失败走 `NativeToolOutcome::error(...)` 而非 `Err(...)`（后者会被前缀成 `error: …`，与桥路径不一致）。
//! UI 直接渲染 `content`（tree text 语言无关）故不下发 uiData；推理是秒级同步调用，必须 `spawn_blocking`，
//! 且**必须可取消**（用户点「停止」要立刻有反馈；两层取消的说明见 `vision_analyze_tool` 内注释）。
//!
//! ## 关闭「本地图片伪视觉分析」时（`app_settings.imageVisionAnalyzeOptimize = false`）
//! 不再跑端侧模型：工具结果只回一段「图片事实」信封，图片本体另交一条 `role = vision_image`
//! 的注入消息（见 `image_send`；前端列表不渲染，组装请求时投影成 user）。
//! 与 dsh `read_image` 同一套语义（文本信封 + 图片块），区别是本项目 `tool` 消息放不下图片块。
//! 另外工具结果会带一份 `uiData`（`type = vision_image_sent` + `imageMessageId`）：界面卡片
//! 展开时据此把「真正发出去的那张图」渲染出来，不用再退化成只有一段文本。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::heavy;
use crate::agent::native_tools::vision::encode::Plan;
use crate::agent::native_tools::vision::image_send;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::vision;
use serde_json::Value;

/// 「本地图片伪视觉分析」开关在 `app_settings` 里的键名（与前端 `settingStore` 同名字段）。
///
/// 缺省 `true`：没写过这一行（用户没改过设置）时行为与旧版完全一致。
const ANALYZE_OPTIMIZE_KEY: &str = "imageVisionAnalyzeOptimize";

/// 本轮是否走「把图片交给模型」：是则返回本次的图片档位（**只读一次设置**）。
///
/// 读库失败按**开启端侧分析**处理（`None`）：一次读配置失败不该悄悄改变发给模型的内容。
async fn send_image_plan(ctx: &NativeToolCtx<'_>) -> Option<Plan> {
    match ctx.settings.get_all().await {
        Ok(map) => (!map
            .get(ANALYZE_OPTIMIZE_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(true))
            .then(|| Plan::from_settings(&map)),
        Err(_) => None,
    }
}

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

    // 关闭「本地图片伪视觉分析」→ 不跑端侧模型，直接把图片本身交给模型看
    //（工具结果只回「图片事实」，图片本体另走 `role = vision_image` 的注入消息）
    if let Some(plan) = send_image_plan(ctx).await {
        return send_image(ctx, &source_path, plan).await;
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

/// 「关闭本地图片伪视觉分析」的路径：读盘 + 校验 + 组一条 `role = vision_image` 消息入队。
///
/// 工具结果给模型「图片事实」（路径 / 格式 / 尺寸 / 字节数），并给界面一份
/// `uiData`（[`image_send::sent_ui_data`]：事实 + 注入消息 id）—— 卡片展开时按 id 取那条
/// 消息里的图渲染。图片本体由 `tool_executor` 在本轮工具全部结束后作为独立消息注入 ——
/// 与 dsh `read_image` 「文本信封 + 图片块」同一套语义，区别是本项目 `tool` 消息放不下图片块。
async fn send_image(
    ctx: &NativeToolCtx<'_>,
    source_path: &str,
    plan: Plan,
) -> Result<NativeToolOutcome, String> {
    let read_path = source_path.to_string();
    let display = source_path.to_string();

    // 读盘 / 嗅探 / 缩放 / 编码 / base64 都是阻塞活：与端侧推理共用 `run_heavy`
    let result = heavy::run_heavy(ctx.cancel, move |_flag| {
        let raw = std::fs::read(&read_path)
            .map_err(|e| format!("Failed to read file '{}': {}", read_path, e))?;
        let prepared = image_send::prepare_image(&display, &raw, plan)?;
        let envelope = image_send::envelope_text(
            &display,
            prepared.mime,
            prepared.bytes.len(),
            prepared.dims,
        );
        let source = prepared.reencoded.then_some(image_send::SourceFacts {
            mime: prepared.source_mime,
            bytes: prepared.source_bytes,
            dims: prepared.source_dims,
        });
        let message = image_send::build_image_message(
            &display,
            prepared.mime,
            &prepared.bytes,
            prepared.dims,
            source,
        );
        Ok::<_, String>((message, envelope))
    })
    .await;

    match result {
        heavy::Heavy::Cancelled => cancelled(source_path),
        heavy::Heavy::Panicked(e) => Ok(NativeToolOutcome::error(format!(
            "Vision Error: internal error: {}",
            e
        ))),
        heavy::Heavy::Done(Ok((message, envelope))) => {
            // 先把 UI 要的引用摘出来（message 接下来要移交给队列）
            let ui_data = image_send::sent_ui_data(&message);
            image_send::queue(ctx.session_id, message);
            Ok(NativeToolOutcome::Value {
                content: envelope,
                ui_data: Some(ui_data),
            })
        }
        // 读盘失败 / 不是支持的图片 / 超出体积上限：工具级错误（模型可据此换路径或先压缩）
        heavy::Heavy::Done(Err(e)) => Ok(NativeToolOutcome::error(format!("Vision Error: {}", e))),
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

    /// 只回一条配置的 `SettingsRepo`：`imageVisionAnalyzeOptimize = false`
    ///（= 用户关掉了本地伪视觉分析 → 工具改成把图片交给模型）
    struct OptOutSettings;

    #[async_trait::async_trait]
    impl crate::session_db::SettingsRepo for OptOutSettings {
        async fn get_all(&self) -> Result<serde_json::Map<String, Value>, String> {
            Ok([("imageVisionAnalyzeOptimize".to_string(), Value::Bool(false))]
                .into_iter()
                .collect())
        }
        async fn upsert(&self, _entries: serde_json::Map<String, Value>) -> Result<(), String> {
            Ok(())
        }
        async fn import_if_empty(
            &self,
            _entries: serde_json::Map<String, Value>,
        ) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// 关闭伪视觉分析后的全链路：**不碰模型目录**（EmptyHost 照样能跑通），
    /// 工具结果只回「图片事实」信封，图片本体入队等 `tool_executor` 注入。
    #[tokio::test]
    async fn image_mode_returns_envelope_and_queues_the_image() {
        let dir = tmp_dir("image_mode");
        // 用内容随机的图（纯色 1x1 PNG 转 JPEG 反而更大，会命中「不劣化」回退）
        std::fs::write(dir.join("shot.png"), super::super::encode::noisy_png(120, 80)).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };
        let cancel = CancellationToken::new();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let session_id = "s_vision_image_mode";
        let settings = OptOutSettings;
        let ctx = NativeToolCtx {
            session_id,
            tool_call_id: "tc",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: crate::agent::native_tools::noop_repo(),
            memory: crate::agent::native_tools::noop_memory(),
            skills: None,
            host: &host,
            settings: &settings,
        };

        let r = vision_analyze_tool(&ctx, &json!({ "path": "shot.png" }))
            .await
            .expect("不应是调用级错误");
        let ui_image_id;
        match r {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.starts_with("🖼️ "), "content: {content}");
                // 默认档位 = JPEG，所以发给模型的是转换后的 JPEG（原 120x80 PNG）
                assert!(content.contains("image/jpeg, 120x80 px"), "content: {content}");
                assert!(
                    content.contains("attached to this conversation turn"),
                    "content: {content}"
                );
                assert!(
                    !content.contains("models directory not found"),
                    "关闭伪视觉分析后不得去探测模型目录: {content}"
                );
                // 界面靠 uiData 找到「真正发出去的那张图」
                let ui = ui_data.expect("模型分析模式必须带 uiData（展开视图要渲染图片）");
                assert_eq!(ui["type"], "vision_image_sent");
                assert!(
                    ui["path"].as_str().unwrap().ends_with("/shot.png"),
                    "path: {}",
                    ui["path"]
                );
                assert_eq!(ui["mediaType"], "image/jpeg");
                assert_eq!(ui["width"], 120);
                assert_eq!(ui["height"], 80);
                assert_eq!(ui["sourceMediaType"], "image/png", "原图对照要带给界面");
                assert_eq!(ui["sourceWidth"], 120);
                assert_eq!(ui["sourceHeight"], 80);
                ui_image_id = ui["imageMessageId"].as_str().unwrap().to_string();
            }
            other => panic!("expected Value, got {other:?}"),
        }

        // 图片本体入队：一条 `role = vision_image`、内容为 text + data URL
        let queued = super::image_send::drain(session_id);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].role, crate::agent::types::VISION_IMAGE_ROLE);
        assert_eq!(
            queued[0].id, ui_image_id,
            "uiData 必须指向那条已入队的注入消息"
        );
        assert_eq!(queued[0].content[1]["type"], "image_url");
        assert!(queued[0].content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 关闭伪视觉分析 + 不是图片 → 工具级错误，且不得入队（否则会给模型发一个空/错的图）
    #[tokio::test]
    async fn image_mode_rejects_non_image_files_without_queueing() {
        let dir = tmp_dir("image_mode_bad");
        std::fs::write(dir.join("notes.txt"), b"just text").unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let host = EmptyHost { root: dir.clone() };
        let cancel = CancellationToken::new();
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let session_id = "s_vision_image_bad";
        let settings = OptOutSettings;
        let ctx = NativeToolCtx {
            session_id,
            tool_call_id: "tc",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: crate::agent::native_tools::noop_repo(),
            memory: crate::agent::native_tools::noop_memory(),
            skills: None,
            host: &host,
            settings: &settings,
        };

        let r = vision_analyze_tool(&ctx, &json!({ "path": "notes.txt" }))
            .await
            .expect("不应是调用级错误");
        match r {
            NativeToolOutcome::Error { content, .. } => {
                assert!(content.starts_with("Vision Error: "), "content: {content}");
                assert!(content.contains("not a supported image format"), "content: {content}");
            }
            other => panic!("expected Error, got {other:?}"),
        }
        assert_eq!(super::image_send::pending_count(session_id), 0);
        std::fs::remove_dir_all(&dir).ok();
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
