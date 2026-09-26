//! 工具定义的权威源（机制 C）—— 定义在此，前端经 Tauri 命令获取
//!
//! 28 个工具定义原先只存在于 TS 侧，而 Rust 引擎 / CLI 也需要自己有一份；两侧各写一份就是第 2、第 3
//! 份定义 —— 本项目最忌讳的「静默分叉」。因此收敛到本模块：
//!
//! - 数据三方同构：TS `ResolvedToolDefinition` ↔ `definitions.json` ↔ `types::ToolDefinition`；
//! - 平台相关描述（`execute_command` / `execute_script`）按 `windows` / `macos` / `linux` 三变体存放
//!   —— 键名与 `std::env::consts::OS`、TS `platformSnapshot()` 的词表一致，无需映射表；
//! - 前端在 Tauri 环境经 `cmd_list_tool_definitions` 取值；浏览器 dev / vitest 直读同一份 json，
//!   因此不存在「快照漂移」。
//!
//! ⚠️ 以后改工具定义直接改 `definitions.json`（它就是权威源），不要再去 TS 侧另写一份定义体；过渡期
//! 由契约测试 `src/tests/contracts/tool-defs-contract.test.ts` 兜底。

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;

use super::types::ToolDefinition;

/// 三个平台键（与 `std::env::consts::OS` / TS `platformSnapshot()` 同词表）
#[allow(dead_code)] // 供 CLI / 测试枚举平台用（生产路径目前只用 current_platform）
pub const PLATFORM_KEYS: [&str; 3] = ["windows", "macos", "linux"];

#[derive(Debug, Deserialize)]
struct DefinitionsFile {
    #[serde(rename = "schemaVersion")]
    #[allow(dead_code)]
    schema_version: u32,
    /// 平台 → 该平台的工具定义列表
    variants: HashMap<String, Vec<ToolDefinition>>,
}

static DEFINITIONS: Lazy<DefinitionsFile> = Lazy::new(|| {
    serde_json::from_str(include_str!("definitions.json"))
        .expect("tool_defs/definitions.json 解析失败（结构见 DefinitionsFile）")
});

/// 当前平台（`std::env::consts::OS` 取值就是 windows / macos / linux）
pub fn current_platform() -> &'static str {
    std::env::consts::OS
}

/// 列出当前平台的工具定义
pub fn list_tool_definitions() -> Vec<ToolDefinition> {
    list_tool_definitions_for(current_platform())
}

/// 列出指定平台的工具定义；未知平台回退 `linux`（命令示例按 POSIX 给，最保守）
pub fn list_tool_definitions_for(platform: &str) -> Vec<ToolDefinition> {
    DEFINITIONS
        .variants
        .get(platform)
        .or_else(|| DEFINITIONS.variants.get("linux"))
        .cloned()
        .unwrap_or_default()
}

/// 当前平台的工具名列表（顺序与定义一致）
#[allow(dead_code)] // 供 CLI（--allow-tools 校验）与前端白名单补全使用，暂未接入
pub fn tool_names() -> Vec<String> {
    list_tool_definitions()
        .into_iter()
        .map(|d| d.name)
        .collect()
}

/// 权威源里记录的全部工具数量（三平台应一致）
#[allow(dead_code)] // 供 CLI 自检 / 前端展示使用，暂未接入
pub fn tool_count() -> usize {
    list_tool_definitions_for(PLATFORM_KEYS[0]).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_TOOLS: usize = 28;

    #[test]
    fn all_platforms_present_and_complete() {
        for platform in PLATFORM_KEYS {
            let defs = list_tool_definitions_for(platform);
            assert_eq!(
                defs.len(),
                EXPECTED_TOOLS,
                "平台 {platform} 的工具数量应为 {EXPECTED_TOOLS}"
            );
        }
    }

    #[test]
    fn every_definition_has_name_description_and_schema() {
        for def in list_tool_definitions() {
            assert!(!def.name.is_empty(), "存在无名工具");
            assert!(
                !def.description.is_empty(),
                "{} 缺少 description（模型靠它决定是否调用）",
                def.name
            );
            assert_eq!(
                def.parameters.type_, "object",
                "{} 的参数 type 必须是 object",
                def.name
            );
            assert!(
                def.parameters.properties.is_object(),
                "{} 缺少 properties（参数 schema 为空）",
                def.name
            );
        }
    }

    #[test]
    fn three_variants_share_the_same_tool_set() {
        let mut windows: Vec<String> = list_tool_definitions_for("windows")
            .into_iter()
            .map(|d| d.name)
            .collect();
        let mut linux: Vec<String> = list_tool_definitions_for("linux")
            .into_iter()
            .map(|d| d.name)
            .collect();
        windows.sort();
        linux.sort();
        assert_eq!(windows, linux, "三平台的工具集合必须一致（只允许描述不同）");
    }

    #[test]
    fn unknown_platform_falls_back_to_linux() {
        assert_eq!(list_tool_definitions_for("freebsd").len(), EXPECTED_TOOLS);
    }

    #[test]
    fn platform_related_descriptions_differ() {
        // execute_command 的命令示例依赖平台：若三变体完全相同，说明导出时平台没被真正区分
        let pick = |p: &str| {
            list_tool_definitions_for(p)
                .into_iter()
                .find(|d| d.name == "execute_command")
                .map(|d| d.description)
                .expect("缺少 execute_command")
        };
        assert_ne!(pick("windows"), pick("linux"), "execute_command 描述未区分平台");
    }
}
