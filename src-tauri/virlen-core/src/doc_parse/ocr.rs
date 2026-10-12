//! 文档内嵌图片的**端侧 OCR** —— 扫描件 / 图片型 PDF 的唯一取字路径。
//!
//! 为什么放在解析链里而不是工具层：OCR 出来的文本就是**正文的一部分**。如果放到工具层再拼接，
//! 分页（`offset`）/ `char_count` / `outTxtFile` 全文落盘就会各写一套（§11 反复踩过的分叉）。
//! 所以 `parse()` 抽完文字层后按需调本模块，把 OCR 文本当作正文的一段交出去。
//!
//! 三层事实（改任何一层都别把另外两层搬过来）：
//! 1. 抽图 + 渲染：[`super::pdf`]（唯一一份 PDF 处理）；
//! 2. 推理：[`crate::vision::ocr_image_at`]（端侧 quasivision，**图片不出本机**，不上传）；
//! 3. 口径（本模块）：什么图值得读、最多读几张、读不出来怎么如实交代。
//!
//! ⚠️ 本模块**从不返回 `Err`**：读不出来（模型缺失 / 编码不支持 / 图里真没字）是结果的一部分 ——
//! 调用方按「有没有文字」决定报 `NoText` 还是把正文交出去，绝不用空字符串冒充成功。

use super::pdf::{self, ImageScanOptions, PdfImage};
use crate::agent::cancellation::CancellationToken;
use std::path::{Path, PathBuf};

/// 宽或高小于它的图不读（图标 / 分隔线 / 装饰背景：OCR 出来只有噪声）
pub const MIN_IMAGE_SIDE: u32 = 64;

/// 一次解析最多读几张图 —— OCR 是秒级推理，图多就慢；超出的如实报「没读」
pub const MAX_IMAGES: usize = 20;

/// 首轮几乎没读出字时的重试门槛：换 90° / 180° / 270° 再试（手机扫描件常是躺着的）
const ROTATION_RETRY_MAX_CHARS: usize = 8;

/// 首轮读出字、但**文本框大多数是竖的**时也要重试的门槛（占比超过它 = 这份图基本确定是躺着的）
const SIDEWAYS_RETRY_RATIO: f32 = 0.5;

// ═══════════════════════════════════════════════════════════════════════════
// 开关与依赖
// ═══════════════════════════════════════════════════════════════════════════

/// OCR 的开关与依赖（`ParseOptions::ocr` 为 `None` = 这条解析链完全不碰 OCR）
#[derive(Clone)]
pub struct OcrOptions {
    /// 端侧视觉模型目录（`Err(原因)` = 模型不在 → OCR 不可用，原因会**如实**报给模型）
    pub models_dir: Result<PathBuf, String>,
    /// 已有文字层也要 OCR（工具参数 `ocrImages: true`）；`false` = 只在抽不到文字时兜底
    pub always: bool,
    /// 取消令牌（扫描件是几十秒的活，必须能中断）
    pub cancel: Option<CancellationToken>,
}

impl std::fmt::Debug for OcrOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OcrOptions")
            .field("models_dir", &self.models_dir)
            .field("always", &self.always)
            .field(
                "cancelled",
                &self.cancel.as_ref().map(|c| c.is_cancelled()),
            )
            .finish()
    }
}

/// 一张图识别出来的文本（正文标记与 `uiData` 共用同一份事实）
#[derive(Debug, Clone)]
pub struct OcrSection {
    /// 文档内的图片序号（1 起，按**绘制顺序**）—— 正文标记里的 `Image N` 就是它
    pub index: usize,
    /// 首次出现的页号（1 起）
    pub page: usize,
    /// 引用它的全部页号（>1 时标记里写成 `pages 3, 4`）
    pub pages: Vec<usize>,
    pub width: u32,
    pub height: u32,
    /// PDF 对象号（界面侧可用来对账；正文标记不用它）
    pub object_id: u32,
    pub chars: usize,
    pub text: String,
}

/// OCR 没跑起来的原因**分类**（文案 / 界面按它分派 —— 不靠字符串猜测）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrUnavailable {
    /// 端侧视觉模型不在（CLI 分发包没带 `quasivision_models` / 资源目录缺失）
    Models,
    /// 内嵌图片抽不出来（PDF 结构损坏 / 加密）
    Images,
}

