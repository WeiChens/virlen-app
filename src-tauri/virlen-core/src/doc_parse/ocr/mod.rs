//! 文档内嵌图片的**端侧 OCR** —— 扫描件 / 图片型 PDF / Office 文档里图片的取字路径。
//!
//! 为什么放在解析链里而不是工具层：OCR 出来的文本就是**正文的一部分**。如果放到工具层再拼接，
//! 分页（`offset`）/ `char_count` / `outTxtFile` 全文落盘就会各写一套（§11 反复踩过的分叉）。
//! 所以 `parse()` 抽完正文后按需调本模块，把 OCR 文本当作正文的一段交出去。
//!
//! 三层事实（改任何一层都别把另外两层搬过来）：
//! 1. 抽图 + 渲染：PDF 走 [`super::pdf::extract_images`]（页号 / 去重 / 过滤都在里面）；
//!    Office 走 `super::office`（文稿 / 演示直接取 IR 里的图片字节，表格取工作表模型里的）；
//! 2. 推理：[`crate::vision::ocr_image_at`]（端侧 quasivision，**图片不出本机**，不上传）；
//! 3. 口径（本模块）：什么图值得读（[`MIN_IMAGE_SIDE`] 太小、[`MAX_ASPECT_RATIO`] 太扁 / 太瘦）、
//!    最多读几张（[`MAX_IMAGES`]）、
//!    读不出来怎么如实交代 —— 两个入口（[`run_pdf_ocr`] 扫一遍 PDF、[`Reading`] 逐张喂、
//!    [`run_images_ocr`] 收一批）**共用**同一套。
//!
//! ⚠️ 本模块**从不返回 `Err`**：读不出来（模型缺失 / 编码不支持 / 图里真没字）是结果的一部分 ——
//! 调用方按「有没有文字」决定报 `NoText` 还是把正文交出去，绝不用空字符串冒充成功。

use super::pdf::{self, ImageScanOptions, OVER_LIMIT_REASON};
use crate::agent::cancellation::CancellationToken;
use std::path::{Path, PathBuf};

/// 宽或高小于它的图不读（图标 / 分隔线 / 装饰背景：OCR 出来只有噪声）
pub const MIN_IMAGE_SIDE: u32 = 64;

/// **形状**筛选：长边 / 短边超过它的图不读（横幅、分区标题条、单行截图 —— `553×81` 那种界面截条，
/// 以及反过来极瘦的长条）。这种图 OCR 基本只出噪声，却照样占掉一个读图名额、花掉几秒推理。
///
/// ⚠️ 只看形状，不看内容（不猜「这张是装饰图」）：`3` 是 2026-10 用户定的 —— 长边 > 短边 × 3。
pub const MAX_ASPECT_RATIO: f64 = 3.0;

/// 一份文档最多读几张图 —— OCR 是秒级推理，图多就慢；超出的如实报「没读」。
///
/// ⚠️ **全局口径**（PDF 与 Office 同一个数，2026-10 用户定的）：超上限的图不静默丢，
/// 而是进 `skipped` 并把 `truncated` 立起来 —— `note` 里会说清「还有图没读」。
pub const MAX_IMAGES: usize = 10;

