//! Agent 引擎数据类型 — 镜像 TypeScript 侧 `src/types/index.ts` 与 `src/domain/engine/types.ts`
//!
//! 字段命名遵循 camelCase（前端 JSON 契约），使用 serde rename 对齐。

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ==================== 全局类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParams {
    pub temperature: f64,
    pub top_p: f64,
    pub max_tokens: i64,
    pub stream: bool,
    /// 会话级推理强度（覆盖 Provider 默认值）。
    /// 引擎只用前端传入的 options.reasoning_effort；此字段仅为「回写持久化时不丢字段」而存在。
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub messages: Vec<Message>,
    pub provider_config_id: String,
    pub model_id: String,
    pub system_prompt: String,
    pub params: SessionParams,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    #[serde(default)]
    pub system_prompt_manually_edited: Option<bool>,
}

/// 消息内容 — 兼容 string 或 block 数组
pub type MessageContent = Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolUseContent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_elapsed_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_data: Option<Value>,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_vision_analyze_optimize: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_vision_analyze_result: Option<String>,
}

impl Message {
    /// 提取纯文本内容（string 直接返回；数组取 text 块拼接）
    pub fn text_content(&self) -> String {
        match &self.content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(Value::as_str) == Some("text") {
                        b.get("text").and_then(Value::as_str).map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    /// 缓存命中的输入 token（provider 明确回报时才有）。
    ///
    /// ⚠️ 各家口径不同：OpenAI 兼容（含 DeepSeek）与 Gemini 把它算在 `prompt_tokens` 里，
    /// Anthropic 的 `input_tokens` 本来就不含缓存。账本写入时由 `usage::ledger_tokens` 按
    /// provider 拉平口径，此处保持 API 原样。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseContent {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
    pub name: String,
    pub input: Value,
}

// ==================== 工具定义 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub description: String,
    pub parameters: ToolParameters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolParameters {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(default)]
    pub properties: Value,
    #[serde(default)]
    pub required: Vec<String>,
    /// 可选 JSON Schema `oneOf`（如 read_file 的 path/paths 二选一）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub one_of: Option<Vec<RequiredSet>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredSet {
    #[serde(default)]
    pub required: Vec<String>,
}

// ==================== 引擎内部类型 ====================

/// 一次 LLM 轮次产生的临时上下文
#[derive(Debug, Clone)]
pub struct ToolCallContext {
    pub assistant_message: Message,
    pub tool_uses: Vec<ToolUseContent>,
    pub round_content: String,
    pub reasoning_content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolStepStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStep {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
    pub status: ToolStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub session_id: String,
    pub assistant_message_id: String,
    pub steps: Vec<ToolStep>,
    pub created_at: i64,
    pub paused: bool,
    pub round: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub assistant_message_id: String,
    pub steps: Vec<ToolStep>,
    pub round: i64,
    pub created_at: i64,
    pub paused: bool,
}

// ==================== Provider / 流事件 ====================

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub system_prompt: Option<String>,
    pub tools: Vec<ToolDefinition>,
    pub temperature: f64,
    pub top_p: f64,
    pub max_tokens: i64,
    pub stream: bool,
    pub tool_choice: String,
    pub reasoning_effort: Option<String>,
    /// 是否启用思考 / 推理模式（与 TS `ChatRequest.thinking` 同语义）。
    ///
    /// - `Some(false)`：**禁用思考**（标题生成等短输出场景）—— openai 兼容写
    ///   `thinking:{type:'disabled'}` + `reasoning_effort:'none'`；anthropic 写
    ///   `thinking:{type:'disabled'}`；桥接协议（gemini 等）由 TS provider 处理。
    /// - `None`：不干预（普通聊天 / 压缩 / 验证）。
    pub thinking: Option<bool>,
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    TextDelta(String),
    ReasoningContentChange(String),
    ToolUse(ToolUseContent),
    MessageStop { reasoning_content: Option<String>, usage: Option<TokenUsage> },
    Error(String),
}

// ==================== Agent 事件 ====================

/// Agent 事件 — 序列化后与 TS `AgentEvent` 完全一致
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AgentEvent {
    pub fn new(type_: impl Into<String>, data: Value) -> Self {
        Self {
            type_: type_.into(),
            data: Some(data),
            error: None,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            type_: "error".into(),
            data: None,
            error: Some(error.into()),
        }
    }
}

// ==================== 迭代类型 ====================

#[derive(Debug, Clone)]
pub struct Goal {
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationIssue {
    pub severity: String,
    pub description: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub passed: bool,
    pub summary: String,
    pub issues: Vec<VerificationIssue>,
}

// ==================== SendMessage 参数 ====================

/// Provider 连接信息（前端解析 ProviderConfig 后传入）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnection {
    pub provider_type: String,
    pub provider_id: String,
    pub api_key: String,
    pub base_url: String,
}

/// 原生工具执行所需的安全配置（前端 securityService / securityRepo 解析后传入）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolSecurity {
    /// 会话工作目录（相对路径的解析基准）
    #[serde(default)]
    pub workspace: String,
    /// 命令审批模式：all | risky | install | none
    #[serde(default)]
    pub approval_mode: String,
    /// list_files 时跳过（不进入）的目录名
    #[serde(default)]
    pub skip_dirs: Vec<String>,
    /// 路径黑名单（canonicalize 前缀匹配）
    #[serde(default)]
    pub blacklist: Vec<String>,
    /// 路径白名单（canonicalize 前缀匹配）
    #[serde(default)]
    pub whitelist: Vec<String>,
    /// SKILL_ROOT 环境变量指向的技能目录（execute_command 注入）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_dir: Option<String>,
    /// 终端沙盒模式：on（写隔离，默认）| off（裸跑）| readonly（只读）
    #[serde(default = "default_sandbox_mode")]
    pub sandbox_mode: String,
    /// 权限三态表：权限 name → allow | ask | deny
    /// （与 TS `src/domain/permission/index.ts` 对齐；取代旧的单一 `approval_mode`）
    #[serde(default)]
    pub permissions: std::collections::BTreeMap<String, String>,
    /// 「忽略沙盒命令」规则**全量**（设置 → 安全 → 忽略沙盒命令）。
    ///
    /// 与 `permissions` / `blacklist` 同一套做法：由配置来源解析后整体下发，引擎侧不再回问 JS
    /// （原内部交互 `sandbox_rule_check` 已连同桥一起删除）。
    /// - GUI（Rust 引擎）：`resolveSecurityConfig` 下发 `app_settings.sandboxIgnoreRules` 的当前快照；
    /// - CLI：入口从同一个 `app_settings` 键读同一份；
    /// - 判定在 Rust 侧完成（`crate::security::find_matching_rule`：text / regex 原生，`js` 交
    ///   内嵌 QuickJS，见 `crate::security::js_rule`）。
    ///
    /// 逐条不做预编译：规则量级是「几条到几十条」，遍历一次的开销远小于一次 IPC；regex 另有
    /// 进程级编译缓存（`security::rules::regex_matches`）。
    #[serde(default)]
    pub sandbox_ignore_rules: Vec<crate::security::SandboxIgnoreRule>,
}

