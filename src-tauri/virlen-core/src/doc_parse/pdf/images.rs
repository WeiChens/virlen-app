//! 内嵌图片 —— 抽图交给端侧 OCR（本仓唯一一份 `lopdf` + `image` 的图片解码 / 渲染实现）。
//!
//! 只负责「把可读的图交出去」：筛选口径（多大才算值得读、最多几张）由调用方给
//! （[`ImageScanOptions`]，见 `crate::doc_parse::ocr`）；抽不出来的如实记进 `ImageScan::skipped`。

// ═══════════════════════════════════════════════════════════════════════════
// 内嵌图片（端侧 OCR 的输入）
// ═══════════════════════════════════════════════════════════════════════════

use std::io::Read;

/// 「超过调用方给的张数上限」这条跳过原因 —— **跨分册不变量**：`crate::doc_parse::ocr` 靠它判断
/// 「还有图没读」（`OcrSummary::truncated`），所以**只此一份** —— 两边各写一遍字符串，改一个字的
/// 文案就会让那个判断静默失效。
pub const OVER_LIMIT_REASON: &str = "over the image limit";

/// Form XObject 的展开深度上限：图片常被包在表单里，但递归没有尽头
const MAX_FORM_DEPTH: usize = 4;

/// 抽图口径 —— 由调用方给（筛选标准属于「要不要 OCR」那条链，见 [`crate::doc_parse::ocr`]）
#[derive(Debug, Clone, Copy)]
pub struct ImageScanOptions {
    /// 宽或高小于它的图跳过（图标 / 分隔线 / 装饰背景：OCR 出来只有噪声）
    pub min_side: u32,
    /// 最多取几张（按绘制顺序取前 N 张）；`0` = 不限
    pub max_images: usize,
}

impl Default for ImageScanOptions {
    fn default() -> Self {
        Self {
            min_side: 1,
            max_images: 0,
        }
    }
}

/// 一张内嵌图片（像素**还没渲染**：扫描件单页可达数十 MB，全部解开太占内存）
#[derive(Debug, Clone)]
pub struct PdfImage {
    /// PDF 对象号（同一对象被多页引用时只出现一次）
    pub object_id: u32,
    /// 首次出现的页号（1 起）
    pub page: usize,
    /// 引用它的全部页号（升序、去重）
    pub pages: Vec<usize>,
    /// 像素尺寸（来自图片字典，不需要解码）
    pub width: u32,
    pub height: u32,
    /// 像素数据
    pub pixels: PdfPixels,
}

/// 像素数据的两种形态：要么已经是 JPEG，要么是待渲染的原始采样
#[derive(Debug, Clone)]
pub enum PdfPixels {
    /// `DCTDecode`：内容就是一份 JPEG（扫描件 / 照片最常见）
    Jpeg(Vec<u8>),
    /// 无滤镜 / `FlateDecode` / `ASCII85Decode` 解出的原始采样
    Raw(RawPixels),
}

/// 原始采样 + 渲染参数（颜色空间在抽取阶段就解析好 —— 页面资源里的具名空间只有那时查得到）
#[derive(Debug, Clone)]
pub struct RawPixels {
    pub data: Vec<u8>,
    /// 每分量位数：1 / 2 / 4 / 8（其余在抽取阶段就跳过）
    pub bits: u8,
    pub color: RawColor,
}

/// 采样怎么变成像素
#[derive(Debug, Clone)]
pub enum RawColor {
    /// 灰度（采样按位宽缩放到 0..=255）
    Gray,
    /// RGB（每像素 3 字节）
    Rgb,
    /// CMYK（每像素 4 字节；渲染时转 RGB）
    Cmyk,
    /// 调色板索引（采样就是索引，**不缩放**）
    Indexed {
        /// 调色板字节（每项 `base` 个分量）
        palette: Vec<u8>,
        /// 每项分量数：1 = 灰度，3 = RGB
        base: u8,
    },
}

