//! headless CLI（`virlen-cli`）—— 与 GUI 共用同一个 lib 的入口
//!
//! 形态：`virlen-cli <命令> [参数]`。本期（S6 + ③）只落地**配置读写**：
//!
//! ```text
//! virlen-cli config get [key ...]          读全部 / 指定键（JSON 输出）
//! virlen-cli config set [--string] k v     写入（值优先按 JSON 解析）
//! virlen-cli config path                   打印实际使用的库文件路径
//! ```
//!
//! 为什么是这个形态：
//! - **与 GUI 同一份数据**：库路径完全由 `HostEnv::data_dir()` 决定（`CliHost` 的默认值
//!   与 Tauri `app_data_dir()` 同形 → 同一个 `virlen.db`），所以 `config set` 改的就是
//!   桌面端读的那份配置（`app_settings` 表，见 `docs/config-sink-plan.md`）。
//! - **逻辑放 lib、bin 只转发**：bin 目标不被单测引用，因此参数解析与命令实现放本模块，
//!   `src/cli_main.rs` 保持三行 —— 测得到才算落地。
//!
//! ⚠️ 输出文案用**中文**：与 crate 内其它用户可见消息一致（Tauri 命令的错误文案、
//! `eprintln!` 提示）。JSON 输出保持原样，脚本可直接解析。

mod config;

use crate::host::CliHost;
use std::io::Write;

/// 成功
pub const EXIT_OK: i32 = 0;
/// 运行期失败（键不存在 / 库打不开 / 读写失败）
pub const EXIT_ERROR: i32 = 1;
/// 用法错误（未知命令、参数个数不对）
pub const EXIT_USAGE: i32 = 2;

/// 解析后的命令
#[derive(Debug, PartialEq)]
pub(crate) enum Command {
    Help,
    Version,
    Config(config::ConfigCmd),
}

/// 帮助文本（`help` / `--help` / 用法错误时一并打印）
pub const USAGE: &str = "\
Virlen CLI（headless）—— 与桌面端读写同一份配置（app_settings 表）

