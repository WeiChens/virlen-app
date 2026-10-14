//! 再蒸馏**选哪个模型**（纯函数）
//!
//! 规则（一句话）：`memoryModel`（老键，若还在）置顶 → `defaultSelectModel` → 任一启用 provider 的
//! 第一个模型；**依次降级重试，3 次尝试全失败才退出**。
//!
//! ⚠️ 与「一天素材 → 记忆」的旧实现相比，这里**刻意不查用量账本**（旧版按「压缩用得最多的模型」排序）：
//! 那要恢复 `usage_model_counts` 一整条 trait 方法 + SQL + 测试，而收益只是「默认选哪个模型」——
//! 用户显式指定的 `memoryModel` 与默认模型已足够覆盖。少一条查询，也少一处会静默失效的耦合。
//!
//! 本模块是**纯函数**：输入 = `app_settings`，输出 = 有顺序的候选列表。真正「建 Provider」由宿主实现
//! [`MemoryProviderBuilder`] 注入 —— GUI 走 `DefaultProviderFactory`（有 JS 宿主，gemini 等桥接协议可用），
//! CLI 走 `create_native_provider`（headless 没有 JS 宿主）。这样「谁排前面」只有一份实现，
//! 而「怎么建」按宿主能力分开。

use crate::agent::provider::Provider;
use crate::agent::types::ProviderConnection;
use serde::Deserialize;
use serde_json::{Map, Value};

/// 蒸馏模型首选（可选；置顶降级链）——与 TS `SettingsStore.memoryModel` 同名同层
pub const MEMORY_MODEL_KEY: &str = "memoryModel";

/// `app_settings.providers`
const PROVIDERS_KEY: &str = "providers";
/// `app_settings.defaultSelectModel`（缺省模型来源）
const DEFAULT_MODEL_KEY: &str = "defaultSelectModel";

/// `app_settings.providers` 里一个 Provider 配置（只取选模型需要的字段）
///
/// 形状由 TS `ProviderConfig` 决定，`type` 是关键字所以显式 rename。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLite {
    pub id: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 解析 `app_settings.providers`（**逐条**解析：一条脏配置不该让其余 provider 也全废）
pub fn providers_from_settings(settings: &Map<String, Value>) -> Vec<ProviderLite> {
    let Some(Value::Array(items)) = settings.get(PROVIDERS_KEY) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| serde_json::from_value::<ProviderLite>(v.clone()).ok())
        .collect()
}

/// 一个「可以试一次」的候选（含建 Provider 所需的连接信息）
#[derive(Debug, Clone)]
pub struct ModelCandidate {
    pub provider_config_id: String,
    pub model_id: String,
    pub provider_type: String,
    pub connection: ProviderConnection,
    /// 来源：`preferred` | `default-model` | `first-available`（写进日志 / 报告）
    pub source: &'static str,
}

impl ModelCandidate {
    /// `providerConfigId/modelId` —— 写进 `memory_redistill_runs.model` 的形态
    pub fn label(&self) -> String {
        format!("{}/{}", self.provider_config_id, self.model_id)
    }
}

/// 按定稿规则排出候选（最多 [`super::MEMORY_REDISTILL_MODEL_MAX_CANDIDATES`] 个，已去重）
pub fn memory_model_candidates(
    settings: &Map<String, Value>,
    max_candidates: usize,
) -> Vec<ModelCandidate> {
    let providers = providers_from_settings(settings);
    let mut out: Vec<ModelCandidate> = Vec::new();

    // ① 用户显式指定的首选（置顶）
    if let Some((pid, mid)) = pair_from(settings.get(MEMORY_MODEL_KEY)) {
        try_push(&mut out, &providers, &pid, &mid, "preferred", max_candidates);
    }
    // ② 兜底：默认选择模型（新用户 / 没指定过）
    if let Some((pid, mid)) = pair_from(settings.get(DEFAULT_MODEL_KEY)) {
        try_push(&mut out, &providers, &pid, &mid, "default-model", max_candidates);
    }
    // ③ 再兜底：任一启用 provider 的第一个模型
    for p in providers.iter().filter(|p| p.enabled) {
        if let Some(m) = p.models.first() {
            try_push(&mut out, &providers, &p.id, m, "first-available", max_candidates);
        }
    }
    out
}

