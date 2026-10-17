/*!
 * Windows 剪贴板原语（只做系统调用，不涉及业务解析）：开关剪贴板（被占用时重试）、
 * CF_HDROP / CF_UNICODETEXT / CF_DIB 读写、注册型自定义格式探测与原始字节读取。
 * 「读哪些格式、怎么解析」由上层 `clipboard_files.rs` 决定。
 */

use windows_sys::Win32::Foundation::{GlobalFree, HGLOBAL};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

/// CF_HDROP：剪贴板里的文件列表（资源管理器复制 / 剪切文件时写入）
const CF_HDROP: u32 = 15;
/// CF_UNICODETEXT：剪贴板里的 UTF-16 文本（应用里「复制文本」的标准格式）
const CF_UNICODETEXT: u32 = 13;
/// CF_DIB：设备无关位图（BITMAPINFOHEADER + 像素；「复制图片」写入这个格式）
const CF_DIB: u32 = 8;
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

/// 剪贴板里是否有 CF_UNICODETEXT（普通「复制文本」）
pub fn is_unicode_text_available() -> bool {
    (unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }) != 0
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
/// GlobalSize 可能大于实际数据（尾部填充），按第一个 NUL 截断。
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

/// 读取剪贴板文本（CF_UNICODETEXT；调用前必须已 open_with_retry）。
/// 不能复用 `read_format_bytes`：后者按第一个 0 字节截断，而 UTF-16 的 ASCII 第二字节就是 0。
pub fn read_unicode_text() -> String {
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        return String::new();
    }
    let hglobal: HGLOBAL = handle;
    let ptr = unsafe { GlobalLock(hglobal) } as *const u16;
    if ptr.is_null() {
        return String::new();
    }
    // GlobalSize 给的是字节（含对齐填充），除以 2 才是字符容量；再套防异常来源的上限
    let max_chars = (unsafe { GlobalSize(hglobal) } / 2).min(MAX_CUSTOM_FORMAT_BYTES / 2);
    let mut end = 0usize;
    while end < max_chars {
        if unsafe { *ptr.add(end) } == 0 {
            break;
        }
        end += 1;
    }
    let slice = unsafe { std::slice::from_raw_parts(ptr, end) };
    let text = String::from_utf16_lossy(slice);
    unsafe { GlobalUnlock(hglobal) };
    text
}

/// 把一段 DIB 写进剪贴板（CF_DIB；调用前必须已 open_with_retry）。三类易错点：
/// ① 必须先 EmptyClipboard（否则 SetClipboardData 直接失败）；② 要 GMEM_MOVEABLE；
/// ③ **成功后句柄归系统**，不能再 GlobalFree（只有失败分支才释放）。
pub fn write_dib(dib: &[u8]) -> bool {
    if dib.is_empty() {
        return false;
    }
    unsafe {
        if EmptyClipboard() == 0 {
            return false;
        }
        let handle = GlobalAlloc(GMEM_MOVEABLE, dib.len());
        if handle.is_null() {
            return false;
        }
        let ptr = GlobalLock(handle) as *mut u8;
        if ptr.is_null() {
            GlobalFree(handle);
            return false;
        }
        std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr, dib.len());
        GlobalUnlock(handle);
        if SetClipboardData(CF_DIB, handle).is_null() {
            GlobalFree(handle);
            return false;
        }
        true
    }
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