impl RawPixels {
    /// 每像素的分量数
    fn components(&self) -> usize {
        match self.color {
            RawColor::Gray | RawColor::Indexed { .. } => 1,
            RawColor::Rgb => 3,
            RawColor::Cmyk => 4,
        }
    }
}

/// 跳过的图片 —— 「图没被读」必须能被解释，不许静默丢弃
#[derive(Debug, Clone)]
pub struct SkippedImage {
    pub object_id: u32,
    pub page: usize,
    /// 英文短语（进 `uiData` / 提示行，不进 i18n）——
    /// [`OVER_LIMIT_REASON`] 那一句是**跨分册判据**（`crate::doc_parse::ocr` 靠它判「还有图没读」）
    pub reason: String,
}

/// 一次抽图的结果
#[derive(Debug, Clone, Default)]
pub struct ImageScan {
    /// 可渲染的图片（绘制顺序）
    pub images: Vec<PdfImage>,
    /// 跳过的图片（尺寸太小 / 超过上限 / 编码不支持）
    pub skipped: Vec<SkippedImage>,
    /// 去重后的图片对象总数（含跳过的）—— 「还有多少张没读」靠它
    pub total: usize,
}

impl PdfImage {
    /// 渲染成图像（JPEG 交给 `image` 解码；原始采样按颜色空间拼像素）
    pub fn to_image(&self) -> Result<image::DynamicImage, String> {
        match &self.pixels {
            PdfPixels::Jpeg(bytes) => image::load_from_memory(bytes)
                .map_err(|e| format!("failed to decode the JPEG image: {e}")),
            PdfPixels::Raw(raw) => raw.render(self.width, self.height),
        }
    }
}

impl RawPixels {
    /// 原始采样 → 像素（尺寸对不上 / 位深与颜色空间不匹配 → 如实报错）
    fn render(&self, width: u32, height: u32) -> Result<image::DynamicImage, String> {
        let pixels = (width as usize) * (height as usize);
        if self.bits < 8 && self.components() != 1 {
            return Err(format!(
                "{} bits per component is not valid for this color space",
                self.bits
            ));
        }
        match &self.color {
            RawColor::Gray => {
                let max = (1u16 << self.bits) - 1;
                let samples = self.unpack(pixels)?;
                let out: Vec<u8> = samples
                    .iter()
                    .map(|s| u8::try_from(*s as u16 * 255 / max).unwrap_or(255))
                    .collect();
                gray_image(out, width, height)
            }
            RawColor::Rgb => rgb_image(self.unpack(pixels * 3)?, width, height),
            RawColor::Cmyk => {
                let samples = self.unpack(pixels * 4)?;
                let mut out = Vec::with_capacity(pixels * 3);
                for px in samples.chunks(4) {
                    let [c, m, y, k] = px else { break };
                    // 朴素减色法（不做 ICC 色彩管理：OCR 只关心字形，色偏无所谓）
                    let k = *k as u16;
                    for value in [c, m, y] {
                        out.push(255u16.saturating_sub((*value as u16 + k).min(255)) as u8);
                    }
                }
                rgb_image(out, width, height)
            }
            RawColor::Indexed { palette, base } => {
                let indices = self.unpack(pixels)?;
                let channels = (*base).max(1) as usize;
                if channels == 1 {
                    let out: Vec<u8> = indices
                        .iter()
                        .map(|i| palette.get(*i as usize).copied().unwrap_or(0))
                        .collect();
                    gray_image(out, width, height)
                } else {
                    let mut out = Vec::with_capacity(pixels * 3);
                    for i in indices {
                        let at = i as usize * channels;
                        match palette.get(at..at + 3) {
                            Some(px) => out.extend_from_slice(px),
                            None => out.extend_from_slice(&[0, 0, 0]),
                        }
                    }
                    rgb_image(out, width, height)
                }
            }
        }
    }

