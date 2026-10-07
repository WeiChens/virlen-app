//! web — 网络分类（分类 id: web），与 JS 侧 `infrastructure/tools/web/` 对应：
//! [`web_fetch`]（抓 URL：HTML→Markdown、二进制拒绝、超时/取消、截断）、[`web_search`]
//! （经已配置搜索源检索）。
//!
//! 两者都是原生实现（`is_native_tool` 命中），纯 Rust CLI 因此也能搜索与抓网页。搜索源配置经
//! `NativeToolCtx::settings` 直读 `app_settings`（与「忽略沙盒命令」同一份来源）。

mod common;
mod web_fetch;
mod web_search;

pub(crate) use web_fetch::web_fetch_tool;
pub(crate) use web_search::web_search_tool;
