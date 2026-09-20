/**
 * clipboard_files — 读系统剪贴板里的「文件路径」
 *
 * 为什么必须走原生：
 *   页面的 paste 事件只能拿到 File 对象（有文件名，没有磁盘路径），
 *   而本项目的文件附件只存路径（不拷贝内容），所以路径只能问系统要。
 *   资源管理器 / 编辑器里「复制文件」放进剪贴板的是文件列表，这条信息只存在于原生层。
 *
 * 目前认识的两种 Windows 剪贴板格式：
 *   1. CF_HDROP（二进制）—— 资源管理器里「复制文件」，逐个 DragQueryFileW 取路径；
 *   2. code/file-list（文本）—— VS Code 里「复制文件」，负载是「换行分隔的 URI 列表」。
 *
 * 文件结构（按职责拆开，新增一种格式改动面很小）：
 *   clipboard_files.rs          命令入口 + 文本格式注册表 + 平台编排（本文件）
 *   clipboard_files/windows.rs  Windows 剪贴板原语（打开 / 关闭 / 读原始字节 / CF_HDROP）
 *   clipboard_files/vscode.rs   code/file-list 的「文本 → 路径」解析
 *
 * 新增一种「文本型」自定义格式：在 vscode.rs 旁边加一个同构文件，
 * 再往 text_formats() 里加一行即可，其余无需改动。
 *
 * 平台覆盖：
 *   - Windows：CF_HDROP 与注册的各文本格式
 *   - macOS / Linux：暂未实现，返回空数组；前端会退回「从剪贴板文本里解析路径」的兜底
 *     （macOS 的 Finder 复制一般带 text/uri-list）
 *
 * 语义约定：读不到 / 平台不支持 / 剪贴板被占用，一律返回空（不报错），
 *           由前端决定是提示还是静默——粘贴这件事不该因为读剪贴板失败而中断。
 *
 * 除文件路径外，还提供：
 *   - 「读纯文本」：终端右键「粘贴」用（见 read_clipboard_text）。
 *     为什么不走 `navigator.clipboard.readText()`：WebView2 的剪贴板读权限默认
 *     不放行（NotAllowedError），而这里已有现成的 Windows 剪贴板原语。
 *   - 「写图片」：消息 / 预览里右键「复制图片」用（见 write_clipboard_image）。
 *     为什么不走 `navigator.clipboard.write(ClipboardItem)`：WebView2 下是否放行
 *     取决于运行时权限，不可靠；原生写 CF_DIB 是确定的（DIB 组装见 dib.rs）。
 *     前端仍保留浏览器 API 作兼容层（macOS / Linux 暂未实现原生写入）。
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

/// 一个「文本型」自定义剪贴板格式。
///
/// 别家（VS Code 等）把文件列表以纯文本写进自定义格式，这里只声明
/// 「格式名 + 文本 → 本机路径」，与具体平台/系统调用解耦。
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

/// 把图片写进系统剪贴板（右键「复制图片」用；Windows: CF_DIB）。
///
/// 前端传 base64（不强求 dataURL 前缀，已在外层剥掉）；具体格式由
/// `image` crate 从字节头部自行判定，因此不需要额外的 mime 参数。
/// 失败时返回 Err，前端会退到 `navigator.clipboard.write(ClipboardItem)`。
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

    /// 图片（base64）→ CF_DIB 写进剪贴板。
    ///
    /// 步骤：解 base64 → 解码图片 → 组装 DIB（见 dib.rs）→ 写 CF_DIB。
    /// 任一步失败都返回 Err（前端退浏览器剪贴板 API，不是致命错误）。
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