/// `{providerConfigId, modelId}` → `(pid, mid)`（缺字段 / 类型不对 → `None`）
fn pair_from(value: Option<&Value>) -> Option<(String, String)> {
    let obj = value?.as_object()?;
    let pid = obj
        .get("providerConfigId")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    let mid = obj
        .get("modelId")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if pid.is_empty() || mid.is_empty() {
        return None;
    }
    Some((pid, mid))
}

/// 追加一个候选：不可用（provider 被删 / 停用 / 缺 key / 模型不在列表里）或已存在 → 静默跳过
fn try_push(
    out: &mut Vec<ModelCandidate>,
    providers: &[ProviderLite],
    pid: &str,
    mid: &str,
    source: &'static str,
    max_candidates: usize,
) {
    if out.len() >= max_candidates.max(1) {
        return;
    }
    let Some(c) = resolve(providers, pid, mid, source) else {
        return;
    };
    if out
        .iter()
        .any(|x| x.provider_config_id == c.provider_config_id && x.model_id == c.model_id)
    {
        return;
    }
    out.push(c);
}

/// 单个候选是否真的可用（**配置层面**的检查；调用失败是另一回事，由降级链处理）
fn resolve(
    providers: &[ProviderLite],
    pid: &str,
    mid: &str,
    source: &'static str,
) -> Option<ModelCandidate> {
    if pid.trim().is_empty() || mid.trim().is_empty() {
        return None;
    }
    let p = providers.iter().find(|p| p.id == pid)?;
    if !p.enabled {
        return None;
    }
    // 模型必须还在该 provider 的模型列表里：不在说明「配置被删 / 模型被禁用」→ 跳过
    if !p.models.iter().any(|m| m == mid) {
        return None;
    }
    if p.api_key.trim().is_empty() || p.base_url.trim().is_empty() {
        return None;
    }
    Some(ModelCandidate {
        provider_config_id: p.id.clone(),
        model_id: mid.to_string(),
        provider_type: p.provider_type.clone(),
        connection: ProviderConnection {
            provider_type: p.provider_type.clone(),
            provider_id: p.id.clone(),
            api_key: p.api_key.clone(),
            base_url: p.base_url.clone(),
        },
        source,
    })
}

/// 由宿主实现的「按候选建 Provider」回调。
///
/// 返回 `Err` = 这个候选建不起来（协议不支持 / 桥不可用）→ 降级链换下一个。
pub trait MemoryProviderBuilder: Send + Sync {
    fn build(&self, conn: &ProviderConnection) -> Result<Box<dyn Provider>, String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::memory::redistill::MEMORY_REDISTILL_MODEL_MAX_CANDIDATES;
    use serde_json::json;

