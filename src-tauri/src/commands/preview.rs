//! HTML 预览的本地静态资源协议（`virlen-preview`）。
//!
//! 为什么需要它：`srcDoc` 的基址是应用页面，HTML 里 `./style.css`、`img/a.png` 这类相对路径
//! 一个都加载不到。把整个文件系统挂成静态服务器（asset 协议 + `**` scope）又太宽 —— 这里做成
//! **一次性 token + 工作区为根**的只读通道：
//!
//! | 闸 | 规则 |
//! |---|---|
//! | token | 只有前端登记过的 token（→ 根目录）才认；未知 token 一律 404 |
//! | 路径 | 解码后拒绝绝对路径、任何 `..` 段、反斜杠与盘符；canonicalize 后必须仍在根内（顺带挡住符号链接逃逸） |
//! | 类型 | 默认只回 CSS / 图片 / 字体 / 音视频；**JS 仅在 token 被标记 allow_scripts 时才回** |
//! | 资源 | 单文件 ≤ 32 MB、并发 ≤ 8；超出即拒 |
//!
//! ⚠️ 任何失败都回一个明确的空响应，**绝不 panic** —— 协议改由 tokio 任务执行，
//! 回调里 panic 会让 responder 被丢弃、请求永远悬着（表现就是「预览卡死」）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

/// 与前端 `preview-asset.ts` 的 scheme 必须逐字一致。
pub const SCHEME: &str = "virlen-preview";

/// 同时登记的根上限（前端每打开一个 HTML 登记一个，关闭即撤销）
const MAX_TOKENS: usize = 8;

/// 单个资源文件上限：够放一张图 / 一个字体 / 一小段视频，又不至于把 webview 拖死
const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// 同时处理的请求上限：恶意 HTML 写一万个 <img> 也只会有 8 个在读盘
const MAX_IN_FLIGHT: usize = 8;

struct AllowEntry {
    root: PathBuf,
    allow_scripts: bool,
}

fn roots() -> &'static Mutex<HashMap<String, AllowEntry>> {
    static ROOTS: OnceLock<Mutex<HashMap<String, AllowEntry>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(MAX_IN_FLIGHT))
}

/// token 只接受字母数字与 `-`（前端用 UUID），长度受限 —— 防止它被当成路径片段塞进来
fn is_safe_token(token: &str) -> bool {
    (8..=64).contains(&token.len()) && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 登记一个可预览的根目录（重复调用同一 token = 覆盖，用于切换 allow_scripts）
#[tauri::command]
pub fn preview_allow_root(token: String, root: String, allow_scripts: bool) -> Result<(), String> {
    if !is_safe_token(&token) {
        return Err("invalid preview token".to_string());
    }
    let canonical = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("cannot resolve preview root: {e}"))?;
    if !canonical.is_dir() {
        return Err("preview root is not a directory".to_string());
    }

    let mut map = roots()
        .lock()
        .map_err(|_| "preview registry is poisoned".to_string())?;
    if map.len() >= MAX_TOKENS && !map.contains_key(&token) {
        // 满了就淘汰一个：token 由前端管理，被淘汰方下次请求只是 404，不会读到别的东西
        if let Some(key) = map.keys().next().cloned() {
            map.remove(&key);
        }
    }
    map.insert(
        token,
        AllowEntry {
            root: canonical,
            allow_scripts,
        },
    );
    Ok(())
}

/// 撤销登记（关闭预览 / 切回编辑 / 换文件时调用）
#[tauri::command]
pub fn preview_revoke_root(token: String) {
    if let Ok(mut map) = roots().lock() {
        map.remove(&token);
    }
}

/// 协议入口：**同步回调里只做「拿并发许可 + 派任务」**，真正的读盘在 tokio 任务里。
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
            );
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        // 任务结束才释放许可（含任何提前返回）
        let _permit = permit;
        let (status, mime, body) = serve(&request).await;
        respond(responder, status, mime, body);
    });
}

async fn serve(request: &Request<Vec<u8>>) -> (StatusCode, &'static str, Vec<u8>) {
    if request.method() != tauri::http::Method::GET {
        return not_found();
    }

    let Some((token, raw_relative)) = split_path(request.uri().path()) else {
        return not_found();
    };
    let entry = {
        let Ok(map) = roots().lock() else {
            return not_found();
        };
        match map.get(&token) {
            Some(entry) => (entry.root.clone(), entry.allow_scripts),
            None => return not_found(),
        }
    };
    let (root, allow_scripts) = entry;

    let Some(relative) = decode_relative(&raw_relative) else {
        return not_found();
    };
    let Some(kind) = ResourceKind::of(&relative, allow_scripts) else {
        return not_found();
    };

    let full = root.join(&relative);
    let Ok(canonical) = tokio::fs::canonicalize(&full).await else {
        return not_found();
    };
    if !inside(&canonical, &root) {
        return (StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec());
    }

    let Ok(meta) = tokio::fs::metadata(&canonical).await else {
        return not_found();
    };
    if !meta.is_file() {
        return not_found();
    }
    if meta.len() > MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "text/plain",
            b"too large".to_vec(),
        );
    }

    match tokio::fs::read(&canonical).await {
        Ok(bytes) => (StatusCode::OK, kind.mime(), bytes),
        Err(_) => not_found(),
    }
}

