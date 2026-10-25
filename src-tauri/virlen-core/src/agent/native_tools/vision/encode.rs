//! 发给视觉模型前的图片规范化：最长边缩放 + 目标格式重编码。
//!
//! 档位来自 `app_settings`（`imageMaxDimension` / `imageConvertFormat`），
//! ⚠️ 与前端 `hooks.ts::fileToDataUrl` **同一套规则**（铁律 1）：改这里必须同步改那边。
//!
//! 五条规则：
//! 1. **只缩不放**：原图最长边小于阈值时保持原尺寸；
//! 2. **不做无谓转换**：目标格式与原格式相同且无需缩放 → 原字节直传（避免二次有损压缩）；
//! 3. **不劣化**：只转格式不缩放时，若转换后反而更大 → 回退原图（「更小」是这套逻辑的目的）；
//! 4. **JPEG 铺白底**：JPEG 没有 alpha，直接丢通道会让透明区变黑；
//! 5. **解码前先挡像素数**：`image::load_from_memory` 会全量展开，1 亿像素的图能耗光内存。

use image::ImageEncoder;
use serde_json::Value;

/// 有损编码质量（JPEG q / WebP q 同一档）：0.82 比 0.85 再省约 10% 字节，肉眼差异可忽略。
const QUALITY: u8 = 82;
const WEBP_QUALITY: f32 = 82.0;

/// 全量解码的像素上限（解码后 4 通道约 400 MB，已是能接受的上限）。
const MAX_DECODE_PIXELS: u64 = 100_000_000;

/// 设置键名（与前端 `settingStore` 同名字段）
pub(crate) const FORMAT_KEY: &str = "imageConvertFormat";
pub(crate) const MAX_DIMENSION_KEY: &str = "imageMaxDimension";

/// 默认最长边：1568 是视觉模型的分档上限，再大只是白花 token。
pub(crate) const DEFAULT_MAX_DIMENSION: u32 = 1568;

/// 允许的最长边档位（设置页也只给这三个选项）
pub(crate) const MAX_DIMENSIONS: [u32; 3] = [1024, 1568, 2048];

/// 目标图片格式
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum OutputFormat {
    #[default]
    Jpeg,
    Png,
    Webp,
}