    /// 把可能按位打包的采样解成「一个采样一个 `u8`」（1/2/4 位左对齐取高比特，8 位原样）
    fn unpack(&self, expected: usize) -> Result<Vec<u8>, String> {
        if self.bits == 8 {
            let needed = expected * self.components();
            if self.data.len() < needed {
                return Err(format!(
                    "the image stream is truncated ({} of {needed} bytes)",
                    self.data.len()
                ));
            }
            return Ok(self.data[..needed].to_vec());
        }
        let per_byte = (8 / self.bits.max(1)) as usize;
        let mask = (1u16 << self.bits) - 1;
        let mut out = Vec::with_capacity(expected);
        for i in 0..expected {
            let byte = self.data.get(i / per_byte).copied().unwrap_or(0);
            let shift = 8 - self.bits * (1 + (i % per_byte) as u8);
            out.push(((byte >> shift) as u16 & mask) as u8);
        }
        Ok(out)
    }
}

fn gray_image(data: Vec<u8>, width: u32, height: u32) -> Result<image::DynamicImage, String> {
    image::GrayImage::from_raw(width, height, data)
        .map(Into::into)
        .ok_or_else(|| "the pixel data does not match the image dimensions".to_string())
}

fn rgb_image(data: Vec<u8>, width: u32, height: u32) -> Result<image::DynamicImage, String> {
    image::RgbImage::from_raw(width, height, data)
        .map(Into::into)
        .ok_or_else(|| "the pixel data does not match the image dimensions".to_string())
}

/// 抽出 PDF 的内嵌图片（按页面绘制顺序；同一对象被多页引用只出一次）
pub fn extract_images(bytes: &[u8], opts: &ImageScanOptions) -> Result<ImageScan, String> {
    let doc = lopdf::Document::load_mem(bytes).map_err(|e| e.to_string())?;
    let mut scan = ImageScan::default();
    // 对象号 → 已收下的下标（`None` = 见过但跳过了：再遇到只当没看见，不重复计总数）
    let mut seen: std::collections::HashMap<u32, Option<usize>> = std::collections::HashMap::new();

    for (page_no, page_id) in doc.get_pages() {
        let page = page_no as usize;
        let resources = doc
            .get_page_resources(page_id)
            .ok()
            .and_then(|(r, _)| r.cloned());
        for (object_id, context) in page_image_ids(&doc, page_id, resources.as_ref()) {
            let key = object_id.0;
            if let Some(loaded) = seen.get(&key) {
                // 同一对象在别的页又画了一次：只补页号（不重复读、不重复送 OCR）
                if let Some(idx) = loaded {
                    if !scan.images[*idx].pages.contains(&page) {
                        scan.images[*idx].pages.push(page);
                    }
                }
                continue;
            }
            scan.total += 1;
            match load_image(&doc, object_id, page, context.as_ref(), opts, scan.images.len()) {
                Ok(image) => {
                    seen.insert(key, Some(scan.images.len()));
                    scan.images.push(image);
                }
                Err(reason) => {
                    seen.insert(key, None);
                    scan.skipped.push(SkippedImage {
                        object_id: key,
                        page,
                        reason,
                    });
                }
            }
        }
    }
    Ok(scan)
}

/// 读一张图片对象的**渲染参数**（不解压像素：尺寸先判，小图 / 超限的图没必要解压）
fn load_image(
    doc: &lopdf::Document,
    object_id: lopdf::ObjectId,
    page: usize,
    resources: Option<&lopdf::Dictionary>,
    opts: &ImageScanOptions,
    taken: usize,
) -> Result<PdfImage, String> {
    if opts.max_images > 0 && taken >= opts.max_images {
        return Err(OVER_LIMIT_REASON.to_string());
    }
    let stream = doc
        .get_object(object_id)
        .and_then(|o| o.as_stream())
        .map_err(|_| "the image object is not a stream".to_string())?;
    let dict = &stream.dict;
    if dict_name(dict, b"Subtype") != Some("Image") {
        return Err("the object is not an image".to_string());
    }
    if dict_i64(dict, b"ImageMask").is_some_and(|v| v != 0) {
        return Err("a stencil mask, not a picture".to_string());
    }
    let (width, height) = (
        dict_i64(dict, b"Width").unwrap_or(0),
        dict_i64(dict, b"Height").unwrap_or(0),
    );
    if width <= 0 || height <= 0 {
        return Err("invalid image dimensions".to_string());
    }
    let (width, height) = (width as u32, height as u32);
    if width < opts.min_side || height < opts.min_side {
        return Err("too small to read".to_string());
    }
    // DCTDecode 的位深写在 JPEG 里，图片字典里的 BitsPerComponent 只对原始采样有意义
    let bits = dict_i64(dict, b"BitsPerComponent").unwrap_or(8);
    let pixels = match decode_pixels(stream, width, bits)? {
        DecodedPixels::Jpeg(data) => PdfPixels::Jpeg(data),
        DecodedPixels::Samples(data) => {
            if !matches!(bits, 1 | 2 | 4 | 8) {
                return Err(format!("{bits} bits per component are not supported"));
            }
            let color = resolve_color(doc, dict, resources)?;
            PdfPixels::Raw(RawPixels {
                data,
                bits: bits as u8,
                color,
            })
        }
    };
    Ok(PdfImage {
        object_id: object_id.0,
        page,
        pages: vec![page],
        width,
        height,
        pixels,
    })
}

