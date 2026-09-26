//! `config` 子命令 —— headless 读写 `app_settings`（配置下沉 D3 的 CLI 入口）
//!
//! 补偿「配置不可用编辑器手改」的易用性损失（`docs/config-sink-plan.md` §0 代价 3）：GUI 与 CLI 写的是同
//! 一个 `virlen.db` 的 `app_settings` 表。
//!
//! ⚠️ 键名与前端 `SettingsStore` 字段同名（camelCase，如 `providers` / `sandboxMode`），Rust 侧不建映射
//! 表 —— 这是「避免两侧字段漂移」的关键约定。因此本命令不校验键名（Rust 侧没有权威 schema）：写错键名会
//! 新增一行垃圾配置，而不是报错；这是有意的取舍（否则就得在 Rust 侧维护一份字段清单，反而引入漂移源）。

use virlen_core::agent::host::HostEnv;
use virlen_core::session_db::{open_session_db, SettingsRepo};
use serde_json::{Map, Value};
use std::io::Write;

use crate::{EXIT_ERROR, EXIT_OK, EXIT_USAGE};

/// `config` 的子命令
#[derive(Debug, PartialEq)]
pub(crate) enum ConfigCmd {
    /// 读取全部（`keys` 为空）或指定键
    Get(Vec<String>),
    /// 写入单个键（值已在解析阶段定型）
    Set { key: String, value: Value },
    /// 打印实际使用的库文件路径（验证 CLI 与 GUI 指向同一份）
    Path,
}

/// 解析 `config` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<ConfigCmd, String> {
    let mut it = args.into_iter();
    let Some(sub) = it.next() else {
        return Err("config 缺少子命令（可用: get / set / path）".to_string());
    };
    let rest: Vec<&str> = it.collect();
    match sub {
        "get" => Ok(ConfigCmd::Get(rest.iter().map(|s| s.to_string()).collect())),
        "set" => {
            // `--string` 只认紧跟在 set 之后的位置（避免与「值恰好叫 --string」混淆）
            let (forced_string, rest) = match rest.first() {
                Some(&"--string") => (true, &rest[1..]),
                _ => (false, &rest[..]),
            };
            match rest {
                [key, raw] => Ok(ConfigCmd::Set {
                    key: (*key).to_string(),
                    value: if forced_string {
                        Value::String((*raw).to_string())
                    } else {
                        parse_value(raw)
                    },
                }),
                _ => Err("用法: config set [--string] <key> <value>".to_string()),
            }
        }
        "path" => Ok(ConfigCmd::Path),
        other => Err(format!(
            "config 未知子命令: {}（可用: get / set / path）",
            other
        )),
    }
}

/// 值解析：优先按 JSON 解析（`true` / `123` / `["a"]` / `{"k":1}`），
/// 失败则按**字符串**处理 —— `gpt-4o`、`sk-xxx`、`D:\work` 这类裸值不必手动加引号。
fn parse_value(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// 执行 `config` 子命令。返回进程退出码。
pub(super) async fn run(
    host: &dyn HostEnv,
    cmd: ConfigCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // 库路径与会话库**同一条推导链**（`host.data_dir()/virlen.db`）——
    // 这正是「CLI 与 GUI 同一份配置」的落点，不要在这里另拼路径。
    let db_path = host.data_dir().join("virlen.db");

    // `path` 只回答「在哪」，**不建库**（否则一个只读查询会顺手创建文件）。
    // 退出码始终 0：路径这个答案**总是存在**；「库还没建」只是提示，不是失败
    //（脚本要判存在与否用 `Test-Path` 即可，stdout 保持「只有路径」一行）。
    if let ConfigCmd::Path = cmd {
        let _ = writeln!(out, "{}", db_path.display());
        if !db_path.exists() {
            let _ = writeln!(err, "提示: 该文件尚不存在（桌面端首次启动后才会创建）");
        }
        return EXIT_OK;
    }

    let db = match open_session_db(host, &|fut| {
        tokio::spawn(fut);
    }) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(
                err,
                "错误: 打开数据库失败 ({}): {}",
                db_path.display(),
                e
            );
            return EXIT_ERROR;
        }
    };
    let settings: &dyn SettingsRepo = db.settings.as_ref();

    match cmd {
        ConfigCmd::Get(keys) => get(settings, &keys, out, err).await,
        ConfigCmd::Set { key, value } => set(settings, &key, value, out, err).await,
        ConfigCmd::Path => unreachable!("path 已在上面返回"),
    }
}

