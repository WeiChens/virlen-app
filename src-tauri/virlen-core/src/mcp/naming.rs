//! 公开工具名 —— 模型可见的 MCP 工具身份。
//!
//! 规则（与 `docs/mcp-plan.md` §4.3、dsh `mcp-client/src/tools.ts` 同构）：
//!
//! - 干净情况：`mcp__<serverName>__<rawName>` 原样；
//! - 发生字符替换或超长截断时，追加 **12 位 SHA-256(`server\0raw`)** 前缀哈希 ——
//!   不同身份**绝不折叠**成同一个名字（否则历史消息里的工具名会指向另一个工具）；
//! - 上限 **64** 字符（三大 provider 的函数名契约），字符集 `[A-Za-z0-9_-]`。
//!
//! ⚠️ 算法一旦发布就是 v1 契约：改它等于让所有会话历史与权限规则失效。
//! `naming_fixtures.json` 里的黄金值由 Rust 与 TS 两侧的测试共同持有（同一份文件），
//! 任何一侧漂移都会红。

use sha2::{Digest, Sha256};

/// 公开名前缀 —— 保留命名空间：内置 37 个工具不允许以它开头。
pub const MCP_PREFIX: &str = "mcp__";

/// 服务器名与工具名之间的分隔符（`serverName` 校验禁止出现 `__`，故可安全切分）。
const SEP: &str = "__";

/// provider 函数名上限（OpenAI / Anthropic / Gemini 的交集）
const MAX_PUBLIC_NAME_LEN: usize = 64;

/// 哈希后缀长度（十六进制字符数）
const HASH_LEN: usize = 12;

/// 取一个 MCP 工具对模型可见的名字。
///
/// 纯函数：同一 `(server, raw)` 永远返回同一字符串；不同对绝不返回同一字符串。
pub fn public_tool_name(server: &str, raw: &str) -> String {
    let joined = format!("{MCP_PREFIX}{server}{SEP}{raw}");
    // 逐字符替换（不是逐字节）：多字节字符替换成**一个**下划线，否则长度会随编码漂移
    let normalized: String = joined
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    // 归一化后全是 ASCII → 字节长度即字符长度，切片安全
    if normalized == joined && normalized.len() <= MAX_PUBLIC_NAME_LEN {
        return normalized;
    }

    let hash = identity_hash(server, raw);
    let keep = MAX_PUBLIC_NAME_LEN - HASH_LEN - 1;
    let head = if normalized.len() > keep {
        &normalized[..keep]
    } else {
        &normalized[..]
    };
    format!("{head}_{hash}")
}

/// `server\0raw` 的 SHA-256 前 12 位十六进制 —— 身份指纹（长度与字符集固定）。
fn identity_hash(server: &str, raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(server.as_bytes());
    hasher.update([0u8]);
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..])[..HASH_LEN].to_string()
}

/// 这个名字是不是 MCP 工具（引擎按它决定走 MCP 分发而不是原生/JS 桥）。
pub fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_PREFIX)
}

/// 从公开名反推 `(server, raw)` —— **只用于展示分组**。
///
/// 权威信息来自 `McpToolInfo`（Rust 侧同时持有 serverName 与 rawName）；
/// 名字被哈希归一化过时这里只能给出「近似」结果，故不作为路由依据。
pub fn split_mcp_tool_name(name: &str) -> Option<(&str, &str)> {
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

    /// 与 TS 共用的黄金值（`src/tests/domain/mcp-naming.test.ts` 读同一份文件）
    #[derive(Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        server: String,
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
                public_tool_name(&case.server, &case.raw),
                case.expected,
                "server={:?} raw={:?}",
                case.server,
                case.raw
            );
        }
    }

    #[test]
    fn every_name_fits_provider_contract() {
        for case in fixtures().cases {
            let name = public_tool_name(&case.server, &case.raw);
            assert!(
                name.len() <= MAX_PUBLIC_NAME_LEN,
                "{name} 超过 {MAX_PUBLIC_NAME_LEN} 字符"
            );
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "{name} 含非法字符"
            );
            assert!(is_mcp_tool_name(&name), "{name} 缺 mcp__ 前缀");
        }
    }

    #[test]
    fn clean_names_are_left_alone() {
        assert_eq!(public_tool_name("github", "create_issue"), "mcp__github__create_issue");
        // 幂等：再算一次结果相同（纯函数）
        assert_eq!(
            public_tool_name("github", "create_issue"),
            public_tool_name("github", "create_issue")
        );
    }

    #[test]
    fn distinct_identities_never_collapse() {
        // 三种「看起来会撞」的输入：非法字符替换 / 大小写不同 / 分隔符出现在 raw 里
        let pairs = [
            ("my tools", "list/files"),
            ("my_tools", "list_files"),
            ("my-tools", "list_files"),
            ("my_tools", "list__files"),
            ("my_tools", "List_files"),
        ];
        let mut names = Vec::new();
        for (server, raw) in pairs {
            names.push(public_tool_name(server, raw));
        }
        names.sort();
        let unique = {
            let mut copy = names.clone();
            copy.dedup();
            copy
        };
        assert_eq!(names, unique, "不同身份折叠成了同一个名字：{names:?}");
    }

    #[test]
    fn unicode_names_are_ascii_only() {
        let name = public_tool_name("工具", "读取");
        assert!(name.is_ascii(), "{name} 应只含 ASCII");
    }

    #[test]
    fn split_round_trips_clean_names() {
        for (server, raw) in [
            ("github", "create_issue"),
            ("fs", "read_file"),
            ("a", "b"),
            ("notes", "search_v2"),
            // raw 里含 `__`：切分点仍在 **第一个** 分隔符（serverName 校验禁止 `__`）
            ("srv", "a__b"),
        ] {
            let name = public_tool_name(server, raw);
            assert_eq!(split_mcp_tool_name(&name), Some((server, raw)), "{name}");
        }
    }

    #[test]
    fn split_rejects_non_mcp_and_malformed() {
        assert_eq!(split_mcp_tool_name("read_file"), None);
        assert_eq!(split_mcp_tool_name("mcp__"), None);
        assert_eq!(split_mcp_tool_name("mcp__srv"), None);
        assert_eq!(split_mcp_tool_name("mcp__srv__"), None);
        assert_eq!(split_mcp_tool_name("mcp____tool"), None);
    }

    #[test]
    fn prefix_is_reserved_for_mcp() {
        // 内置工具名里不允许出现这个前缀（P1 的契约测试会再断言一次）
        for builtin in ["read_file", "execute_command", "todo_write"] {
            assert!(!is_mcp_tool_name(builtin));
        }
    }
}
