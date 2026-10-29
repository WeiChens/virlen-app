//! 公开工具名 —— 模型可见的 MCP 工具身份。
//!
//! **直接用服务器自己的工具名**（`get_scene_info` / `look`），不再拼 `mcp__<server>__<raw>`。
//! 名字里带服务器名的代价太大：改一次服务器配置名，所有历史会话与白名单里的工具名一起失效
//! （真实事故：默认 Agent 白名单里 35 个旧名全部落空，界面却写着「已选 35 个工具」，见 §11.69）。
//! 而「区分同名工具」本该由冲突判定兜住 —— 见下面的 ⚠️。
//!
//! - 干净名：原样返回；
//! - 发生字符替换 / 空名 / 超 64 字符时，追加 **12 位 SHA-256(`raw`)** 指纹 —— 同一服务器内不同身份
//!   绝不折叠（否则历史消息里的工具名会指向另一个工具）；
//! - 以历史前缀 `mcp__` 开头的名字先换成中性前缀 `mcp_tool_`（否则会被旧数据解析当成旧版名）；
//! - 上限 **64** 字符（三大 provider 的函数名契约），字符集 `[A-Za-z0-9_-]`。
//!
//! ⚠️ 跨服务器同名不在这里解决：名字里已经没有服务器，两台服务器都叫 `look` 就是真冲突，
//! 由 `McpManager::republish` 判定并 fail-closed（两边都不下发 + 报给界面）。本模块只保证
//! 「长度 / 字符集合法」与「同一服务器内不折叠」。
//!
//! ⚠️ `MCP_PREFIX` 只剩**历史兼容**用途：旧会话 / 旧白名单里的 `mcp__<server>__<raw>` 仍要能
//! 认出来（卡片展示、白名单一次性迁移），但它再也不会被生成。
//!
//! 用户可以在设置页给单个工具**改公开名**（`McpServerConfig::tool_aliases`）：默认仍走本模块，
//! 别名则用 [`validate_tool_alias`] 校验（不做归一化 —— 界面上看到的名字必须就是下发的名字）。

use sha2::{Digest, Sha256};

/// 历史公开名前缀 —— 只用于识别旧数据，**不再生成**。
pub const MCP_PREFIX: &str = "mcp__";

/// 历史名字里服务器名与工具名之间的分隔符。
const SEP: &str = "__";

/// provider 函数名上限（OpenAI / Anthropic / Gemini 的交集）
pub const MAX_PUBLIC_NAME_LEN: usize = 64;

/// 哈希后缀长度（十六进制字符数）
const HASH_LEN: usize = 12;

/// 取一个 MCP 工具对模型可见的名字。
///
/// 纯函数：同一 `raw` 永远返回同一字符串。不同服务器的同名工具会得到**同一个**名字 ——
/// 那是真冲突，交由管理器判定（本函数不参与去重）。
pub fn public_tool_name(raw: &str) -> String {
    // 逐字符替换（不是逐字节）：多字节字符替换成**一个**下划线，否则长度会随编码漂移
    let normalized: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // 占用历史前缀的名字必须变形：否则新名字会被旧数据解析当成 `mcp__<server>__<raw>`
    let name = match normalized.strip_prefix(MCP_PREFIX) {
        Some(rest) => format!("mcp_tool_{rest}"),
        None => normalized,
    };

    // 空名 / 改过字符 / 超长 → 必须加指纹，否则会与别的身份折叠
    let needs_hash = name.is_empty() || name != raw || name.len() > MAX_PUBLIC_NAME_LEN;
    if !needs_hash {
        return name;
    }

    // 归一化后全是 ASCII → 字节长度即字符长度，切片安全
    let hash = identity_hash(raw);
    let keep = MAX_PUBLIC_NAME_LEN - HASH_LEN - 1;
    let head = if name.len() > keep {
        &name[..keep]
    } else {
        &name[..]
    };
    format!("{head}_{hash}")
}

/// 用户自定义公开名（别名）的合法性。
///
/// 与 [`public_tool_name`] 的关键区别：默认名允许被「归一化 + 加指纹」改写，别名**不允许** ——
/// 用户在界面上看到的名字必须就是模型看到的名字，静默改写只会变成「我明明填了却不是我填的」。
/// 因此这里只校验、不纠正，错误文案直接给用户看。
///
/// 不在这里拦「与内置工具 / 另一台服务器重名」：那是发布期的判定（`registry::classify`，
/// fail-closed + 界面横幅）。在这里拦会让「以后新增一个同名内置工具」把整份配置卡成
/// 存不进去 —— 用户连改别的服务器都做不到。
pub fn validate_tool_alias(alias: &str) -> Result<(), String> {
    if alias.is_empty() {
        return Err("工具名不能为空".to_string());
    }
    if !alias
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("工具名只能包含字母、数字、下划线和连字符".to_string());
    }
    if alias.len() > MAX_PUBLIC_NAME_LEN {
        return Err(format!(
            "工具名不能超过 {MAX_PUBLIC_NAME_LEN} 个字符（模型函数名的硬上限）"
        ));
    }
    if alias.starts_with(MCP_PREFIX) {
        return Err(format!(
            "工具名不能以 {MCP_PREFIX} 开头（那是旧版命名的前缀，会被当成旧数据解析）"
        ));
    }
    Ok(())
}

