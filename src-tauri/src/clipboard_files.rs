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
 * 语义约定：读不到 / 平台不支持 / 剪贴板被占用，一律返回空数组（不报错），
 *           由前端决定是提示还是静默——粘贴这件事不该因为读剪贴板失败而中断。
 */

// 解析逻辑与平台无关，drag_drop 也复用它；非 Windows 构建下暂无使用者
#[allow(dead_code)]
pub(crate) mod vscode;

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

#[cfg(target_os = "windows")]
mod platform {
    use super::{text_formats, windows, TextFormat};

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
}

#[cfg(not(target_os = "windows"))]
mod platform {
    /// 非 Windows 平台暂未实现（见文件头说明），返回空数组让前端走文本兜底
    pub fn read_file_paths() -> Vec<String> {
        Vec::new()
    }
}
