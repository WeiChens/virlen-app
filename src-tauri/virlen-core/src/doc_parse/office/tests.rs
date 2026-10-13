//! `office` 的用例：合并单元格（就地插说明 / A1 记法 / 被覆盖格里的值）、格内换行压平、图片说明、
//! 工作表选择与整册 / 选表两条路的版式。
//!
//! 造 fixture 的样板在本文件里（最小 docx 靠 `zip` 手拼、`.xls` 没法造只能手工拼 `Sheet`）。
use super::*;
use super::cells::{flatten_breaks, flatten_shared_strings, flatten_sheet_breaks};
use super::images::{image_text, images_lead, xls_image_facts};
use super::merge::{
    collect_xls_merges, inject_table_notes, parse_a1_range, table_merge_note, MergeRegion,
    MERGE_LEAD, TABLE_MERGE_LEAD, TABLE_MERGE_LEAD_SHORT,
};
use super::notes::{Mentions, MAX_MENTIONS};
use super::render::{render_xls_sheet, resolve_sheet};
// `Cow` / IR 与表格类型原先靠 `office` 顶层的 `use` 生效；拆分后要在这里显式引
use std::borrow::Cow;

use office_oxide::ir::{DocumentIR, Element, InlineContent, Table};
use office_oxide::xls::{Sheet, XlsImage};
use office_oxide::xlsx::SharedStringTable;

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/office/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// `.doc`（Word 97 旧二进制，OLE/CFB 容器）—— `read_file` 读不出来的那一类
#[test]
fn legacy_doc_is_extracted() {
    let out = extract_text(&fixture("simple.doc"), None, "doc").unwrap();
    assert!(
        out.text.contains("This is a simple file created with Word 97"),
        "实际：{:?}",
        out.text.chars().take(120).collect::<String>()
    );
    assert!(out.sheets.is_empty(), "Word 文档没有工作表");
}

/// `.docx` → Markdown（结构信息保留）；`sheet` 参数在 Word 上要**说明**被忽略，而不是静默
#[test]
fn docx_becomes_markdown_and_reports_the_ignored_sheet_param() {
    let out = extract_text(&fixture("SampleDoc.docx"), Some("Sheet1"), "docx").unwrap();
    assert!(!out.text.trim().is_empty(), "docx 应有文本");
    assert!(out.sheet.is_none());
    let note = out.note.expect("Word 文档上 sheet 参数必须给出说明");
    assert!(note.contains("only applies to .xlsx/.xls"), "{note}");
}

/// `.xlsx` 整册：每张表的名字都要出现（模型要能自己选表）
#[test]
fn xlsx_lists_every_sheet_and_extracts_all_by_default() {
    let out = extract_text(&fixture("SampleSS.xlsx"), None, "xlsx").unwrap();
    assert!(out.sheets.len() >= 2, "样本是多表工作簿：{:?}", out.sheets);
    for name in &out.sheets {
        assert!(out.text.contains(name), "整册文本里应含表名 {name}");
    }
    assert!(out.text.contains("Test spreadsheet"), "实际：{}", out.text);
}

/// `.xlsx` 选表：只回那一张表的内容，且**不报错**
#[test]
fn xlsx_single_sheet_is_selected_by_name() {
    let out = extract_text(&fixture("SampleSS.xlsx"), Some("Sheet Number 2"), "xlsx").unwrap();
    assert_eq!(out.sheet.as_deref(), Some("Sheet Number 2"));
    assert!(out.text.starts_with("Sheet Number 2"), "实际：{}", out.text);
    assert!(
        !out.text.contains("Test spreadsheet"),
        "选了第二张表就不该带第一张表的内容：{}",
        out.text
    );
}

