//! MCP `inputSchema` 清洗 —— 把「任意 JSON Schema」收敛到三大 provider 都吃得下的子集。
//!
//! 为什么必须有这一层：MCP 生态里 Zod / TypeBox 生成的 schema 大量使用 `$ref` + `$defs`，
//! 而本项目的 `ToolParameters` 是简化结构（`type` / `properties` / `required` / `oneOf`）。
//! 不处理会踩三种真实故障：
//!
//! 1. 嵌套 schema 在序列化给 provider 时**静默丢失**（用户看到「工具参数不对」但没人报错）；
//! 2. `required` 指向已被删除的属性 → OpenAI 严格模式整请求 400；
//! 3. `$ref` / `$schema` 这类关键字被 Gemini 直接拒掉（它只认 OpenAPI 子集）。
//!
//! 处理策略（宁松不炸）：能内联就内联；内联不了（远端 `$ref` / 循环 / 超深）就**降级**成
//! 宽松 object，并把原因写进 `description`，让模型知道「参数是自由格式」而不是瞎猜。

use serde_json::{Map, Value};

/// `$ref` 内联深度上限：防「A → B → A」之外的长链把请求体撑爆
const MAX_REF_DEPTH: usize = 8;

/// 清洗一个 MCP 输入 schema，返回**恒为 object 类型**的 JSON Schema。
pub fn sanitize(input: &Value) -> Value {
    let defs = collect_defs(input);
    let resolved = resolve_node(input, &defs, 0, &mut Vec::new());

    let mut obj = match resolved {
        Value::Object(map) => map,
        // 布尔 schema（`true` / `false`）或非对象：只能当自由格式
        _ => return degraded(None),
    };
    strip_bookkeeping_keys(&mut obj);

    let properties = match obj.get("properties") {
        Some(Value::Object(props)) => props.clone(),
        Some(_) => return degraded(description_of(&obj)), // properties 不是对象 → 不可信
        None => {
            // 没有 properties 但有 anyOf/oneOf/allOf：三家 provider 都不支持顶层联合
            if obj.contains_key("anyOf") || obj.contains_key("oneOf") || obj.contains_key("allOf") {
                return degraded(description_of(&obj));
            }
            Map::new()
        }
    };
    if let Some(ty) = obj.get("type").and_then(Value::as_str) {
        if ty != "object" {
            return degraded(description_of(&obj));
        }
    }

    obj.insert("type".to_string(), Value::String("object".to_string()));
    obj.insert("properties".to_string(), Value::Object(properties.clone()));
    // required 只保留真实存在的属性（OpenAI 严格模式的硬要求）
    let required = obj
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            let mut kept: Vec<Value> = Vec::new();
            for item in arr {
                let Some(name) = item.as_str() else { continue };
                if !properties.contains_key(name) {
                    continue;
                }
                if kept.iter().any(|v| v.as_str() == Some(name)) {
                    continue;
                }
                kept.push(Value::String(name.to_string()));
            }
            kept
        })
        .unwrap_or_default();
    obj.insert("required".to_string(), Value::Array(required));

    Value::Object(obj)
}

// ==================== 内部实现 ====================

/// `$defs` / `definitions` 合并成一张名字表（内联时用）
fn collect_defs(input: &Value) -> Map<String, Value> {
    let mut defs = Map::new();
    let Some(obj) = input.as_object() else {
        return defs;
    };
    for key in ["$defs", "definitions"] {
        if let Some(Value::Object(map)) = obj.get(key) {
            for (name, node) in map {
                defs.entry(name.clone()).or_insert_with(|| node.clone());
            }
        }
    }
    defs
}

