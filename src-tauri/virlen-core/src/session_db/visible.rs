//! 「可见行」计数与分页补足 —— 与桌面端折叠行模型（`virlen-app` 的
//! `message-list/rows.ts::buildRows`）**同一口径**。
//!
//! 为什么要按「可见行」而非原始条数分页：连续工具调用会被 UI 折成一行，`role='tool'` 的结果
//! 气泡恒渲染 null（0 高度）。一页 60 条若大半是工具调用，屏幕上可能只多一两行 —— 用户滚到顶部
//! 却几乎看不到新内容，只能反复上滑。故这里反复向更早取数，直到累计窗口的可见行数达标
//! （或到底 / 触上限），**一次 IPC 就给足**，避免 UI 端多次加载造成抖动。
//!
//! ⚠️ 判据必须与前端 `utils/messageContent.ts` / `message-list/rows.ts` 同源；若前端改了折叠规则，
//! 这里要同步，否则会出现「加载条数对不上」。

use crate::agent::types::Message;
use crate::session_db::repo::SessionRepo;
use crate::session_db::types::MessagePage;

/// 补足时最多连续取几页（兜底：整段历史全是工具调用时，可见行数永远涨不上去，不能无限取）。
pub const MESSAGE_FILL_MAX_CHUNKS: usize = 5;

/// 消息是否有正文（text 块拼接、去首尾空白；与前端 `messageHasBody` 同口径）。
pub fn message_has_body(message: &Message) -> bool {
    match &message.content {
        serde_json::Value::String(s) => !s.trim().is_empty(),
        serde_json::Value::Array(blocks) => {
            let text: String = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            !text.trim().is_empty()
        }
        _ => false,
    }
}

/// 是否带非文本可见块（引用 / 图片 / 文件 / 技能；与前端 `messageHasAttachmentBlocks` 同口径）。
pub fn message_has_attachment_blocks(message: &Message) -> bool {
    match &message.content {
        serde_json::Value::Array(blocks) => blocks.iter().any(|b| {
            matches!(
                b.get("type").and_then(|t| t.as_str()),
                Some("image_url") | Some("file") | Some("quote") | Some("skill")
            )
        }),
        _ => false,
    }
}

/// 是否是「工具宿主」assistant（带工具调用 + 不带可见附件块；与前端 `isToolCallMessage` 同口径）。
pub fn is_tool_call_message(message: &Message) -> bool {
    message.role == "assistant"
        && message
            .tool_calls
            .as_ref()
            .is_some_and(|calls| !calls.is_empty())
        && !message_has_attachment_blocks(message)
}

/// 一段消息在 UI 里会渲染出**高度**的行数。
///
/// - `role='tool'` 的结果消息气泡恒为 null（0 高度），折叠与否都不计；
/// - `fold = true`：连续的工具宿主合成一组（组内遇到带正文的宿主则收口分段），每段计 1 行；
/// - `fold = false`：不折叠，工具宿主各自成卡片（各 1 行），故只有 tool 结果被排除。
pub fn visible_row_count(messages: &[Message], fold: bool) -> usize {
    let mut rows = 0usize;
    // 是否处于「连续工具调用段」内（仅 fold = true 时有意义）
    let mut in_run = false;
    for message in messages {
        // tool 结果消息的气泡永远渲染 null（0 高度）
        if message.role == "tool" {
            continue;
        }
        if fold && is_tool_call_message(message) {
            if !in_run {
                rows += 1; // 段首：整段计 1 行
                in_run = true;
            } else if message_has_body(message) {
                rows += 1; // 中段带正文 → 收口另起一段，新段再计 1 行
            }
            // 否则并入当前段，不额外计行
        } else {
            rows += 1;
            in_run = false;
        }
    }
    rows
}

/// 分页取消息并补足到「足够 UI 渲染的量」。
///
/// 反复向更早取 `chunk` 条，直到累计窗口的可见行数 ≥ `min_visible`、或没有更早的消息、
/// 或连续取够 [`MESSAGE_FILL_MAX_CHUNKS`] 页。返回累计后的窗口（升序）。
///
/// - `chunk`：每次 SQL 取的原始条数；
/// - `before_rowid`：起始游标（`None` = 尾部窗口）；
/// - `min_visible`：可见行数下限（≤ 0 时只取一页，行为与不分页补足一致）；
/// - `fold`：折叠开关（= 前端设置项 `hideToolCallThink`）。
pub async fn get_message_page_filled(
    repo: &dyn SessionRepo,
    session_id: &str,
    chunk: usize,
    before_rowid: Option<i64>,
    min_visible: usize,
    fold: bool,
) -> Result<MessagePage, String> {
    let chunk = chunk.max(1);
    let mut cursor = before_rowid;
    // 已累计的窗口（升序，旧 → 新）；每取到更早的一页就补到它前面
    let mut window: Vec<Message> = Vec::new();
    let mut has_more = false;
    let mut oldest_rowid = None;
    for _ in 0..MESSAGE_FILL_MAX_CHUNKS {
        let page = repo.get_message_page(session_id, chunk, cursor).await?;
        has_more = page.has_more;
        if page.messages.is_empty() {
            break;
        }
        oldest_rowid = page.oldest_rowid;
        let mut merged = page.messages;
        merged.append(&mut window);
        window = merged;
        if !has_more || visible_row_count(&window, fold) >= min_visible {
            break;
        }
        match oldest_rowid {
            Some(rowid) => cursor = Some(rowid),
            None => break,
        }
    }
    Ok(MessagePage {
        messages: window,
        has_more,
        oldest_rowid,
    })
}