impl OcrUnavailable {
    /// 稳定的分类串（`uiData.ocr.unavailableKind`）
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Models => "models",
            Self::Images => "images",
        }
    }
}

/// OCR 结果摘要（进 `uiData`；`unavailable` 有值 = 这次没能读）
#[derive(Debug, Clone, Default)]
pub struct OcrSummary {
    /// OCR 这条链跑起来了吗（`false` = `unavailable` 有值）
    pub available: bool,
    /// 没跑起来的原因分类
    pub unavailable: Option<OcrUnavailable>,
    /// 原因原文（英文短句，直接进提示行 / 失败细节）
    pub unavailable_reason: Option<String>,
    /// **读出了文字**的图片张数
    pub images: usize,
    /// 识别出的字符数（= 正文块长度）
    pub chars: usize,
    /// 抽图阶段就跳过的张数（太小 / 超上限 / 编码不支持）
    pub skipped: usize,
    /// 读了但一个字都没认出来的张数
    pub empty: usize,
    /// 渲染 / 推理失败的原因（每条一句话，张数有上限）
    pub errors: Vec<String>,
    /// PDF 里去重后的图片对象总数
    pub total: usize,
    /// 是否被上限 / 取消截断（还有图没读）
    pub truncated: bool,
    /// 逐图结果（界面侧展示用）
    pub sections: Vec<OcrSection>,
}

impl OcrSummary {
    /// 「这条链没跑起来」的摘要（图数 / 跳过数照实带，免得丢事实）
    fn unavailable(
        kind: OcrUnavailable,
        reason: String,
        total: usize,
        skipped: usize,
    ) -> Self {
        Self {
            available: false,
            unavailable: Some(kind),
            unavailable_reason: Some(reason),
            skipped,
            total,
            ..Default::default()
        }
    }
}

/// 一次 OCR 的结果：正文块 + 摘要
pub struct OcrOutcome {
    /// 每张图一节、带 `[OCR] Image N · page P · WxH` 标记的正文；一个字都没读出来时是空串
    pub text: String,
    pub summary: OcrSummary,
}

// ═══════════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════════

/// 跑一遍 OCR：抽图 → 逐张识别 → 拼成正文块
pub fn run_pdf_ocr(bytes: &[u8], opts: &OcrOptions) -> OcrOutcome {
    let scan = match pdf::extract_images(
        bytes,
        &ImageScanOptions {
            min_side: MIN_IMAGE_SIDE,
            max_images: MAX_IMAGES,
        },
    ) {
        Ok(scan) => scan,
        // 抽图失败（PDF 结构坏了）：如实说「图片读不出来」，不冒充「图里没字」
        Err(e) => {
            return OcrOutcome {
                text: String::new(),
                summary: OcrSummary::unavailable(
                    OcrUnavailable::Images,
                    format!("the embedded images could not be read ({e})"),
                    0,
                    0,
                ),
            }
        }
    };

    let models_dir = match &opts.models_dir {
        Ok(dir) => dir.clone(),
        Err(reason) => {
            return OcrOutcome {
                text: String::new(),
                summary: OcrSummary::unavailable(
                    OcrUnavailable::Models,
                    one_line(reason),
                    scan.total,
                    scan.skipped.len(),
                ),
            }
        }
    };

    let mut sections: Vec<OcrSection> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut empty = 0usize;
    let mut cancelled = false;
    for (i, image) in scan.images.iter().enumerate() {
        if opts.cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            cancelled = true;
            break;
        }
        let index = i + 1;
        match ocr_one(&models_dir, image) {
            Ok(text) if !text.trim().is_empty() => sections.push(OcrSection {
                index,
                page: image.page,
                pages: image.pages.clone(),
                width: image.width,
                height: image.height,
                object_id: image.object_id,
                chars: text.chars().count(),
                text,
            }),
            Ok(_) => empty += 1,
            Err(e) => errors.push(format!("image {index} (page {}): {e}", image.page)),
        }
    }

    let text = sections
        .iter()
        .map(|s| format!("{}\n{}", section_marker(s), s.text))
        .collect::<Vec<_>>()
        .join("\n\n");
    let over_limit = scan
        .skipped
        .iter()
        .any(|s| s.reason == "over the image limit");
    let summary = OcrSummary {
        available: true,
        unavailable: None,
        unavailable_reason: None,
        images: sections.len(),
        chars: text.chars().count(),
        skipped: scan.skipped.len(),
        empty,
        errors,
        total: scan.total,
        truncated: over_limit || cancelled,
        sections,
    };
    OcrOutcome { text, summary }
}

