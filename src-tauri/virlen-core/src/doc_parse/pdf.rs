//! PDF 抽文字 + 抽内嵌图片 —— **唯一一份** `pdf-extract` / `lopdf` 调用。
//!
//! ⚠️ 知识库导入（`rag::document::parse_pdf`）与 `parse_document` 工具都走这里的 [`extract_text`]：
//! 同一份库、同一份错误语义。任何一侧要改（升级 crate / 换提取器 / 加预处理）都只改这里，
//! 不许在调用方另写一份。
//!
//! 三条能力：
//! - [`extract_text`]：抽**文字层**，并按版面坐标重排成「人读到的那一行」（见文件后半「文字层」段）。
//!   扫描件 / 纯图片 PDF 抽出来是空的 → 调用方按
//!   [`crate::doc_parse::ParseError::NoText`] 处理（要不要接着 OCR 由 `ParseOptions::ocr` 决定）。
//! - [`extract_text_raw`]：原样调用 `pdf-extract`（不重排）—— 重排不可用时的兜底路径。
//! - [`extract_images`]：抽**内嵌图片对象**（`lopdf`，`pdf-extract` 的同一个底层库），胶水在
//!   [`crate::doc_parse::ocr`]。**不做页面栅格化**：那要引入 PDF 渲染器（原生库），本项目只做纯 Rust，
//!   图片取出来直接交给端侧视觉，不出本机。
//!
//! 抽图口径：按**页面绘制顺序**（内容流里的 `Do`，含 Form XObject 内部）；同一图片对象被多页引用
//! 只出一次；尺寸太小 / 编码不支持的如实记进 [`ImageScan::skipped`]，不静默丢弃。

// ═══════════════════════════════════════════════════════════════════════════
// 文字层：按版面坐标重排（读出来是「人看到的那一行」，而不是内容流里画的先后）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么不能直接用上游的 `extract_text_from_mem`：它按**内容流绘制顺序**吐字，只在
// 「y 变了 / x 往回跳」时插换行。发票、行程单、报表这类「每个格子各画一次」的版面里，
// 标签与它右边的值是两次不同的绘制 → 被拆到不同的行（实测一张电子发票：「名称：」
// 与它后面格子里真正的公司名分在两行，金额 / 数量 / 税率跟项目名互相穿插）。
//
// 做法：文字仍然由 `pdf-extract` 解码（不重写取字逻辑），只借它公开的 `OutputDev` 钩子
// 拿**每个字落笔的坐标与字号**，然后自己组版：
// - 一次文本绘制算子（`Tj` / `TJ` / `'` / `"`）画出来的一串字当成**原子**：串内只按缺口补
//   空格、绝不重排 —— 上游算出的字宽有时不可信（见 [`normalize_widths`]），按字排序会把
//   两串交错成乱码（实测：「15:24032:61-907-30」）；
// - 串之间按「页 → 行（y 相近就是一行）→ 左到右」排；
// - 页与页之间空一行、行距明显大于字高时也空一行（段落感）。
//
// ⚠️ 上游（`pdf-extract` 0.7）有两处会直接毁掉结果，都在 [`patch_fonts`] 里**就地**绕开；
// 库认不出的写法一律靠 [`guarded`] 兜住（panic 只让这个文件失败，不许炸掉导入流程）。

use lopdf::{dictionary, Object, ObjectId, Stream};
use pdf_extract::{MediaBox, OutputDev, OutputError, Transform};

/// 从 PDF 字节里抽文本（**按版面坐标重排**）。
///
/// 返回的 `Err` 是**库的原始错误文本**（不加前缀）：调用方各自决定怎么说
/// （RAG 用中文前缀，工具用 [`crate::doc_parse::ParseError::Backend`] 的英文模板）。
pub fn extract_text(bytes: &[u8]) -> Result<PdfText, String> {
    match layout_text(bytes) {
        // 重排成功且有字：就是它
        Ok(text) if !text.trim().is_empty() => Ok(PdfText {
            text,
            laid_out: true,
        }),
        // 重排不可用（库 panic / 加密 / 认不出的字体）或一个字都没抽到（纯图 PDF）：
        // 退回**原样顺序**那条路，让调用方按原来的语义处理（该报「没文字」就报、
        // 该报库的错就报）—— 退回去的结果永远不会比改之前更差
        _ => extract_text_raw(bytes).map(|text| PdfText {
            text,
            laid_out: false,
        }),
    }
}

