//! `pdf` 的用例：文字层（版面重排 / 具名 CMap / `/W` 归一）与内嵌图片（绘制顺序 / 解码器 / 颜色空间）。
//!
//! 造 PDF 的样板在 `crate::doc_parse::test_pdf`（与生产代码同源）。

use super::*;
use super::text::patch_fonts;

/// 手写的最小无压缩 PDF（Helvetica + 一个 Tj）—— 只验「能抽出文字」这条路径，
/// 不引入二进制 fixture
const MINIMAL_PDF: &str = "%PDF-1.4\n\
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n\
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n\
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n\
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n\
5 0 obj<</Length 44>>stream\n\
BT /F1 12 Tf 20 100 Td (Hello PDF Text) Tj ET\n\
endstream\nendobj\n\
trailer<</Root 1 0 R>>\n%%EOF\n";

#[test]
fn extracts_text_from_a_minimal_pdf() {
    match extract_text(MINIMAL_PDF.as_bytes()) {
        Ok(out) => assert!(
            out.text.contains("Hello PDF Text"),
            "应抽出手写 PDF 里的文字，实际：{:?}",
            out.text
        ),
        // 这份手写 PDF 没有完整的 xref：库若不接受，允许解析失败（工具侧会报 Backend）
        Err(e) => assert!(!e.is_empty(), "失败也要给出原因，实际：{e}"),
    }
}

#[test]
fn garbage_input_fails_instead_of_returning_junk() {
    assert!(extract_text(b"not a pdf at all").is_err());
}

// ═════════════════════════════════════════════════════════════════════════
// 内嵌图片抽取（自造 PDF：不引入二进制 fixture，形状全靠 lopdf 写出来）
// ═════════════════════════════════════════════════════════════════════════

// 造 PDF 的样板在 `test_pdf`（与本模块同源，见其模块头）
use crate::doc_parse::test_pdf::{gray_stream, pdf};
// ⚠️ 必须 `use` 进来：`dictionary!` 的「尾逗号」分支内部调的是**未限定**的 `dictionary!`，
// 在调用点无此名字时报 `cannot find macro`
use lopdf::dictionary;
// ⚠️ Object 原先靠 pdf 顶层的 use lopdf::{…} 生效；拆分后要在这里显式引
use lopdf::Object;

/// 按内容流里的 `Do` 顺序取图（不是字典顺序），并能渲染成像素
#[test]
fn extracts_the_embedded_images_in_draw_order() {
    let a = gray_stream(100, 80, vec![0; 8000]);
    let b = gray_stream(90, 70, vec![255; 6300]);
    let bytes = pdf(&[vec!["Im1", "Im0"]], &[("Im0", a), ("Im1", b)]);

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    assert_eq!(scan.total, 2);
    assert!(scan.skipped.is_empty(), "{:#?}", scan.skipped);
    assert_eq!(
        scan.images.iter().map(|i| i.width).collect::<Vec<_>>(),
        vec![90, 100],
        "要按 `Do` 的先后，不是字典顺序"
    );
    let rendered = scan.images[0].to_image().unwrap();
    assert_eq!((rendered.width(), rendered.height()), (90, 70));
    assert_eq!(&scan.images[0].pages, &[1]);
}

/// 图标 / 分隔线那类小图不读（省 OCR 时间，也少一堆噪声）
#[test]
fn skips_images_below_the_minimum_side() {
    let small = gray_stream(32, 300, vec![0; 32 * 300]);
    let big = gray_stream(300, 32, vec![0; 300 * 32]);
    let bytes = pdf(&[vec!["Im0", "Im1"]], &[("Im0", small), ("Im1", big)]);

    let scan = extract_images(
        &bytes,
        &ImageScanOptions {
            min_side: 64,
            max_images: 0,
        },
    )
    .unwrap();
    assert!(scan.images.is_empty());
    assert_eq!(scan.total, 2, "跳过的也要计入总数（否则「还有几张没读」就说不清）");
    assert_eq!(scan.skipped.len(), 2);
    assert_eq!(scan.skipped[0].reason, "too small to read");
    assert_eq!(scan.skipped[0].page, 1);
}

/// 同一个图片对象在每页都画（水印 / 页眉）：只拉出来一次，但页号要全记下
#[test]
fn reuses_one_object_across_pages_without_reading_it_twice() {
    let image = gray_stream(100, 100, vec![7; 10000]);
    let bytes = pdf(
        &[vec!["Im0"], vec!["Im0"], vec!["Im0"]],
        &[("Im0", image)],
    );

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    assert_eq!(scan.total, 1, "同一对象的多次引用只算一张");
    assert_eq!(scan.images.len(), 1);
    assert_eq!(scan.images[0].pages, vec![1, 2, 3]);
}

