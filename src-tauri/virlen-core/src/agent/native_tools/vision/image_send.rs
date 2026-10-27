//! vision — 把图片本身交给模型的「注入消息」（`role = vision_image`）。
//!
//! ## 为什么要单独造一个角色
//! 工具的返回消息（`role = "tool"`）在 virlen 里只能是**字符串**：OpenAI 兼容的 `tool` 消息
//! 不支持图片 part。所以「让模型看图」不能塞进工具结果，只能另起一条消息；而这条消息又
//! **不该出现在界面里**（用户不想在对话流里多看到一张自己没发的图）。
//!
//! 于是取一个中间层角色：
//! - 库里 / 内存里：`role = "vision_image"`，前端列表、导出、侧栏一律跳过（同 dsh 的
//!   「图片块不进对话气泡」）；
//! - 组装请求时才投影成 user：
//!   - OpenAI 兼容 → `{role:"user", content:[{text},{image_url}]}`
//!   - Anthropic → 并入紧邻的 tool_result 那一轮 user（追加 text + `{type:"image"}`）
//!
//! ## 队列
//! 工具执行时只 `queue`，由 `tool_executor::execute_tool_steps` 在**本轮全部工具结束后**
//! 统一排空并落库（顺序：所有 tool 结果 → 图片消息 → 下一次请求）。放在工具内部直接追加是
//! 不行的：`tool` 消息之间不能被别的角色隔断，否则 OpenAI 会以
//! 「tool_call 没有紧跟响应」报错。
//!
//! ## 落库
//! 内容里是 `data:image/...;base64,...`，`append_messages_inner` 写前会自动外置成
//! `attachment://<sha256>.<ext>`（见 `crate::attachment`），请求组装时再还原 —— 所以
//! base64 只活在内存与本轮请求里，不会把库撑大。
//!
//! ## 发出去的是转换后的图，不是原文件
//! 读盘后过一道 `encode::encode_for_model`：最长边缩到设置档位、按设置编码成 JPEG / PNG / WebP。
//! 同一个设置同样作用于用户直接发的图（前端 `hooks.ts::fileToDataUrl`），两边规则必须一致。
//!
//! ## 界面怎么看到「真正发出去的那张图」
//! 工具结果（`role = tool`）的正文只能是文本，图片在注入消息里；而注入消息本身界面不渲染。
//! 所以工具结果另带一份 `uiData`（[`sent_ui_data`]）：`type = vision_image_sent` +
//! `imageMessageId`（注入消息的 id）+ 图片事实。卡片展开视图按 id 到会话里取那条消息的
//! `image_url` 渲染 —— 显示的就是**发给模型的那份字节**（附件内容寻址，与发出去的完全相同）。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use crate::agent::types::{Message, VISION_IMAGE_ROLE};

/// 单张图上限（对**转换后**的字节生效）：`attachment::MAX_BYTES` 同值，再大就不外置、
/// 也不该塞进请求（base64 后还要再涨 1/3，且这张图会随之后每一次请求重发）。
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// 支持的图片格式（魔数 → mime）。
///
/// 只收四家主流视觉模型都认的栅格格式：BMP / AVIF / SVG 虽然附件目录能存，但模型侧
/// 不一定吃，宁可在工具层直接报错让调用方转换，也不要发出去等上游 400。
const SUPPORTED: &str = "PNG/JPEG/WebP/GIF";

fn starts_with(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && &bytes[..prefix.len()] == prefix
}