/// 解压后的内容：要么是 JPEG，要么是原始采样
enum DecodedPixels {
    Jpeg(Vec<u8>),
    Samples(Vec<u8>),
}

/// 按 `/Filter` 链解出图片内容（只支持**纯 Rust 能解**的编码，其余如实报「不支持」）
fn decode_pixels(
    stream: &lopdf::Stream,
    width: u32,
    bits: i64,
) -> Result<DecodedPixels, String> {
    let filters = stream.filters().unwrap_or_default();
    let mut data = stream.content.clone();
    for (i, filter) in filters.iter().enumerate() {
        let last = i + 1 == filters.len();
        match filter.as_str() {
            "ASCII85Decode" => data = ascii85_decode(&data),
            "FlateDecode" => {
                data = inflate(&data)?;
                if last {
                    data = apply_predictor(&stream.dict, &data, width, bits)?;
                }
            }
            "DCTDecode" if last => return Ok(DecodedPixels::Jpeg(data)),
            "DCTDecode" => {
                return Err("unexpected image filter order (DCTDecode must come last)".to_string())
            }
            other => return Err(format!("unsupported image encoding: {other}")),
        }
    }
    Ok(DecodedPixels::Samples(data))
}

/// zlib 解压（`FlateDecode`）—— 少数生成器写的是裸 deflate（少了 zlib 头），故兜底再试一次
fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    if flate2::read::ZlibDecoder::new(data)
        .read_to_end(&mut out)
        .is_ok()
    {
        return Ok(out);
    }
    out.clear();
    flate2::read::DeflateDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| format!("failed to decompress the image stream: {e}"))?;
    Ok(out)
}