/// `raw` 的 SHA-256 前 12 位十六进制 —— 身份指纹（长度与字符集固定）。
fn identity_hash(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..])[..HASH_LEN].to_string()
}

/// 是不是**旧版**公开名（`mcp__<server>__<raw>`）。
///
/// ⚠️ 只用于读旧数据（历史消息卡片、白名单一次性迁移）。**不要**拿它判「这个工具属于 MCP」——
/// 现在的工具名不带前缀，归属只能问 `mcp::route()` / 前端的名称目录。
pub fn is_legacy_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_PREFIX)
}

/// 从**旧版**公开名反推 `(server, raw)`；不是旧版名 / 形状残缺 → `None`。
pub fn split_legacy_mcp_tool_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix(MCP_PREFIX)?;
    let (server, raw) = rest.split_once(SEP)?;
    if server.is_empty() || raw.is_empty() {
        return None;
    }
    Some((server, raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// 黄金值（`naming_fixtures.json`）：算法漂移即红
    #[derive(Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        raw: String,
        expected: String,
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(include_str!("naming_fixtures.json")).expect("命名 fixture 解析失败")
    }

    #[test]
    fn matches_golden_values() {
        for case in fixtures().cases {
            assert_eq!(
                public_tool_name(&case.raw),
                case.expected,
                "raw={:?}",
                case.raw
            );
        }
    }

    #[test]
    fn every_name_fits_provider_contract() {
        for case in fixtures().cases {
            let name = public_tool_name(&case.raw);
            assert!(
                name.len() <= MAX_PUBLIC_NAME_LEN,
                "{name} 超过 {MAX_PUBLIC_NAME_LEN} 字符"
            );
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "{name} 含非法字符"
            );
        }
    }

    #[test]
    fn clean_names_are_left_alone() {
        assert_eq!(public_tool_name("create_issue"), "create_issue");
        assert_eq!(public_tool_name("get_scene_info"), "get_scene_info");
        // 幂等：再算一次结果相同（纯函数）
        assert_eq!(
            public_tool_name("create_issue"),
            public_tool_name("create_issue")
        );
    }

    #[test]
    fn distinct_rawws_never_collapse() {
        // 三种「看起来会撞」的输入：非法字符替换 / 大小写不同 / 超长截断
        let raws = [
            "list/files",
            "list_files",
            "List_files",
            "list files",
            &"a".repeat(80),
        ];
        let mut names: Vec<String> = raws.iter().map(|raw| public_tool_name(raw)).collect();
        names.sort();
        let mut unique = names.clone();
        unique.dedup();
        assert_eq!(names, unique, "不同身份折叠成了同一个名字：{names:?}");
    }

    #[test]
    fn unicode_names_are_ascii_only() {
        let name = public_tool_name("读取");
        assert!(name.is_ascii(), "{name} 应只含 ASCII");
    }

    /// 历史前缀被当成「需要加指纹」：否则一个叫 `mcp__x__y` 的工具会被误认成旧版名
    #[test]
    fn legacy_prefix_is_never_emitted() {
        let name = public_tool_name("mcp__blender__look");
        assert!(!is_legacy_mcp_tool_name(&name), "{name} 不该带历史前缀");
    }

    #[test]
    fn split_round_trips_legacy_names() {
        for (server, raw) in [("github", "create_issue"), ("srv", "a__b")] {
            let name = format!("{MCP_PREFIX}{server}{SEP}{raw}");
            assert_eq!(
                split_legacy_mcp_tool_name(&name),
                Some((server, raw)),
                "{name}"
            );
        }
    }

    #[test]
    fn split_rejects_non_legacy_and_malformed() {
        // 新名字（不带前缀）不是旧版名 —— 归属要走 `mcp::route()`
        assert_eq!(split_legacy_mcp_tool_name("read_file"), None);
        assert_eq!(split_legacy_mcp_tool_name("mcp__"), None);
        assert_eq!(split_legacy_mcp_tool_name("mcp__srv"), None);
        assert_eq!(split_legacy_mcp_tool_name("mcp__srv__"), None);
        assert_eq!(split_legacy_mcp_tool_name("mcp____tool"), None);
    }

    /// 别名只校验、不纠正（用户填什么就是什么，否则界面与下发会分叉）
    #[test]
    fn aliases_are_validated_not_rewritten() {
        for good in ["look", "blender_look", "a-b_C9", &"x".repeat(64)] {
            assert_eq!(validate_tool_alias(good), Ok(()), "{good:?} 应通过");
        }
        for (bad, hint) in [
            ("", "不能为空"),
            ("has space", "只能包含"),
            ("读取", "只能包含"),
            ("list/files", "只能包含"),
            (&"x".repeat(65), "不能超过"),
            ("mcp__blender__look", "不能以"),
        ] {
            let error = validate_tool_alias(bad).expect_err(bad);
            assert!(error.contains(hint), "{bad:?} 的错误文案应是「{hint}」，实得：{error}");
        }
    }
}
