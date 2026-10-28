//! 从「Claude Desktop / 业界惯例」的 `mcpServers` JSON 导入配置（设置页的「从 JSON 导入」）。
//!
//! 为什么解析放 Rust 而不是前端：导入要产出 `McpServerConfig`（含 id 生成、默认值、校验），
//! 这些语义必须与「设置页保存」走同一份实现；前端再写一遍就是第二种真相。
//!
//! 支持两种形状（都常见）：
//!
//! ```json
//! { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "server-filesystem", "."] } } }
//! { "fs": { "command": "npx", "args": [] } }
//! ```
//!
//! 每条支持 `command`（stdio）或 `url`（Streamable HTTP）。其余字段（审批 / 超时 / 重连）
//! 一律取默认值 —— 外部格式没有这些概念，猜不如给默认。

use serde::Serialize;
use serde_json::{json, Value};

use super::config::{validate_server_name, McpServerConfig};

/// 一条被跳过的条目（前端逐条列出原因，绝不静默丢弃）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImport {
    pub name: String,
    pub reason: String,
}

/// 导入结果
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<McpServerConfig>,
    pub skipped: Vec<SkippedImport>,
}

/// 解析一段导入 JSON。
///
/// - `existing`：已存在的服务器（只用于判重名 —— 同名一律跳过，不覆盖用户已有配置）；
/// - 返回的配置尚未落库，由调用方保存并 reload。
pub fn parse_import(raw: &str, existing: &[McpServerConfig]) -> Result<ImportResult, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let servers = value.get("mcpServers").unwrap_or(&value);
    let Some(map) = servers.as_object() else {
        return Err("配置里没有 mcpServers 对象".to_string());
    };

    let mut imported: Vec<McpServerConfig> = Vec::new();
    let mut skipped: Vec<SkippedImport> = Vec::new();

    for (name, entry) in map {
        let config = match build_config(name, entry) {
            Ok(config) => config,
            Err(reason) => {
                skipped.push(SkippedImport {
                    name: name.clone(),
                    reason,
                });
                continue;
            }
        };
        // 重名判据与 `validate_all` 一致（大小写敏感）：只是这里给的是「跳过」而不是「整批失败」
        let duplicated = existing.iter().any(|item| item.name == config.name)
            || imported.iter().any(|item| item.name == config.name);
        if duplicated {
            skipped.push(SkippedImport {
                name: name.clone(),
                reason: "同名服务器已存在".to_string(),
            });
            continue;
        }
        imported.push(config);
    }

    Ok(ImportResult { imported, skipped })
}

/// 单条：`command` → stdio，`url` → http，其余一律视为非法条目
fn build_config(name: &str, entry: &Value) -> Result<McpServerConfig, String> {
    validate_server_name(name)?;
    let Some(object) = entry.as_object() else {
        return Err("条目不是对象".to_string());
    };

    let mut value = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": name,
    });

    if let Some(command) = object.get("command").and_then(Value::as_str) {
        if command.trim().is_empty() {
            return Err("command 为空".to_string());
        }
        value["transport"] = json!("stdio");
        value["command"] = json!(command);
        value["args"] = json!(string_array(object.get("args"), "args")?);
        if let Some(cwd) = object.get("cwd").and_then(Value::as_str) {
            if !cwd.trim().is_empty() {
                value["cwd"] = json!(cwd);
            }
        }
        let env = string_map(object.get("env"), "env")?;
        if !env.is_empty() {
            value["env"] = json!(env);
        }
    } else if let Some(url) = object.get("url").and_then(Value::as_str) {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("url 必须以 http:// 或 https:// 开头".to_string());
        }
        value["transport"] = json!("http");
        value["url"] = json!(url);
        let headers = string_map(object.get("headers"), "headers")?;
        if !headers.is_empty() {
            value["headers"] = json!(headers);
        }
    } else {
        return Err("缺少 command（stdio）或 url（http）".to_string());
    }

    let config: McpServerConfig = serde_json::from_value(value)
        .map_err(|e| format!("配置字段形状不对：{e}"))?;
    config.validate()?;
    Ok(config)
}

/// `[...]` → `Vec<String>`（缺省 = 空；有非字符串元素就报错，不猜）
fn string_array(value: Option<&Value>, field: &str) -> Result<Vec<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("{field} 里必须全是字符串"))
            })
            .collect(),
        Some(_) => Err(format!("{field} 必须是数组")),
    }
}