用法:
  virlen-cli config get [key ...]        读取配置；不指定 key 时输出全部（JSON）
  virlen-cli config set [--string] <key> <value>
                                         写入配置；value 优先按 JSON 解析
                                         （true / 123 / [\"a\"] / {\"k\":1}），
                                         --string 强制按字符串写入
  virlen-cli config path                 打印实际使用的库文件路径（应与 GUI 相同）
                                         库尚未创建时也返回 0，仅在 stderr 给出提示
  virlen-cli help | --help | -h          显示本帮助
  virlen-cli version | --version | -V    显示版本

环境变量:
  VIRLEN_DATA_DIR      覆盖数据目录。默认 <平台数据根>/JianWeichen.virlen，与 GUI 一致
  VIRLEN_RESOURCE_DIR  覆盖资源目录（只影响需要资源文件的工具）

退出码:
  0 成功    1 失败（键不存在 / 库打不开 / 读写失败）    2 用法错误
";

/// 解析参数（`args` **不含**程序名本身）。纯函数 —— 单测直接断言它。
pub(crate) fn parse_args(args: &[String]) -> Result<Command, String> {
    let mut it = args.iter().map(String::as_str);
    let Some(first) = it.next() else {
        // 不带参数 = 看帮助（比静默退出更友好）
        return Ok(Command::Help);
    };
    match first {
        "help" | "--help" | "-h" => Ok(Command::Help),
        "version" | "--version" | "-V" => Ok(Command::Version),
        "config" => config::parse(it.collect()).map(Command::Config),
        other => Err(format!("未知命令: {}", other)),
    }
}

/// CLI 主入口。
///
/// `args` 为 `std::env::args()` 去掉程序名后的部分；输出走注入的 `out` / `err`
/// （不直接读全局流 → 单测可以用 `Vec<u8>` 断言输出）。
/// 返回进程退出码，由 bin 的 `main` 交给 `std::process::exit`。
pub async fn run(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    match parse_args(args) {
        Err(e) => {
            let _ = writeln!(err, "错误: {}\n\n{}", e, USAGE);
            EXIT_USAGE
        }
        Ok(Command::Help) => {
            let _ = write!(out, "{}", USAGE);
            EXIT_OK
        }
        Ok(Command::Version) => {
            let _ = writeln!(out, "virlen-cli {}", env!("CARGO_PKG_VERSION"));
            EXIT_OK
        }
        // 只有真正要读写的子命令才去推导宿主 / 打开库：
        // `help` / `version` 因此不会因为「数据目录不可用」而失败。
        Ok(Command::Config(cmd)) => {
            let host = CliHost::from_env();
            config::run(&host, cmd, out, err).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_args_show_help() {
        assert_eq!(parse_args(&[]), Ok(Command::Help));
        for a in ["help", "--help", "-h"] {
            assert_eq!(parse_args(&args(&[a])), Ok(Command::Help));
        }
        for a in ["version", "--version", "-V"] {
            assert_eq!(parse_args(&args(&[a])), Ok(Command::Version));
        }
    }

    /// `config set` 的值：能当 JSON 解析就当 JSON，否则当字符串（裸值不必手动加引号）
    #[test]
    fn set_parses_value_as_json_then_falls_back_to_string() {
        let cmd = parse_args(&args(&["config", "set", "maxTokens", "4096"])).unwrap();
        assert_eq!(
            cmd,
            Command::Config(config::ConfigCmd::Set {
                key: "maxTokens".into(),
                value: json!(4096),
            })
        );

        let cmd = parse_args(&args(&["config", "set", "defaultSelectModel", "gpt-4o"])).unwrap();
        assert_eq!(
            cmd,
            Command::Config(config::ConfigCmd::Set {
                key: "defaultSelectModel".into(),
                value: Value::String("gpt-4o".into()),
            })
        );

        let cmd = parse_args(&args(&["config", "set", "providers", r#"[{"id":"p1"}]"#])).unwrap();
        assert_eq!(
            cmd,
            Command::Config(config::ConfigCmd::Set {
                key: "providers".into(),
                value: json!([{ "id": "p1" }]),
            })
        );
    }

    /// `--string` 强制按字符串写入：`4096` 是数字，但加上开关就是字符串 "4096"
    #[test]
    fn set_string_flag_forces_string_value() {
        let cmd = parse_args(&args(&["config", "set", "--string", "someId", "4096"])).unwrap();
        assert_eq!(
            cmd,
            Command::Config(config::ConfigCmd::Set {
                key: "someId".into(),
                value: Value::String("4096".into()),
            })
        );
    }

    /// 用法错误必须是「可读的用法提示」而不是 panic
    #[test]
    fn usage_errors_are_reported() {
        assert!(parse_args(&args(&["nope"])).is_err());
        assert!(parse_args(&args(&["config"])).is_err());
        assert!(parse_args(&args(&["config", "nope"])).is_err());
        assert!(parse_args(&args(&["config", "set", "only-key"])).is_err());
        assert!(parse_args(&args(&["config", "set", "a", "b", "c"])).is_err());
        assert!(parse_args(&args(&["config", "set", "--string", "a"])).is_err());
    }

    #[tokio::test]
    async fn help_and_version_do_not_touch_the_database() {
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(run(&[], &mut out, &mut err).await, EXIT_OK);
        assert!(String::from_utf8(out).unwrap().contains("用法:"));

        let mut out = Vec::new();
        assert_eq!(
            run(&args(&["version"]), &mut out, &mut err).await,
            EXIT_OK
        );
        assert!(String::from_utf8(out).unwrap().starts_with("virlen-cli "));
    }

    #[tokio::test]
    async fn unknown_command_exits_with_usage_code() {
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(
            run(&args(&["nope"]), &mut out, &mut err).await,
            EXIT_USAGE
        );
        assert!(String::from_utf8(err).unwrap().contains("未知命令"));
    }
}