fn default_sandbox_mode() -> String {
    "on".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageOptions {
    pub session: Session,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub provider: Option<ProviderConnection>,
    /// 解析后的工具定义列表（前端按 session.allowedTools 过滤后传入）
    #[serde(default)]
    pub tool_defs: Vec<ToolDefinition>,
    #[serde(default = "default_true")]
    pub enable_tools: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from_snapshot: Option<RunSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default = "default_max_tool_rounds")]
    pub max_tool_rounds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration_goal: Option<String>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: i64,
    /// 前端用于路由 user_interaction 回执的会话上下文
    #[serde(default)]
    pub session_id: String,
    /// 原生工具执行的安全配置（None 时工具全部走 JS 桥）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<NativeToolSecurity>,
    /// 前端注入的链路追踪 ID（与前端 chat/engine 事件对齐，可空）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_max_tool_rounds() -> i64 {
    30
}
fn default_max_iterations() -> i64 {
    5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_text_content_string() {
        let m = Message {
            id: "1".into(),
            role: "assistant".into(),
            content: Value::String("hello".into()),
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: 0,
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: None,
            image_vision_analyze_result: None,
        };
        assert_eq!(m.text_content(), "hello");
    }

    #[test]
    fn message_text_content_blocks() {
        let m = Message {
            id: "1".into(),
            role: "assistant".into(),
            content: serde_json::json!([
                { "type": "text", "text": "a" },
                { "type": "image_url", "image_url": { "url": "x" } },
                { "type": "text", "text": "b" }
            ]),
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: 0,
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: None,
            image_vision_analyze_result: None,
        };
        assert_eq!(m.text_content(), "a b");
    }

    #[test]
    fn agent_event_serialize_shape() {
        let ev = AgentEvent::new("stream_event", serde_json::json!({ "delta": "x" }));
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "stream_event");
        assert_eq!(v["data"]["delta"], "x");
        assert!(v.get("error").is_none());
    }
}
