/*!
 * 读系统剪贴板里的「文件路径」：页面 paste 只能拿到 File（无磁盘路径），而附件只存路径。
 * Windows 两种格式：`CF_HDROP`（资源管理器，二进制）、`code/file-list`（VS Code，文本）。
 * 结构：本文件 = 命令入口 + 文本格式注册表 + 平台编排；`windows.rs` = 原语；`vscode.rs` = 文本→路径解析。
 * 新增文本型格式：在 `vscode.rs` 旁加同构文件，再往 `text_formats()` 加一行。
 * 语义：读不到 / 不支持 / 被占用一律返回空（不报错）—— 粘贴不该因读剪贴板失败而中断。
 * 另有「读纯文本」（终端右键粘贴）与「写图片」（CF_DIB；WebView2 的 write API 不可靠）。
 */

// 解析逻辑与平台无关，drag_drop 也复用它；非 Windows 构建下暂无使用者
#[allow(dead_code)]
pub(crate) mod vscode;

// 图片 → DIB 的字节组装与平台无关（供 Windows 写剪贴板用），可跨平台单测；
// 非 Windows 构建下暂无使用者
#[allow(dead_code)]
pub(crate) mod dib;

#[cfg(target_os = "windows")]
mod windows;

/// 一个「文本型」自定义剪贴板格式：格式名 + 「文本 → 本机路径」，与平台/系统调用解耦。
#[cfg(target_os = "windows")]
struct TextFormat {
    /// 注册型格式名（Windows 上交给 RegisterClipboardFormat）
    name: &'static str,
    /// 负载文本 → 一组本机路径
    parse: fn(&str) -> Vec<String>,
}

/// 目前支持的自定义文本格式；以后新增（JetBrains / Sublime / …）在这里加一行即可。
#[cfg(target_os = "windows")]
fn text_formats() -> &'static [TextFormat] {
    &[TextFormat {
        name: vscode::FORMAT_NAME,
        parse: vscode::parse,
    }]
}

/// 读剪贴板里的文件路径（绝对路径；分隔符由各解析器决定，前端会再归一）
#[tauri::command]
pub async fn read_clipboard_file_paths() -> Vec<String> {
    // 剪贴板是被系统全局持有的资源，读它可能短暂失败（重试在平台实现里）
    tokio::task::spawn_blocking(platform::read_file_paths)
        .await
        .unwrap_or_default()
}

/// 读剪贴板里的纯文本（终端右键「粘贴」用；读不到返回空串，前端退浏览器剪贴板 API）
#[tauri::command]
pub async fn read_clipboard_text() -> String {
    // 同 read_clipboard_file_paths：剪贴板是全局资源，读它可能短暂被占用
    tokio::task::spawn_blocking(platform::read_text)
        .await
        .unwrap_or_default()
}

/// 把图片写进系统剪贴板（Windows: CF_DIB）。前端传 base64（前缀已在外层剥），
/// 格式由 `image` crate 按字节头部判定；失败时前端退 `navigator.clipboard.write`。
#[tauri::command]
pub async fn write_clipboard_image(base64: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || platform::write_image(&base64))
        .await
        .map_err(|e| format!("剪贴板写入任务异常：{e}"))?
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{dib, text_formats, windows, TextFormat};
    use base64::Engine as _;

    pub fn read_file_paths() -> Vec<String> {
        // 先探测剪贴板里有哪些我们认识的格式，避免无谓地打开剪贴板
        let has_hdrop = windows::is_hdrop_available();
        let text_hits: Vec<(&TextFormat, u32)> = text_formats()
            .iter()
            .filter_map(|format| {
                let id = windows::register_format(format.name);
                windows::is_format_available(id).then_some((format, id))
            })
            .collect();
        if !has_hdrop && text_hits.is_empty() {
            return Vec::new();
        }

        // 剪贴板同一时刻只能被一个进程打开。粘贴这一刻 WebView / 输入法都可能正占着它，
        // 属于常态而非异常，所以重试几次而不是一次失败就放弃。
        if !windows::open_with_retry() {
            return Vec::new();
        }

        // 1) 资源管理器复制 → CF_HDROP（二进制路径列表），优先
        let mut paths = if has_hdrop {
            windows::read_hdrop_paths()
        } else {
            Vec::new()
        };

        // 2) 其次：自定义文本格式（VS Code 等）。CF_HDROP 有结果就不再看了。
        if paths.is_empty() {
            for (format, id) in text_hits {
                let Some(bytes) = windows::read_format_bytes(id) else {
                    continue;
                };
                let parsed = (format.parse)(&String::from_utf8_lossy(&bytes));
                if !parsed.is_empty() {
                    paths = parsed;
                    break;
                }
            }
        }

        windows::close();
        paths
    }

    pub fn read_text() -> String {
        if !windows::is_unicode_text_available() {
            return String::new();
        }
        if !windows::open_with_retry() {
            return String::new();
        }
        let text = windows::read_unicode_text();
        windows::close();
        text
    }

    /// 图片（base64）→ CF_DIB 写入。任一步失败都返回 Err（前端退浏览器剪贴板 API，不致命）。
    pub fn write_image(base64: &str) -> Result<(), String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|e| format!("base64 解码失败：{e}"))?;
        let dib_bytes = dib::image_to_dib(&bytes)?;
        // 剪贴板同一时刻只能被一个进程打开，重试几次而不是一次失败就放弃
        if !windows::open_with_retry() {
            return Err("剪贴板被占用，无法写入".into());
        }
        let ok = windows::write_dib(&dib_bytes);
        windows::close();
        if ok {
            Ok(())
        } else {
            Err("写入系统剪贴板失败".into())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    /// 非 Windows 平台暂未实现（见文件头说明），返回空数组让前端走文本兜底
    pub fn read_file_paths() -> Vec<String> {
        Vec::new()
    }

    /// 同上：返回空串，前端退回 navigator.clipboard 兜底
    pub fn read_text() -> String {
        String::new()
    }

    /// 同上：返回错误，前端退回 navigator.clipboard.write(ClipboardItem) 兜底
    pub fn write_image(_base64: &str) -> Result<(), String> {
        Err("当前平台暂未实现原生图片剪贴板写入".into())
    }
}
