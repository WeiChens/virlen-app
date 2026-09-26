//! 供应商目录 —— 模板表 + 推理强度档位表的**唯一权威源**（机制 C 同款）
//!
//! 数据本体在同目录的 `provider_catalog.json`；两条路径同源（Rust `include_str!` 内嵌 ↔ 前端浏览器
//! dev / vitest 用 `?raw` 直读同一份，见 `provider/catalog-source.ts`）→ 不可能漂移，因此不需要任何
//! 「差异检查」逻辑（与 `agent/prompts` 同一取舍）。
//!
//! 搬过来的原因：模板表原先只在 `src/domain/provider/config.ts`，而 CLI 的配置向导必须用它 —— CLI
//! 里没有 JS，抄一份到 Rust 会立刻产生第二个权威源（改一处忘另一处 = 静默分叉）。
//!
//! ## 排序口径（唯一一条）
//!
//! 推理档位的顺序即语义（`none/off < minimal < low < medium < high < xhigh < max`）：拖动条要单调、
//! 归一化要稳定都依赖它。顺序由本文件 `reasoningEffortUnion` 定义，前端 `sortReasoningEfforts()` 与
//! CLI 的选择顺序都按这个并集顺序产出。
//! ⚠️ 改这个数组 = 同时改两侧行为（前端 `provider-config.test.ts` 与本模块单测都会盯着它）。

use serde::{Deserialize, Serialize};

/// 目录 JSON 的原文（编译期内嵌；前端也读同一份文件）
pub const PROVIDER_CATALOG_JSON: &str = include_str!("provider_catalog.json");

/// `allowTypeList` 的一项：同一家供应商支持的另一种协议 + 该协议下的 Base URL
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTypeOption {
    /// 协议类型（openai / anthropic）
    #[serde(rename = "type")]
    pub type_name: String,
    /// 该协议对应的 API 地址
    pub base_url: String,
}

/// 一个供应商模板
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTemplate {
    /// 模板标识（`deepseek` / `custom` …）—— 也是图标查找的键
    pub template_name: String,
    /// 默认协议类型（openai / anthropic / gemini）
    #[serde(rename = "type")]
    pub type_name: String,
    /// 展示名（前端经 i18n 查表，CLI 直接用）
    pub label: String,
    /// 默认 API 地址（`custom` 为空串，由用户填写）
    pub base_url: String,
    /// 多协议可选项；不存在 = 该模板不支持切协议
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_type_list: Option<Vec<ProviderTypeOption>>,
    /// 仅作参考数据，不再参与 UI 选项计算（选项已改为用户从并集里多选，见
    /// `ProviderConfig.reasoningEffortList`）。字段保留是为了不丢各平台支持情况的事实。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_reasoning_effort_list: Option<Vec<String>>,
    /// 官网地址（前端「服务商网址」链接）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub official_link: Option<String>,
}

/// 供应商目录（模板表 + 推理档位表）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    /// 推理强度档位并集（**顺序即语义**，见模块头）
    pub reasoning_effort_union: Vec<String>,
    /// 新建供应商时默认勾选的档位
    pub default_reasoning_effort_list: Vec<String>,
    /// 全部模板
    pub templates: Vec<ProviderTemplate>,
}

impl ProviderCatalog {
    /// 按 `templateName` 找模板（找不到返回 `None`，调用方决定报错文案）
    pub fn find_template(&self, template_name: &str) -> Option<&ProviderTemplate> {
        self.templates.iter().find(|t| t.template_name == template_name)
    }

    /// 档位在并集里的序号（未知档位排到最后 —— 与前端 `effortRank` 同口径）
    pub fn effort_rank(&self, val: &str) -> usize {
        self.reasoning_effort_union
            .iter()
            .position(|v| v == val)
            .unwrap_or(self.reasoning_effort_union.len())
    }
}