/// 按文件头识别图片类型（与扩展名无关：扩展名只用于报错文案）。
pub(crate) fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if starts_with(bytes, &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if starts_with(bytes, &[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if starts_with(bytes, b"GIF87a") || starts_with(bytes, b"GIF89a") {
        return Some("image/gif");
    }
    // RIFF....WEBP
    if starts_with(bytes, b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 只读文件头拿宽高（不解整张图：几 MB 的 PNG 全解要几十毫秒）。
pub(crate) fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    use std::io::Cursor;
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

/// 人类可读的字节数（与 `native_tools/file` 的口径一致：B / KB / MB）。
fn human_size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    let k = bytes as f64 / 1024.0;
    if k < 1024.0 {
        format!("{:.1} KB", k)
    } else {
        format!("{:.1} MB", k / 1024.0)
    }
}

/// 文件名（含扩展名）；取不到时回退整个路径。
fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// 工具结果正文（模型可读英文，UI 侧按 `uiData` 重建，故不进 i18n）。
///
/// 格式与 `read_file` 的 emoji 头保持一致，第二行给出「图片事实」，
/// 第三行说明「这张图已经随本轮请求发出去了」—— 否则模型会拿路径去再读一遍文件。
pub(crate) fn envelope_text(path: &str, mime: &str, bytes: usize, dims: Option<(u32, u32)>) -> String {
    let size = human_size(bytes);
    let facts = match dims {
        Some((w, h)) => format!("{}, {}x{} px, {}", mime, w, h, size),
        None => format!("{}, {} (dimensions unavailable)", mime, size),
    };
    format!(
        "🖼️ {}\n📐 {}\n💡 The image itself is attached to this conversation turn — inspect it directly. Local pseudo-vision analysis is disabled, so no OCR/object text was produced for it.",
        path, facts
    )
}

/// 图片消息里那段给模型看的说明（图片块紧跟在它后面）。
fn handle_text(path: &str, mime: &str, bytes: usize, dims: Option<(u32, u32)>) -> String {
    let size = human_size(bytes);
    let facts = match dims {
        Some((w, h)) => format!("{}, {}x{} px, {}", mime, w, h, size),
        None => format!("{}, {}", mime, size),
    };
    format!(
        "Image \"{}\" ({}, {}). Attached to this turn; look at it directly instead of reading the file again.",
        file_name(path),
        path,
        facts
    )
}

/// 原图事实（只在重编码 / 缩放真的发生过时才给，UI 用它对账「发出去的这份缩了多少」）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SourceFacts {
    pub mime: &'static str,
    pub bytes: usize,
    pub dims: Option<(u32, u32)>,
}

/// 组装一条 `role = vision_image` 消息（text handle + `image_url` data URL）。
///
/// `source` = 「原图是什么」（mime / 字节 / 宽高）：只在重编码过时传入，
/// 供 UI / 轨迹展示「原图 image/png · 3840x2160 px · 3.2 MB」。
pub(crate) fn build_image_message(
    path: &str,
    mime: &str,
    bytes: &[u8],
    dims: Option<(u32, u32)>,
    source: Option<SourceFacts>,
) -> Message {
    let data_url = format!("data:{};base64,{}", mime, STANDARD.encode(bytes));
    let content = json!([
        { "type": "text", "text": handle_text(path, mime, bytes.len(), dims) },
        {
            "type": "image_url",
            "image_url": { "url": data_url, "detail": "auto" }
        }
    ]);
    let mut ui_data = json!({
        "type": "vision_image",
        "path": path,
        "mediaType": mime,
        "bytes": bytes.len(),
    });
    if let Some((w, h)) = dims {
        ui_data["width"] = json!(w);
        ui_data["height"] = json!(h);
    }
    if let Some(source) = source {
        ui_data["sourceMediaType"] = json!(source.mime);
        ui_data["sourceBytes"] = json!(source.bytes);
        if let Some((w, h)) = source.dims {
            ui_data["sourceWidth"] = json!(w);
            ui_data["sourceHeight"] = json!(h);
        }
    }
    Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: VISION_IMAGE_ROLE.to_string(),
        content,
        ui_data: Some(ui_data),
        timestamp: crate::telemetry::now_ms(),
        ..Default::default()
    }
}

/// 工具结果下发给界面的 `uiData`：图片消息自己的事实 + 那条注入消息的 id。
///
/// 卡片展开视图拿 `imageMessageId` 去会话里找这条消息，把它的 `image_url` 渲染出来 ——
/// 显示的就是**发给模型的那份字节**（附件是内容寻址的，与请求里的 data URL 一一对应）。
/// 只有 `type` 换成 `vision_image_sent`，其余事实（mime / 宽高 / 字节 / 原图对照）照旧。
pub(crate) fn sent_ui_data(message: &Message) -> Value {
    let mut data = message
        .ui_data
        .clone()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if let Value::Object(map) = &mut data {
        map.insert("type".into(), json!("vision_image_sent"));
        map.insert("imageMessageId".into(), json!(message.id));
    }
    data
}

// ==================== 会话级待注入队列 ====================

/// 待注入的图片消息（session_id → 消息，按产生顺序）。
///
/// 与后台服务结束通知（`native_tools/service/notice.rs`）同一套「先入队、轮次边界再注入」的
/// 时序，只是这里的注入点更早（本轮工具一结束就注入，见 `execute_tool_steps`）。
static PENDING: LazyLock<Mutex<HashMap<String, Vec<Message>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 压入一条待注入的图片消息。
pub(crate) fn queue(session_id: &str, message: Message) {
    PENDING
        .lock()
        .unwrap()
        .entry(session_id.to_string())
        .or_default()
        .push(message);
}

/// 排空该会话的待注入图片消息（按产生顺序）。
pub(crate) fn drain(session_id: &str) -> Vec<Message> {
    PENDING
        .lock()
        .unwrap()
        .remove(session_id)
        .unwrap_or_default()
}

/// 会话被删除：丢掉它还没注入的图片消息（队列是全局的，不清理会跨会话泄漏）。
pub fn drop_session(session_id: &str) {
    PENDING.lock().unwrap().remove(session_id);
}

/// `inspect_image` 的结论：(mime, 宽高)
pub(crate) type ImageFacts = (&'static str, Option<(u32, u32)>);

/// 该文件能否作为图片消息发给模型：返回 mime / 宽高，或一句可回给模型的错误。
///
/// 只看「能不能解出图片」：体积上限在 [`prepare_image`] 里对**转换后**的字节判。
pub(crate) fn inspect_image(path: &str, bytes: &[u8]) -> Result<ImageFacts, String> {
    if bytes.is_empty() {
        return Err(format!("cannot send \"{}\" as an image: the file is empty", path));
    }
    let Some(mime) = sniff_image_mime(bytes) else {
        return Err(format!(
            "cannot send \"{}\" as an image: the file content is not a supported image format ({} required)",
            path, SUPPORTED
        ));
    };
    Ok((mime, image_dimensions(bytes)))
}

/// 一张「准备发出去」的图：已经过嗅探 + 缩放 + 重编码。
pub(crate) struct Prepared {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub dims: Option<(u32, u32)>,
    pub reencoded: bool,
    /// 原文件的事实（重编码过才有意义，UI 用）
    pub source_mime: &'static str,
    pub source_bytes: usize,
    pub source_dims: Option<(u32, u32)>,
}

/// 读盘后的字节 → 实际要发出去的那份图（嗅探 → 缩放 / 转码 → 体积上限）。
///
/// 体积上限对**输出**判：一张 40 MB 的截图缩到 1568 长边 + JPEG 后只有几百 KB，
/// 按原文件大小卡掉它是错的。
pub(crate) fn prepare_image(
    path: &str,
    raw: &[u8],
    plan: super::encode::Plan,
) -> Result<Prepared, String> {
    let (source_mime, source_dims) = inspect_image(path, raw)?;
    let encoded = super::encode::encode_for_model(raw, source_mime, plan)?;
    if encoded.bytes.is_empty() {
        return Err(format!("cannot send \"{}\" as an image: encoding produced an empty file", path));
    }
    if encoded.bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "cannot send \"{}\" as an image: {} exceeds the {} limit; downscale the image and try again",
            path,
            human_size(encoded.bytes.len()),
            human_size(MAX_IMAGE_BYTES)
        ));
    }
    Ok(Prepared {
        mime: encoded.mime,
        dims: Some((encoded.width, encoded.height)),
        reencoded: encoded.reencoded,
        source_mime,
        source_bytes: raw.len(),
        source_dims,
        bytes: encoded.bytes,
    })
}