/// 预测器（TIFF / PNG）：带 `Predictor` 的图片流按行差分编码，不解出来的是斜的
fn apply_predictor(
    dict: &lopdf::Dictionary,
    data: &[u8],
    width: u32,
    bits: i64,
) -> Result<Vec<u8>, String> {
    use lopdf::filters::png::{decode_frame, decode_row, FilterType};

    // `/DecodeParms`（或缩写 `/DP`）可能是字典，也可能是与 `/Filter` 一一对应的数组
    let params = [b"DecodeParms".as_slice(), b"DP".as_slice()]
        .iter()
        .find_map(|key| dict.get(key).ok())
        .and_then(|obj| {
            obj.as_dict().ok().or_else(|| {
                obj.as_array()
                    .ok()
                    .and_then(|items| items.iter().find_map(|o| o.as_dict().ok()))
            })
        });
    let Some(params) = params else {
        return Ok(data.to_vec());
    };
    let predictor = dict_i64(params, b"Predictor").unwrap_or(1);
    if predictor <= 1 {
        return Ok(data.to_vec());
    }
    let columns = dict_i64(params, b"Columns").unwrap_or(width as i64).max(1) as usize;
    let colors = dict_i64(params, b"Colors").unwrap_or(1).max(1) as usize;
    let bpc = dict_i64(params, b"BitsPerComponent").unwrap_or(bits).max(1) as usize;
    // 每像素字节数（向上取整）—— PNG 预测器就按它对齐
    let bpp = (bpc * colors).div_ceil(8).max(1);

    let filter = match predictor {
        // 15 = 每行自带 filter 字节（最优）；10~14 与 TIFF 的 2 是固定 filter
        2 | 11 => FilterType::Sub,
        10 => FilterType::None,
        12 => FilterType::Up,
        13 => FilterType::Avg,
        14 => FilterType::Paeth,
        15 => {
            return decode_frame(data, bpp, columns)
                .map_err(|e| format!("failed to undo the PNG predictor: {e}"))
        }
        other => return Err(format!("unsupported predictor: {other}")),
    };

    let row_len = columns * bpp;
    if row_len == 0 || !data.len().is_multiple_of(row_len) {
        return Err("predicted image data is not a whole number of rows".to_string());
    }
    let mut previous = vec![0u8; row_len];
    let mut current = vec![0u8; row_len];
    let mut out = Vec::with_capacity(data.len());
    for row in data.chunks_exact(row_len) {
        current.copy_from_slice(row);
        decode_row(filter, bpp, &previous, &mut current);
        out.extend_from_slice(&current);
        std::mem::swap(&mut previous, &mut current);
    }
    Ok(out)
}

/// ASCII85（`ASCII85Decode`）—— 自己实现是因为 `lopdf` 只对**非图片**流公开它（`decompressed_content`
/// 遇到 `Subtype /Image` 直接拒绝），而 ASCII85+Flate 是旧扫描件常见的组合。
///
/// 非法字节一律跳过：宁可少解出一点像素，也不要让整份文档解析失败。
fn ascii85_decode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 4 / 5);
    let mut tuple: u32 = 0;
    let mut count = 0usize;
    for &byte in input {
        match byte {
            b'~' => break, // EOD
            b'z' if count == 0 => out.extend_from_slice(&[0, 0, 0, 0]),
            b if b.is_ascii_whitespace() => {}
            byte @ b'!'..=b'u' => {
                tuple = tuple * 85 + (byte - b'!') as u32;
                count += 1;
                if count == 5 {
                    out.extend_from_slice(&tuple.to_be_bytes());
                    tuple = 0;
                    count = 0;
                }
            }
            _ => {}
        }
    }
    if count > 0 {
        for _ in count..5 {
            tuple = tuple * 85 + 84;
        }
        out.extend_from_slice(&tuple.to_be_bytes()[..count - 1]);
    }
    out
}

/// 颜色空间 → 渲染参数。具名空间（`/CS0` 之类）与 `ICCBased` 只在这里解析
///（出了页面资源的作用域就查不到了，所以必须在抽取阶段做）
fn resolve_color(
    doc: &lopdf::Document,
    dict: &lopdf::Dictionary,
    resources: Option<&lopdf::Dictionary>,
) -> Result<RawColor, String> {
    let obj = dict
        .get(b"ColorSpace")
        .map_err(|_| "the image has no color space".to_string())?;
    resolve_color_of(doc, obj, resources, 0)
}