    fn settings(providers: Value, extra: &[(&str, Value)]) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert(PROVIDERS_KEY.to_string(), providers);
        for (k, v) in extra {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    fn provider(id: &str, models: &[&str]) -> Value {
        json!({
            "id": id,
            "type": "openai",
            "name": id,
            "apiKey": "sk-x",
            "baseUrl": "https://api.example.com",
            "models": models,
            "enabled": true,
        })
    }

    fn candidates(s: &Map<String, Value>) -> Vec<String> {
        memory_model_candidates(s, MEMORY_REDISTILL_MODEL_MAX_CANDIDATES)
            .iter()
            .map(ModelCandidate::label)
            .collect()
    }

    /// 主路径：首选置顶 → 默认模型 → 第一个可用模型
    #[test]
    fn preferred_then_default_then_first_available() {
        let s = settings(
            json!([provider("p1", &["a", "b"]), provider("p2", &["c"])]),
            &[
                (MEMORY_MODEL_KEY, json!({"providerConfigId": "p2", "modelId": "c"})),
                (DEFAULT_MODEL_KEY, json!({"providerConfigId": "p1", "modelId": "b"})),
            ],
        );
        let out = memory_model_candidates(&s, MEMORY_REDISTILL_MODEL_MAX_CANDIDATES);
        assert_eq!(
            out.iter().map(ModelCandidate::label).collect::<Vec<_>>(),
            vec!["p2/c", "p1/b", "p1/a"]
        );
        assert_eq!(out[0].source, "preferred");
        assert_eq!(out[1].source, "default-model");
        assert_eq!(out[2].source, "first-available");
        assert_eq!(out[0].provider_type, "openai");
    }

    /// 降级链长度上限：多出来的候选不再试（这正是「3 次尝试」的实现）
    #[test]
    fn chain_is_capped() {
        let s = settings(
            json!([
                provider("p1", &["a", "b", "c"]),
                provider("p2", &["d"]),
                provider("p3", &["e"]),
            ]),
            &[(DEFAULT_MODEL_KEY, json!({"providerConfigId": "p1", "modelId": "a"}))],
        );
        assert_eq!(candidates(&s).len(), MEMORY_REDISTILL_MODEL_MAX_CANDIDATES);
    }

    /// 不可用的候选被跳过：provider 停用 / 缺 key / 模型已不在列表里
    #[test]
    fn unavailable_candidates_are_skipped() {
        let mut disabled = provider("p1", &["a"]);
        disabled["enabled"] = json!(false);
        let mut no_key = provider("p2", &["b"]);
        no_key["apiKey"] = json!("");
        let s = settings(json!([disabled, no_key, provider("p3", &["c"])]), &[]);
        assert_eq!(candidates(&s), vec!["p3/c"], "只有真正可用的才进降级链");

        // 模型被删（不在 models 列表里）→ 该候选被跳过；但「首个模型」兜底仍成立
        let s2 = settings(json!([provider("p1", &["other"])]), &[]);
        let out2 = memory_model_candidates(&s2, MEMORY_REDISTILL_MODEL_MAX_CANDIDATES);
        assert_eq!(out2.len(), 1);
        assert_eq!(out2[0].label(), "p1/other");
    }

    /// 同一个候选不得重复出现（首选与默认模型常常是同一个）
    #[test]
    fn duplicates_are_removed() {
        let s = settings(
            json!([provider("p1", &["a", "b"])]),
            &[
                (MEMORY_MODEL_KEY, json!({"providerConfigId": "p1", "modelId": "a"})),
                (DEFAULT_MODEL_KEY, json!({"providerConfigId": "p1", "modelId": "a"})),
            ],
        );
        // `first-available` 只兜底「第一个启用 provider 的第一个模型」（就是 a）—— 不展开整个模型表，
        // 否则一个 provider 装 50 个模型就会把降级链的 3 个位置占满
        assert_eq!(candidates(&s), vec!["p1/a"]);
    }

    /// 脏配置不该炸整次整理：一条坏 provider 只丢它自己
    #[test]
    fn malformed_entries_are_ignored() {
        let s = settings(
            json!([
                {"id": "broken"},
                provider("p1", &["a"]),
                "not-an-object",
            ]),
            &[],
        );
        assert_eq!(candidates(&s), vec!["p1/a"]);

        assert!(memory_model_candidates(&Map::new(), 3).is_empty());
        let mut bad = Map::new();
        bad.insert(PROVIDERS_KEY.to_string(), json!("oops"));
        assert!(memory_model_candidates(&bad, 3).is_empty());
    }

    /// 首选写成空串 / 半截对象 → 当没给（不产生空候选）
    #[test]
    fn empty_preference_is_ignored() {
        let s = settings(
            json!([provider("p1", &["a"])]),
            &[(MEMORY_MODEL_KEY, json!({"providerConfigId": "", "modelId": ""}))],
        );
        assert_eq!(candidates(&s), vec!["p1/a"]);
    }
}
