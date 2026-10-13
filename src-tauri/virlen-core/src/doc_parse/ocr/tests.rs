//! `ocr` 的用例：标记行 / 提示行措辞、模型不在、页面没有图、抽图失败，以及两个 `#[ignore]`
//! 的真模型端到端（跑法见文件末尾注释）。

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