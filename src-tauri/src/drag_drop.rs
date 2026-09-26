/*!
 * drag_drop — Windows 自定义 OLE 拖放目标
 *
 * 为什么不用 Tauri 自带的 onDragDropEvent：
 *   Tauri 的拖放由 wry 实现，它的 DragEnter 只会 GetData(CF_HDROP)，拿不到就直接判为
 *   无效（连 DROPEFFECT 都不设），于是 Drop 根本不会触发。而 VS Code 拖拽文件时并不放
 *   CF_HDROP，只放了 text/plain（换行分隔的路径文本）+ Chromium 的“虚拟文件”，
 *   结果拖进本应用毫无反应（连高亮都没有）。
 *
 * 本模块自己实现 IDropTarget，按优先级识别三种格式：
 *   1. CF_HDROP                     —— 资源管理器拖来的文件（真实路径）
 *   2. code/file-list               —— VS Code 复制时用的自定义格式（拖拽一般没有，顺带兜住）
 *   3. CF_UNICODETEXT (text/plain)  —— VS Code 拖拽时放的“换行分隔路径文本”
 *
 * 解析复用 clipboard_files::vscode（它同时能解析 URI 与纯路径）。
 *
 * 注入方式沿用 wry 的手法：枚举目标窗口的所有子窗口（WebView2 的内层窗口），
 * RevokeDragDrop + RegisterDragDrop 换成我们的实现。
 *
 * 与前端约定：通过 Tauri 事件 `virlen:drag-drop` 下发，payload 形状与原 DragDropEvent
 * 完全一致（{ type, paths, position }），前端只把监听源从 onDragDropEvent 换成 listen 即可。
 */

use std::cell::UnsafeCell;
use std::ffi::c_void;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, PCWSTR, Ref};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium,
    RevokeDragDrop, CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use crate::clipboard_files::vscode;

/// 前端监听的事件名
pub const EVENT: &str = "virlen:drag-drop";

/// 拖放落点（相对窗口左上角，物理像素；前端再按 devicePixelRatio 换算）
#[derive(Clone, serde::Serialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

/// 下发前端的事件负载（形状与 Tauri 内置 DragDropEvent 一致）
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DragDropPayload {
    Enter { paths: Vec<String>, position: Position },
    Over { position: Position },
    Leave,
    Drop { paths: Vec<String>, position: Position },
}

/// 我们认识的格式 id（启动时解析一次，避免每次拖拽都注册）
struct Formats {
    hdrop: u16,
    unicode_text: u16,
    vscode_file_list: u16,
}

impl Formats {
    fn resolve() -> Self {
        let name: Vec<u16> = vscode::FORMAT_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // 注册型格式：同名多次调用返回同一个 id
        let vscode_file_list = unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) } as u16;
        Self {
            hdrop: CF_HDROP.0,
            unicode_text: CF_UNICODETEXT.0,
            vscode_file_list,
        }
    }
}

#[implement(IDropTarget)]
struct DropTarget {
    app: AppHandle,
    hwnd: HWND,
    formats: Formats,
    /// 当前有效拖拽应该显示的光标效果（DragEnter 决定，DragOver 复用）
    cursor_effect: UnsafeCell<DROPEFFECT>,
    /// 本次拖拽是否“有效”（数据对象里有我们能识别的格式）。
    /// COM 的 DragEnter/DragOver/Drop 只拿到 &self，所以用 UnsafeCell 记状态。
    enter_valid: UnsafeCell<bool>,
}

impl DropTarget {
    fn new(app: AppHandle, hwnd: HWND) -> Self {
        Self {
            app,
            hwnd,
            formats: Formats::resolve(),
            cursor_effect: UnsafeCell::new(DROPEFFECT_NONE),
            enter_valid: UnsafeCell::new(false),
        }
    }

    fn emit(&self, payload: DragDropPayload) {
        let _ = self.app.emit(EVENT, payload);
    }

    /// 把屏幕坐标(pt) 换算成窗口客户区坐标
    fn client_position(&self, pt: &POINTL) -> Position {
        let mut point = POINT { x: pt.x, y: pt.y };
        unsafe {
            let _ = ScreenToClient(self.hwnd, &mut point);
        }
        Position {
            x: point.x,
            y: point.y,
        }
    }
}

/// 取指定格式的 STGMEDIUM（该格式不存在时返回 None）
unsafe fn get_medium(data: &IDataObject, cf: u16) -> Option<STGMEDIUM> {
    if cf == 0 {
        return None;
    }
    let format = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    data.GetData(&format).ok()
}