/// 正文里的一张图标记：模型要引用「哪张图的字」就靠它
fn section_marker(section: &OcrSection) -> String {
    let where_at = if section.pages.len() > 1 {
        format!(
            "pages {}",
            section
                .pages
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        format!("page {}", section.page)
    };
    format!(
        "[OCR] Image {} · {where_at} · {}×{}",
        section.index, section.width, section.height
    )
}

/// 读一张图：渲染 → 端侧 OCR（判定「躺着」时换三个方向再试）
fn ocr_one(models_dir: &Path, image: &PdfImage) -> Result<String, String> {
    let rendered = image.to_image()?;
    let first = crate::vision::ocr_image_at(models_dir, &rendered)?;
    let chars = first.text.trim().chars().count();
    if chars >= ROTATION_RETRY_MAX_CHARS && first.sideways < SIDEWAYS_RETRY_RATIO {
        return Ok(first.text);
    }
    // 两种「方向不对」的信号：几乎没读出字（可能躺着），或文本框大多是竖的（基本确定躺着）。
    // 手机扫描件常把竖页转 90° 存进 PDF，而检测模型对旋转文字只能认出一部分 ——
    // 硬读会得到残缺文本（实测：正立的页面能读出全句，躺着的只能拼出半句）。
    let mut best = first.text;
    let mut best_len = best.trim().chars().count();
    let mut turned = rendered;
    for _ in 0..3 {
        turned = turned.rotate90();
        if let Ok(candidate) = crate::vision::ocr_image_at(models_dir, &turned) {
            let len = candidate.text.trim().chars().count();
            if len > best_len {
                best = candidate.text;
                best_len = len;
            }
        }
    }
    Ok(best)
}

// ═══════════════════════════════════════════════════════════════════════════
// 给模型 / 界面的说法
// ═══════════════════════════════════════════════════════════════════════════

/// 成功解析时给模型的一条说明（`DocText::note`，固定英文）；没什么好说的 → `None`
///
/// `layer`：这份 PDF 的文字层是什么状态 —— 决定措辞是「补充」还是「兜底」。
pub fn summary_note(summary: &OcrSummary, layer: TextLayer) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(reason) = &summary.unavailable_reason {
        parts.push(format!("on-device OCR is unavailable ({reason})"));
    } else if summary.images > 0 {
        let read = format!("{} embedded image(s)", summary.images);
        parts.push(match layer {
            TextLayer::Present => {
                format!("{read} were additionally read with on-device OCR (marked [OCR])")
            }
            TextLayer::Empty => format!(
                "no text layer — the text below was extracted on-device (OCR) from {read}"
            ),
            TextLayer::Failed(reason) => format!(
                "the text layer could not be extracted ({reason}) — the text below was extracted on-device (OCR) from {read}"
            ),
        });
    }
    if summary.skipped > 0 {
        parts.push(format!(
            "{} image(s) were skipped (too small, over the {} image limit, or an unsupported encoding)",
            summary.skipped, MAX_IMAGES
        ));
    }
    if summary.empty > 0 {
        parts.push(format!(
            "{} image(s) contained no recognizable text",
            summary.empty
        ));
    }
    for error in &summary.errors {
        parts.push(format!("OCR failed on {error}"));
    }
    if summary.truncated && summary.unavailable_reason.is_none() {
        parts.push("the scan stopped before every image was read".to_string());
    }
    if parts.is_empty() {
        return None;
    }
    let mut sentence = parts.join("; ");
    if let Some(first) = sentence.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    Some(format!("{sentence}."))
}