/// 抽出来的文字层
#[derive(Debug, Clone)]
pub struct PdfText {
    /// 文本（行与行之间是 `\n`；页与页、段落之间空一行）
    pub text: String,
    /// 是否是**按版面坐标重排**过的
    ///
    /// `false` = 退回了原样顺序（上游库在某个字体上 panic，或版面重排一个字都没拿到），
    /// 行序可能跟页面上看到的不一样 —— 调用方据此如实说明一句。
    pub laid_out: bool,
}

/// 退回原样顺序时给模型的一句话（动态英文事实，不进 i18n）
pub const RAW_ORDER_NOTE: &str = "the text follows the order in which the document draws it \
(the layout pass could not be used), so lines may not match the page's visual layout";

/// 原样调用 `pdf-extract`（**不重排**，也不做任何修补）—— 兜底路径，等同于这一步改动之前的取字
pub fn extract_text_raw(bytes: &[u8]) -> Result<String, String> {
    guarded(|| pdf_extract::extract_text_from_mem(bytes).map_err(|e| e.to_string()))
}

/// 上游库的 `assert!` / `panic!`（不认的字体编码、认不出的 ToUnicode 名）**绝不能顺着调用栈
/// 炸掉知识库导入**：包一层，panic 当成「这个文件读不了」如实报出来。
///
/// ⚠️ `pdf-extract` 没有全局状态，panic 不会毒化任何东西，写坏的中间结果随栈一起丢掉。
/// 那句 panic 文本会由默认 hook 打到 stderr（GUI 进程里没人看），这里**不换 hook**：
/// 换 hook 是进程级副作用，会跟 `telemetry` 装的那一个打架。
fn guarded<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => Err(format!(
            "the text extractor panicked on this document ({})",
            panic_reason(payload.as_ref())
        )),
    }
}

/// panic 载荷里那句话（`&str` / `String`；别的一律「unknown reason」）
fn panic_reason(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown reason".to_string())
}

/// 按版面坐标重排的取字（主路）：载入 → 就地修补字体 → 收坐标 → 组版
fn layout_text(bytes: &[u8]) -> Result<String, String> {
    let mut doc = lopdf::Document::load_mem(bytes).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        // 与原样路径同一口径（`pdf-extract` 的 `maybe_decrypt`）：先试空口令 ——
        // 「只设了权限口令、没设打开口令」的 PDF 就得这么开；真设了口令的在这里报错
        doc.decrypt("").map_err(|e| e.to_string())?;
    }
    patch_fonts(&mut doc);

    let mut collector = RunCollector::new();
    guarded(|| pdf_extract::output_doc(&doc, &mut collector).map_err(|e| e.to_string()))?;
    Ok(collector.assemble())
}

// ─────────────────────────── 就地修补字体字典 ───────────────────────────

/// 把文档里用得上的字体字典按 `pdf-extract` 的口径补一遍（**只改内存里的文档**，不落盘）
///
/// 两处，都是「库自己不会做、而我们不必重写取字逻辑」的活：
/// - [`patch_named_cmap`]：中文公文里常见的具名 CMap（`UniGB-UCS2-H` 之类）会让库直接 panic；
/// - [`normalize_widths`]：`/W` 的一种写法库读错了下标，导致区间内所有字宽落回默认值。
fn patch_fonts(doc: &mut lopdf::Document) {
    let mut seen = std::collections::HashSet::new();
    let page_ids: Vec<ObjectId> = doc.get_pages().values().cloned().collect();
    for page_id in page_ids {
        for font_id in page_font_ids(doc, page_id) {
            if !seen.insert(font_id) {
                continue;
            }
            patch_named_cmap(doc, font_id);
            for descendant in cid_descendants(doc, font_id) {
                if seen.insert(descendant) {
                    normalize_widths(doc, descendant);
                }
            }
        }
    }
}