/// 从 CF_HDROP 的 STGMEDIUM 里取出全部路径
unsafe fn read_hdrop(medium: &STGMEDIUM) -> Vec<String> {
    let hdrop = HDROP(medium.u.hGlobal.0 as _);
    let count = DragQueryFileW(hdrop, u32::MAX, None);
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let len = DragQueryFileW(hdrop, index, None);
        if len == 0 {
            continue;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let written = DragQueryFileW(hdrop, index, Some(buf.as_mut_slice()));
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

/// 读 HGLOBAL 里的原始字节（用于自定义文本格式），按第一个 NUL 截断
unsafe fn read_hglobal_bytes(medium: &STGMEDIUM) -> Vec<u8> {
    let hglobal = medium.u.hGlobal;
    let ptr = GlobalLock(hglobal) as *const u8;
    if ptr.is_null() {
        return Vec::new();
    }
    let len = GlobalSize(hglobal);
    let slice = std::slice::from_raw_parts(ptr, len);
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    let bytes = slice[..end].to_vec();
    let _ = GlobalUnlock(hglobal);
    bytes
}

/// 读 CF_UNICODETEXT（UTF-16，遇 0 结束）
unsafe fn read_hglobal_utf16(medium: &STGMEDIUM) -> Option<String> {
    let hglobal = medium.u.hGlobal;
    let ptr = GlobalLock(hglobal) as *const u16;
    if ptr.is_null() {
        return None;
    }
    let len = GlobalSize(hglobal) / 2;
    let mut buf = Vec::with_capacity(len);
    for i in 0..len {
        let c = *ptr.add(i);
        if c == 0 {
            break;
        }
        buf.push(c);
    }
    let _ = GlobalUnlock(hglobal);
    String::from_utf16(&buf).ok()
}

/// 按优先级从数据对象里解析出文件路径（读取到的 STGMEDIUM 一律负责释放）
unsafe fn read_paths(data: &IDataObject, formats: &Formats) -> Vec<String> {
    // 1) CF_HDROP：资源管理器拖来的真实文件
    if let Some(mut medium) = get_medium(data, formats.hdrop) {
        let paths = read_hdrop(&medium);
        ReleaseStgMedium(&mut medium);
        if !paths.is_empty() {
            return paths;
        }
    }

    // 2) code/file-list：VS Code 复制用的自定义格式（拖拽一般不带，兜底）
    if let Some(mut medium) = get_medium(data, formats.vscode_file_list) {
        let bytes = read_hglobal_bytes(&medium);
        ReleaseStgMedium(&mut medium);
        let paths = vscode::parse(&String::from_utf8_lossy(&bytes));
        if !paths.is_empty() {
            return paths;
        }
    }

    // 3) text/plain：VS Code 拖拽时放的“换行分隔路径文本”
    if let Some(mut medium) = get_medium(data, formats.unicode_text) {
        let text = read_hglobal_utf16(&medium);
        ReleaseStgMedium(&mut medium);
        if let Some(text) = text {
            let paths = vscode::parse(&text);
            if !paths.is_empty() {
                return paths;
            }
        }
    }

    Vec::new()
}

impl IDropTarget_Impl for DropTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        // 拖进来的时候就解析一次：既能判“有没有我们认识的格式”，也能直接给前端路径
        let paths = match pdataobj.as_ref() {
            Some(data) => unsafe { read_paths(data, &self.formats) },
            None => Vec::new(),
        };

        if paths.is_empty() {
            // 不认识的拖拽：不设 effect（保持 NONE），等同拒绝，和 wry 行为一致
            unsafe { *self.enter_valid.get() = false };
            return Ok(());
        }

        unsafe {
            *self.enter_valid.get() = true;
            *self.cursor_effect.get() = DROPEFFECT_COPY;
            *pdweffect = DROPEFFECT_COPY;
        }
        self.emit(DragDropPayload::Enter {
            paths,
            position: self.client_position(pt),
        });
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let valid = unsafe { *self.enter_valid.get() };
        let effect = if valid { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        unsafe { *pdweffect = effect };
        if valid {
            self.emit(DragDropPayload::Over {
                position: self.client_position(pt),
            });
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if unsafe { *self.enter_valid.get() } {
            unsafe { *self.enter_valid.get() = false };
            self.emit(DragDropPayload::Leave);
        }
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if !unsafe { *self.enter_valid.get() } {
            return Ok(());
        }
        let paths = match pdataobj.as_ref() {
            Some(data) => unsafe { read_paths(data, &self.formats) },
            None => Vec::new(),
        };
        unsafe { *pdweffect = DROPEFFECT_COPY };
        self.emit(DragDropPayload::Drop {
            paths,
            position: self.client_position(pt),
        });
        Ok(())
    }
}

/// 初始化：在 webview 就绪后，把 wry 注册的 drop target 替换成我们的
pub fn init(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app = app.clone();
    // with_webview 会在 webview 创建完成后、于主线程执行
    let _ = window.with_webview(move |_webview| {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        inject_child_windows(&app, hwnd);
    });
}

/// 枚举窗口的所有子窗口，逐个替换 drop target（与 wry 的做法一致）
fn inject_child_windows(app: &AppHandle, parent: HWND) {
    // RegisterDragDrop 要求当前线程已初始化 OLE（WebView2 通常会做，这里兜底）。
    // 初始化失败就整体放弃：否则会把原本可用的 drop target 撤掉又换不上，拖拽反而全废。
    if unsafe { OleInitialize(None) }.is_err() {
        return;
    }

    let mut callback = |hwnd: HWND| -> bool {
        let target: IDropTarget = DropTarget::new(app.clone(), hwnd).into();
        unsafe {
            // 先直接尝试登记（子窗口上若没有 target，直接就成功）；
            // 失败（多半是 wry 已登记过）才撤销再重登，避免出现空档。
            let mut registered = RegisterDragDrop(hwnd, &target);
            if registered.is_err() {
                let _ = RevokeDragDrop(hwnd);
                registered = RegisterDragDrop(hwnd, &target);
            }
            if registered.is_ok() {
                // 让对象活到进程结束：注册后系统持有一份引用，这里再多留一份保底
                std::mem::forget(target);
            }
        }
        true
    };

    // 把闭包以裸指针塞进 LPARAM（EnumChildWindows 的回调只能收一个 isize 参数）
    let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
    let closure_pointer_pointer: *mut c_void = unsafe { std::mem::transmute(&mut trait_obj) };
    let lparam = LPARAM(closure_pointer_pointer as isize);

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let closure = &mut *(lparam.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
        closure(hwnd).into()
    }

    unsafe {
        let _ = EnumChildWindows(Some(parent), Some(enum_callback), lparam);
    }
}