/// 超过张数上限：停手，但如实报「还有图没读」
#[test]
fn stops_at_the_image_limit_and_says_so() {
    let bytes = pdf(
        &[vec!["Im0", "Im1", "Im2"]],
        &[
            ("Im0", gray_stream(100, 100, vec![0; 10000])),
            ("Im1", gray_stream(100, 100, vec![0; 10000])),
            ("Im2", gray_stream(100, 100, vec![0; 10000])),
        ],
    );

    let scan = extract_images(
        &bytes,
        &ImageScanOptions {
            min_side: 1,
            max_images: 2,
        },
    )
    .unwrap();
    assert_eq!(scan.images.len(), 2);
    assert_eq!(scan.total, 3);
    assert_eq!(scan.skipped.len(), 1);
    assert_eq!(scan.skipped[0].reason, OVER_LIMIT_REASON, "原因只有一份（ocr 靠它判截断）");
    // 文案本身也是契约：它会随跳过数进提示行，别顺手改
    assert_eq!(OVER_LIMIT_REASON, "over the image limit");
}

/// DCTDecode（JPEG，扫描件最常见）：字节原样取出，交给 `image` 解码
#[test]
fn jpeg_images_are_passed_through_to_the_image_decoder() {
    use image::ImageEncoder as _;

    let rgb = image::RgbImage::from_fn(80, 60, |x, y| {
        image::Rgb([(x % 255) as u8, (y % 255) as u8, 128])
    });
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
        .write_image(rgb.as_raw(), 80, 60, image::ExtendedColorType::Rgb8)
        .unwrap();
    let stream = lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 80,
            "Height" => 60,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        },
        jpeg,
    );
    let bytes = pdf(&[vec!["Im0"]], &[("Im0", stream)]);

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    assert!(matches!(scan.images[0].pixels, PdfPixels::Jpeg(_)));
    let rendered = scan.images[0].to_image().unwrap();
    assert_eq!((rendered.width(), rendered.height()), (80, 60));
}

/// Flate + PNG 预测器：不还差分的话图是斜的
#[test]
fn flate_streams_with_a_png_predictor_are_undone() {
    use std::io::Write as _;

    // 两行 × 三列 8 位灰度，第二行与第一行相同 —— `Predictor 12`（逐行 Up）下差分为全 0
    let mut predicted = vec![10u8, 20, 30];
    predicted.extend_from_slice(&[0, 0, 0]);
    let mut encoder =
        flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&predicted).unwrap();
    let compressed = encoder.finish().unwrap();

    let stream = lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 3,
            "Height" => 2,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
            "Filter" => "FlateDecode",
            "DecodeParms" => dictionary! { "Predictor" => 12, "Columns" => 3 },
        },
        compressed,
    );
    let bytes = pdf(&[vec!["Im0"]], &[("Im0", stream)]);

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    let image = scan.images[0].to_image().unwrap().to_luma8();
    assert_eq!(image.get_pixel(0, 0).0[0], 10);
    assert_eq!(image.get_pixel(1, 0).0[0], 20);
    assert_eq!(image.get_pixel(2, 1).0[0], 30);
    assert_eq!(image.get_pixel(0, 1).0[0], 10, "第二行要还原成与第一行相同");
}

/// 1 位灰度（老扫描件的黑白页）：按位取高比特并拉满到 0 / 255
#[test]
fn one_bit_samples_are_expanded() {
    let stream = lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 8,
            "Height" => 2,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 1,
        },
        vec![0b1010_0000, 0b0000_0000],
    );
    let bytes = pdf(&[vec!["Im0"]], &[("Im0", stream)]);

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    let image = scan.images[0].to_image().unwrap().to_luma8();
    let row: Vec<u8> = (0..8).map(|x| image.get_pixel(x, 0).0[0]).collect();
    assert_eq!(row, vec![255, 0, 255, 0, 0, 0, 0, 0]);
}

/// 调色板（`/Indexed`）：采样当索引查表，不是当灰度
#[test]
fn indexed_color_spaces_use_the_palette() {
    let palette = vec![255u8, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    let stream = lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 2,
            "Height" => 2,
            "ColorSpace" => vec![
                lopdf::Object::Name(b"Indexed".to_vec()),
                lopdf::Object::Name(b"DeviceRGB".to_vec()),
                3.into(),
                lopdf::Object::String(palette, lopdf::StringFormat::Literal),
            ],
            "BitsPerComponent" => 8,
        },
        vec![0, 1, 2, 3],
    );
    let bytes = pdf(&[vec!["Im0"]], &[("Im0", stream)]);

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    let image = scan.images[0].to_image().unwrap().to_rgb8();
    assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0]);
    assert_eq!(image.get_pixel(1, 0).0, [0, 255, 0]);
    assert_eq!(image.get_pixel(0, 1).0, [0, 0, 255]);
    assert_eq!(image.get_pixel(1, 1).0, [255, 255, 255]);
}