/// `config get`：不指定 key 时输出整表；指定时输出**只含这些键**的对象。
///
/// 有键不存在 → stderr 警告 + 退出码 1（stdout 仍是合法 JSON，脚本可两头都用：
/// 解析 stdout 取值，看退出码判断「是不是全都有」）。
async fn get(
    settings: &dyn SettingsRepo,
    keys: &[String],
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let all: Map<String, Value> = match settings.get_all().await {
        Ok(m) => m,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取配置失败: {}", e);
            return EXIT_ERROR;
        }
    };

    if keys.is_empty() {
        // `serde_json::Map` 默认是 BTreeMap → 输出按 key 排序，稳定可 diff
        let _ = writeln!(out, "{}", to_pretty(&Value::Object(all)));
        return EXIT_OK;
    }

    let mut picked = Map::new();
    let mut missing: Vec<&str> = Vec::new();
    for k in keys {
        match all.get(k) {
            Some(v) => {
                picked.insert(k.clone(), v.clone());
            }
            None => missing.push(k),
        }
    }
    let _ = writeln!(out, "{}", to_pretty(&Value::Object(picked)));
    if !missing.is_empty() {
        let _ = writeln!(err, "警告: 配置键不存在: {}", missing.join(", "));
        return EXIT_ERROR;
    }
    EXIT_OK
}

/// `config set`：单键 upsert（写入是短事务，与会话写入共用同一把连接锁 → 不会 SQLITE_BUSY）。
async fn set(
    settings: &dyn SettingsRepo,
    key: &str,
    value: Value,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if key.trim().is_empty() {
        let _ = writeln!(err, "错误: key 不能为空");
        return EXIT_USAGE;
    }
    let mut entries = Map::new();
    entries.insert(key.to_string(), value.clone());
    match settings.upsert(entries).await {
        Ok(()) => {
            // 回显写成 JSON（与 `get` 的取值口径一致，便于人工核对）
            let _ = writeln!(out, "已写入 app_settings: {} = {}", key, value);
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: 写入配置失败: {}", e);
            EXIT_ERROR
        }
    }
}