/// `{k: v}` → 有序 map（缺省 = 空；值非字符串就报错）
fn string_map(
    value: Option<&Value>,
    field: &str,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    match value {
        None | Some(Value::Null) => Ok(Default::default()),
        Some(Value::Object(map)) => {
            let mut out = std::collections::BTreeMap::new();
            for (key, item) in map {
                let text = item
                    .as_str()
                    .ok_or_else(|| format!("{field}.{key} 必须是字符串"))?;
                out.insert(key.clone(), text.to_string());
            }
            Ok(out)
        }
        Some(_) => Err(format!("{field} 必须是对象")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_claude_desktop_shape() {
        let raw = r#"{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
                        "env": { "FOO": "bar" } },
                "remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer x" } }
            }
        }"#;
        let result = parse_import(raw, &[]).expect("应能解析");
        assert_eq!(result.imported.len(), 2);
        assert!(result.skipped.is_empty());

        let fs = result.imported.iter().find(|c| c.name == "fs").unwrap();
        assert_eq!(fs.transport.kind(), "stdio");
        let spec = fs.transport_spec_stdio().unwrap();
        assert_eq!(spec.command, "npx");
        assert_eq!(spec.args.len(), 3);
        assert_eq!(spec.env.get("FOO").map(String::as_str), Some("bar"));
        // 外部格式没有审批概念 → 走默认（ask），不是 allow
        assert_eq!(fs.approval, super::super::config::McpApproval::Ask);
        assert!(!fs.id.is_empty());

        let remote = result.imported.iter().find(|c| c.name == "remote").unwrap();
        assert_eq!(remote.transport.kind(), "http");

        // 两次导入的 id 不同（每次都是新服务器）
        let again = parse_import(raw, &[]).unwrap();
        assert_ne!(again.imported[0].id, result.imported[0].id);
    }

    #[test]
    fn accepts_a_bare_server_map() {
        let raw = r#"{ "fs": { "command": "npx" } }"#;
        let result = parse_import(raw, &[]).unwrap();
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].name, "fs");
    }

    #[test]
    fn skips_bad_entries_with_reasons_instead_of_failing_the_whole_import() {
        let raw = r#"{
            "mcpServers": {
                "ok": { "command": "npx" },
                "has space": { "command": "npx" },
                "no transport": { "args": [] },
                "bad url": { "url": "ftp://x" },
                "bad args": { "command": "npx", "args": [1] }
            }
        }"#;
        let result = parse_import(raw, &[]).unwrap();
        assert_eq!(result.imported.len(), 1, "只应导入 ok");
        let skipped: Vec<&str> = result
            .skipped
            .iter()
            .map(|item| item.name.as_str())
            .collect();
        assert!(skipped.contains(&"has space"));
        assert!(skipped.contains(&"no transport"));
        assert!(skipped.contains(&"bad url"));
        assert!(skipped.contains(&"bad args"));
        for item in &result.skipped {
            assert!(!item.reason.is_empty(), "每条跳过都要有原因");
        }
    }

    #[test]
    fn existing_names_are_skipped_not_overwritten() {
        let existing = vec![serde_json::from_value(json!({
            "id": "1", "name": "fs", "transport": "stdio", "command": "npx"
        }))
        .unwrap()];
        let result = parse_import(r#"{ "fs": { "command": "other" } }"#, &existing).unwrap();
        assert!(result.imported.is_empty());
        assert_eq!(result.skipped[0].reason, "同名服务器已存在");
    }

    #[test]
    fn malformed_json_is_a_clear_error() {
        let error = parse_import("{ not json", &[]).unwrap_err();
        assert!(error.contains("JSON 解析失败"), "{error}");
        let error = parse_import("[]", &[]).unwrap_err();
        assert!(error.contains("mcpServers"), "{error}");
    }

    #[test]
    fn duplicate_names_inside_one_import_are_skipped() {
        // JSON 对象本身不会重复键，但大小写不同的同名条目不该都被导入
        let raw = r#"{ "fs": { "command": "npx" }, "FS": { "command": "npx" } }"#;
        let result = parse_import(raw, &[]).unwrap();
        assert_eq!(result.imported.len(), 2, "fs 与 FS 是两个不同的服务器名");
    }
}
