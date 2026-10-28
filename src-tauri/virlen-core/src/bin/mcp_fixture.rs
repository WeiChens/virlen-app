//! MCP 测试夹具服务器 —— **只用于测试**（`tests/mcp_stdio.rs` 通过 `CARGO_BIN_EXE_mcp-fixture`
//! 定位它）。产物不参与应用打包，也不含任何业务逻辑。
//!
//! 为什么要一个真子进程：stdio 传输里最容易错的从来不是协议解析，而是**进程侧**的东西 ——
//! Windows `.cmd` 垫片、管道读写、半包、进程退出检测、stderr 归类。这些东西只有真的起一个
//! 子进程才测得到；用假 Transport 只能测到「我们自己想象的行为」。
//!
//! 覆盖的行为：
//! - `initialize` 回声客户端请求的版本；`serverInfo` = `mcp-fixture`
//! - `tools/list` **分两页**（验证分页游标）
//! - `tools/call`：`echo`（回参数字符串）/ `structured`（带 structuredContent）/ `fail`（isError）
//! - `resources/list` **分两页**；`resources/read`：文本（`file://notes.md`）/ 二进制（`file://blob.bin`）
//! - 收到 `notifications/initialized` 后主动发一条 `notifications/tools/list_changed`
//!   和一条反向请求 `sampling/createMessage`（验证「客户端必须应答，不能装死」）
//! - stderr 写一行握手日志（验证尾部缓冲）
//!
//! 环境变量：
//! - `VIRLEN_MCP_FIXTURE_CRASH_AFTER_MS=<ms>`：到点自杀（验证断链检测 / 重连）

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn main() {
    eprintln!("[mcp-fixture] ready");

    if let Ok(ms) = std::env::var("VIRLEN_MCP_FIXTURE_CRASH_AFTER_MS") {
        if let Ok(ms) = ms.parse::<u64>() {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                eprintln!("[mcp-fixture] crashing on purpose");
                std::process::exit(7);
            });
        }
    }

    let stdin = std::io::stdin();
    let mut announced = false;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            eprintln!("[mcp-fixture] 收到非 JSON 行（忽略）");
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

        match method.as_str() {
            "initialize" => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18");
                respond(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {
                            "tools": { "listChanged": true },
                            "resources": { "listChanged": false }
                        },
                        "serverInfo": { "name": "mcp-fixture", "version": "0.1.0" },
                        "instructions": "fixture server"
                    }),
                );
            }
            "notifications/initialized" => {
                if !announced {
                    announced = true;
                    // 1) 工具列表变化通知
                    emit(json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/tools/list_changed"
                    }));
                    // 2) 反向请求：客户端必须回 MethodNotFound（不能装死）
                    emit(json!({
                        "jsonrpc": "2.0",
                        "id": "srv-1",
                        "method": "sampling/createMessage",
                        "params": { "note": "unsupported on purpose" }
                    }));
                }
            }
            "tools/list" => {
                let cursor = params.get("cursor").and_then(Value::as_str);
                let result = match cursor {
                    None => json!({
                        "tools": [
                            {
                                "name": "echo",
                                "description": "回声：把参数原样返回",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": { "text": { "type": "string" } },
                                    "required": ["text"]
                                }
                            },
                            {
                                "name": "structured",
                                "description": "带结构化结果",
                                "inputSchema": { "type": "object", "properties": {} }
                            }
                        ],
                        "nextCursor": "p2"
                    }),
                    Some("p2") => json!({
                        "tools": [{
                            "name": "fail",
                            "description": "总是失败（isError）",
                            "inputSchema": { "type": "object", "properties": {} }
                        }]
                    }),
                    Some(other) => {
                        respond_error(&id, -32602, &format!("unknown cursor: {other}"));
                        continue;
                    }
                };
                respond(&id, result);
            }
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                match name.as_str() {
                    "echo" => respond(
                        &id,
                        json!({
                            "content": [{
                                "type": "text",
                                "text": serde_json::to_string(&arguments).unwrap_or_default()
                            }]
                        }),
                    ),
                    "structured" => respond(
                        &id,
                        json!({
                            "content": [{ "type": "text", "text": "3" }],
                            "structuredContent": { "sum": 3 }
                        }),
                    ),
                    "fail" => respond(
                        &id,
                        json!({
                            "content": [{ "type": "text", "text": "boom from fixture" }],
                            "isError": true
                        }),
                    ),
                    other => respond_error(&id, -32601, &format!("unknown tool: {other}")),
                }
            }
            "ping" => respond(&id, json!({})),
            "resources/list" => {
                let cursor = params.get("cursor").and_then(Value::as_str);
                let result = match cursor {
                    None => json!({
                        "resources": [
                            {
                                "uri": "file://notes.md",
                                "name": "notes",
                                "mimeType": "text/markdown",
                                "size": 12,
                                "description": "示例笔记"
                            },
                            {
                                "uri": "file://blob.bin",
                                "name": "blob",
                                "mimeType": "application/octet-stream"
                            }
                        ],
                        "nextCursor": "r2"
                    }),
                    Some("r2") => json!({ "resources": [] }),
                    Some(other) => {
                        respond_error(&id, -32602, &format!("unknown cursor: {other}"));
                        continue;
                    }
                };
                respond(&id, result);
            }
            "resources/read" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default();
                match uri {
                    "file://notes.md" => respond(
                        &id,
                        json!({
                            "contents": [{
                                "uri": "file://notes.md",
                                "mimeType": "text/markdown",
                                "text": "# notes"
                            }]
                        }),
                    ),
                    "file://blob.bin" => respond(
                        &id,
                        json!({
                            "contents": [{
                                "uri": "file://blob.bin",
                                "mimeType": "application/octet-stream",
                                "blob": "AAAA"
                            }]
                        }),
                    ),
                    other => respond_error(&id, -32602, &format!("unknown uri: {other}")),
                }
            }
            // 反向请求的应答（客户端回 MethodNotFound）：记一行就走，不断连接
            "" => {
                if message.get("result").is_some() || message.get("error").is_some() {
                    eprintln!("[mcp-fixture] 收到客户端应答 id={}", id.unwrap_or(Value::Null));
                }
            }
            other => {
                if id.is_some() {
                    respond_error(&id, -32601, &format!("Method not found: {other}"));
                }
            }
        }
    }
    eprintln!("[mcp-fixture] stdin closed, bye");
}

fn respond(id: &Option<Value>, result: Value) {
    let Some(id) = id else { return };
    emit(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn respond_error(id: &Option<Value>, code: i64, message: &str) {
    let Some(id) = id else { return };
    emit(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }));
}

/// 写一行 JSON（`println!` 走 `LineWriter`，遇换行即 flush）
fn emit(message: Value) {
    println!("{}", serde_json::to_string(&message).unwrap_or_default());
    let _ = std::io::stdout().flush();
}
