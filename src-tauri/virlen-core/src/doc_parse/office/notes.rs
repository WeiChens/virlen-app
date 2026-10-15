//! 说明的公共词汇 —— 合并区域与图片共用的一份「只列前 N 条、其余只计数」的收集器。
//!
//! 两个分册都用到它（`merge` / `images` 各自往里塞句子，`render` 负责把收集到的句子交给调用方），
//! 所以单独成册：不然它只能挂在某一个分册里、别的分册反向依赖。
//! 还有一个共同的出口：[`fact_paragraph`]（把一句事实变成 IR 里的普通段落 —— 合并说明与图片标记
//! 都是这么“就地”贴进正文的）。

use office_oxide::ir::{Element, InlineContent, Paragraph, TextSpan};

/// 一句说明里最多列几条（合并区域 / 图片各自计数）—— 一张满是合并或满是图的表
/// 不该把说明写成一篇长文
pub(super) const MAX_MENTIONS: usize = 8;

/// 说明里引用「被覆盖格里另存的值」时最多显示多少字符
const MAX_HIDDEN_VALUE_CHARS: usize = 40;

/// 一句说明的收集器（合并区域 / 图片共用）：只留前 [`MAX_MENTIONS`] 条的文本，但要数得清总数
///
/// 为什么不是「直接拼一句 String」：整册工作簿的说明要把多张表的区域混在一句里，得能分辨区域
/// 属于哪张表（用 Excel 自己的 `表名!A1` 记法），所以每个来源各自渲染好一句话再交进来。
#[derive(Default)]
pub(super) struct Mentions {
    /// 前几条的说明（多出来的只计数）
    texts: Vec<String>,
    /// 真实总数（说明里那句「and N more」靠它）
pub(super) total: usize,
}

impl Mentions {
    /// 已经列满了 —— 后面的区域不必再为「被覆盖格里的值」去扫单元格
pub(super) fn full(&self) -> bool {
        self.texts.len() >= MAX_MENTIONS
    }

pub(super) fn add(&mut self, text: String) {
        self.total += 1;
        if !self.full() {
            self.texts.push(text);
        }
    }

    /// `DocText::note` 的那句话（没有条目 → `None`）：`<开头>: <条目…>[; and N more]`
pub(super) fn note(&self, lead: &str) -> Option<String> {
        if self.total == 0 {
            return None;
        }
        let mut parts = self.texts.clone();
        if self.total > self.texts.len() {
            parts.push(format!("and {} more", self.total - self.texts.len()));
        }
        Some(format!("{lead}: {}", parts.join("; ")))
    }
}

/// 说明里引用一个值：空白 → `None`；过长 → 截断（只要够模型看出「这里还有别的数据」）
pub(super) fn shrink(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_HIDDEN_VALUE_CHARS {
        return Some(trimmed.to_string());
    }
    let head: String = trimmed.chars().take(MAX_HIDDEN_VALUE_CHARS).collect();
    Some(format!("{head}…"))
}

/// 一句事实 → IR 里的一个普通段落（库自己的渲染器会把它排在原来那个位置、独占一行）
///
/// 合并说明与图片标记共用：两者都是“在原本什么都没有（或什么都没有讲）的位置插一句”。
pub(super) fn fact_paragraph(text: String) -> Element {
    Element::Paragraph(Paragraph {
        content: vec![InlineContent::Text(TextSpan::plain(text))],
        ..Default::default()
    })
}

/// 多句说明 → `DocText::note`（都没话 → `None`；句子之间用 ` · `，
/// 与「sheet 参数在 Word 上被忽略」那句同一口径）
pub(super) fn join_notes(notes: &[Option<String>]) -> Option<String> {
    let mut out = String::new();
    for note in notes.iter().flatten() {
        if !out.is_empty() {
            out.push_str(" · ");
        }
        out.push_str(note);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}