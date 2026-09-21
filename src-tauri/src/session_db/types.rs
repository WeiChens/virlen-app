//! 会话持久化的对外 DTO（IPC 序列化单位）
//!
//! 从原 `session_db.rs` 拆出：这里只放数据结构与查询上限常量，不含任何 DB 逻辑。

use crate::agent::types::Message;
use serde::{Deserialize, Serialize};

// ==================== 分页结果 ====================

/// 会话消息分页结果（尾部窗口加载用）
///
/// 前端切换会话时只取「最近 limit 条」，向上滚动再用 `oldest_rowid` 回补更早的历史，
/// 避免一次性把数千条消息经 IPC 全部搬到前端造成的加载卡顿。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    /// 本页消息（按插入顺序升序）
    pub messages: Vec<Message>,
    /// 是否还有更早的消息可供回补
    pub has_more: bool,
    /// 本页最旧消息的 rowid（作为下一页的 before_rowid）
    pub oldest_rowid: Option<i64>,
}

/// 会话内「用户消息」的轻量索引项（右侧锚点列表用）
///
/// 只包含 id 与纯文本摘要，不含 assistant / tool 消息的大量正文，
/// 因此即使会话有数千条消息，也能一次性取回而不重新引入加载卡顿。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageRef {
    pub id: String,
    /// 纯文本摘要（已截断）
    pub preview: String,
}

/// 消息检索结果项（会话内 / 跨会话通用）
///
/// `text` 是「围绕首个命中位置生成的片段」（超长已省略号截断），
/// 前端直接渲染并对关键词做高亮；来源信息（会话标题 / 工作目录 / Agent）
/// 由 JOIN `sessions` 表带出，供跨会话检索时展示上下文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchItem {
    pub id: String,
    pub session_id: String,
    pub role: String,
    /// 命中片段（围绕首个命中位置截取，超长已省略）
    pub text: String,
    pub timestamp: i64,
    pub session_title: String,
    pub workspace: Option<String>,
    pub agent_id: Option<String>,
    /// 该消息所属的工具名（仅 `role='tool'` 的消息会解析；前端据此展示「查看文件」等标签）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

/// 消息检索的 keyset（游标）分页游标：按 `(timestamp, rowid)` 倒序定位「上一页最后一条」。
///
/// 相比 offset，keyset 不会因检索期间新写入的消息而错位（新消息 timestamp/rowid 更大，
/// 排在已翻页之前，不影响更旧页的定位）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCursor {
    pub timestamp: i64,
    pub rowid: i64,
}

/// 消息检索分页结果（按时间倒序，keyset 游标分页）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchPage {
    pub items: Vec<MessageSearchItem>,
    pub has_more: bool,
    /// 下一页游标（`has_more` 为 true 时给出，否则为 None）
    pub next_cursor: Option<SearchCursor>,
}

// ==================== 消息查询（query messages 工具）====================

/// 「消息查询」工具的硬上限（服务端权威 clamp，防止 JS 侧绕过）
pub const MSG_QUERY_MAX_BACK: usize = 20;
pub const MSG_QUERY_MAX_FWD: usize = 20;
/// 单次窗口最多返回的消息数 - 1（即最多 `MSG_QUERY_MAX_SPAN + 1` 条）
pub const MSG_QUERY_MAX_SPAN: usize = 20;
pub const MSG_QUERY_MAX_LIMIT: usize = 50;
/// 普通消息正文最多返回的字符数
pub const MSG_QUERY_TEXT_MAX_CHARS: usize = 4000;
/// 工具调用参数 / 工具结果最多返回的字符数（需求：详情 ≈100 字符以内）
pub const MSG_QUERY_TOOL_DETAIL_MAX_CHARS: usize = 100;
/// 概览摘要最多返回的字符数
pub const MSG_QUERY_PREVIEW_MAX_CHARS: usize = 100;

/// 工具调用的精简描述（只告诉模型「调用了什么工具 + 关键参数」）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBrief {
    pub name: String,
    /// 参数 JSON 的截断形式（≤ `MSG_QUERY_TOOL_DETAIL_MAX_CHARS`）
    pub input_brief: String,
    pub input_truncated: bool,
}

/// 「消息查询」工具：单条消息的骨架（已剔除深度思考，工具参数已截断）
///
/// ⚠️ 只有「已压缩区间」（时序 < 最后一个 summary）的消息才会被返回：
/// 该区间之后的对话已在模型当前上下文中，重复下发只会浪费 token。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBrief {
    /// 1 基时序（会话内消息的插入顺序）
    pub seq: i64,
    pub id: String,
    pub role: String,
    pub timestamp: i64,
    /// 正文（仅 text 块拼接；≤ `MSG_QUERY_TEXT_MAX_CHARS`）
    pub text: String,
    pub text_truncated: bool,
    /// 是否含图片 / 文件 / 引用块（仅提示，不展开内容）
    pub has_attachments: bool,
    /// assistant 消息调用的工具（参数按 `MSG_QUERY_TOOL_DETAIL_MAX_CHARS` 截断）
    pub tool_calls: Vec<ToolCallBrief>,
    /// tool 消息才有（对应 assistant 的 tool_call id）
    pub tool_call_id: Option<String>,
    pub is_error: Option<bool>,
    /// 是否含深度思考 —— 内容**永不返回**，只给这个标记
    pub has_reasoning: bool,
}

/// `get_message_window` 的返回：锚点前后 N 条（时序升序）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWindow {
    /// 锚点消息是否存在（false = id / seq 无效或已删除）
    pub anchor_found: bool,
    /// 解析出的锚点时序（未找到时为 0）
    pub anchor_seq: i64,
    pub start_seq: i64,
    pub end_seq: i64,
    /// 会话消息总数
    pub total: i64,
    /// 「已压缩区间」上界 = 最后一个 summary 的时序；
    /// `None` = 会话从未压缩（此时没有可查询的历史，全部消息都在上下文中）
    pub boundary_seq: Option<i64>,
    /// 窗口后沿因触及上界而被裁剪
    pub clamped_by_boundary: bool,
    pub messages: Vec<MessageBrief>,
}

/// 时序概览项（list 模式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTimelineItem {
    pub seq: i64,
    pub id: String,
    pub role: String,
    pub timestamp: i64,
    /// 纯文本摘要（≤ `MSG_QUERY_PREVIEW_MAX_CHARS`）
    pub preview: String,
    /// 该消息调用的工具名（assistant 才有）
    pub tool_names: Vec<String>,
}

/// `get_message_timeline` 的返回（时序升序）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTimelinePage {
    pub items: Vec<MessageTimelineItem>,
    pub has_more: bool,
    /// 更早一页的游标（`has_more` 时给出）
    pub next_cursor: Option<i64>,
    pub total: i64,
    /// 同 `MessageWindow::boundary_seq`
    pub boundary_seq: Option<i64>,
}
