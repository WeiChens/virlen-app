//! vision — 视觉分类（分类 id: vision），与 JS 侧 `infrastructure/tools/vision/` 对应。
//!
//! 两条路：
//! - **本地图片伪视觉分析开启**（`app_settings.imageVisionAnalyzeOptimize = true`，默认）：
//!   图片不出本机，推理在 `quasivision`，工具回 tree text；
//! - **关闭**：不跑端侧模型，改把图片本身交给模型看 —— 工具回一段「图片事实」文本，
//!   另注入一条 `role = vision_image` 的消息（组装请求时投影成 user，见 `image_send`）。

mod encode;
mod image_send;
mod vision_analyze;
pub(crate) use image_send::drain as drain_image_messages;
pub use image_send::drop_session as drop_image_messages;
#[cfg(test)]
pub(crate) use image_send::queue as queue_image_message;
pub(crate) use vision_analyze::vision_analyze_tool;