fn resolve_color_of(
    doc: &lopdf::Document,
    obj: &lopdf::Object,
    resources: Option<&lopdf::Dictionary>,
    depth: usize,
) -> Result<RawColor, String> {
    if depth > 8 {
        return Err("the color space is nested too deeply".to_string());
    }
    match obj {
        lopdf::Object::Reference(id) => {
            let target = doc
                .get_object(*id)
                .map_err(|_| "the color space reference is broken".to_string())?;
            resolve_color_of(doc, target, resources, depth + 1)
        }
        lopdf::Object::Name(name) => match name.as_slice() {
            b"DeviceGray" | b"G" | b"CalGray" => Ok(RawColor::Gray),
            b"DeviceRGB" | b"RGB" | b"CalRGB" => Ok(RawColor::Rgb),
            b"DeviceCMYK" | b"CMYK" => Ok(RawColor::Cmyk),
            // 具名空间：去页面 / 表单资源里找定义
            other => {
                let name = String::from_utf8_lossy(other).to_string();
                let defined = resources
                    .and_then(|r| r.get_deref(b"ColorSpace", doc).ok())
                    .and_then(|o| resolve_named(doc, o, &name));
                match defined {
                    Some(inner) => resolve_color_of(doc, &inner, resources, depth + 1),
                    None => Err(format!("unsupported color space: /{name}")),
                }
            }
        },
        lopdf::Object::Array(items) => {
            let kind = items
                .first()
                .and_then(|o| o.as_name_str().ok())
                .unwrap_or_default()
                .to_string();
            match kind.as_str() {
                "Indexed" | "I" => {
                    let base = items
                        .get(1)
                        .ok_or_else(|| "the indexed color space has no base".to_string())?;
                    let base = resolve_color_of(doc, base, resources, depth + 1)?;
                    let base_components = match base {
                        RawColor::Gray => 1u8,
                        RawColor::Rgb => 3u8,
                        _ => {
                            return Err(
                                "unsupported indexed color space (the base must be gray or RGB)"
                                    .to_string(),
                            )
                        }
                    };
                    let lookup = items
                        .get(3)
                        .ok_or_else(|| "the indexed color space has no palette".to_string())?;
                    let palette = palette_bytes(doc, lookup)?;
                    Ok(RawColor::Indexed {
                        palette,
                        base: base_components,
                    })
                }
                "ICCBased" => {
                    // ICCBased 只取「几个分量」：OCR 不需要色彩管理，但分量数决定怎么拆采样
                    let n = items
                        .get(1)
                        .and_then(|o| match o {
                            lopdf::Object::Reference(id) => doc.get_object(*id).ok(),
                            direct => Some(direct),
                        })
                        .and_then(|o| o.as_stream().ok())
                        .and_then(|s| dict_i64(&s.dict, b"N"))
                        .unwrap_or(3);
                    match n {
                        1 => Ok(RawColor::Gray),
                        3 => Ok(RawColor::Rgb),
                        4 => Ok(RawColor::Cmyk),
                        other => Err(format!("unsupported ICCBased color space with {other} components")),
                    }
                }
                "CalRGB" => Ok(RawColor::Rgb),
                "CalGray" => Ok(RawColor::Gray),
                other => Err(format!("unsupported color space: {other}")),
            }
        }
        _ => Err("unsupported color space".to_string()),
    }
}

/// 在资源字典的 `/ColorSpace` 里按名字找定义（找不到 → `None`）
fn resolve_named(
    doc: &lopdf::Document,
    spaces: &lopdf::Object,
    name: &str,
) -> Option<lopdf::Object> {
    let spaces = match spaces {
        lopdf::Object::Reference(id) => doc.get_object(*id).ok()?,
        direct => direct,
    };
    let dict = spaces.as_dict().ok()?;
    dict.get(name.as_bytes()).ok().cloned()
}

/// 调色板字节：可能是字符串，也可能是一份流（`Object::String` / `Stream`）
fn palette_bytes(doc: &lopdf::Document, lookup: &lopdf::Object) -> Result<Vec<u8>, String> {
    match lookup {
        lopdf::Object::String(bytes, _) => Ok(bytes.clone()),
        lopdf::Object::Reference(id) => {
            let target = doc
                .get_object(*id)
                .map_err(|_| "the palette stream reference is broken".to_string())?;
            Ok(target.as_stream().map(|s| s.content.clone()).unwrap_or_default())
        }
        _ => Err("unsupported palette representation".to_string()),
    }
}