impl OutputFormat {
    pub(crate) fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }

    /// 设置值 → 格式（认不出来的一律按 JPEG，与前端默认一致）
    pub(crate) fn from_setting(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "png" => Self::Png,
            "webp" => Self::Webp,
            _ => Self::Jpeg,
        }
    }

    fn from_mime(mime: &str) -> Option<Self> {
        match mime {
            "image/jpeg" => Some(Self::Jpeg),
            "image/png" => Some(Self::Png),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

/// 一次发送采用的档位
#[derive(Clone, Copy, Debug)]
pub(crate) struct Plan {
    pub format: OutputFormat,
    pub max_dimension: u32,
}

impl Plan {
    /// 从 `app_settings` 读档位：缺省 / 非法值都回落到默认，绝不让一次读配置失败改变行为。
    pub(crate) fn from_settings(map: &serde_json::Map<String, Value>) -> Self {
        let format = map
            .get(FORMAT_KEY)
            .and_then(Value::as_str)
            .map(OutputFormat::from_setting)
            .unwrap_or_default();
        let max_dimension = map
            .get(MAX_DIMENSION_KEY)
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .filter(|v| MAX_DIMENSIONS.contains(v))
            .unwrap_or(DEFAULT_MAX_DIMENSION);
        Self { format, max_dimension }
    }
}

/// 转换结果（`bytes` + 该以什么 mime 发出去）
pub(crate) struct Encoded {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    /// 是否重新编码过：false = 原字节直传
    pub reencoded: bool,
}

/// 等比缩到「最长边 ≤ max」，只缩不放
fn fit(w: u32, h: u32, max: u32) -> (u32, u32) {
    let longest = w.max(h);
    if longest <= max || longest == 0 {
        return (w, h);
    }
    let scale = max as f64 / longest as f64;
    (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    )
}

fn encode_image(img: &image::DynamicImage, format: OutputFormat) -> Result<Vec<u8>, String> {
    let (w, h) = (img.width(), img.height());
    let mut out: Vec<u8> = Vec::new();
    match format {
        OutputFormat::Jpeg => {
            // 有 alpha 时先合成到白底：透明像素的 RGB 通常是 (0,0,0)，直接丢通道会得到黑底
            let rgb = if img.color().has_alpha() {
                let mut canvas =
                    image::RgbaImage::from_pixel(w, h, image::Rgba([255, 255, 255, 255]));
                image::imageops::overlay(&mut canvas, &img.to_rgba8(), 0, 0);
                image::DynamicImage::ImageRgba8(canvas).to_rgb8()
            } else {
                img.to_rgb8()
            };
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY)
                .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
                .map_err(|e| format!("failed to encode JPEG: {}", e))?;
        }
        OutputFormat::Png => {
            let rgba = img.to_rgba8();
            image::codecs::png::PngEncoder::new(&mut out)
                .write_image(rgba.as_raw(), w, h, image::ExtendedColorType::Rgba8)
                .map_err(|e| format!("failed to encode PNG: {}", e))?;
        }
        OutputFormat::Webp => {
            let rgba = img.to_rgba8();
            out = webp::Encoder::from_rgba(rgba.as_raw(), w, h)
                .encode(WEBP_QUALITY)
                .to_vec();
        }
    }
    Ok(out)
}

/// 按档位规范化一张图。
///
/// `source_mime` 是嗅探出来的**原始**类型（`&'static str`，回退时要用它）。
pub(crate) fn encode_for_model(
    bytes: &[u8],
    source_mime: &'static str,
    plan: Plan,
) -> Result<Encoded, String> {
    let (w, h) = super::image_send::image_dimensions(bytes)
        .ok_or_else(|| "cannot read image dimensions; the file may be truncated or corrupt".to_string())?;
    let (nw, nh) = fit(w, h, plan.max_dimension);
    let scaling = (nw, nh) != (w, h);

    // 格式没变、尺寸也不用动 → 原字节直传
    if !scaling && OutputFormat::from_mime(source_mime) == Some(plan.format) {
        return Ok(Encoded {
            bytes: bytes.to_vec(),
            mime: source_mime,
            width: w,
            height: h,
            reencoded: false,
        });
    }

    if w as u64 * h as u64 > MAX_DECODE_PIXELS {
        return Err(format!(
            "cannot decode {}x{} image: it exceeds the {} megapixel decode limit",
            w,
            h,
            MAX_DECODE_PIXELS / 1_000_000
        ));
    }

    let img = image::load_from_memory(bytes).map_err(|e| format!("failed to decode image: {}", e))?;
    let img = if scaling {
        img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let (ow, oh) = (img.width(), img.height());
    let out = encode_image(&img, plan.format)?;

    // 只转格式时：转换后反而更大就发原图（目标与设置一致不如「更大」重要）
    if !scaling && out.len() >= bytes.len() {
        return Ok(Encoded {
            bytes: bytes.to_vec(),
            mime: source_mime,
            width: w,
            height: h,
            reencoded: false,
        });
    }

    Ok(Encoded {
        bytes: out,
        mime: plan.format.mime(),
        width: ow,
        height: oh,
        reencoded: true,
    })
}

/// 测试用：内容随机、体积接近真实截图的 PNG。
///
/// 纯色图会被 PNG 压到几十字节，转 JPEG/WebP 反而变大，「不劣化」回退规则就会生效 ——
/// 那样的样本验不到转换。
#[cfg(test)]
pub(crate) fn noisy_png(w: u32, h: u32) -> Vec<u8> {
    let mut img = image::RgbaImage::new(w, h);
    let mut seed: u32 = 0x1234_5678;
    for p in img.pixels_mut() {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let v = (seed >> 24) as u8;
        *p = image::Rgba([v, v.wrapping_add(80), v.wrapping_add(160), 255]);
    }
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .unwrap();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(format: OutputFormat, max_dimension: u32) -> Plan {
        Plan { format, max_dimension }
    }

    #[test]
    fn same_format_within_limit_is_passed_through_byte_for_byte() {
        let bytes = noisy_png(40, 20);
        let r = encode_for_model(&bytes, "image/png", plan(OutputFormat::Png, 1568)).unwrap();
        assert!(!r.reencoded);
        assert_eq!(r.bytes, bytes);
        assert_eq!(r.mime, "image/png");
        assert_eq!((r.width, r.height), (40, 20));
    }

    #[test]
    fn large_image_is_scaled_to_the_longest_side() {
        let bytes = noisy_png(2000, 1000);
        let r = encode_for_model(&bytes, "image/png", plan(OutputFormat::Png, 1568)).unwrap();
        assert!(r.reencoded);
        assert_eq!((r.width, r.height), (1568, 784));
    }

    #[test]
    fn small_image_is_never_upscaled() {
        // 目标 JPEG：会重编码，但尺寸必须保持 40x20
        let bytes = noisy_png(40, 20);
        let r = encode_for_model(&bytes, "image/png", plan(OutputFormat::Jpeg, 1568)).unwrap();
        assert_eq!((r.width, r.height), (40, 20));
        assert_eq!(r.mime, "image/jpeg");
        assert_eq!(&r.bytes[..3], &[0xff, 0xd8, 0xff], "JPEG 魔数");
    }

    #[test]
    fn webp_output_carries_the_riff_container() {
        let bytes = noisy_png(64, 32);
        let r = encode_for_model(&bytes, "image/png", plan(OutputFormat::Webp, 1568)).unwrap();
        assert_eq!(r.mime, "image/webp");
        assert_eq!(&r.bytes[..4], b"RIFF");
        assert_eq!(&r.bytes[8..12], b"WEBP");
    }

    #[test]
    fn transparent_pixels_flatten_to_white_for_jpeg() {
        // 直接验编码器：透明图转出来是白底，而不是被「不劣化」规则回退的原图
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            8,
            image::Rgba([0, 0, 0, 0]),
        ));
        let jpeg = encode_image(&img, OutputFormat::Jpeg).unwrap();
        let decoded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        let p = decoded.get_pixel(4, 4);
        assert!(p[0] > 240 && p[1] > 240 && p[2] > 240, "透明区应为白底，实得 {:?}", p);
    }

    /// 转完反而更大 → 发原图（目标与设置一致不如「更大」重要）
    #[test]
    fn conversion_that_grows_the_file_falls_back_to_the_original() {
        // 1x1 纯色 PNG 只有几十字节，转 JPEG 一定更大
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[255u8, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let r = encode_for_model(&bytes, "image/png", plan(OutputFormat::Jpeg, 1568)).unwrap();
        assert!(!r.reencoded);
        assert_eq!(r.mime, "image/png");
    }

    #[test]
    fn plan_reads_settings_and_falls_back_on_junk() {
        let mut map = serde_json::Map::new();
        map.insert(FORMAT_KEY.into(), Value::String("webp".into()));
        map.insert(MAX_DIMENSION_KEY.into(), Value::from(2048));
        let p = Plan::from_settings(&map);
        assert_eq!(p.format, OutputFormat::Webp);
        assert_eq!(p.max_dimension, 2048);

        let mut junk = serde_json::Map::new();
        junk.insert(FORMAT_KEY.into(), Value::String("bmp".into()));
        junk.insert(MAX_DIMENSION_KEY.into(), Value::from(9999));
        let p = Plan::from_settings(&junk);
        assert_eq!(p.format, OutputFormat::Jpeg);
        assert_eq!(p.max_dimension, DEFAULT_MAX_DIMENSION);
    }
}
