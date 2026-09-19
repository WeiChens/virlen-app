/**
 * clipboard_files — 读系统剪贴板里的「文件路径」
 *
 * 为什么必须走原生：
 *   页面的 paste 事件只能拿到 File 对象（有文件名，没有磁盘路径），
 *   而本项目的文件附件只存路径（不拷贝内容），所以路径只能问系统要。
 *   资源管理器 / Finder 里「复制文件」放进剪贴板的是文件列表（Windows 上是 CF_HDROP），
 *   这条信息只存在于原生层。
 *
 * 平台覆盖：
 *   - Windows：CF_HDROP + DragQueryFileW（本次实现）
 *   - macOS / Linux：暂未实现，返回空数组；
 *     前端会退回「从剪贴板文本里解析路径」的兜底（macOS 的 Finder 复制一般带 text/uri-list）
 *
 * 语义约定：读不到 / 平台不支持 / 剪贴板被占用，一律返回空数组（不报错），
 *           由前端决定是提示还是静默——粘贴这件事不该因为读剪贴板失败而中断。
 */

/// 读剪贴板里的文件路径（绝对路径，原样返回，不改变分隔符）
#[tauri::command]
pub async fn read_clipboard_file_paths() -> Vec<String> {
    // 剪贴板是被系统全局持有的资源，读它可能短暂失败（重试在平台实现里）
    tokio::task::spawn_blocking(platform::read_file_paths)
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// CF_HDROP：剪贴板里的文件列表（资源管理器复制 / 剪切文件时写入）
    const CF_HDROP: u32 = 15;
    /// DragQueryFileW 传 -1 表示「只问文件个数，不要名字」
    const QUERY_FILE_COUNT: u32 = u32::MAX;
    /// 剪贴板被占用时的重试次数 × 间隔
    const OPEN_RETRIES: u32 = 8;
    const OPEN_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);

    pub fn read_file_paths() -> Vec<String> {
        // 没有文件格式就直接退出，连剪贴板都不用开
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
            return Vec::new();
        }
        // 剪贴板同一时刻只能被一个进程打开。粘贴这一刻 WebView / 输入法都可能正占着它，
        // 属于常态而非异常，所以重试几次而不是一次失败就放弃。
        if !open_with_retry() {
            return Vec::new();
        }
        let paths = read_hdrop_paths();
        unsafe { CloseClipboard() };
        paths
    }

    fn open_with_retry() -> bool {
        for _ in 0..OPEN_RETRIES {
            // hwnd 传 null：本命令没有窗口句柄，也不需要被通知剪贴板变化
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(OPEN_RETRY_INTERVAL);
        }
        false
    }

    /// 从 CF_HDROP 句柄里取出所有路径（调用前必须已 OpenClipboard）
    fn read_hdrop_paths() -> Vec<String> {
        let handle = unsafe { GetClipboardData(CF_HDROP) };
        if handle.is_null() {
            return Vec::new();
        }
        let drop: HDROP = handle as HDROP;

        let count = unsafe { DragQueryFileW(drop, QUERY_FILE_COUNT, std::ptr::null_mut(), 0) };
        let mut paths = Vec::with_capacity(count as usize);

        for index in 0..count {
            // 问第 index 个文件需要多少字符（不含结尾 \0），再按这个长度取一次
            let len = unsafe { DragQueryFileW(drop, index, std::ptr::null_mut(), 0) };
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let written = unsafe { DragQueryFileW(drop, index, buf.as_mut_ptr(), len + 1) };
            if written == 0 {
                continue;
            }
            buf.truncate(written as usize);
            if let Ok(path) = String::from_utf16(&buf) {
                if !path.is_empty() {
                    paths.push(path);
                }
            }
        }
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