/// 解不了的编码（JPEG 2000 / CCITT / JBIG2）：如实报，不猜
#[test]
fn unsupported_encodings_are_reported_not_guessed() {
    for (filter, expected) in [
        ("JPXDecode", "unsupported image encoding: JPXDecode"),
        ("CCITTFaxDecode", "unsupported image encoding: CCITTFaxDecode"),
    ] {
        let stream = lopdf::Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 100,
                "Height" => 100,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
                "Filter" => filter,
            },
            vec![0; 100],
        );
        let bytes = pdf(&[vec!["Im0"]], &[("Im0", stream)]);
        let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
        assert!(scan.images.is_empty(), "{filter} 不该被当成可读的图");
        assert_eq!(scan.total, 1);
        assert_eq!(scan.skipped[0].reason, expected);
    }
}

/// 图片包在 Form XObject 里（不少生成器这么做）：要顺着表单找下去，且用表单自己的资源
#[test]
fn images_inside_form_xobjects_are_found() {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.4");
    let pages_id = doc.new_object_id();
    let image_id = doc.add_object(gray_stream(120, 90, vec![3; 120 * 90]));
    let form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Nested" => image_id } },
        },
        b"q 1 0 0 1 0 0 cm /Nested Do Q".to_vec(),
    ));
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"/Fm0 Do".to_vec()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Fm0" => form_id } },
        "Contents" => content_id,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();

    let scan = extract_images(&bytes, &ImageScanOptions::default()).unwrap();
    assert_eq!(scan.images.len(), 1);
    assert_eq!((scan.images[0].width, scan.images[0].height), (120, 90));
    assert_eq!((scan.images[0].page, scan.images[0].object_id), (1, image_id.0));
}

// ═════════════════════════════════════════════════════════════════════════
// 文字层：按版面坐标重排（自造 PDF：坐标与绘制顺序都是我们写的，能精确断言）
// ═════════════════════════════════════════════════════════════════════════

use crate::doc_parse::test_pdf::PdfBuilder;

/// 造一份只有文字层的 PDF：`pages` 是每页的内容流原文（`/F1` 是 Helvetica）
fn text_pdf(pages: &[&str]) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let font = builder.add(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    for content in pages {
        builder.page(
            content,
            dictionary! { "Font" => dictionary! { "F1" => font } },
        );
    }
    builder.finish()
}

/// 造一份「Type0 + 具名 CMap」的 PDF（中文公文 / 行程单那种写法）：内容流画的是 UCS-2 码值
///
/// `encoding` 是字体的 `/Encoding`；`widths` 非空时原样写进 CIDFont 的 `/W`
fn named_cmap_pdf(encoding: &str, widths: Option<Vec<Object>>) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let descriptor = builder.add(dictionary! {
        "Type" => "FontDescriptor", "FontName" => "STSong-Light",
    });
    let mut cid = dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType0",
        "BaseFont" => "STSong-Light",
        "FontDescriptor" => descriptor,
        "DW" => 1000,
    };
    if let Some(widths) = widths {
        cid.set("W", Object::Array(widths));
    }
    let cid = builder.add(cid);
    let font = builder.add(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "STSong-Light-UniGB-UCS2-H",
        "Encoding" => encoding,
        "DescendantFonts" => vec![Object::Reference(cid)],
    });
    // 「行程」的 UCS-2 码值
    builder.page(
        "BT /F1 12 Tf 1 0 0 1 100 700 Tm <884C7A0B> Tj ET",
        dictionary! { "Font" => dictionary! { "F1" => font } },
    );
    builder.finish()
}

/// 版面顺序 ≠ 绘制顺序：右边那格先画、下面那行先画，读出来仍要是「左→右、上→下」
#[test]
fn text_is_assembled_in_visual_order_not_draw_order() {
    let bytes = text_pdf(&[
        "BT /F1 12 Tf 1 0 0 1 300 700 Tm (VALUE) Tj ET\n\
         BT /F1 12 Tf 1 0 0 1 100 700 Tm (LABEL:) Tj ET\n\
         BT /F1 12 Tf 1 0 0 1 100 690 Tm (SECOND) Tj ET",
    ]);
    let out = extract_text(&bytes).unwrap();
    assert!(out.laid_out, "正常 PDF 要走重排那条路");
    assert_eq!(out.text, "LABEL: VALUE\nSECOND");
}