/// 字层的状态 —— 决定提示行的措辞（「补充」「兜底」「救回来的」）
#[derive(Debug, Clone)]
pub enum TextLayer {
    /// 有文字层（OCR 是补充）
    Present,
    /// 没有文字层（OCR 是兜底）
    Empty,
    /// 文字层抽失败（原因是库的原始错误）
    Failed(String),
}

/// 一个字都没抽出来时的失败细节（`ParseError::NoText` 的补充说明，固定英文）
///
/// 顺序有意为之：**没有图**比「模型不在」更接近真相 —— 那种情况下即使模型在位也读不出字。
pub fn no_text_detail(summary: &OcrSummary) -> String {
    let unavailable = summary
        .unavailable
        .zip(summary.unavailable_reason.as_deref());
    if summary.total == 0 && !matches!(unavailable, Some((OcrUnavailable::Images, _))) {
        return "the PDF contains no embedded images".to_string();
    }
    if let Some((kind, reason)) = unavailable {
        return match kind {
            OcrUnavailable::Models => format!("on-device OCR is unavailable: {reason}"),
            // 抽图失败的原因本身就是一句完整的话
            OcrUnavailable::Images => reason.to_string(),
        };
    }
    if summary.images == 0 && summary.empty > 0 {
        return format!(
            "on-device OCR found no text in {} embedded image(s)",
            summary.empty
        );
    }
    if summary.images == 0 && summary.skipped == summary.total {
        return format!(
            "all {} embedded image(s) were skipped (too small, over the limit, or an unsupported encoding)",
            summary.total
        );
    }
    match summary.errors.first() {
        Some(error) => format!("on-device OCR failed — {error}"),
        None => "on-device OCR found no text".to_string(),
    }
}