/// 长文档把 OCR 正文块追加在正文后面时的开头（PDF 与表格两条路共用一句，模型一眼认得出这段字
/// 来自图里）；文稿 / 演示的图片是**就地**贴标记，不用它。
pub const BLOCK_LEAD: &str = "[OCR] On-device OCR of the embedded images:";

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
    /// 文档内的图片序号（1 起，按**文档顺序**）—— 正文标记里的 `Image N` 就是它
    pub index: usize,
    /// 图在文档里的位置（英文短句）：PDF = `page 3` / `pages 3, 4`，`xlsx` = 工作表名，
    /// 选单张表 / `.xls` = 空串（讲述不出来时标记里整段省掉）
    pub place: String,
    pub width: u32,
    pub height: u32,
    /// PDF 对象号（界面侧可用来对账；正文标记不用它；非 PDF → `None`）
    pub object_id: Option<u32>,
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
    /// 识别出的字符数（各图之和 —— 不含标记行本身）
    pub chars: usize,
    /// 抽图阶段就跳过的张数（太小 / 超上限 / 编码不支持）
    pub skipped: usize,
    /// 读了但一个字都没认出来的张数
    pub empty: usize,
    /// 渲染 / 推理失败的原因（每条一句话，张数有上限）
    pub errors: Vec<String>,
    /// 抽出来的图片张数（PDF = 去重后的图片对象数；Office = 正文 / 工作表里出现的张数）
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
            max_aspect_ratio: MAX_ASPECT_RATIO,
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
            let mut summary = OcrSummary::unavailable(
                OcrUnavailable::Models,
                one_line(reason),
                scan.total,
                scan.skipped.len(),
            );
            // 「还有图没读」是事实，与模型在不在无关（扫描阶段已按上限截过）
            summary.truncated = scan
                .skipped
                .iter()
                .any(|s| s.reason == OVER_LIMIT_REASON);
            return OcrOutcome {
                text: String::new(),
                summary,
            };
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
        let place = page_label(&image.pages);
        // 渲染 / 解码失败与「模型没读出字」是两回事，但记账方式一样：如实记进摘要
        match image
            .to_image()
            .and_then(|rendered| ocr_one(&models_dir, rendered))
        {
            Ok(text) if !text.trim().is_empty() => sections.push(OcrSection {
                index,
                place,
                width: image.width,
                height: image.height,
                object_id: Some(image.object_id),
                chars: text.chars().count(),
                text,
            }),
            Ok(_) => empty += 1,
            Err(e) => errors.push(format!("{}: {e}", error_label(index, &place))),
        }
    }

    let text = sections_block(&sections);
    let over_limit = scan
        .skipped
        .iter()
        .any(|s| s.reason == OVER_LIMIT_REASON);
    let summary = OcrSummary {
        available: true,
        unavailable: None,
        unavailable_reason: None,
        images: sections.len(),
        chars: sections.iter().map(|s| s.chars).sum(),
        skipped: scan.skipped.len(),
        empty,
        errors,
        total: scan.total,
        truncated: over_limit || cancelled,
        sections,
    };
    OcrOutcome { text, summary }
}

/// 正文里的一张图标记：模型要引用「哪张图的字」就靠它 —— `[OCR] Image 2 · page 3 · 1240×1754`
///
/// 位置那段没有时（`.xls` 讲不出图挂在哪张表、选单张表的 `xlsx`）整段省掉，不留空档。
fn section_marker(section: &OcrSection) -> String {
    let place = section.place.trim();
    if place.is_empty() {
        format!(
            "[OCR] Image {} · {}×{}",
            section.index, section.width, section.height
        )
    } else {
        format!(
            "[OCR] Image {} · {place} · {}×{}",
            section.index, section.width, section.height
        )
    }
}