/// 序列化失败兜底（`Value` 一定能序列化，这里的 `unwrap_or` 只是不留 panic 面）
fn to_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use virlen_core::host::CliHost;
    use serde_json::json;
    use std::path::PathBuf;

    fn args(v: &[&'static str]) -> Vec<&'static str> {
        v.to_vec()
    }

    /// 每个用例独占一个临时数据目录 —— 它就是「CLI 与 GUI 同一个目录」的替身
    fn temp_host() -> (CliHost, PathBuf) {
        let dir = std::env::temp_dir().join(format!("virlen_cli_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (CliHost::new(vec![], dir.clone()), dir)
    }

    #[test]
    fn parses_subcommands() {
        assert_eq!(parse(args(&["get"])), Ok(ConfigCmd::Get(vec![])));
        assert_eq!(
            parse(args(&["get", "providers", "sandboxMode"])),
            Ok(ConfigCmd::Get(vec![
                "providers".to_string(),
                "sandboxMode".to_string()
            ]))
        );
        assert_eq!(parse(args(&["path"])), Ok(ConfigCmd::Path));
        assert_eq!(
            parse(args(&["set", "sandboxMode", "off"])),
            Ok(ConfigCmd::Set {
                key: "sandboxMode".into(),
                value: Value::String("off".into())
            })
        );
        // 值为布尔 / 数字 / 对象 → 按 JSON 定型
        assert_eq!(
            parse(args(&["set", "telemetryEnabled", "true"])),
            Ok(ConfigCmd::Set {
                key: "telemetryEnabled".into(),
                value: json!(true)
            })
        );
        assert_eq!(
            parse(args(&["set", "--string", "maxTokens", "4096"])),
            Ok(ConfigCmd::Set {
                key: "maxTokens".into(),
                value: Value::String("4096".into())
            })
        );
        assert!(parse(args(&[])).is_err());
        assert!(parse(args(&["nope"])).is_err());
        assert!(parse(args(&["set", "k"])).is_err());
    }

    /// 端到端（真 SQLite）：写入 → 重新打开同一个目录 → 读到同一份值。
    /// 这条用例等价于「CLI 写、GUI 读」的路径（两侧只看 `host.data_dir()`）。
    #[tokio::test]
    async fn set_then_get_roundtrip_shares_one_database() {
        let (host, dir) = temp_host();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &host,
            ConfigCmd::Set {
                key: "defaultSelectModel".into(),
                value: Value::String("gpt-4o".into()),
            },
            &mut out,
            &mut err,
        )
        .await;
        assert_eq!(code, EXIT_OK, "stderr={}", String::from_utf8_lossy(&err));

        // 第二个「进程」：同一数据目录、全新宿主 → 必须读到刚写的值
        let (host2, _) = (CliHost::new(vec![], dir.clone()), ());
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&host2, ConfigCmd::Get(vec![]), &mut out, &mut err).await;
        assert_eq!(code, EXIT_OK);
        let printed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(printed["defaultSelectModel"], json!("gpt-4o"));
    }

    /// 指定键：只输出被点名的键；缺失的键报警告并按失败退出（stdout 仍合法）
    #[tokio::test]
    async fn get_selected_keys_reports_missing() {
        let (host, _) = temp_host();
        let mut out = Vec::new();
        let mut err = Vec::new();
        run(
            &host,
            ConfigCmd::Set {
                key: "sandboxMode".into(),
                value: Value::String("on".into()),
            },
            &mut out,
            &mut err,
        )
        .await;

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &host,
            ConfigCmd::Get(vec!["sandboxMode".into(), "noSuchKey".into()]),
            &mut out,
            &mut err,
        )
        .await;
        assert_eq!(code, EXIT_ERROR);
        let printed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(printed["sandboxMode"], json!("on"));
        assert!(printed.get("noSuchKey").is_none(), "缺失键不进 stdout");
        assert!(String::from_utf8_lossy(&err).contains("noSuchKey"));
    }

    /// 空表也要输出合法 JSON（`{}`），不能什么都不打印
    #[tokio::test]
    async fn get_on_empty_table_prints_empty_object() {
        let (host, _) = temp_host();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&host, ConfigCmd::Get(vec![]), &mut out, &mut err).await;
        assert_eq!(code, EXIT_OK);
        assert_eq!(String::from_utf8_lossy(&out).trim(), "{}");
    }

    /// `path` 只回答路径：**不得**创建库文件（否则只读查询会留下副作用），
    /// 且「库尚未创建」不算失败（stdout 仍只有一行路径）
    #[tokio::test]
    async fn path_does_not_create_database() {
        let (host, dir) = temp_host();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&host, ConfigCmd::Path, &mut out, &mut err).await;

        let printed = String::from_utf8_lossy(&out).trim().to_string();
        assert_eq!(printed, dir.join("virlen.db").display().to_string());
        assert_eq!(code, EXIT_OK);
        assert!(String::from_utf8_lossy(&err).contains("尚不存在"));
        assert!(!dir.join("virlen.db").exists(), "path 不得建库");

        // 建库之后同一命令不再提示，且 stdout 一模一样
        let mut out = Vec::new();
        let mut err = Vec::new();
        run(&host, ConfigCmd::Get(vec![]), &mut out, &mut err).await;
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(run(&host, ConfigCmd::Path, &mut out, &mut err).await, EXIT_OK);
        assert_eq!(String::from_utf8_lossy(&out).trim(), printed);
        assert!(!String::from_utf8_lossy(&err).contains("尚不存在"));
    }

    /// 空 key 是用法错误（不写库）
    #[tokio::test]
    async fn empty_key_is_usage_error() {
        let (host, _) = temp_host();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &host,
            ConfigCmd::Set {
                key: "   ".into(),
                value: json!(1),
            },
            &mut out,
            &mut err,
        )
        .await;
        assert_eq!(code, EXIT_USAGE);
    }
}
