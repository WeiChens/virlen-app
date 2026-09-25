//! 固化行的模型与文本清洗（`LineKind` / `OutLine` / `sanitize` / `expand`）
//!
//! 这四样是「一屏文本怎么表示」的全部约定：`sanitize` 决定**什么能进终端**（ANSI 转义与控制字符
//! 必须整段剥掉，否则会把界面画乱），`expand` 决定**视口与固化算高度的口径一致**（各切一次就会
//! 出现内容被截断或错位）。它们没有状态、不依赖 `UiState`，因此单独一层。

/// 一行输出的**语义**（渲染层据此上色；状态机不关心颜色）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineKind {
    /// 用户输入
    User,
    /// 助手正文
    Assistant,
    /// 工具开始行
    Tool,
    /// 工具结果 / 实时输出
    ToolOutput,
    /// 提示、收尾摘要
    Notice,
    /// 错误
    Error,
}

/// 一段输出（`text` 里可以带 `\n`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutLine {
    pub kind: LineKind,
    pub text: String,
}

impl OutLine {
    pub(crate) fn new(kind: LineKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: sanitize(&text.into()),
        }
    }
}

/// 去掉终端**转义序列**与控制字符（工具输出可能带 ANSI 颜色 / 进度条 / `\r`）——
/// 不清理就会**把界面本身画乱**（ratatui 会把 `[31m` 当普通字符算宽度）。
/// 保留 `\n`（分段）与 `\t`（缩进）。
///
/// ⚠️ 只滤「控制字符」是不够的：ESC 被抹掉后 `[31m` 会**留下可见文本** ——
/// 必须整段识别 CSI（`ESC [ … 终止字节`）与 OSC（`ESC ] … BEL/ST`）。
pub(crate) fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek().copied() {
                // CSI：ESC [ 参数/中间字节 终止字节(0x40..=0x7e)
                Some('[') => {
                    it.next();
                    for c2 in it.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c2) {
                            break;
                        }
                    }
                }
                // OSC：ESC ] … BEL 或 ST(ESC \)
                Some(']') => {
                    it.next();
                    while let Some(c2) = it.next() {
                        if c2 == '\u{7}' {
                            break;
                        }
                        if c2 == '\u{1b}' {
                            if it.peek() == Some(&'\\') {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                // 其它两字符转义序列（ESC ( B 之类）
                Some(_) => {
                    it.next();
                }
                None => {}
            }
            continue;
        }
        if c.is_control() && c != '\n' && c != '\t' {
            continue;
        }
        out.push(c);
    }
    out
}

/// 把一个 `OutLine` 展开成若干**逻辑行**（按 `\n` 切）。
///
/// 渲染与固化都走它 → 「视口里看到的行数」与「固化时算的高度」口径一致
/// （两处各切一次，一旦不一致就会出现内容被截断或错位）。
pub(crate) fn expand(lines: &[OutLine]) -> Vec<(LineKind, &str)> {
    let mut out = Vec::new();
    for l in lines {
        for part in l.text.split('\n') {
            out.push((l.kind, part));
        }
    }
    out
}