/// 表名不存在 → 报错里带全部可用表名（模型据此改参数重试）
#[test]
fn unknown_sheet_reports_the_available_ones() {
    let err = extract_text(&fixture("SampleSS.xlsx"), Some("Nope"), "xlsx").unwrap_err();
    assert_eq!(err.kind(), "sheet_not_found");
    let msg = err.message();
    assert!(msg.contains("Worksheet \"Nope\" not found"), "{msg}");
    assert!(msg.contains("First Sheet"), "应列出可用表名：{msg}");
}

/// `.xls`（旧二进制表格）整册与选表两条路
#[test]
fn legacy_xls_supports_whole_workbook_and_single_sheet() {
    let all = extract_text(&fixture("Simple.xls"), None, "xls").unwrap();
    assert_eq!(all.sheets, vec!["Sheet1", "Sheet2", "Sheet3"]);
    assert!(all.text.contains("replaceMe"), "实际：{}", all.text);

    let one = extract_text(&fixture("Simple.xls"), Some("sheet2"), "xls").unwrap();
    assert_eq!(one.sheet.as_deref(), Some("Sheet2"), "表名匹配忽略大小写");
    assert!(one.text.starts_with("Sheet2"), "实际：{}", one.text);
    assert!(!one.text.contains("replaceMe"), "选表后不该带别表内容");
}

