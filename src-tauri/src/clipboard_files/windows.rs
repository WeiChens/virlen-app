/**
 * clipboard_files::windows — Windows 剪贴板原语
 *
 * 只做「系统调用」，不掺杂业务解析，供上层（clipboard_files.rs）组合：
 *   - 打开 / 关闭剪贴板（被占用时重试）
 *   - CF_HDROP：资源管理器里「复制文件」写入的二进制路径列表
 *   - 注册型自定义格式：探测是否存在、读取原始字节（GlobalLock / GlobalSize）
 *
 * 上层只负责决定「读哪些格式、怎么解析」，具体怎么跟系统打交道都在这里。
 */

use windows_sys::Win32::Foundation::HGLOBAL;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

/// CF_HDROP：剪贴板里的文件列表（资源管理器复制 / 剪切文件时写入）
const CF_HDROP: u32 = 15;
/// DragQueryFileW 传 -1 表示「只问文件个数，不要名字」
const QUERY_FILE_COUNT: u32 = u32::MAX;
/// 剪贴板被占用时的重试次数 × 间隔
const OPEN_RETRIES: u32 = 8;
const OPEN_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);
/// 自定义格式读取上限：正常的路径列表最多几 KB，这里只是防御异常来源
const MAX_CUSTOM_FORMAT_BYTES: usize = 16 * 1024 * 1024;

/// 把格式名注册成 Windows 自定义剪贴板格式 id（同名多次调用返回同一个 id；0 表示失败）
pub fn register_format(name: &str) -> u32 {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
}

/// 剪贴板里当前是否有指定格式（id 为 0 视为不存在）
pub fn is_format_available(id: u32) -> bool {
    id != 0 && (unsafe { IsClipboardFormatAvailable(id) }) != 0
}

/// 剪贴板里是否有 CF_HDROP（资源管理器里复制的文件）
pub fn is_hdrop_available() -> bool {
    (unsafe { IsClipboardFormatAvailable(CF_HDROP) }) != 0
}

/// 打开剪贴板；被占用（粘贴这一刻 WebView / 输入法可能正占着它）时重试几次
pub fn open_with_retry() -> bool {
    for _ in 0..OPEN_RETRIES {
        // hwnd 传 null：本命令没有窗口句柄，也不需要被通知剪贴板变化
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return true;
        }
        std::thread::sleep(OPEN_RETRY_INTERVAL);
    }
    false
}

/// 关闭剪贴板
pub fn close() {
    unsafe { CloseClipboard() };
}

/// 读取指定格式的原始字节（调用前必须已 open_with_retry）。
///
/// GlobalSize 给的是内存块大小，可能比实际数据大（尾部是填充），
/// 这里按第一个 NUL 截断后返回。
pub fn read_format_bytes(id: u32) -> Option<Vec<u8>> {
    if id == 0 {
        return None;
    }
    let handle = unsafe { GetClipboardData(id) };
    if handle.is_null() {
        return None;
    }
    let hglobal: HGLOBAL = handle;
    let ptr = unsafe { GlobalLock(hglobal) } as *const u8;
    if ptr.is_null() {
        return None;
    }
    let len = unsafe { GlobalSize(hglobal) }.min(MAX_CUSTOM_FORMAT_BYTES);
    let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    let bytes = slice[..end].to_vec();
    unsafe { GlobalUnlock(hglobal) };
    Some(bytes)
}

/// 从 CF_HDROP 句柄里取出所有路径（调用前必须已 open_with_retry）
pub fn read_hdrop_paths() -> Vec<String> {
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