/// 失败原因压缩成一行（模型侧提示行只放得下一句；`models_dir` 的原始错误是多行的）
fn one_line(reason: &str) -> String {
    let head = reason.lines().next().unwrap_or_default().trim();
    if head.is_empty() {
        "the on-device vision models are not available".to_string()
    } else {
        head.trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(images: usize, skipped: usize, empty: usize) -> OcrSummary {
        OcrSummary {
            available: true,
            images,
            skipped,
            empty,
            ..Default::default()
        }
    }

    /// 标记行：单页写 `page N`，被多页引用的写 `pages 3, 4`
    #[test]
    fn section_marker_names_the_page_or_pages() {
        let mut section = OcrSection {
            index: 2,
            page: 3,
            pages: vec![3],
            width: 1240,
            height: 1754,
            object_id: 27,
            chars: 5,
            text: "hello".to_string(),
        };
        assert_eq!(
            section_marker(&section),
            "[OCR] Image 2 · page 3 · 1240×1754"
        );
        section.pages = vec![3, 4];
        assert_eq!(
            section_marker(&section),
            "[OCR] Image 2 · pages 3, 4 · 1240×1754"
        );
    }

    /// 提示行：有文字层是「追加」，没有是「兜底」；跳过 / 空图 / 失败都要点名
    #[test]
    fn summary_note_explains_what_happened() {
        assert_eq!(
            summary_note(&summary(2, 0, 0), TextLayer::Present).unwrap(),
            "2 embedded image(s) were additionally read with on-device OCR (marked [OCR])."
        );
        assert_eq!(
            summary_note(&summary(2, 0, 0), TextLayer::Empty).unwrap(),
            "No text layer — the text below was extracted on-device (OCR) from 2 embedded image(s)."
        );
        assert!(summary_note(&summary(1, 0, 0), TextLayer::Failed("broken xref".to_string()))
            .unwrap()
            .contains("text layer could not be extracted (broken xref)"));

        let messy = OcrSummary {
            available: true,
            images: 1,
            skipped: 3,
            empty: 2,
            errors: vec!["image 4 (page 2): unsupported image encoding: JPXDecode".to_string()],
            truncated: true,
            ..Default::default()
        };
        let note = summary_note(&messy, TextLayer::Empty).unwrap();
        assert!(note.contains("3 image(s) were skipped"), "{note}");
        assert!(note.contains("2 image(s) contained no recognizable text"), "{note}");
        assert!(note.contains("JPXDecode"), "{note}");
        assert!(note.contains("stopped before every image"), "{note}");

        // 一切正常且没有文字层可追加 → 不必给模型塞一句废话
        assert!(summary_note(&summary(0, 0, 0), TextLayer::Present).is_none());
    }

    /// 模型不在：提示行如实说原因，且把真实错误压成一行（原始错误是多行的）
    #[test]
    fn unavailable_ocr_is_reported_with_a_single_line_reason() {
        let missing = OcrSummary {
            available: false,
            unavailable: Some(OcrUnavailable::Models),
            unavailable_reason: Some("quasivision models directory not found".to_string()),
            total: 2,
            ..Default::default()
        };
        assert_eq!(
            summary_note(&missing, TextLayer::Empty).unwrap(),
            "On-device OCR is unavailable (quasivision models directory not found)."
        );
        assert_eq!(
            no_text_detail(&missing),
            "on-device OCR is unavailable: quasivision models directory not found"
        );

        let multi_line = "quasivision models directory not found.\nSearched:\n  - \"C:/x\"\n";
        assert_eq!(one_line(multi_line), "quasivision models directory not found");
    }

    /// 抽不到文字时的细节：按「没有图 / 全是空图 / 全被跳过」分别给话
    #[test]
    fn no_text_detail_covers_each_reason() {
        assert_eq!(
            no_text_detail(&OcrSummary::default()),
            "the PDF contains no embedded images"
        );
        assert_eq!(
            no_text_detail(&summary(0, 0, 2)),
            "the PDF contains no embedded images",
            "一张图都没有时，真相是「没图可读」，不用绕到「认不出字」上"
        );
        let all_empty = OcrSummary {
            available: true,
            total: 2,
            empty: 2,
            ..Default::default()
        };
        assert_eq!(
            no_text_detail(&all_empty),
            "on-device OCR found no text in 2 embedded image(s)"
        );
        let all_skipped = OcrSummary {
            available: true,
            total: 3,
            skipped: 3,
            ..Default::default()
        };
        assert_eq!(
            no_text_detail(&all_skipped),
            "all 3 embedded image(s) were skipped (too small, over the limit, or an unsupported encoding)"
        );

        // 模型不在但页面里根本没有图：真相是「没图可读」，不是「缺模型」
        let no_images = OcrSummary {
            available: false,
            unavailable: Some(OcrUnavailable::Models),
            unavailable_reason: Some("quasivision models directory not found".to_string()),
            ..Default::default()
        };
        assert_eq!(
            no_text_detail(&no_images),
            "the PDF contains no embedded images"
        );

        // 抽图本身失败：那是「图读不出来」，别绕到「模型不在」上
        let broken = OcrSummary::unavailable(
            OcrUnavailable::Images,
            "the embedded images could not be read (broken xref)".to_string(),
            0,
            0,
        );
        assert_eq!(broken.unavailable.unwrap().kind(), "images");
        assert_eq!(
            no_text_detail(&broken),
            "the embedded images could not be read (broken xref)"
        );
    }

    /// 真的跑一遍（模型目录给个假的）：一个字也不冒充读过，图数 / 页号照实记
    #[test]
    fn missing_models_do_not_pretend_to_have_read_anything() {
        let bytes = crate::doc_parse::test_pdf::scanned_pdf(1, 100);
        let outcome = run_pdf_ocr(
            &bytes,
            &OcrOptions {
                models_dir: Err(
                    "quasivision models directory not found.\nSearched:\n  - \"C:/x\"".to_string(),
                ),
                always: false,
                cancel: None,
            },
        );
        assert!(outcome.text.is_empty());
        assert!(!outcome.summary.available);
        assert_eq!(outcome.summary.unavailable, Some(OcrUnavailable::Models));
        assert_eq!(outcome.summary.total, 1, "图还是数出来了");
        assert_eq!(
            summary_note(&outcome.summary, TextLayer::Empty).unwrap(),
            "On-device OCR is unavailable (quasivision models directory not found)."
        );
    }

    /// 页面里没有图片：OCR 没东西可读，且**不去碰模型目录**（不该白等一场推理）
    #[test]
    fn a_pdf_without_images_has_nothing_to_read() {
        let bytes = crate::doc_parse::test_pdf::pdf(&[vec![]], &[]);
        let outcome = run_pdf_ocr(
            &bytes,
            &OcrOptions {
                models_dir: Err("not needed".to_string()),
                always: true,
                cancel: None,
            },
        );
        assert!(outcome.text.is_empty());
        assert_eq!(outcome.summary.total, 0);
        assert_eq!(
            no_text_detail(&outcome.summary),
            "the PDF contains no embedded images"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 真模型端到端（`#[ignore]`）
    //
    // 跑法：`cargo test -p virlen-core --lib -- --ignored`（需 `src-tauri/resources/quasivision_models`）
    // 为什么默认跳过：要加载 36.9 MB ONNX 模型、秒级起步，没装模型的机器上会假红 —— 而
    // 「识别质量」不是单测能锁的东西（模型换版本就可能变）。
    // ═════════════════════════════════════════════════════════════════════════

    /// 一张带字的「扫描页」图片（`tests/fixtures/ocr/page.png`，System.Drawing 画的）
    fn page_image() -> image::DynamicImage {
        let path = format!("{}/tests/fixtures/ocr/page.png", env!("CARGO_MANIFEST_DIR"));
        image::open(&path).expect("缺少测试图片")
    }

    /// 把图像编成 JPEG 并做成「一整页就是一张图」的扫描件 PDF
    fn scanned_pdf_of(image: &image::DynamicImage) -> Vec<u8> {
        use image::ImageEncoder as _;

        let rgb = image.to_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .write_image(
                rgb.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        crate::doc_parse::test_pdf::scanned_jpeg_pdf(
            jpeg,
            image.width() as i64,
            image.height() as i64,
        )
    }

    /// 本机模型目录（默认跳过的那两个用例用它）
    fn local_models() -> PathBuf {
        crate::vision::models_dir(crate::host::default_host().as_ref()).expect("本机应有 quasivision 模型")
    }

    /// 端到端：造一份「一整页就是一张带字 JPEG」的扫描件 PDF，端侧 OCR 要把图里的字读回来
    #[test]
    #[ignore = "需要端侧视觉模型（src-tauri/resources/quasivision_models）"]
    fn ocr_reads_a_scanned_page() {
        let bytes = scanned_pdf_of(&page_image());
        let outcome = run_pdf_ocr(
            &bytes,
            &OcrOptions {
                models_dir: Ok(local_models()),
                always: true,
                cancel: None,
            },
        );
        assert_eq!(outcome.summary.images, 1, "{:#?}", outcome.summary);
        assert!(
            outcome.text.contains("[OCR] Image 1 · page 1"),
            "{}",
            outcome.text
        );
        assert!(outcome.text.contains("VIRLEN"), "{}", outcome.text);
        assert!(outcome.text.contains("8801"), "{}", outcome.text);
        assert!(outcome.text.contains("未霖文档识别"), "{}", outcome.text);
    }

    /// 躺着的扫描件（图存成横的，手机扫的常见）：首轮读不出时换 90° / 270° 重试要救得回来
    #[test]
    #[ignore = "需要端侧视觉模型（src-tauri/resources/quasivision_models）"]
    fn ocr_reads_a_sideways_scan() {
        let bytes = scanned_pdf_of(&page_image().rotate90());
        let outcome = run_pdf_ocr(
            &bytes,
            &OcrOptions {
                models_dir: Ok(local_models()),
                always: true,
                cancel: None,
            },
        );
        assert!(
            outcome.text.contains("VIRLEN"),
            "旋转重试没救回来：{}",
            outcome.text
        );
    }

    /// 不是 PDF / PDF 损坏：说「图片读不出来」，不是「图里没字」
    #[test]
    fn a_broken_pdf_says_the_images_could_not_be_read() {
        let outcome = run_pdf_ocr(
            b"not a pdf at all",
            &OcrOptions {
                models_dir: Err("not needed".to_string()),
                always: true,
                cancel: None,
            },
        );
        assert!(outcome.text.is_empty());
        assert_eq!(outcome.summary.unavailable, Some(OcrUnavailable::Images));
        assert!(
            no_text_detail(&outcome.summary).starts_with("the embedded images could not be read"),
            "{}",
            no_text_detail(&outcome.summary)
        );
    }
}