/// 上游字宽不可信时两串会「在版面上重叠」：仍要各占一格、中间留一个空格，
/// **绝不许按字交错**（那正是行程单两列日期被搅成「15:24032:61-907-30」的原因）
#[test]
fn overlapping_runs_stay_intact() {
    let bytes = text_pdf(&[
        "BT /F1 12 Tf 1 0 0 1 100 700 Tm (AAAA) Tj ET\n\
         BT /F1 12 Tf 1 0 0 1 110 700 Tm (BBBB) Tj ET",
    ]);
    assert_eq!(extract_text(&bytes).unwrap().text, "AAAA BBBB");
}

/// 具名 CMap（`/Encoding /UniGB-UCS2-H`，码值就是 UCS-2）又没有 ToUnicode：
/// 上游库只认 `Identity-H`、碰到它就 panic，靠 [`patch_named_cmap`] 把字体改写成
/// `Identity-H` + 恒等 ToUnicode 才读得出来
#[test]
fn named_cmap_fonts_are_decoded_through_an_injected_identity_map() {
    let out = extract_text(&named_cmap_pdf("UniGB-UCS2-H", None)).unwrap();
    assert!(out.laid_out, "改写之后应该走重排那条路");
    assert_eq!(out.text, "行程");
}

/// 认不出的具名 CMap（`GBK-EUC-H`，码值不是 Unicode）：**不猜**，
/// 但也不能让上游那句 panic 顺着调用栈炸掉导入 —— 结果是「这个文件读不了」的错误。
///
/// ⚠️ 这个用例会看到一条 stderr 里的 panic 打印（默认 hook），那是预期的
#[test]
fn an_unsupported_cmap_is_an_error_not_a_panic() {
    let error = extract_text(&named_cmap_pdf("GBK-EUC-H", None)).unwrap_err();
    assert!(error.contains("panicked"), "要如实说是取字库挡下的，实际：{error}");
}

/// 页与页之间空一行；同一页里行距明显变大也空一行（段落感）
#[test]
fn pages_and_paragraphs_are_separated_by_blank_lines() {
    let page1 = "BT /F1 12 Tf 1 0 0 1 100 700 Tm (FIRST) Tj ET\n\
                 BT /F1 12 Tf 1 0 0 1 100 688 Tm (NEXT-LINE) Tj ET\n\
                 BT /F1 12 Tf 1 0 0 1 100 600 Tm (PARAGRAPH) Tj ET";
    let page2 = "BT /F1 12 Tf 1 0 0 1 100 700 Tm (SECOND-PAGE) Tj ET";
    let out = extract_text(&text_pdf(&[page1, page2])).unwrap();
    assert_eq!(out.text, "FIRST\nNEXT-LINE\n\nPARAGRAPH\n\nSECOND-PAGE");
}

/// `/W` 的 `cfirst clast w` 形式（上游读错下标 → 全部落回 `DW`）要归一成 `c [w …]`
#[test]
fn widths_are_normalized_into_the_form_the_reader_understands() {
    let bytes = named_cmap_pdf(
        "UniGB-UCS2-H",
        Some(vec![3.into(), 5.into(), 500.into()]),
    );
    let mut doc = lopdf::Document::load_mem(&bytes).unwrap();
    patch_fonts(&mut doc);

    let widths = doc
        .objects
        .values()
        .filter_map(|o| o.as_dict().ok())
        .find_map(|dict| dict.get(b"W").ok().and_then(|w| w.as_array().ok()))
        .expect("CIDFont 的 /W 还在");
    assert_eq!(widths[0].as_i64().unwrap(), 3);
    assert_eq!(
        widths[1].as_array().unwrap().len(),
        3,
        "3 5 500 → 3 [500 500 500]"
    );
    assert_eq!(widths[1].as_array().unwrap()[0].as_i64().unwrap(), 500);
}

/// 区间大到不值得展开时原样留着（不能因为归一就把几十 KB 撑成几 MB）
#[test]
fn huge_width_ranges_are_left_alone() {
    let bytes = named_cmap_pdf(
        "UniGB-UCS2-H",
        Some(vec![1.into(), 100_000.into(), 1000.into()]),
    );
    let mut doc = lopdf::Document::load_mem(&bytes).unwrap();
    patch_fonts(&mut doc);

    let widths = doc
        .objects
        .values()
        .filter_map(|o| o.as_dict().ok())
        .find_map(|dict| dict.get(b"W").ok().and_then(|w| w.as_array().ok()))
        .expect("CIDFont 的 /W 还在");
    assert_eq!(widths.len(), 3, "原样三个元素");
    assert_eq!(widths[1].as_i64().unwrap(), 100_000);
}