/// 解析内置目录。
///
/// 返回 `Result` 而不是 `expect`：这是**数据**不是代码，一个手滑的逗号不该让进程 panic。
/// 解析失败说明 `provider_catalog.json` 被改坏 —— 单测 `catalog_parses` 会在 CI 拦住它。
pub fn provider_catalog() -> Result<ProviderCatalog, String> {
    serde_json::from_str(PROVIDER_CATALOG_JSON).map_err(|e| {
        format!(
            "内置供应商目录解析失败（virlen-core/src/agent/provider/provider_catalog.json）: {}",
            e
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat() -> ProviderCatalog {
        provider_catalog().expect("内置目录必须可解析")
    }

    #[test]
    fn catalog_parses() {
        let c = cat();
        assert!(!c.templates.is_empty());
        assert!(!c.reasoning_effort_union.is_empty());
        assert!(!c.default_reasoning_effort_list.is_empty());
    }

    /// 档位顺序即语义：单调递增，`off` 紧跟 `none`（与前端 `provider-config.test.ts` 同一条断言）
    #[test]
    fn union_order_is_monotonic() {
        assert_eq!(
            cat().reasoning_effort_union,
            vec![
                "none", "off", "minimal", "low", "medium", "high", "xhigh", "max"
            ]
        );
    }

    #[test]
    fn default_effort_list_is_subset_of_union() {
        let c = cat();
        assert_eq!(
            c.default_reasoning_effort_list,
            vec!["low", "medium", "high"]
        );
        for v in &c.default_reasoning_effort_list {
            assert!(
                c.reasoning_effort_union.contains(v),
                "默认档位 {v} 不在并集内"
            );
        }
    }

    #[test]
    fn has_all_predefined_templates() {
        let c = cat();
        for name in [
            "deepseek", "zhipu", "qwen", "openai", "anthropic", "gemini", "custom",
        ] {
            assert!(c.find_template(name).is_some(), "缺少模板 {name}");
        }
    }

    #[test]
    fn every_template_has_required_fields() {
        for t in &cat().templates {
            assert!(!t.template_name.is_empty());
            assert!(!t.label.is_empty());
            assert!(
                matches!(t.type_name.as_str(), "openai" | "anthropic" | "gemini"),
                "模板 {} 的 type 非法: {}",
                t.template_name,
                t.type_name
            );
            // baseUrl 必须存在（`custom` 是空串，允许）
            let _: &str = &t.base_url;
            if let Some(alts) = &t.allow_type_list {
                for a in alts {
                    assert!(!a.type_name.is_empty());
                    assert!(
                        a.base_url.starts_with("http"),
                        "模板 {} 的备用 baseUrl 非法: {}",
                        t.template_name,
                        a.base_url
                    );
                }
            }
        }
    }

    /// 多协议模板与官网链接（前端 `provider-config.test.ts` 的关键断言在 Rust 侧也钉一遍）
    #[test]
    fn multi_protocol_templates_and_links() {
        let c = cat();
        let deepseek = c.find_template("deepseek").unwrap();
        let alts = deepseek.allow_type_list.as_ref().unwrap();
        assert_eq!(alts.len(), 2);
        assert_eq!(alts[0].type_name, "openai");
        assert_eq!(alts[1].type_name, "anthropic");
        assert_eq!(
            deepseek.official_link.as_deref(),
            Some("https://platform.deepseek.com")
        );

        let custom = c.find_template("custom").unwrap();
        assert_eq!(custom.base_url, "");
    }

    /// 序列化必须**省掉 None 字段**：前端断言 `allowReasoningEffortList` 为 `undefined`
    /// （写成 `null` 会让 `toBeUndefined()` 失败）
    #[test]
    fn none_fields_are_omitted_when_serialized() {
        let v = serde_json::to_value(cat()).unwrap();
        let anthropic = v["templates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["templateName"] == "anthropic")
            .unwrap();
        assert!(anthropic.get("allowTypeList").is_none());
        assert!(anthropic.get("allowReasoningEffortList").is_none());
        assert!(anthropic.get("officialLink").is_some());
    }

    #[test]
    fn effort_rank_puts_unknown_last() {
        let c = cat();
        assert_eq!(c.effort_rank("none"), 0);
        assert_eq!(c.effort_rank("max"), 7);
        assert_eq!(c.effort_rank("whatever"), c.reasoning_effort_union.len());
    }
}