// ==================== 测试 ====================

/// 1x1 透明 PNG（最小合法图）：验魔数 / 尺寸 / base64 都用它
#[cfg(test)]
pub(super) const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

#[cfg(test)]
pub(crate) fn pending_count(session_id: &str) -> usize {
    PENDING
        .lock()
        .unwrap()
        .get(session_id)
        .map(Vec::len)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_the_four_supported_raster_formats() {
        assert_eq!(sniff_image_mime(PNG_1X1), Some("image/png"));
        assert_eq!(sniff_image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"GIF87a...."), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
    }

    #[test]
    fn rejects_unknown_bytes() {
        assert_eq!(sniff_image_mime(b"plain text"), None);
        assert_eq!(sniff_image_mime(&[]), None);
        // RIFF 但不是 WEBP（WAVE）
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WAVE"), None);
        // 截断的 PNG 签名
        assert_eq!(sniff_image_mime(&[0x89, 0x50, 0x4e]), None);
    }

    #[test]
    fn envelope_names_the_path_and_the_facts() {
        let text = envelope_text("/w/shot.png", "image/png", 2048, Some((640, 480)));
        assert!(text.starts_with("🖼️ /w/shot.png\n"), "text: {text}");
        assert!(text.contains("image/png, 640x480 px, 2.0 KB"), "text: {text}");
        assert!(text.contains("attached to this conversation turn"), "text: {text}");
    }

    #[test]
    fn envelope_survives_unknown_dimensions() {
        let text = envelope_text("/w/shot.gif", "image/gif", 10, None);
        assert!(text.contains("image/gif, 10 B (dimensions unavailable)"), "text: {text}");
    }

    #[test]
    fn image_message_carries_text_then_data_url() {
        let message = build_image_message("/w/shot.png", "image/png", PNG_1X1, Some((1, 1)), None);
        assert_eq!(message.role, VISION_IMAGE_ROLE);
        let blocks = message.content.as_array().expect("content 应是块数组");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        let handle = blocks[0]["text"].as_str().unwrap();
        assert!(
            handle.starts_with("Image \"shot.png\" (/w/shot.png, image/png, 1x1 px,"),
            "handle: {handle}"
        );
        assert!(handle.contains("look at it directly"), "handle: {handle}");
        assert_eq!(blocks[1]["type"], "image_url");
        let url = blocks[1]["image_url"]["url"].as_str().unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "url: {url}");
        assert_eq!(blocks[1]["image_url"]["detail"], "auto");
        let ui = message.ui_data.as_ref().unwrap();
        assert_eq!(ui["type"], "vision_image");
        assert_eq!(ui["path"], "/w/shot.png");
        assert_eq!(ui["width"], 1);
        assert_eq!(ui["height"], 1);
    }

    #[test]
    fn inspect_image_reports_what_the_model_can_use() {
        let (mime, dims) = inspect_image("/w/shot.png", PNG_1X1).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(dims, Some((1, 1)));

        let empty = inspect_image("/w/x.png", &[]).unwrap_err();
        assert!(empty.contains("the file is empty"), "err: {empty}");

        let not_image = inspect_image("/w/a.txt", b"hello").unwrap_err();
        assert!(not_image.contains("not a supported image format"), "err: {not_image}");
    }

    /// 转换后才是发出去的那份：PNG → JPEG 后 mime / 尺寸 / 字节都按新图报，且记住原图事实
    #[test]
    fn prepare_image_reports_the_converted_facts() {
        let plan = super::super::encode::Plan {
            format: super::super::encode::OutputFormat::Jpeg,
            max_dimension: 1568,
        };
        let png = super::super::encode::noisy_png(40, 20);
        let p = prepare_image("/w/shot.png", &png, plan).unwrap();
        assert!(p.reencoded);
        assert_eq!(p.mime, "image/jpeg");
        assert_eq!(p.dims, Some((40, 20)));
        assert_eq!(p.source_mime, "image/png");
        assert_eq!(p.source_bytes, png.len());
        assert_eq!(p.source_dims, Some((40, 20)), "原图尺寸要留给 UI 对账");
        assert_eq!(&p.bytes[..3], &[0xff, 0xd8, 0xff], "发送的应是 JPEG");
    }

    /// 工具结果下发界的 `uiData`：事实原样带过来，只把 type 换成「已发送」并指回注入消息
    #[test]
    fn sent_ui_data_points_back_at_the_injected_message() {
        let message = build_image_message(
            "/w/shot.png",
            "image/jpeg",
            &[0xff, 0xd8, 0xff],
            Some((40, 20)),
            Some(SourceFacts {
                mime: "image/png",
                bytes: 999,
                dims: Some((80, 40)),
            }),
        );
        let data = sent_ui_data(&message);
        assert_eq!(data["type"], "vision_image_sent");
        assert_eq!(data["imageMessageId"], message.id);
        assert_eq!(data["path"], "/w/shot.png");
        assert_eq!(data["mediaType"], "image/jpeg");
        assert_eq!(data["width"], 40);
        assert_eq!(data["height"], 20);
        assert_eq!(data["sourceMediaType"], "image/png");
        assert_eq!(data["sourceWidth"], 80);
        assert_eq!(data["sourceHeight"], 40);
        // 注入消息自己的 uiData 不能被改写（它仍标 vision_image）
        assert_eq!(message.ui_data.as_ref().unwrap()["type"], "vision_image");
    }

    /// 本来就是目标格式且不超阈值 → 原字节直传（不做无谓的二次有损）
    #[test]
    fn prepare_image_passes_png_through_when_png_is_requested() {
        let plan = super::super::encode::Plan {
            format: super::super::encode::OutputFormat::Png,
            max_dimension: 1568,
        };
        let p = prepare_image("/w/shot.png", PNG_1X1, plan).unwrap();
        assert!(!p.reencoded);
        assert_eq!(p.bytes, PNG_1X1);
    }

    #[test]
    fn queue_is_per_session_and_drains_in_order() {
        let a = "s_vision_queue_a";
        let b = "s_vision_queue_b";
        queue(a, build_image_message("/w/1.png", "image/png", PNG_1X1, None, None));
        queue(a, build_image_message("/w/2.png", "image/png", PNG_1X1, None, None));
        queue(b, build_image_message("/w/3.png", "image/png", PNG_1X1, None, None));
        assert_eq!(pending_count(a), 2);

        let drained = drain(a);
        assert_eq!(drained.len(), 2);
        assert!(drained[0].content[0]["text"].as_str().unwrap().contains("/w/1.png"));
        assert_eq!(pending_count(a), 0, "排空后队列为空（不得重复注入）");
        assert_eq!(pending_count(b), 1, "别的会话不受影响");

        drop_session(b);
        assert_eq!(pending_count(b), 0);
    }
}