fn not_found() -> (StatusCode, &'static str, Vec<u8>) {
    (StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec())
}

fn respond(responder: UriSchemeResponder, status: StatusCode, mime: &'static str, body: Vec<u8>) {
    let built = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // 字体 / CSS 跨源加载需要；脚本侧的外传由 iframe 的 CSP 兜（config 里见 html-preview）
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // 预览的是磁盘上的当前内容：不要缓存，改完文件重新加载就能看到
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body);

    match built {
        Ok(response) => responder.respond(response),
        // 头值全是常量，正常不会走到这里；仍给一个最小响应，绝不让请求悬着
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

/// `/token/rest/of/path` → `(token, "rest/of/path")`
fn split_path(path: &str) -> Option<(String, String)> {
    let rest = path.trim_start_matches('/');
    let (token, relative) = rest.split_once('/')?;
    if !is_safe_token(token) || relative.is_empty() {
        return None;
    }
    Some((token.to_string(), relative.to_string()))
}

/// 百分号解码；非法 `%XX` 直接拒（不猜、不部分解）
fn percent_decode(input: &str) -> Option<String> {
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

/// URL 路径 → 安全的相对路径；任何可疑段都拒（宁可 404，也不做「尽力而为」的拼接）
fn decode_relative(raw: &str) -> Option<PathBuf> {
    let decoded = percent_decode(raw)?;
    // 资源请求理论上不带 query；带了就忽略，避免把 `?v=1` 当成文件名的一部分
    let decoded = decoded.split(['?', '#']).next()?;
    if decoded.contains('\0') {
        return None;
    }

    let mut out = PathBuf::new();
    for segment in decoded.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        // 反斜杠（Windows 分隔符）与盘符（`C:`）一律不认：只允许 URL 风格的相对路径
        if segment.contains('\\') || segment.contains(':') {
            return None;
        }
        out.push(segment);
    }

    (!out.as_os_str().is_empty()).then_some(out)
}

/// 目标是否仍在根目录内（两边统一正斜杠后按前缀比）。
///
/// ⚠️ 大小写归一化**只在 Windows 做**：Linux / macOS 的路径可能真的存在 `/data/Demo` 与
/// `/data/demo` 两个目录，无条件折成小写会把「根外的同名变体」（典型是符号链接指向的兄弟目录）
/// 判成「在根内」。与 `git::lock::normalize_key` 的取舍保持一致。
fn inside(path: &Path, root: &Path) -> bool {
    let normalize = |value: &Path| {
        let text = value.to_string_lossy().replace('\\', "/");
        let text = text.trim_end_matches('/');
        if cfg!(target_os = "windows") {
            text.to_lowercase()
        } else {
            text.to_string()
        }
    };
    let target = normalize(path);
    let base = normalize(root);
    target == base || target.starts_with(&format!("{base}/"))
}

/// 允许返回的资源类型（HTML 预览只需要这些；`js` 仅在显式允许脚本时加入）
#[derive(Clone, Copy)]
enum ResourceKind {
    Css,
    JavaScript,
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
    Ico,
    Bmp,
    Avif,
    Woff,
    Woff2,
    Ttf,
    Otf,
    Eot,
    Mp4,
    Webm,
    Ogg,
    Mp3,
    Wav,
    M4a,
    Flac,
}

impl ResourceKind {
    fn of(path: &Path, allow_scripts: bool) -> Option<Self> {
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())?;
        let kind = match ext.as_str() {
            "css" => Self::Css,
            "js" | "mjs" if allow_scripts => Self::JavaScript,
            "png" => Self::Png,
            "jpg" | "jpeg" => Self::Jpeg,
            "gif" => Self::Gif,
            "webp" => Self::Webp,
            "svg" => Self::Svg,
            "ico" => Self::Ico,
            "bmp" => Self::Bmp,
            "avif" => Self::Avif,
            "woff" => Self::Woff,
            "woff2" => Self::Woff2,
            "ttf" => Self::Ttf,
            "otf" => Self::Otf,
            "eot" => Self::Eot,
            "mp4" => Self::Mp4,
            "webm" => Self::Webm,
            "ogg" | "ogv" => Self::Ogg,
            "mp3" => Self::Mp3,
            "wav" => Self::Wav,
            "m4a" => Self::M4a,
            "flac" => Self::Flac,
            _ => return None,
        };
        Some(kind)
    }

    fn mime(self) -> &'static str {
        match self {
            Self::Css => "text/css; charset=utf-8",
            Self::JavaScript => "text/javascript; charset=utf-8",
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
            Self::Ico => "image/x-icon",
            Self::Bmp => "image/bmp",
            Self::Avif => "image/avif",
            Self::Woff => "font/woff",
            Self::Woff2 => "font/woff2",
            Self::Ttf => "font/ttf",
            Self::Otf => "font/otf",
            Self::Eot => "application/vnd.ms-fontobject",
            Self::Mp4 => "video/mp4",
            Self::Webm => "video/webm",
            Self::Ogg => "video/ogg",
            Self::Mp3 => "audio/mpeg",
            Self::Wav => "audio/wav",
            Self::M4a => "audio/mp4",
            Self::Flac => "audio/flac",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_must_be_uuid_shaped() {
        assert!(is_safe_token("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!is_safe_token("short"));
        assert!(!is_safe_token("../escape"));
        assert!(!is_safe_token("550e8400-e29b-41d4-a716-44665544000/"));
    }

    #[test]
    fn split_path_takes_token_as_first_segment() {
        assert_eq!(
            split_path("/550e8400-e29b-41d4-a716-446655440000/css/app.css"),
            Some((
                "550e8400-e29b-41d4-a716-446655440000".to_string(),
                "css/app.css".to_string()
            ))
        );
        assert!(split_path("/short/a.css").is_none());
        assert!(split_path("/550e8400-e29b-41d4-a716-446655440000").is_none());
    }

    #[test]
    fn relative_path_rejects_escapes() {
        assert_eq!(
            decode_relative("css/app.css"),
            Some(PathBuf::from("css/app.css"))
        );
        // 明文与编码后的 `..` 都拒
        assert!(decode_relative("../secret.png").is_none());
        assert!(decode_relative("css/%2e%2e/secret.png").is_none());
        assert!(decode_relative("css/..%2Fsecret.png").is_none());
        // 绝对路径 / 盘符 / 反斜杠
        assert!(decode_relative("/etc/passwd").is_none());
        assert!(decode_relative("C:/secret.png").is_none());
        assert!(decode_relative("css\\app.css").is_none());
        // 空段与当前目录
        assert!(decode_relative("css//app.css").is_none());
        assert!(decode_relative("./app.css").is_none());
        // 非法百分号编码
        assert!(decode_relative("css/%zz.css").is_none());
    }

    #[test]
    fn relative_path_drops_query_suffix() {
        assert_eq!(
            decode_relative("css/app.css?v=3"),
            Some(PathBuf::from("css/app.css"))
        );
    }

    #[test]
    fn inside_compares_prefix_with_platform_case_rules() {
        let root = Path::new("E:/Work/Demo");
        assert!(inside(Path::new("E:/Work/Demo/a.png"), root));
        assert!(!inside(Path::new("E:/Work/Demo2/a.png"), root));
        assert!(!inside(Path::new("E:/Work/Other/a.png"), root));
        // 大小写：Windows 不敏感；其它平台必须当两个不同目录（否则符号链接可跨大小写变体逃逸）
        if cfg!(target_os = "windows") {
            assert!(inside(Path::new("e:/work/demo/sub/a.png"), root));
        } else {
            assert!(!inside(Path::new("e:/work/demo/sub/a.png"), root));
        }
    }

    #[test]
    fn resource_kind_only_allows_static_types() {
        assert!(ResourceKind::of(Path::new("a.css"), false).is_some());
        assert!(ResourceKind::of(Path::new("a.PNG"), false).is_some());
        assert!(ResourceKind::of(Path::new("a.woff2"), false).is_some());
        // 脚本默认不给：只有显式允许时才回
        assert!(ResourceKind::of(Path::new("a.js"), false).is_none());
        assert!(ResourceKind::of(Path::new("a.js"), true).is_some());
        // 文档 / 无扩展名 / 可执行文件一律不认
        assert!(ResourceKind::of(Path::new("index.html"), true).is_none());
        assert!(ResourceKind::of(Path::new("id_rsa"), true).is_none());
        assert!(ResourceKind::of(Path::new("a.exe"), true).is_none());
        assert!(ResourceKind::of(Path::new(".env"), true).is_none());
    }
}