/// 一段 OCR 正文块：每张图一节（`[OCR] Image N · 位置 · 尺寸` + 识别出的字），节间空一行
///
/// 一个字都没读出来 → 空串（调用方据此决定加不加那段 —— 空字符串不能冒充成功，见模块头）。
fn sections_block(sections: &[OcrSection]) -> String {
    sections
        .iter()
        .map(|s| format!("{}\n{}", section_marker(s), s.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// 页号标签：单页 `page 3`，被多页引用 `pages 3, 4`（`place` 就是它）
fn page_label(pages: &[usize]) -> String {
    let first = pages.first().copied().unwrap_or(1);
    if pages.len() > 1 {
        format!(
            "pages {}",
            pages
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        format!("page {first}")
    }
}

/// 报错时点名「哪张图、在哪」：`image 3 (page 2)`；位置讲不出来时 `image 3 (location unknown)`
fn error_label(number: usize, place: &str) -> String {
    let place = place.trim();
    if place.is_empty() {
        format!("image {number} (location unknown)")
    } else {
        format!("image {number} ({place})")
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Office 一侧：已经抽出来的图（字节在手，等着一周读）
// ═══════════════════════════════════════════════════════════════════════════

/// 已经从文档里抽出来、等着识别的一张图（`office` 一侧的输入：字节来自文档包）
///
/// PDF 不走这里：它的抽图 + 去重 + 「太小 / 超上限」判定全在 [`super::pdf::extract_images`] 里，
/// 顺手也把页号算好了（`place` = `page 3`）。
pub struct ExtractedImage {
    /// 文档内的序号（1 起，按文档顺序）—— 正文标记里的 `image N` 就是它
    pub number: usize,
    /// 位置标签（`销售` / `body` / `table`…）；讲不出来就空串（标记里整段省掉）
    pub place: String,
    /// 图片字节（PNG / JPEG / …）
    pub bytes: Vec<u8>,
}

/// 读一批**已经抽出来**的图（表格那两条路：正文先排好，OCR 文字追加在后面）
pub fn run_images_ocr(images: Vec<ExtractedImage>, opts: &OcrOptions) -> OcrOutcome {
    let mut reading = Reading::new(opts);
    for image in images {
        reading.read(image);
    }
    let summary = reading.finish();
    OcrOutcome {
        text: sections_block(&summary.sections),
        summary,
    }
}

/// 逐张读图的记账器 —— 抽图与推理**交替**进行时的入口（文稿 / 演示：图里的字要就地贴着标记）。
///
/// 为什么需要它：文稿 / 演示的图片标记是**就地**插进正文的，所以「读这张图」必须发生在走 IR 的
/// 时候（否则得回头定位刚插的段落）；而「读哪几张、最多几张、读不出来怎么记」这套口径只能有一份
/// —— 本类型与 [`run_pdf_ocr`] 共用 [`MIN_IMAGE_SIDE`] / [`MAX_ASPECT_RATIO`] / [`MAX_IMAGES`] / 旋转重试 / 措辞。
///
/// 用法：每遇到一张图调 [`read`](Self::read)（拿回 `Some(section)` = 读出来了，贴在标记后面），
/// 最后 [`finish`](Self::finish) 拿摘要。
pub struct Reading<'a> {
    opts: &'a OcrOptions,
    /// `None` = 模型不在（只数图，一个字都不冒充读）
    models_dir: Option<PathBuf>,
    /// 模型不在的原因（`finish` 时如实交出去）
    unavailable: Option<String>,
    /// 遇到的图片张数（含跳过 / 超上限的）
    seen: usize,
    /// 过了尺寸筛、真递给模型的张数（上限按它算）—— 模型不在时也照数：
    /// 「读到第几张」是**与模型无关**的事实（否则缺模型的机器上看不到「还有图没读」）
    handed: usize,
    skipped: usize,
    empty: usize,
    errors: Vec<String>,
    cancelled: bool,
    over_limit: bool,
    sections: Vec<OcrSection>,
}

impl<'a> Reading<'a> {
    pub fn new(opts: &'a OcrOptions) -> Self {
        let (models_dir, unavailable) = match &opts.models_dir {
            Ok(dir) => (Some(dir.clone()), None),
            Err(reason) => (None, Some(one_line(reason))),
        };
        Self {
            opts,
            models_dir,
            unavailable,
            seen: 0,
            handed: 0,
            skipped: 0,
            empty: 0,
            errors: Vec::new(),
            cancelled: false,
            over_limit: false,
            sections: Vec::new(),
        }
    }

    /// 读一张图：`Some(section)` = 读出字了；`None` = 跳过 / 空 / 失败（原因已记进摘要）
    pub fn read(&mut self, image: ExtractedImage) -> Option<OcrSection> {
        self.seen += 1;
        if self.cancelled || self.opts.cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            self.cancelled = true;
            return None;
        }
        // 「多小算小」「读到第几张」是两个**与模型无关**的事实：模型不在也该照实数
        // （否则 `skipped` / `truncated` 会因为模型缺失变成 0，note 里那句「还有 N 张没读」就没了）。
        // 先只看**头部**拿尺寸：太小 / 超上限的图根本不必解码（几 MB 的 PNG 解一遗是几十毫秒）
        let (width, height) = match image_size(&image.bytes) {
            Ok(size) => size,
            Err(e) => {
                self.errors.push(format!(
                    "{}: {e}",
                    error_label(image.number, &image.place)
                ));
                return None;
            }
        };
        if width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE {
            self.skipped += 1;
            return None;
        }
        if self.handed >= MAX_IMAGES {
            self.over_limit = true;
            self.skipped += 1;
            return None;
        }
        // 形状筛选放**上限之后**：超上限的图必须记成 `over the image limit`（`truncated` 靠它），
        // 不然「还有图没读」会在图都是扁条时静默消失。跳过的图不占名额（与 PDF 一侧同口径）
        if is_extreme_aspect(width, height) {
            self.skipped += 1;
            return None;
        }
        self.handed += 1;
        // 模型不在：到此为止（一个字都不冒充读，也不白解一遍图）
        let models_dir = self.models_dir.clone()?;
        let rendered = match image::load_from_memory(&image.bytes) {
            Ok(image) => image,
            Err(e) => {
                self.errors.push(format!(
                    "{}: the image could not be decoded ({e})",
                    error_label(image.number, &image.place)
                ));
                return None;
            }
        };
        match ocr_one(&models_dir, rendered) {
            Ok(text) if !text.trim().is_empty() => {
                let section = OcrSection {
                    index: image.number,
                    place: image.place,
                    width,
                    height,
                    object_id: None,
                    chars: text.chars().count(),
                    text,
                };
                self.sections.push(section.clone());
                Some(section)
            }
            Ok(_) => {
                self.empty += 1;
                None
            }
            Err(e) => {
                self.errors
                    .push(format!("{}: {e}", error_label(image.number, &image.place)));
                None
            }
        }
    }

    /// 摘要（与 [`run_pdf_ocr`] 同一形状）
    pub fn finish(self) -> OcrSummary {
        let mut summary = match self.unavailable {
            Some(reason) => OcrSummary::unavailable(
                OcrUnavailable::Models,
                reason,
                self.seen,
                self.skipped,
            ),
            None => OcrSummary {
                available: true,
                unavailable: None,
                unavailable_reason: None,
                images: self.sections.len(),
                chars: self.sections.iter().map(|s| s.chars).sum(),
                skipped: self.skipped,
                empty: self.empty,
                errors: Vec::new(),
                total: self.seen,
                truncated: false,
                sections: self.sections,
            },
        };
        // 「哪张图解不开」与「还有图没读」都是事实，模型在不在都得留着
        summary.errors = self.errors;
        summary.truncated = self.over_limit || self.cancelled;
        summary
    }
}

/// 形状太扁 / 太瘦的图不值得读（长边 / 短边 > [`MAX_ASPECT_RATIO`]）
///
/// PDF 一侧有一份同样的判据（`pdf::ImageScanOptions::max_aspect_ratio` —— 那边筛选发生在抽图时，
/// 由调用方把比例传进去）；数字只有 [`MAX_ASPECT_RATIO`] 一份，两边都照它算。
fn is_extreme_aspect(width: u32, height: u32) -> bool {
    let long = width.max(height);
    let short = width.min(height);
    // 到这里 `width` / `height` 都已过 [`MIN_IMAGE_SIDE`]（≥ 64），短边不会是 0
    f64::from(long) / f64::from(short) > MAX_ASPECT_RATIO
}

/// 只看图片**头部**拿尺寸（不必把整张图解开 —— 几 MB 的 PNG 解一遗是几十毫秒）
fn image_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    use std::io::Cursor;
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("the image format could not be recognized ({e})"))?
        .into_dimensions()
        .map_err(|e| format!("the image could not be decoded ({e})"))
}

/// 读一张图：端侧 OCR（判定「躺着」时换三个方向再试）
fn ocr_one(models_dir: &Path, rendered: image::DynamicImage) -> Result<String, String> {
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
/// `layer`：这份文档的正文是什么状态 —— 决定措辞是「补充」还是「兜底」。
pub fn summary_note(summary: &OcrSummary, layer: TextLayer) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(reason) = &summary.unavailable_reason {
        parts.push(format!("on-device OCR is unavailable ({reason})"));
    } else if summary.images > 0 {
        let read = format!("{} embedded image(s)", summary.images);
        parts.push(match layer {
            TextLayer::Present => {
                format!("{read} were additionally read with on-device OCR (marked OCR)")
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
            "{} image(s) were skipped (too small, too wide or too tall, over the {} image limit, or an unsupported encoding)",
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
///
/// ⚠️ 名字说的是 PDF 的「文字层」，但 Office 那边也用同一套措辞：有正文 = `Present`，
/// 整份文档除了图片一个字都没有（整篇截图）= `Empty`，抽正文本身失败 = `Failed`。
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
/// `subject` = 这份文档的指称（`the PDF` / `the document`）—— PDF 与 Office 走同一套结论，
/// 但「这个文件里有没有图」这句话得说对对象。
///
/// 顺序有意为之：**没有图**比「模型不在」更接近真相 —— 那种情况下即使模型在位也读不出字。
pub fn no_text_detail(summary: &OcrSummary, subject: &str) -> String {
    let unavailable = summary
        .unavailable
        .zip(summary.unavailable_reason.as_deref());
    if summary.total == 0 && !matches!(unavailable, Some((OcrUnavailable::Images, _))) {
        return format!("{subject} contains no embedded images");
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
            "all {} embedded image(s) were skipped (too small, too wide or too tall, over the limit, or an unsupported encoding)",
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
mod tests;
