//! 图片附件协议（`virlen-attachment`）。
//!
//! 数据库里 `messages.content` 只保存 `attachment://<sha256>.<ext>` 引用（见
//! `virlen_core::attachment` 模块头）。webview 加载不了这种自定义 scheme，需要一层协议把它
//! 翻译成 HTTP 响应 —— 本文件就是那层，做法与 HTML 预览的 `virlen-preview` 完全一致：
//! **同步回调只做「拿并发许可 + 派任务」，真正的读盘在 tokio 任务里，任何失败都回明确响应、绝不 panic。**
//!
//! 安全闸只有一道，但足够硬：**文件名必须是 `<64 位小写 hex>.<认识的图片扩展名>`**
//! （`virlen_core::attachment::parse_ref` 校验）。名字里不可能出现分隔符 / `..` / 盘符，
//! 所以 `root.join(name)` 永远落在附件目录内 —— 不需要再补一层 canonicalize 比较。

use std::sync::OnceLock;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};
use virlen_core::attachment;

/// 与前端 `src/domain/files/attachment-src.ts` 的常量必须逐字一致
pub const SCHEME: &str = "virlen-attachment";

/// 单个附件上限：与写入侧（`attachment::MAX_BYTES`）一致，超了不给
const MAX_BYTES: u64 = attachment::MAX_BYTES as u64;

/// 同时处理的请求上限：一屏一百张图也只会有这些在读盘
const MAX_IN_FLIGHT: usize = 8;

fn semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(MAX_IN_FLIGHT))
}

/// 协议入口（注册在 `lib.rs`；scheme 常量必须与前端一致）
pub fn handle_uri_request(
    _ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let permit = match semaphore().try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            respond(
                responder,
                StatusCode::TOO_MANY_REQUESTS,
                "text/plain",
                b"busy".to_vec(),
                false,
            );
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let (status, mime, body, cacheable) = serve(&request).await;
        respond(responder, status, mime, body, cacheable);
    });
}

async fn serve(request: &Request<Vec<u8>>) -> (StatusCode, &'static str, Vec<u8>, bool) {
    if request.method() != tauri::http::Method::GET {
        return not_found();
    }
    let Some(name) = attachment_name(request) else {
        return not_found();
    };
    // 唯一的安全校验：形状不合法直接 404（不猜、不做「尽力而为」的路径修正）
    if attachment::parse_ref(&format!("{}{}", attachment::PREFIX, name)).is_none() {
        return not_found();
    }
    let Some(store) = attachment::global() else {
        // 启动早期 / 初始化失败：附件不可达，但应用照常可用
        return not_found();
    };

    let path = store.root().join(&name);
    let meta = match tokio::fs::metadata(&path).await {
        Ok(meta) if meta.is_file() => meta,
        _ => return not_found(),
    };
    if meta.len() > MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "text/plain",
            b"too large".to_vec(),
            false,
        );
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            mime_of(&name),
            bytes,
            // 内容寻址：同名文件字节永不改变，可以放心长期缓存（滚动时不重复读盘）
            true,
        ),
        Err(_) => not_found(),
    }
}

/// 请求路径 → 附件名。
///
/// 前端按平台拼 URL（Windows: `http://virlen-attachment.localhost/<name>`，
/// 其它: `virlen-attachment://localhost/<name>`），所以名字在 path 里；
/// 兼容 `virlen-attachment://<name>` 这种把名字放在 host 上的写法。
fn attachment_name(request: &Request<Vec<u8>>) -> Option<String> {
    let uri = request.uri();
    let raw = uri.path().trim_matches('/');
    let raw = if raw.is_empty() {
        // 只有「名字当 host」的写法（`virlen-attachment://<name>`）才回退到 host；
        // 其它 scheme（`http://x/`）一律当没有名字 —— 否则任何主机名都会被当成附件名
        if uri.scheme_str() == Some(SCHEME) {
            uri.host().unwrap_or_default()
        } else {
            ""
        }
    } else {
        raw
    };
    if raw.is_empty() || raw.contains('/') {
        return None;
    }
    percent_decode(raw)
}

/// 百分号解码；非法 `%XX` 直接拒
fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_string());
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// 扩展名 → mime（名字已在 `parse_ref` 校验过，这里只需覆盖已知集合）
fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or_default() {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn not_found() -> (StatusCode, &'static str, Vec<u8>, bool) {
    (StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), false)
}

fn respond(
    responder: UriSchemeResponder,
    status: StatusCode,
    mime: &'static str,
    body: Vec<u8>,
    cacheable: bool,
) {
    let built = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // 右键菜单「复制图片 / 另存为」在 webview 里是 fetch(blob) 读回来的，需要跨源许可
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            header::CACHE_CONTROL,
            if cacheable {
                // 内容寻址 → 同名即同字节，永久缓存
                "public, max-age=31536000, immutable"
            } else {
                "no-store"
            },
        )
        .body(body);

    match built {
        Ok(response) => responder.respond(response),
        Err(_) => {
            if let Ok(fallback) = Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
            {
                responder.respond(fallback);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn name_comes_from_path() {
        let hex = "a".repeat(64);
        assert_eq!(
            attachment_name(&request(&format!(
                "http://virlen-attachment.localhost/{hex}.png"
            ))),
            Some(format!("{hex}.png"))
        );
        // 名字放在 host 上的写法也要认
        assert_eq!(
            attachment_name(&request(&format!("virlen-attachment://{hex}.webp"))),
            Some(format!("{hex}.webp"))
        );
    }

    #[test]
    fn nested_and_encoded_paths_are_rejected() {
        assert_eq!(attachment_name(&request("http://x/a/b.png")), None);
        assert_eq!(attachment_name(&request("http://x/")), None);
        assert_eq!(attachment_name(&request("http://x/%zz.png")), None);
        // 编码后的 `..` 解出来仍是非法名字（不是合法的 hex.png），后续 parse_ref 会拒
        let decoded = attachment_name(&request("http://x/%2e%2e.png")).unwrap();
        assert!(attachment::parse_ref(&format!("{}{}", attachment::PREFIX, decoded)).is_none());
    }

    #[test]
    fn mime_table_covers_every_allowed_extension() {
        assert_eq!(mime_of("a.png"), "image/png");
        assert_eq!(mime_of("a.jpg"), "image/jpeg");
        assert_eq!(mime_of("a.svg"), "image/svg+xml");
        assert_eq!(mime_of("a.unknown"), "application/octet-stream");
    }
}