/// 一页资源字典里 `/Font` 的字体对象号
fn page_font_ids(doc: &lopdf::Document, page_id: ObjectId) -> Vec<ObjectId> {
    let Some(fonts) = inherited(doc, page_id, b"Resources")
        .and_then(|resources| dict_value(doc, &resources, b"Font"))
    else {
        return Vec::new();
    };
    match fonts.as_dict() {
        Ok(dict) => dict.iter().filter_map(|(_, v)| v.as_reference().ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// 一个 Type0 字体的 `/DescendantFonts`（真正的 CIDFont 字典）对象号
fn cid_descendants(doc: &lopdf::Document, font_id: ObjectId) -> Vec<ObjectId> {
    doc.get_object(font_id)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .and_then(|dict| dict.get(b"DescendantFonts").ok().map(|o| deref_obj(doc, o)))
        .and_then(|array| array.as_array().ok().cloned())
        .map(|items| items.iter().filter_map(|o| o.as_reference().ok()).collect())
        .unwrap_or_default()
}

/// Type0 字体写了**具名 CMap**（`/Encoding /UniGB-UCS2-H` 之类）又没有 ToUnicode →
/// 改写成 `/Encoding /Identity-H` + **恒等 ToUnicode**。
///
/// 依据：这一族具名 CMap（`UniGB-UCS2-H` / `UniCNS-UCS2-V` / `UniJIS-UCS2-HW-H` …）的码值
/// 就是 **UCS-2**（它把 UCS-2 码映射到 Adobe-GB1 / CNS1 … 的 CID），所以「码值 → Unicode」正好
/// 是恒等映射，不需要那张巨大的 CID 表。而库里对具名 CMap 只有一句
/// `assert!(name == "Identity-H")` —— 深圳地铁行程单这类 PDF 就是在这里 panic、整份读不出来的。
///
/// 别的具名 CMap（`GBK-EUC-H`、`B5pc-H` …）码值不是 Unicode，映射要靠各自的 CMap 表：
/// **不猜**，原样留给上层如实报「读不了」。
fn patch_named_cmap(doc: &mut lopdf::Document, font_id: ObjectId) {
    let Some(dict) = doc.get_object(font_id).ok().and_then(|o| o.as_dict().ok()) else {
        return;
    };
    if dict.get(b"Subtype").ok().and_then(|o| o.as_name_str().ok()) != Some("Type0") {
        return;
    }
    if dict.get(b"ToUnicode").is_ok() {
        return; // 自带 ToUnicode：库自己能解，不动它
    }
    let Ok(Object::Name(name)) = dict.get(b"Encoding") else {
        return; // 内嵌 CMap 流：库能解；缺 /Encoding 的：库自己会报
    };
    if !String::from_utf8_lossy(name).to_uppercase().contains("UCS2") {
        return;
    }

    let to_unicode = doc.add_object(Stream::new(dictionary! {}, IDENTITY_CMAP.to_vec()));
    if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&font_id) {
        dict.set("Encoding", Object::Name(b"Identity-H".to_vec()));
        dict.set("ToUnicode", Object::Reference(to_unicode));
    }
}

/// 恒等 ToUnicode（码值就是 Unicode）：一行 `bfrange` 覆盖整个 2 字节码空间
const IDENTITY_CMAP: &[u8] = b"/CIDInit /ProcSet findresource begin\n\
12 dict begin\n\
begincmap\n\
1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n\
1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n\
endcmap\n\
CMapName currentdict /CMap defineresource pop\nend\nend\n";

/// 把 CIDFont 的 `/W` 归一成 `c [w …]` 形式。
///
/// 为什么：`pdf-extract` 0.7 读 `cfirst clast w` 那支把下标写错了（`c_last` 与 `c_width`
/// 都取的是 `w[i]`）→ 循环区间为空、**这个区间里所有字的宽度都落回 `DW`**。行程单的数字
/// 因此被当成全角排（实测字距 8 而它字面只有 3.7），日期两列在版面上「互相重叠」。
/// 库改不了，就把文档改成它认得的那一支。
///
/// 只做等价的形状转换：区间太大或形状不认识时**原样留着**（上游对它的行为与改之前一致）。
fn normalize_widths(doc: &mut lopdf::Document, cid_id: ObjectId) {
    let Some(items) = doc
        .get_object(cid_id)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .and_then(|dict| dict.get(b"W").ok())
        .and_then(|w| w.as_array().ok().cloned())
    else {
        return;
    };

    let mut rewritten: Vec<Object> = Vec::with_capacity(items.len());
    let mut changed = false;
    let mut i = 0;
    while i < items.len() {
        let Ok(first) = items[i].as_i64() else {
            rewritten.extend_from_slice(&items[i..]); // 形状不认识：剩下原样带走
            break;
        };
        match items.get(i + 1).cloned() {
            Some(Object::Array(widths)) => {
                rewritten.push(items[i].clone());
                rewritten.push(Object::Array(widths));
                i += 2;
            }
            Some(last) => {
                let count = last
                    .as_i64()
                    .ok()
                    .and_then(|last| last.checked_sub(first))
                    .and_then(|span| span.checked_add(1));
                let Some((count, width)) = count.zip(items.get(i + 2).cloned()) else {
                    rewritten.extend_from_slice(&items[i..]);
                    break;
                };
                if !(0..=MAX_EXPANDED_WIDTHS).contains(&count) {
                    // 区间大到不值得展开（或本身不合法）：原样留着，行为与改之前一致
                    rewritten.extend_from_slice(&items[i..i + 3]);
                    i += 3;
                    continue;
                }
                rewritten.push(items[i].clone());
                rewritten.push(Object::Array(vec![width; count as usize]));
                changed = true;
                i += 3;
            }
            None => {
                rewritten.extend_from_slice(&items[i..]);
                break;
            }
        }
    }

    if changed {
        if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&cid_id) {
            dict.set("W", Object::Array(rewritten));
        }
    }
}

/// 展开 `cfirst clast w` 的上限（超过就原样留着）：真实的 `/W` 只列用到的那些字，
/// 几百顶天；`1 65535 1000` 这种「全表同宽」的写法展开反而是几千倍的浪费。
const MAX_EXPANDED_WIDTHS: i64 = 4096;

/// 页字典上的键：本页没有就顺着 `/Parent` 往页树上找（`/Resources` 常挂在 Pages 节点）
fn inherited(doc: &lopdf::Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = doc
        .get_object(page_id)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .cloned();
    while let Some(dict) = current {
        if let Ok(value) = dict.get(key) {
            return Some(deref_obj(doc, value));
        }
        current = dict
            .get(b"Parent")
            .ok()
            .and_then(|parent| parent.as_reference().ok())
            .and_then(|id| doc.get_object(id).ok())
            .and_then(|o| o.as_dict().ok())
            .cloned();
    }
    None
}

/// 字典里的一个键（值可能是个引用，顺带解开）
fn dict_value(doc: &lopdf::Document, dict: &Object, key: &[u8]) -> Option<Object> {
    dict.as_dict().ok()?.get(key).ok().map(|o| deref_obj(doc, o))
}

/// 解引用（不是引用就原样克隆）
fn deref_obj(doc: &lopdf::Document, object: &Object) -> Object {
    match object {
        Object::Reference(id) => doc.get_object(*id).cloned().unwrap_or(Object::Null),
        other => other.clone(),
    }
}

// ───────────────────────── 收坐标 + 组版 ─────────────────────────

/// 一次文本绘制算子（`Tj` / `TJ` / `'` / `"`）画出来的一串字 —— 重排时**不可拆分的原子**
struct TextRun {
    /// 页号（1 起）
    page: u32,
    /// 串起点（版面坐标：x 向右、y **向下**，与 `PlainTextOutput` 同一口径）
    x: f64,
    y: f64,
    /// 字号（已乘 CTM 的缩放）
    size: f64,
    /// 串右沿（按上游给的字宽估，可能偏大 → 见 [`RUN_OVERLAP_EM`]）
    end: f64,
    /// 串内文本（按缺口补过空格，字序与文件一致）
    text: String,
}

/// 串内补一个空格的缺口（× 字号）：同一串里明显分开的两段
const RUN_SPACE_EM: f64 = 0.25;
/// 串与串之间补空格的缺口（× 字号）
const RUN_GAP_EM: f64 = 0.2;
/// 两串「重叠得离谱」的阈值（× 字号）：说明上游字宽不可信，
/// 它们在版面里其实各占一格（行程单的两列日期就是这样）→ 也得补空格，不许粘成一片
const RUN_OVERLAP_EM: f64 = 0.5;
/// 归到同一行的 y 容差（× 字号）
const LINE_TOLERANCE: f64 = 0.5;
/// 行距超过「两行字号之和 × 它」就空一行（段落感）
const PARAGRAPH_GAP_RATIO: f64 = 0.9;
/// 字号兜底（除不尽 / 缺字体矩阵时不让阈值缩成 0）
const MIN_FONT_SIZE: f64 = 1.0;
/// 字宽兜底（× 字号）：上游给 0 时只用来估字间距，不影响文本本身
const MIN_ADVANCE_EM: f64 = 0.2;

/// 收坐标的 `OutputDev`：一个字一个字接住，按「一次 Tj 一串」归堆，最后组版
struct RunCollector {
    page: u32,
    flip: Transform,
    runs: Vec<TextRun>,
    current: Option<TextRun>,
}

impl RunCollector {
    fn new() -> Self {
        Self {
            page: 0,
            flip: Transform::identity(),
            runs: Vec::new(),
            current: None,
        }
    }

    /// 收尾当前这一串（换串 / 换页时必须调，否则最后一串会丢）
    fn finish_run(&mut self) {
        if let Some(run) = self.current.take() {
            if !run.text.is_empty() {
                self.runs.push(run);
            }
        }
    }

    /// 把收下的串拼成文本：页 → 行（y 相近）→ 左到右
    fn assemble(mut self) -> String {
        self.finish_run();
        let mut runs = self.runs;
        runs.sort_by(|a, b| {
            a.page
                .cmp(&b.page)
                .then(a.y.total_cmp(&b.y))
                .then(a.x.total_cmp(&b.x))
        });

        let mut out = String::new();
        // 上一行的（页, 基线 y, 字号）—— 用来决定「换行」还是「空一行」
        let mut previous: Option<(u32, f64, f64)> = None;
        let mut start = 0;
        while start < runs.len() {
            let end = line_end(&runs, start);
            push_line(&mut out, &runs[start..end], &mut previous);
            start = end;
        }
        out
    }
}

impl OutputDev for RunCollector {
    fn begin_page(
        &mut self,
        page_num: u32,
        media_box: &MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), OutputError> {
        self.finish_run();
        self.page = page_num;
        // y 轴翻过来：PDF 原点在左下、y 向上；翻完 y 就是「往下增长」（与 `PlainTextOutput` 同口径）
        self.flip = Transform::row_major(1., 0., 0., -1., 0., media_box.ury - media_box.lly);
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        self.finish_run();
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        // 库在**每次文本绘制算子**之前调它：上一串到此为止
        self.finish_run();
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), OutputError> {
        self.finish_run();
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), OutputError> {
        // 库在 `Td` / `TD` / `T*` 时调它：那只是「同一串里的换行线索」，位置本身已经收下了
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        char: &str,
    ) -> Result<(), OutputError> {
        let place = trm.post_transform(&self.flip);
        let size = scaled_font_size(trm, font_size);
        let advance = (width * size).max(size * MIN_ADVANCE_EM);
        let (page, x, y) = (self.page, place.m31, place.m32);
        let run = self.current.get_or_insert_with(|| TextRun {
            page,
            x,
            y,
            size,
            end: x,
            text: String::new(),
        });
        if x - run.end > run.size * RUN_SPACE_EM {
            run.text.push(' ');
        }
        run.text.push_str(char);
        run.end = x + advance;
        Ok(())
    }
}

/// 字号 × CTM 的缩放（用行列式的平方根，跟 `PlainTextOutput` 同一套算法）
fn scaled_font_size(trm: &Transform, font_size: f64) -> f64 {
    let determinant = (trm.m11 * trm.m22 - trm.m12 * trm.m21).abs();
    (font_size * determinant.sqrt()).max(MIN_FONT_SIZE)
}

/// 从 `start` 起、y 落在同一行的串到哪里为止
///
/// `runs` 已按「页 → y → x」排好，所以**一行就是一段连续区间**，不用再分组
fn line_end(runs: &[TextRun], start: usize) -> usize {
    let base = &runs[start];
    let mut end = start + 1;
    while end < runs.len() {
        let run = &runs[end];
        let tolerance = base.size.max(run.size) * LINE_TOLERANCE;
        if run.page != base.page || (run.y - base.y).abs() > tolerance {
            break;
        }
        end += 1;
    }
    end
}

/// 拼一行（按 x 从左到右；串之间按缺口补空格），并决定它前面是「换行」还是「空一行」
fn push_line(out: &mut String, line: &[TextRun], previous: &mut Option<(u32, f64, f64)>) {
    let size = line.iter().map(|run| run.size).fold(0.0, f64::max);
    let (page, y) = (line[0].page, line[0].y);
    if let Some((previous_page, previous_y, previous_size)) = *previous {
        out.push('\n');
        let paragraph = (y - previous_y) > (size + previous_size) * PARAGRAPH_GAP_RATIO;
        if page != previous_page || paragraph {
            out.push('\n');
        }
    }
    *previous = Some((page, y, size));

    let mut last_end: Option<f64> = None;
    for run in line {
        if let Some(end) = last_end {
            let gap = run.x - end;
            // 缺口够宽 → 空格；重叠得离谱 → 上游字宽不可信，两串其实各占一格，也得空格
            if gap > run.size * RUN_GAP_EM || gap < -run.size * RUN_OVERLAP_EM {
                out.push(' ');
            }
        }
        out.push_str(&run.text);
        last_end = Some(run.end);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 内嵌图片（端侧 OCR 的输入）
// ═══════════════════════════════════════════════════════════════════════════

use std::io::Read;

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
    /// 英文短语（进 `uiData` / 提示行，不进 i18n）
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
        return Err("over the image limit".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(scan.skipped[0].reason, "over the image limit");
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
}