/// 递归解析（`$ref` 内联 + 剥掉 `$`-开头的簿记关键字）。
///
/// `stack` 记录当前内联链上的 `$ref`，用于识别循环引用（A→B→A 会无限展开）。
fn resolve_node(
    node: &Value,
    defs: &Map<String, Value>,
    depth: usize,
    stack: &mut Vec<String>,
) -> Value {
    let Some(obj) = node.as_object() else {
        return node.clone();
    };

    if let Some(reference) = obj.get("$ref").and_then(Value::as_str) {
        if depth >= MAX_REF_DEPTH || stack.iter().any(|r| r.as_str() == reference) {
            return degraded(description_of(obj));
        }
        let Some(name) = local_ref_name(reference) else {
            // 远端 `$ref`（`https://…` / 同级文件）：拿不到定义
            return degraded(description_of(obj));
        };
        let Some(target) = defs.get(&name) else {
            return degraded(description_of(obj));
        };
        stack.push(reference.to_string());
        let mut resolved = resolve_node(target, defs, depth + 1, stack);
        stack.pop();
        merge_annotations(&mut resolved, obj);
        return resolved;
    }

    let mut out = Map::new();
    for (key, value) in obj {
        match key.as_str() {
            "properties" => match value.as_object() {
                Some(props) => {
                    let mut mapped = Map::new();
                    for (prop_name, prop) in props {
                        mapped.insert(prop_name.clone(), resolve_node(prop, defs, depth, stack));
                    }
                    out.insert(key.clone(), Value::Object(mapped));
                }
                None => {
                    out.insert(key.clone(), value.clone());
                }
            },
            // 单节点子 schema
            "items" | "additionalProperties" | "not" | "contains" | "propertyNames" | "if"
            | "then" | "else" => {
                out.insert(key.clone(), resolve_node(value, defs, depth, stack));
            }
            // 节点数组
            "anyOf" | "oneOf" | "allOf" | "prefixItems" => match value.as_array() {
                Some(arr) => {
                    let mapped: Vec<Value> = arr
                        .iter()
                        .map(|item| resolve_node(item, defs, depth, stack))
                        .collect();
                    out.insert(key.clone(), Value::Array(mapped));
                }
                None => {
                    out.insert(key.clone(), value.clone());
                }
            },
            // 簿记关键字：内联后没有意义（留着会被 provider 拒）
            "$defs" | "definitions" | "$schema" | "$id" | "$comment" | "$anchor" => {}
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// `#/$defs/<name>` / `#/definitions/<name>` → `Some(name)`；其余（远端 / 深路径）→ `None`
fn local_ref_name(reference: &str) -> Option<String> {
    let rest = reference
        .strip_prefix("#/$defs/")
        .or_else(|| reference.strip_prefix("#/definitions/"))?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    // JSON Pointer 转义（`~1` → `/`、`~0` → `~`）：名字里带这些字符时才算真名
    Some(rest.replace("~1", "/").replace("~0", "~"))
}

/// `$ref` 旁边的注解（`description` / `title`）补到解析结果上（2020-12 允许这种写法）
fn merge_annotations(resolved: &mut Value, source: &Map<String, Value>) {
    let Some(target) = resolved.as_object_mut() else {
        return;
    };
    for key in ["description", "title"] {
        if target.contains_key(key) {
            continue;
        }
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn description_of(obj: &Map<String, Value>) -> Option<&str> {
    obj.get("description").and_then(Value::as_str)
}

fn strip_bookkeeping_keys(obj: &mut Map<String, Value>) {
    for key in ["$defs", "definitions", "$schema", "$id", "$comment", "$anchor"] {
        obj.remove(key);
    }
}

/// 降级：宽松 object + 一句说明（告诉模型「别指望结构化参数」）
fn degraded(description: Option<&str>) -> Value {
    let mut map = Map::new();
    map.insert("type".to_string(), Value::String("object".to_string()));
    map.insert("properties".to_string(), Value::Object(Map::new()));
    let hint = "This tool's parameter schema could not be represented as a plain object schema; \
                treat the arguments as free-form and follow the tool description.";
    let text = match description.map(str::trim).filter(|d| !d.is_empty()) {
        Some(existing) => format!("{existing}\n\n{hint}"),
        None => hint.to_string(),
    };
    map.insert("description".to_string(), Value::String(text));
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_object_schema_is_kept() {
        let input = json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径" },
                "limit": { "type": "integer", "default": 10 }
            },
            "required": ["path"],
            "additionalProperties": false
        });
        let out = sanitize(&input);
        assert_eq!(out["type"], "object");
        assert_eq!(out["properties"]["path"]["type"], "string");
        assert_eq!(out["properties"]["limit"]["default"], 10);
        assert_eq!(out["required"], json!(["path"]));
        // additionalProperties 是 OpenAI 严格模式要的，不能剥
        assert_eq!(out["additionalProperties"], false);
    }

    #[test]
    fn local_refs_are_inlined() {
        let input = json!({
            "type": "object",
            "$defs": {
                "Filter": {
                    "type": "object",
                    "properties": { "q": { "type": "string" } },
                    "required": ["q"]
                }
            },
            "properties": {
                "filter": { "$ref": "#/$defs/Filter" }
            },
            "required": ["filter"]
        });
        let out = sanitize(&input);
        assert_eq!(out["properties"]["filter"]["type"], "object");
        assert_eq!(out["properties"]["filter"]["properties"]["q"]["type"], "string");
        assert_eq!(out["properties"]["filter"]["required"], json!(["q"]));
        assert!(out.get("$defs").is_none(), "$defs 内联后应被剥掉");
    }

    #[test]
    fn legacy_definitions_are_inlined_too() {
        let input = json!({
            "type": "object",
            "definitions": { "Item": { "type": "string" } },
            "properties": { "items": { "type": "array", "items": { "$ref": "#/definitions/Item" } } }
        });
        let out = sanitize(&input);
        assert_eq!(out["properties"]["items"]["items"]["type"], "string");
        assert!(out.get("definitions").is_none());
    }

    #[test]
    fn ref_sibling_description_survives() {
        let input = json!({
            "type": "object",
            "$defs": { "S": { "type": "string" } },
            "properties": { "x": { "$ref": "#/$defs/S", "description": "说明" } }
        });
        let out = sanitize(&input);
        assert_eq!(out["properties"]["x"]["type"], "string");
        assert_eq!(out["properties"]["x"]["description"], "说明");
    }

    #[test]
    fn remote_ref_degrades_instead_of_exploding() {
        let input = json!({
            "type": "object",
            "properties": {
                "x": { "$ref": "https://example.com/schema.json#/defs/X", "description": "远端" }
            }
        });
        let out = sanitize(&input);
        assert_eq!(out["properties"]["x"]["type"], "object");
        assert!(out["properties"]["x"]["description"]
            .as_str()
            .unwrap()
            .contains("free-form"));
    }

    #[test]
    fn circular_refs_terminate() {
        let input = json!({
            "type": "object",
            "$defs": {
                "A": { "type": "object", "properties": { "b": { "$ref": "#/$defs/B" } } },
                "B": { "type": "object", "properties": { "a": { "$ref": "#/$defs/A" } } }
            },
            "properties": { "root": { "$ref": "#/$defs/A" } }
        });
        let out = sanitize(&input); // 不 hang 就算过
        assert_eq!(out["properties"]["root"]["type"], "object");
    }

    #[test]
    fn required_is_pruned_to_existing_properties() {
        let input = json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "required": ["a", "gone", "gone", 7]
        });
        let out = sanitize(&input);
        assert_eq!(out["required"], json!(["a"]));
    }

    #[test]
    fn bookkeeping_keys_are_stripped() {
        let input = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "urn:example",
            "type": "object",
            "properties": { "a": { "type": "string" } }
        });
        let out = sanitize(&input);
        assert!(out.get("$schema").is_none());
        assert!(out.get("$id").is_none());
        assert_eq!(out["properties"]["a"]["type"], "string");
    }

    #[test]
    fn top_level_union_degrades_to_object() {
        let input = json!({
            "anyOf": [
                { "type": "object", "properties": { "a": { "type": "string" } } },
                { "type": "string" }
            ],
            "description": "两选一"
        });
        let out = sanitize(&input);
        assert_eq!(out["type"], "object");
        assert_eq!(out["properties"], json!({}));
        assert!(out["description"].as_str().unwrap().starts_with("两选一"));
        assert!(out["description"].as_str().unwrap().contains("free-form"));
    }

    #[test]
    fn non_object_type_degrades() {
        let out = sanitize(&json!({ "type": "string" }));
        assert_eq!(out["type"], "object");
        assert_eq!(out["properties"], json!({}));
    }

    #[test]
    fn boolean_schema_degrades() {
        for input in [json!(true), json!(false), json!({})] {
            let out = sanitize(&input);
            assert_eq!(out["type"], "object");
            assert_eq!(out["properties"], json!({}));
        }
    }

    #[test]
    fn missing_type_defaults_to_object() {
        let out = sanitize(&json!({ "properties": { "a": { "type": "number" } } }));
        assert_eq!(out["type"], "object");
        assert_eq!(out["properties"]["a"]["type"], "number");
        assert_eq!(out["required"], json!([]));
    }

    #[test]
    fn nested_arrays_and_anyof_are_resolved() {
        let input = json!({
            "type": "object",
            "$defs": { "N": { "type": "number" } },
            "properties": {
                "list": {
                    "type": "array",
                    "items": { "anyOf": [{ "$ref": "#/$defs/N" }, { "type": "null" }] }
                }
            }
        });
        let out = sanitize(&input);
        let items = &out["properties"]["list"]["items"];
        assert_eq!(items["anyOf"][0]["type"], "number");
        assert_eq!(items["anyOf"][1]["type"], "null");
    }
}
