//! vision — 视觉分类（分类 id: vision）
//!
//! 与 JS 侧 `src/infrastructure/tools/vision/` 对应。
//! 原生化后图片**依然不出本机**（推理在 `quasivision`，纯端侧）。

mod vision_analyze;

pub(crate) use vision_analyze::vision_analyze_tool;
