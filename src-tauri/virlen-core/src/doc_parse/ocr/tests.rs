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

/// 一张图的事实（标记 / 摘要共用）
fn section_of(index: usize, place: &str) -> OcrSection {
    OcrSection {
        index,
        place: place.to_string(),
        width: 1240,
        height: 1754,
        object_id: Some(27),
        chars: 5,
        text: "hello".to_string(),
    }
}

/// 一张真 PNG（`Reading` 要先看头部拿尺寸、再解码）
fn png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(width, height, image::Rgb([255, 0, 0]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

/// 一张待读的图（Office 一侧的输入）
fn picture(number: usize, bytes: Vec<u8>) -> ExtractedImage {
    ExtractedImage {
        number,
        place: "body".to_string(),
        bytes,
    }
}

/// 标记行：位置写在 `place` 里（PDF = `page 3` / `pages 3, 4`；讲述不出来时整段省掉）
#[test]
fn section_marker_names_the_place_when_there_is_one() {
    let mut section = section_of(2, "page 3");
    assert_eq!(
        section_marker(&section),
        "[OCR] Image 2 · page 3 · 1240×1754"
    );
    section.place = "pages 3, 4".to_string();
    assert_eq!(
        section_marker(&section),
        "[OCR] Image 2 · pages 3, 4 · 1240×1754"
    );
    // `.xls` 讲不出图挂在哪张表：整段省掉，不留 `·  ·` 那样的空档
    section.place = String::new();
    assert_eq!(section_marker(&section), "[OCR] Image 2 · 1240×1754");
}

/// 页号标签：单页 `page 3`，多页 `pages 3, 4`
#[test]
fn page_label_covers_single_and_multiple_pages() {
    assert_eq!(page_label(&[3]), "page 3");
    assert_eq!(page_label(&[3, 4]), "pages 3, 4");
    assert_eq!(page_label(&[]), "page 1", "页号缺省时按第 1 页算");
}

/// 报错点名：`image 3 (page 2)`；位置讲不出来时 `image 3 (location unknown)`
#[test]
fn error_label_names_the_image_and_its_place() {
    assert_eq!(error_label(3, "page 2"), "image 3 (page 2)");
    assert_eq!(error_label(3, "  "), "image 3 (location unknown)");
}

/// 提示行：有文字层是「追加」，没有是「兜底」；跳过 / 空图 / 失败都要点名
#[test]
fn summary_note_explains_what_happened() {
    assert_eq!(
        summary_note(&summary(2, 0, 0), TextLayer::Present).unwrap(),
        "2 embedded image(s) were additionally read with on-device OCR (marked OCR)."
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
        no_text_detail(&missing, "the PDF"),
        "on-device OCR is unavailable: quasivision models directory not found"
    );

    let multi_line = "quasivision models directory not found.\nSearched:\n  - \"C:/x\"\n";
    assert_eq!(one_line(multi_line), "quasivision models directory not found");
}

/// 抽不到文字时的细节：按「没有图 / 全是空图 / 全被跳过」分别给话
#[test]
fn no_text_detail_covers_each_reason() {
    assert_eq!(
        no_text_detail(&OcrSummary::default(), "the PDF"),
        "the PDF contains no embedded images"
    );
    assert_eq!(
        no_text_detail(&summary(0, 0, 2), "the PDF"),
        "the PDF contains no embedded images",
        "一张图都没有时，真相是「没图可读」，不用绕到「认不出字」上"
    );
    // Office 一侧走同一个结论，但点名的对象得对
    assert_eq!(
        no_text_detail(&OcrSummary::default(), "the document"),
        "the document contains no embedded images"
    );
    let all_empty = OcrSummary {
        available: true,
        total: 2,
        empty: 2,
        ..Default::default()
    };
    assert_eq!(
        no_text_detail(&all_empty, "the PDF"),
        "on-device OCR found no text in 2 embedded image(s)"
    );
    let all_skipped = OcrSummary {
        available: true,
        total: 3,
        skipped: 3,
        ..Default::default()
    };
    assert_eq!(
        no_text_detail(&all_skipped, "the PDF"),
        "all 3 embedded image(s) were skipped (too small, too wide or too tall, over the limit, or an unsupported encoding)"
    );

    // 模型不在但页面里根本没有图：真相是「没图可读」，不是「缺模型」
    let no_images = OcrSummary {
        available: false,
        unavailable: Some(OcrUnavailable::Models),
        unavailable_reason: Some("quasivision models directory not found".to_string()),
        ..Default::default()
    };
    assert_eq!(
        no_text_detail(&no_images, "the PDF"),
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
        no_text_detail(&broken, "the PDF"),
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
        no_text_detail(&outcome.summary, "the PDF"),
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
        no_text_detail(&outcome.summary, "the PDF")
            .starts_with("the embedded images could not be read"),
        "{}",
        no_text_detail(&outcome.summary, "the PDF")
    );
}

// ═══════════════════════════════════════════════════════
// Office 一侧：逐张喂（`Reading`）与收一批（`run_images_ocr`）
// ═══════════════════════════════════════════════════════

/// 模型不在：图数照数，一个字都不冒充读（与 PDF 那条路同一套结论）
#[test]
fn reading_without_models_only_counts_the_images() {
    let opts = OcrOptions {
        models_dir: Err(
            "quasivision models directory not found.\nSearched:\n  - \"C:/x\"".to_string(),
        ),
        always: true,
        cancel: None,
    };
    let mut reading = Reading::new(&opts);
    assert!(reading.read(picture(1, png(120, 90))).is_none());
    let summary = reading.finish();
    assert!(!summary.available);
    assert_eq!(summary.unavailable, Some(OcrUnavailable::Models));
    assert_eq!(summary.total, 1, "图还是数出来了");
    assert!(summary.sections.is_empty(), "模型不在就不能有 section");
    assert_eq!(
        summary_note(&summary, TextLayer::Present).unwrap(),
        "On-device OCR is unavailable (quasivision models directory not found)."
    );
}

/// 太小 / 解不开 / 模型不在：三种结果各记各的，不互相冒充
///
/// ⚠️ 全部用 `models_dir: Err`：真去加载模型在没装模型的机器上要等几十秒，而这种用例要锁的是
/// **记账逻辑**（谁跳过、谁失败），不是推理质量。
#[test]
fn reading_filters_skips_and_counts() {
    let opts = OcrOptions {
        models_dir: Err("quasivision models directory not found".to_string()),
        always: true,
        cancel: None,
    };
    let mut reading = Reading::new(&opts);
    assert!(
        reading.read(picture(1, png(4, 4))).is_none(),
        "4×4 太小，不读"
    );
    assert!(
        reading.read(picture(2, b"not an image".to_vec())).is_none(),
        "不是图 → 解不开"
    );
    assert!(
        reading.read(picture(3, png(120, 90))).is_none(),
        "模型不在 → 读不出"
    );
    let summary = reading.finish();
    assert_eq!(summary.total, 3, "三张都见到了");
    assert_eq!(summary.skipped, 1, "太小那张只算跳过：{:?}", summary);
    assert_eq!(summary.images, 0);
    assert_eq!(summary.errors.len(), 1, "{:?}", summary.errors);
    assert!(
        summary.errors[0].contains("image 2 (body)"),
        "报错要点名哪张图、在哪：{:?}",
        summary.errors
    );
    assert!(!summary.available);
}

/// 上限就是 [`MAX_IMAGES`] 张：第 11 张起只计数，并把 `truncated` 立起来（note 里会说「还有图没读」）
///
/// ⚠️ 上限的判定与「模型在不在」**无关**：模型缺失时也得如实报「还有 N 张没读」。
#[test]
fn reading_stops_at_the_image_limit() {
    let opts = OcrOptions {
        models_dir: Err("quasivision models directory not found".to_string()),
        always: true,
        cancel: None,
    };
    let mut reading = Reading::new(&opts);
    for number in 1..=MAX_IMAGES + 2 {
        reading.read(picture(number, png(120, 90)));
    }
    let summary = reading.finish();
    assert_eq!(MAX_IMAGES, 10, "2026-10 用户定的：一份文档最多 10 张");
    assert_eq!(summary.total, MAX_IMAGES + 2, "见到的图数不藏");
    assert_eq!(summary.skipped, 2, "超上限的两张只计数");
    assert!(summary.truncated, "还有图没读要如实说");
    // 模型不在时那句「还有 N 张没读」的措辞从「停在哪」换成「跳过了几张、为什么」
    // （两种读法都得出现上限这个数）
    let note = summary_note(&summary, TextLayer::Present).unwrap();
    assert!(
        note.contains("2 image(s) were skipped (too small, too wide or too tall, over the 10 image limit"),
        "{note}"
    );
}

/// 取消：一张都不读，并如实把 `truncated` 立起来（不静默停）
#[test]
fn reading_stops_when_cancelled() {
    let cancel = crate::agent::cancellation::CancellationToken::new();
    cancel.cancel();
    let opts = OcrOptions {
        models_dir: Err("not needed".to_string()),
        always: true,
        cancel: Some(cancel),
    };
    let mut reading = Reading::new(&opts);
    assert!(reading.read(picture(1, png(120, 90))).is_none());
    let summary = reading.finish();
    assert!(summary.errors.is_empty(), "取消了就不该再往下走");
    assert_eq!(summary.skipped, 0, "取消不是「图太小」");
    assert!(summary.truncated);
    assert_eq!(summary.total, 1);
}

/// 形状太扁 / 太瘦的图不读（`553×81` 那种界面截条）—— 只看形状，不看内容；
/// 边界是**超过**才跳（正好 3:1 仍读）。
///
/// ⚠️ 用 `models_dir: Err`：要锁的是**筛选**，不是推理质量（真加载模型在没装模型的机器上要等几十秒）。
#[test]
fn flat_and_skinny_images_are_skipped_by_shape() {
    assert_eq!(MAX_ASPECT_RATIO, 3.0, "2026-10 用户定的：长边 > 短边 × 3 就不主动读");
    let opts = OcrOptions {
        models_dir: Err("quasivision models directory not found".to_string()),
        always: true,
        cancel: None,
    };
    let mut reading = Reading::new(&opts);
    assert!(
        reading.read(picture(1, png(553, 81))).is_none(),
        "扁平横幅（6.8:1）不读"
    );
    assert!(
        reading.read(picture(2, png(81, 553))).is_none(),
        "瘦长条（1:6.8）同样不读（两个方向都算）"
    );
    assert!(
        reading.read(picture(3, png(300, 100))).is_none(),
        "正好 3:1 在界内 → 不是被形状筛掉的（读不出来是模型不在）"
    );
    let summary = reading.finish();
    assert_eq!(summary.total, 3, "见到的图数不藏");
    assert_eq!(
        summary.skipped, 2,
        "只有两张扁的被形状筛掉：{:?}",
        summary
    );
    assert!(summary.errors.is_empty(), "形状跳过不是错误：{:?}", summary.errors);
}

/// 形状筛选排在张数上限**之后**：上限已到时的图必须记成「超上限」（`truncated` 靠它），
/// 否则「还有图没读」会在剩下的图都是扁条时静默消失
#[test]
fn the_image_limit_is_checked_before_the_shape() {
    let opts = OcrOptions {
        models_dir: Err("quasivision models directory not found".to_string()),
        always: true,
        cancel: None,
    };
    let mut reading = Reading::new(&opts);
    for number in 1..=MAX_IMAGES {
        reading.read(picture(number, png(120, 90)));
    }
    // 上限之后的图故意都是扁条：也必须算「超上限」
    reading.read(picture(MAX_IMAGES + 1, png(600, 80)));
    reading.read(picture(MAX_IMAGES + 2, png(600, 80)));
    let summary = reading.finish();
    assert_eq!(summary.skipped, 2);
    assert!(
        summary.truncated,
        "超上限这件事不能被形状筛选吃掉：{:?}",
        summary
    );
}

/// 收一批：正文块与摘要同一份事实（模型不在 → 一个字也不能冒充）
#[test]
fn run_images_ocr_builds_the_block_and_the_summary() {
    let opts = OcrOptions {
        models_dir: Err("not needed".to_string()),
        always: true,
        cancel: None,
    };
    let outcome = run_images_ocr(vec![picture(1, png(120, 90))], &opts);
    assert!(outcome.text.is_empty(), "模型不在就不能有正文块");
    assert_eq!(outcome.summary.total, 1);
    assert!(!outcome.summary.available);
}