/// 加密 / 损坏文件：报错，不返回半截内容
#[test]
fn corrupt_file_fails_with_a_backend_error() {
    let dir = std::env::temp_dir().join(format!("virlen_office_bad_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("broken.docx");
    std::fs::write(&file, b"definitely not a zip package").unwrap();
    let err = extract_text(file.to_str().unwrap(), None, "docx").unwrap_err();
    assert_eq!(err.kind(), "backend");
    assert!(
        err.message().starts_with("Failed to parse docx document"),
        "{}",
        err.message()
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn sheet_resolution_prefers_exact_match() {
    let sheets = vec!["Data".to_string(), "data".to_string()];
    assert_eq!(resolve_sheet(&sheets, "data").unwrap(), 1);
    assert_eq!(resolve_sheet(&sheets, " Data ").unwrap(), 0, "首尾空白要忽略");
    assert!(resolve_sheet(&sheets, "nope").is_err());
}

// ══════════════════════ 合并单元格 ══════════════════════

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("virlen_office_{tag}_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 造一份最小 docx（`word/document.xml` 的正文由调用方给）——
/// 表格里的 `gridSpan` / `vMerge` 没法用库的写入 API 造，只能直接拼 OOXML
fn write_docx(dir: &std::path::Path, document_xml: &str) -> String {
    use std::io::Write;
    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
    const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let path = dir.join("t.docx");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
    for (name, body) in [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("word/document.xml", document_xml),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    path.to_str().unwrap().to_string()
}

/// 3 列表，首行的「合计」横跨 2 列
const DOCX_MIDDLE_MERGE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tblGrid>
        <w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/>
      </w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
          <w:p><w:r><w:t>合计</w:t></w:r></w:p>
        </w:tc>
        <w:tc><w:p><w:r><w:t>备注</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>含税</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

/// 2 列表，首列的「华东」纵跨第 2~3 行
const DOCX_VERTICAL_MERGE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:p><w:r><w:t>地区</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc>
          <w:tcPr><w:vMerge w:val="restart"/></w:tcPr>
          <w:p><w:r><w:t>华东</w:t></w:r></w:p>
        </w:tc>
        <w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
        <w:tc><w:p><w:r><w:t>80</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

/// 表格的**行中间**有横向合并时，右边的单元格不能左移
/// （库自带的 `to_markdown()` 会输出 `| 合计 | 备注 |  |`，「备注」本该在第 3 列）
#[test]
fn rows_with_a_middle_merge_keep_their_columns() {
    let dir = tmp_dir("merge_mid");
    let path = write_docx(&dir, DOCX_MIDDLE_MERGE);
    let out = extract_text(&path, None, "docx").unwrap();

    assert!(
        out.text.contains("| 合计 |  | 备注 |"),
        "「备注」必须留在第 3 列：{}",
        out.text
    );
    // 说明**就地**落在这张表前面（不再堆到文件最前面 —— 模型看不到「table 1」这种坐标）
    assert_eq!(out.note, None, "文稿的合并说明不再进 note：{:?}", out.note);
    let lines: Vec<&str> = out.text.lines().collect();
    let marker = merge_marker(&lines);
    assert_eq!(
        lines[marker],
        "merged cells (only the region's top-left cell shows its value, the rest is empty): \
         r1c1-r1c2 spans 2 columns"
    );
    assert_eq!(lines[marker + 1], "", "说明与表格之间隔一个空行");
    assert_eq!(lines[marker + 2], "| 合计 |  | 备注 |", "说明要贴着它那张表");
    std::fs::remove_dir_all(&dir).ok();
}

/// 纵向合并（`vMerge`）：说明里要点出跨了几行，且被覆盖位不能把后面的列挤走
#[test]
fn vertical_merges_are_reported() {
    let dir = tmp_dir("merge_vertical");
    let path = write_docx(&dir, DOCX_VERTICAL_MERGE);
    let out = extract_text(&path, None, "docx").unwrap();

    assert!(
        out.text.contains("|  | 80 |"),
        "纵向合并的续格位置要留空：{}",
        out.text
    );
    let lines: Vec<&str> = out.text.lines().collect();
    let marker = merge_marker(&lines);
    assert!(
        lines[marker].ends_with(": r2c1-r3c1 spans 2 rows"),
        "{}",
        lines[marker]
    );
    assert_eq!(lines[marker + 2], "| 地区 | 销量 |", "说明要贴着它那张表");
    std::fs::remove_dir_all(&dir).ok();
}

/// 三张表，只有**中间**那张带横向合并：说明必须出现在那张表前面，
/// 而不是像以前那样全部堆到文件最前面（总说明只能写「table 2 r1c1-r1c2」，
/// 而正文里没有这个坐标，模型对不上号）
const DOCX_THREE_TABLES_ONE_MERGED: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第一张表</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>第二张表</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
          <w:p><w:r><w:t>合并表头</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>丙</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>丁</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>第三张表</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:p><w:r><w:t>戊</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>己</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

/// 找一个行号：说明应该是正文里**独占一行**的一句
fn merge_marker(lines: &[&str]) -> usize {
    lines
        .iter()
        .position(|line| line.starts_with("merged cells"))
        .expect("应该有一句合并说明")
}

#[test]
fn each_table_carries_its_own_merge_note() {
    let dir = tmp_dir("merge_per_table");
    let path = write_docx(&dir, DOCX_THREE_TABLES_ONE_MERGED);
    let out = extract_text(&path, None, "docx").unwrap();

    assert_eq!(out.note, None, "文稿的合并说明不再进 note：{:?}", out.note);
    let lines: Vec<&str> = out.text.lines().collect();
    assert_eq!(
        lines.iter().filter(|l| l.starts_with("merged cells")).count(),
        1,
        "只有中间那张表带合并：{:#?}",
        out.text
    );
    let marker = merge_marker(&lines);
    assert_eq!(lines[marker + 1], "", "说明与表之间隔一个空行");
    assert_eq!(
        lines[marker + 2],
        "| 合并表头 |  |",
        "说明要贴着它那张表：{}",
        out.text
    );
    // 前面那张表（以及后面的段落）都不该被这句说明带上
    let before = lines[..marker].join("\n");
    assert!(before.contains("| 甲 | 乙 |"), "{before}");
    assert!(!before.contains("merged cells"), "{before}");
    std::fs::remove_dir_all(&dir).ok();
}

/// 完整解释**只讲一次**：第一张带合并的表拿到括号那句，后面的表只留 `merged cells:`；
/// 没合并的表一张说明都不给（说明仍然各自贴在自己那张表前）
#[test]
fn the_explanation_is_given_only_once() {
    use office_oxide::ir::{Section, TableCell, TableRow};

    let table = |merged: bool| {
        let cells = if merged {
            vec![TableCell {
                col_span: 2,
                ..Default::default()
            }]
        } else {
            vec![TableCell::default()]
        };
        Table {
            rows: vec![TableRow {
                cells,
                ..Default::default()
            }],
            ..Default::default()
        }
    };
    let mut ir = DocumentIR {
        sections: vec![Section {
            elements: vec![
                Element::Table(table(true)),
                Element::Table(table(false)),
                Element::Table(table(true)),
            ],
            ..Default::default()
        }],
        ..Default::default()
    };
    inject_table_notes(&mut ir);

    let elements = &ir.sections[0].elements;
    let shape: Vec<&str> = elements
        .iter()
        .map(|element| match element {
            Element::Paragraph(_) => "note",
            Element::Table(_) => "table",
            _ => "other",
        })
        .collect();
    assert_eq!(
        shape,
        vec!["note", "table", "table", "note", "table"],
        "说明各自贴在自己那张表前，没合并的表不给说明"
    );

    let notes: Vec<String> = elements
        .iter()
        .filter_map(|element| match element {
            Element::Paragraph(paragraph) => {
                paragraph.content.iter().find_map(|inline| match inline {
                    InlineContent::Text(span) => Some(span.text.clone()),
                    _ => None,
                })
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        notes,
        vec![
            format!("{TABLE_MERGE_LEAD}: r1c1-r1c2 spans 2 columns"),
            format!("{TABLE_MERGE_LEAD_SHORT}: r1c1-r1c2 spans 2 columns"),
        ],
        "解释只在第一句里，第二句只留短开头且条目一字不少：{notes:?}"
    );
    assert_eq!(
        notes
            .iter()
            .filter(|note| note.starts_with(TABLE_MERGE_LEAD))
            .count(),
        1,
        "同一句解释不能讲两遍：{notes:?}"
    );
}

/// 上限是**每张表**各 [`MAX_MENTIONS`] 条（不再是全文件共 8 条）：
/// 说明贴在表上，就只讲这张表的事
#[test]
fn every_table_has_its_own_mention_cap() {
    use office_oxide::ir::{TableCell, TableRow};

    let spanned = |rows: usize| Table {
        rows: (0..rows)
            .map(|_| TableRow {
                cells: vec![TableCell {
                    col_span: 2,
                    ..Default::default()
                }],
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };

    let note = table_merge_note(&spanned(MAX_MENTIONS + 4), false).unwrap();
    assert!(note.starts_with(TABLE_MERGE_LEAD), "{note}");
    assert!(
        note.contains(&format!("r{MAX_MENTIONS}c1-r{MAX_MENTIONS}c2 spans 2 columns")),
        "{note}"
    );
    assert!(
        !note.contains(&format!("r{}c1", MAX_MENTIONS + 1)),
        "第 9 条只计数、不展开：{note}"
    );
    assert!(note.contains("and 4 more"), "{note}");

    // 另一张表各算各的：两张表合起来也不串
    let other = table_merge_note(&spanned(2), false).unwrap();
    assert!(other.contains("r1c1-r1c2") && other.contains("r2c1-r2c2"), "{other}");
    assert!(!other.contains("more"), "{other}");
    assert!(table_merge_note(&spanned(0), false).is_none(), "没有行就没有说明");

    // 完整解释已经在这个文件里讲过了 → 只留短开头
    assert_eq!(
        table_merge_note(&spanned(2), true).unwrap(),
        format!("{TABLE_MERGE_LEAD_SHORT}: r1c1-r1c2 spans 2 columns; r2c1-r2c2 spans 2 columns")
    );
}

/// 没有合并 → 一个字的说明都不加（这句话只该在真有时出现）
#[test]
fn documents_without_merges_carry_no_note() {
    let out = extract_text(&fixture("SampleDoc.docx"), None, "docx").unwrap();
    assert_eq!(out.note, None, "实际：{:?}", out.note);
    assert!(
        !out.text.contains("merged cells"),
        "没有合并就不该有说明：{}",
        out.text
    );
}

/// `.xlsx`：区域直接来自 `MERGEDCELLS`（A1 记法），被覆盖格里另存的值得说明
#[test]
fn xlsx_merges_use_a1_notation_and_report_covered_values() {
    let dir = tmp_dir("merge_xlsx");
    let path = dir.join("merged.xlsx");
    {
        let mut writer = office_oxide::xlsx::write::XlsxWriter::new();
        {
            let mut sheet = writer.add_sheet("销售");
            let grid = [
                ["季度合计", "", "", ""],
                ["地区", "销量", "金额", "备注"],
                ["华东", "120", "3400", "含税"],
                ["华南", "80", "2100", ""],
            ];
            for (row, cells) in grid.iter().enumerate() {
                for (col, value) in cells.iter().enumerate() {
                    if !value.is_empty() {
                        sheet.set_cell(
                            row,
                            col,
                            office_oxide::xlsx::write::CellData::String(value.to_string()),
                        );
                    }
                }
            }
            // 表头横跨 4 列；A3:A4 纵向合并（左上角是「华东」，被覆盖的 A4 里还留着「华南」）
            sheet.merge_cells(0, 0, 1, 4);
            sheet.merge_cells(2, 0, 2, 1);
        }
        writer.save(&path).unwrap();
    }

    let out = extract_text(path.to_str().unwrap(), None, "xlsx").unwrap();
    let note = out.note.expect("xlsx 的合并必须给出一句说明");
    assert!(note.contains("销售!A1:D1 spans 4 columns"), "{note}");
    assert!(note.contains("销售!A3:A4 spans 2 rows"), "{note}");
    assert!(
        note.contains("a covered cell also holds \"华南\""),
        "被覆盖的值不能静默丢掉：{note}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// `.xls`：`MERGEDCELLS` 的四元组 → 区域，被覆盖格里的值同样要说明
/// （旧二进制格式没法在测试里造，所以手工拼一张 `Sheet`：字段全是公开的）
#[test]
fn xls_merges_and_covered_values_are_reported() {
    use office_oxide::xls::CellValue as XlsValue;

    let sheet = Sheet {
        rows: vec![
            vec![XlsValue::String("季度合计".into())],
            vec![XlsValue::String("地区".into()), XlsValue::String("销量".into())],
            vec![XlsValue::String("华东".into()), XlsValue::Number(120.0)],
            vec![XlsValue::String("华南".into()), XlsValue::Number(80.0)],
        ],
        merged_cells: vec![(0, 0, 0, 1), (2, 3, 0, 0)],
        ..Default::default()
    };

    let mut merges = Mentions::default();
    collect_xls_merges(&sheet, "", &mut merges);
    let note = merges.note(MERGE_LEAD).expect("合并必须给出一句说明");
    assert!(note.contains("A1:B1 spans 2 columns"), "{note}");
    assert!(note.contains("A3:A4 spans 2 rows"), "{note}");
    assert!(note.contains("also holds \"华南\""), "{note}");
    assert_eq!(merges.total, 2);
}

/// 说明里最多列 [`MAX_MENTIONS`] 条，剩下的只计数
#[test]
fn mentions_are_capped_but_still_counted() {
    let mut merges = Mentions::default();
    for index in 0..(MAX_MENTIONS + 4) {
        merges.add(format!("region {index}"));
    }
    let note = merges.note(MERGE_LEAD).unwrap();
    assert!(note.contains(&format!("region {}", MAX_MENTIONS - 1)), "{note}");
    assert!(!note.contains(&format!("region {MAX_MENTIONS}")), "{note}");
    assert!(note.contains("and 4 more"), "{note}");
    assert_eq!(merges.total, MAX_MENTIONS + 4);
}

/// A1 记法的区域：没有冒号不是合并、首尾反着写要归一、越界引用挡掉
#[test]
fn a1_ranges_are_parsed_and_normalized() {
    assert!(parse_a1_range("A1").is_none(), "单格不是合并区");
    assert_eq!(parse_a1_range("A1:C1"), Some(MergeRegion::new(0, 0, 0, 2)));
    assert_eq!(parse_a1_range("C1:A1"), Some(MergeRegion::new(0, 0, 0, 2)), "反着写也要归一");
    assert!(parse_a1_range("A1:ZZZZZZ1").is_none(), "越界引用挡掉");
    assert!(!MergeRegion::new(2, 2, 5, 5).is_merge(), "单格不算合并");
    assert_eq!(MergeRegion::new(0, 1, 0, 3).a1(), "A1:D2");
    assert_eq!(MergeRegion::new(2, 3, 0, 0).rc(), "r3c1-r4c1");
}

// ══════════════════════ 格内换行 / 制表符 ══════════════════════

/// 造一份含格内换行 / 制表符的 `.xlsx`（写完就关：读者只认文件）
fn write_xlsx_with_breaks(path: &std::path::Path) {
    let mut writer = office_oxide::xlsx::write::XlsxWriter::new();
    {
        let mut sheet = writer.add_sheet("到资晾晒单");
        let grid = [
            ["指标", "2026年新签约\n项目投资到位率（%）", "动工项目\n数量\n（个）"],
            ["高新区", "64.7%", "22"],
            ["英德市", "甲\t乙", "27.1%"],
        ];
        for (row, cells) in grid.iter().enumerate() {
            for (col, value) in cells.iter().enumerate() {
                sheet.set_cell(
                    row,
                    col,
                    office_oxide::xlsx::write::CellData::String(value.to_string()),
                );
            }
        }
    }
    writer.save(path).unwrap();
}

/// 格内的换行（Excel 的 Alt+Enter、列窄时折行后**存进值里**的换行）不能把一行拆成多行：
/// 工作表的正文版式是「一行 = 一条记录、制表符分列」，一个换行就把这一行剩下的列全顶下去
#[test]
fn xlsx_cells_with_line_breaks_stay_on_their_row() {
    let dir = tmp_dir("xlsx_breaks");
    let path = dir.join("breaks.xlsx");
    write_xlsx_with_breaks(&path);

    let out = extract_text(path.to_str().unwrap(), None, "xlsx").unwrap();
    let lines: Vec<&str> = out.text.lines().collect();
    assert_eq!(lines.len(), 4, "表名 + 3 行数据，一行都不该多：{lines:#?}");
    assert_eq!(lines[0], "到资晾晒单");
    assert_eq!(
        lines[1],
        "指标\t2026年新签约 项目投资到位率（%）\t动工项目 数量 （个）"
    );
    assert_eq!(lines[1].matches('\t').count(), 2, "3 列就是 2 个制表符");
    assert_eq!(lines[2], "高新区\t64.7%\t22");
    assert_eq!(lines[3], "英德市\t甲 乙\t27.1%", "格内制表符会凭空多出一列");

    // 选单表那条路（`sheet_plain_text`）同样不能拆行
    let one = extract_text(path.to_str().unwrap(), Some("到资晾晒单"), "xlsx").unwrap();
    assert_eq!(one.sheet.as_deref(), Some("到资晾晒单"));
    assert!(one.text.contains("动工项目 数量 （个）"), "实际：{}", one.text);
    assert_eq!(one.text.lines().count(), 4, "实际：{}", one.text);
    std::fs::remove_dir_all(&dir).ok();
}

/// 扩展名与容器不符的表格（`.xls` 里装的其实是 `.xlsx`）走的是「库判真格式 + 再开一份」
/// 那条兜底路 —— 也得压平
#[test]
fn mislabeled_spreadsheet_is_still_flattened() {
    let dir = tmp_dir("xlsx_mislabeled");
    let path = dir.join("报表.xls");
    write_xlsx_with_breaks(&path);

    let out = extract_text(path.to_str().unwrap(), None, "xls").unwrap();
    assert_eq!(out.text.lines().count(), 4, "实际：{}", out.text);
    assert!(out.text.contains("动工项目 数量 （个）"), "实际：{}", out.text);
    std::fs::remove_dir_all(&dir).ok();
}

/// 压平规则：换行 / 回车 / 制表符 → 一个空格；连续空行合成一个；折行留下的缩进不算内容
#[test]
fn in_cell_breaks_flatten_to_spaces() {
    assert!(matches!(flatten_breaks("动工项目"), Cow::Borrowed(_)), "没得改就别分配");
    assert_eq!(flatten_breaks("动工项目\n数量\n（个）"), "动工项目 数量 （个）");
    assert_eq!(flatten_breaks("Total\r\nRevenue"), "Total Revenue");
    assert_eq!(flatten_breaks("Total\rRevenue"), "Total Revenue");
    assert_eq!(flatten_breaks("甲\n\n乙"), "甲 乙");
    assert_eq!(flatten_breaks("  甲 \n 乙  "), "甲 乙");
    assert_eq!(flatten_breaks("甲\t乙"), "甲 乙");
    assert_eq!(flatten_breaks("\n \n"), "");
}

/// Excel 自己写的字符串都在共享字符串表里（单元格只存索引）—— 那张表也要压平
#[test]
fn shared_strings_are_flattened_too() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t xml:space="preserve">动工项目
数量</t></si>
  <si><t>没有换行</t></si>
</sst>"#;
    let mut table = SharedStringTable::parse(xml.as_bytes()).unwrap();
    flatten_shared_strings(&mut table);
    assert_eq!(table.get(0), Some("动工项目 数量"));
    assert_eq!(table.get(1), Some("没有换行"));
}

/// `.xls`：字符串直接存在单元格里（数字格式那些不可能带换行）—— 同一套压平
/// （旧二进制格式没法在测试里造，只能手工拼一张 [`Sheet`]）
#[test]
fn xls_cells_with_line_breaks_are_flattened() {
    use office_oxide::xls::CellValue as XlsValue;

    let mut sheet = Sheet {
        rows: vec![
            vec![
                XlsValue::String("动工项目\n数量（个）".into()),
                XlsValue::Number(22.0),
            ],
            vec![XlsValue::String("甲\t乙".into()), XlsValue::Empty],
        ],
        ..Default::default()
    };
    flatten_sheet_breaks(&mut sheet);

    assert_eq!(sheet.rows[0][0], XlsValue::String("动工项目 数量（个）".into()));
    assert_eq!(sheet.rows[0][1], XlsValue::Number(22.0), "数字不动");
    assert_eq!(sheet.rows[1][0], XlsValue::String("甲 乙".into()));
    // 渲染出来仍是一行一条记录（`.xls` 选单表那条路走的就是这个渲染器）
    assert_eq!(
        render_xls_sheet(&sheet).lines().collect::<Vec<_>>(),
        vec!["动工项目 数量（个）\t22", "甲 乙"]
    );
}

// ══════════════════════ 图片 ══════════════════════

/// 造一份含图片的 `.xlsx`：一张表两张图（一张带 alt、一张不带），另一张表无图
fn write_xlsx_with_images(path: &std::path::Path) {
    use office_oxide::xlsx::write::{CellData, XlsxWriter};

    // 图的内容无所谓（读者只把包的字节搬出来）—— 但字节数会进说明，给个可断言的长度
    let mut logo = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
    logo.resize(2048, 0);

    let mut writer = XlsxWriter::new();
    {
        let mut sheet = writer.add_sheet("销售");
        sheet.set_cell(0, 0, CellData::String("2026 到资晾晒单".to_string()));
        // 顺手放一个合并：图片说明与合并说明要能同在一句里
        sheet.merge_cells(0, 0, 1, 2);
        sheet.add_image_with_alt(
            logo,
            "png",
            0,
            0,
            480 * 9525,
            320 * 9525,
            Some("公司 logo".to_string()),
        );
        sheet.add_image(vec![0xFF, 0xD8, 0xFF, 0xE0], "jpeg", 0, 457_200, 96 * 9525, 96 * 9525);
    }
    {
        let mut sheet = writer.add_sheet("数据");
        sheet.set_cell(0, 0, CellData::String("无图".to_string()));
    }
    writer.save(path).unwrap();
}

/// 图片：只报「这里有图」—— 哪张表、第几张、格式、显示尺寸、字节数、alt 文本；
/// 图的内容一个字都不进正文（更不能让模型以为「这里本来就没东西」）
#[test]
fn xlsx_images_are_reported_without_reading_them() {
    let dir = tmp_dir("xlsx_images");
    let path = dir.join("images.xlsx");
    write_xlsx_with_images(&path);

    let out = extract_text(path.to_str().unwrap(), None, "xlsx").unwrap();
    let note = out.note.expect("有图片就必须给出一句说明");
    assert!(note.contains("the workbook holds 2 images"), "{note}");
    assert!(
        note.contains("销售!image 1 (png, 480x320 px, 2.0 KB, alt \"公司 logo\")"),
        "{note}"
    );
    assert!(note.contains("销售!image 2 (jpeg, 96x96 px, 4 B)"), "{note}");
    assert!(!note.contains("数据!image"), "没有图的表不该被点名：{note}");
    // 与合并说明同在一句里（` · ` 相连）
    assert!(note.contains("merged cells show"), "{note}");
    assert!(note.contains("销售!A1:B1 spans 2 columns"), "{note}");
    assert!(note.contains(" · "), "两句说明用 ` · ` 相连：{note}");
    // 正文照旧，图片的字节不进去
    assert!(out.text.contains("2026 到资晾晒单"), "实际：{}", out.text);
    assert!(!out.text.contains("PNG"), "图片的内容不解析：{}", out.text);

    // 选单表：正文标题已给表名，图片不必再冠 `表名!`；开头句换成 this sheet
    let one = extract_text(path.to_str().unwrap(), Some("销售"), "xlsx").unwrap();
    let note = one.note.expect("选单表也要报图片");
    assert!(note.contains("this sheet holds 2 images"), "{note}");
    assert!(
        note.contains("image 1 (png, 480x320 px, 2.0 KB, alt \"公司 logo\")"),
        "{note}"
    );
    assert!(!note.contains("销售!image"), "单表模式不必冠表名：{note}");

    // 选中的表没有图 → 一句说明都不加
    let none = extract_text(path.to_str().unwrap(), Some("数据"), "xlsx").unwrap();
    assert_eq!(none.note, None, "实际：{:?}", none.note);
    std::fs::remove_dir_all(&dir).ok();
}

/// `.xls` 的图片是**工作簿级**的（`MsoDrawingGroup` 全簿共用，归属哪张表读不出来）——
/// 说明里如实写 sheet unknown（旧二进制格式没法在测试里造，只能手工拼一条 [`XlsImage`]）
#[test]
fn xls_images_are_reported_without_sheet_attribution() {
    use office_oxide::xls::ImageFormat;

    let pic = XlsImage {
        format: ImageFormat::Png,
        data: vec![0; 2048],
        index: 0,
    };
    let mut images = Mentions::default();
    images.add(image_text("", 1, &xls_image_facts(&pic)));
    let note = images
        .note(&images_lead("the workbook (sheet unknown)", images.total))
        .unwrap();

    assert!(note.contains("image contents are not extracted"), "{note}");
    assert!(note.contains("sheet unknown"), "{note}");
    assert!(note.contains("image 1 (png, 2.0 KB)"), "{note}");
    assert!(images_lead("the workbook", 1).contains("holds 1 image"));
    assert!(images_lead("the workbook", 2).contains("holds 2 images"));
}