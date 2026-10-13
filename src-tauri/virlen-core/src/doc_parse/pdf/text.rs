//! 文字层 —— 按版面坐标重排：借 `pdf-extract` 的 `OutputDev` 钩子收坐标，自己组版。
//!
//! 本仓唯一一份 `pdf-extract` 取字实现；对外只有 [`extract_text`] / [`extract_text_raw`]
//! （在 `pdf::mod` 里 re-export，路径不变）。图片那半在 `super::images`，两半互不引用。

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
///
/// `pub(super)`：只给 `pdf::tests` 用（拆分后测试不在同一文件里），对外仍不导出。
pub(super) fn patch_fonts(doc: &mut lopdf::Document) {
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