/// 一页上按**绘制顺序**出现的图片（含 Form XObject 内部），并带上图片所在作用域的资源
fn page_image_ids(
    doc: &lopdf::Document,
    page_id: lopdf::ObjectId,
    resources: Option<&lopdf::Dictionary>,
) -> Vec<(lopdf::ObjectId, Option<lopdf::Dictionary>)> {
    let xobjects = xobjects_of(doc, resources);
    let mut names = doc
        .get_and_decode_page_content(page_id)
        .map(|content| drawn_names(&content.operations))
        .unwrap_or_default();
    if names.is_empty() {
        // 宁可顺序差，也不要漏图：内容流解不出来就按资源字典里的出现顺序
        names = xobjects.iter().map(|(name, _)| name.clone()).collect();
    }
    let mut out = Vec::new();
    for name in names {
        if let Some((_, id)) = xobjects.iter().find(|(candidate, _)| *candidate == name) {
            collect_images(doc, *id, resources, &mut out, 0);
        }
    }
    out
}

/// 一串已解码的操作里被 `Do` 画出来的 XObject 名字（保持绘制顺序）
fn drawn_names(operations: &[lopdf::content::Operation]) -> Vec<Vec<u8>> {
    operations
        .iter()
        .filter(|op| op.operator == "Do")
        .filter_map(|op| op.operands.first().and_then(|o| o.as_name_str().ok()))
        .map(|name| name.as_bytes().to_vec())
        .collect()
}

/// 把一个 XObject 里的图片（含嵌套表单）收进 `out`
fn collect_images(
    doc: &lopdf::Document,
    id: lopdf::ObjectId,
    resources: Option<&lopdf::Dictionary>,
    out: &mut Vec<(lopdf::ObjectId, Option<lopdf::Dictionary>)>,
    depth: usize,
) {
    if depth > MAX_FORM_DEPTH {
        return;
    }
    let Ok(stream) = doc.get_object(id).and_then(|o| o.as_stream()) else {
        return;
    };
    match dict_name(&stream.dict, b"Subtype") {
        Some("Image") => out.push((id, resources.cloned())),
        Some("Form") => {
            // 表单用自己的资源（没写就继承外层）—— 具名颜色空间常定义在这里
            let own = stream
                .dict
                .get(b"Resources")
                .ok()
                .and_then(|o| deref_dict(doc, o))
                .or_else(|| resources.cloned());
            let xobjects = xobjects_of(doc, own.as_ref());
            let mut names = stream
                .decode_content()
                .map(|content| drawn_names(&content.operations))
                .unwrap_or_default();
            if names.is_empty() {
                names = xobjects.iter().map(|(name, _)| name.clone()).collect();
            }
            for name in names {
                if let Some((_, child)) = xobjects.iter().find(|(candidate, _)| *candidate == name) {
                    collect_images(doc, *child, own.as_ref(), out, depth + 1);
                }
            }
        }
        _ => {}
    }
}

/// 资源字典里的 `/XObject`（名字 → 对象号，保持字典顺序）
fn xobjects_of(
    doc: &lopdf::Document,
    resources: Option<&lopdf::Dictionary>,
) -> Vec<(Vec<u8>, lopdf::ObjectId)> {
    let Some(resources) = resources else {
        return Vec::new();
    };
    let Ok(obj) = resources.get(b"XObject") else {
        return Vec::new();
    };
    let dict = match obj {
        lopdf::Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| o.as_dict().ok()),
        direct => direct.as_dict().ok(),
    };
    let Some(dict) = dict else { return Vec::new() };
    dict.iter()
        .filter_map(|(name, value)| match value {
            lopdf::Object::Reference(id) => Some((name.clone(), *id)),
            _ => None,
        })
        .collect()
}

fn deref_dict(doc: &lopdf::Document, obj: &lopdf::Object) -> Option<lopdf::Dictionary> {
    match obj {
        lopdf::Object::Dictionary(d) => Some(d.clone()),
        lopdf::Object::Reference(id) => doc
            .get_object(*id)
            .ok()
            .and_then(|o| o.as_dict().ok())
            .cloned(),
        _ => None,
    }
}

fn dict_i64(dict: &lopdf::Dictionary, key: &[u8]) -> Option<i64> {
    dict.get(key).ok().and_then(|o| o.as_i64().ok())
}

fn dict_name<'a>(dict: &'a lopdf::Dictionary, key: &[u8]) -> Option<&'a str> {
    dict.get(key).ok().and_then(|o| o.as_name_str().ok())
}