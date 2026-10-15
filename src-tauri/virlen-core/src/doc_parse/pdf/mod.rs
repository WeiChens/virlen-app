//! PDF 抽文字 + 抽内嵌图片 —— **唯一一份** `pdf-extract` / `lopdf` 调用。
//!
//! ⚠️ 知识库导入（`rag::document::parse_pdf`）与 `parse_document` 工具都走这里的 [`extract_text`]：
//! 同一份库、同一份错误语义。任何一侧要改（升级 crate / 换提取器 / 加预处理）都只改这里，
//! 不许在调用方另写一份。
//!
//! 两条能力各一个分册（互相不引用，读一条不必读另一条）：
//! - `text`：抽**文字层**并按版面坐标重排（[`extract_text`]）；重排不可用时退回**原样顺序**
//!   （[`extract_text_raw`]）。扫描件 / 纯图片 PDF 抽出来是空的 → 调用方按
//!   `crate::doc_parse::ParseError::NoText` 处理（要不要接着 OCR 由 `ParseOptions::ocr` 决定）。
//! - `images`：抽**内嵌图片对象**（[`extract_images`]），胶水在 `crate::doc_parse::ocr`。
//!   **不做页面栅格化**：那要引入 PDF 渲染器（原生库），本项目只做纯 Rust，图片取出来直接交给端侧视觉，
//!   不出本机。抽图口径：按**页面绘制顺序**（内容流里的 `Do`，含 Form XObject 内部）；同一图片对象
//!   被多页引用只出一次；尺寸太小 / 形状太扁 / 编码不支持的如实记进 `ImageScan::skipped`，不静默丢弃。
//!
//! 本文件只做「对外名字的收敛」：外部一律走 `doc_parse::pdf::xxx`，与拆分前逐字一致（调用点不改）。

mod images;
mod text;

#[cfg(test)]
mod tests;

pub use self::images::{
    extract_images, ImageScan, ImageScanOptions, PdfImage, PdfPixels, RawColor, RawPixels,
    SkippedImage, EXTREME_ASPECT_REASON, OVER_LIMIT_REASON,
};
pub use self::text::{extract_text, extract_text_raw, PdfText, RAW_ORDER_NOTE};