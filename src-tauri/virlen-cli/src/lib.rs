//! `virlen-cli` —— Virlen 的 headless 入口（**命令实现本体**，不是空壳）
//!
//! 形态：`virlen-cli <命令> [参数]`。已落地：
//!
//! ```text
//! virlen-cli config get [key ...]             读全部 / 指定键（JSON 输出）
//! virlen-cli config set [--string] k v        写入（值优先按 JSON 解析）
//! virlen-cli config path                      打印实际使用的库文件路径
//! virlen-cli run [选项] <prompt>              无界面跑一次 agent（headless 对话）
//! virlen-cli chat [选项]                      交互式会话（内联视口 TUI；非终端自动降级）
//! virlen-cli list-session [-g agent|workdir]  列出会话（可分组）
//! virlen-cli list-agent                       列出 Agent
//! virlen-cli provider <add|edit|rm|list|test> 交互式管理供应商配置（逐步录入 + 验证）
//! virlen-cli agent <add|edit|rm|list>          交互式管理 Agent 配置（逐步录入）
//! ```
//!
//! 为什么命令实现住在本 crate 的 lib（而不是 core / bin）：
//!
//! 三 crate 的分工是「**core / cli / tauri**」三个模块，各自只依赖内层：
//!
//! | crate | 角色 | 边界 |
//! |---|---|---|
//! | `virlen-core` | 引擎 / 持久化 / 沙盒 / 安全 / RAG / 视觉 | **零 `tauri::`**，也**不含命令入口** |
//! | `virlen-cli`（本 crate） | headless 命令实现 + 交互式 TUI（`chat`） | 只依赖 core；**零 `tauri::`** |
//! | `virlen-app` | GUI 壳（Tauri 命令 / 托盘 / 平台集成） | 唯一 Tauri 侧 |
//!
//! ⚠️ bin 目标（`src/main.rs`）**无法被单测引用**，因此逻辑都在本 lib 里，`main.rs` 保持
//! 三行转发 —— 测得到才算落地。（这些代码原住在 `virlen-core/src/cli/`，迁出的目的就是
//! 让 core 只管引擎与持久化，把「有哪些入口 / 长什么样」留给本 crate。）
//!
//! - **与 GUI 同一份数据**：库路径完全由 `HostEnv::data_dir()` 决定（`CliHost` 的默认值
//!   与 Tauri `app_data_dir()` 同形 → 同一个 `virlen.db`），所以 `config set` 改的就是
//!   桌面端读的那份配置（`app_settings` 表，见 `docs/config-sink-plan.md`）。
//!
//! ⚠️ 输出文案用**中文**：与 crate 内其它用户可见消息一致（Tauri 命令的错误文案、
//! `eprintln!` 提示）。JSON 输出保持原样，脚本可直接解析。

mod config;
mod list;
mod run;
mod session_rt;
mod tui;
// 配置向导：`provider` / `agent` 两个交互式子命令 + 共用设施
// （`wizard` 问答原语 / `settings_edit` 数组键的按 id 增删改）
mod agent;
mod provider;
mod settings_edit;
mod wizard;

use std::io::Write;
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;
use virlen_core::host::CliHost;

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
    Run(run::RunCmd),
    Chat(tui::ChatCmd),
    ListSessions(list::SessionsCmd),
    ListAgents(list::AgentsCmd),
    Provider(provider::ProvCmd),
    Agent(agent::AgentCmd),
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
  virlen-cli run [选项] <prompt>         无界面跑一次 agent（headless；`run --help` 看选项）
  virlen-cli chat [选项]                   交互式会话（与桌面端共用同一份会话库；
                                         内联视口 TUI，输入框钉在底部；`chat --help` 看选项）
                                         非终端（管道 / 重定向 / CI）或 `--no-tui` 时
                                         自动改用顺序输出模式；终端连续失败超 5s 也会降级
  virlen-cli list-session [-g agent|workdir] [--limit N] [--json]
                                         列出会话（与桌面端同一份库；`--help` 看说明）
  virlen-cli list-agent [--json]         列出 Agent（app_settings.agents）
  virlen-cli provider <add|edit|rm|list|test>
                                         交互式管理供应商配置（逐步录入 → 验证 → 写入）
  virlen-cli agent <add|edit|rm|list>   交互式管理 Agent 配置（逐步录入）
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
        "run" => run::parse(it.collect()).map(Command::Run),
        "chat" => tui::parse(it.collect()).map(Command::Chat),
        "list-session" | "list-sessions" => {
            list::parse_sessions(it.collect()).map(Command::ListSessions)
        }
        "list-agent" | "list-agents" => list::parse_agents(it.collect()).map(Command::ListAgents),
        "provider" => provider::parse(it.collect()).map(Command::Provider),
        "agent" => agent::parse(it.collect()).map(Command::Agent),
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
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            config::run(host.as_ref(), cmd, out, err).await
        }
        // `run` 需要把宿主**交给引擎**（`Arc<dyn HostEnv>`），故在此构造后按引用传入
        Ok(Command::Run(cmd)) => {
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            run::run(&host, cmd, out, err).await
        }
        // `chat`（交互式）：同样把宿主交给引擎与（TUI / 顺序输出）两条实现
        Ok(Command::Chat(cmd)) => {
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            tui::run(&host, cmd, out, err).await
        }
        // 列表类命令同样需要 `Arc<dyn HostEnv>`（打开会话库）
        Ok(Command::ListSessions(cmd)) => {
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            list::run_sessions(&host, cmd, out, err).await
        }
        Ok(Command::ListAgents(cmd)) => {
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            list::run_agents(&host, cmd, out, err).await
        }
        // 配置向导：两条都是交互式命令（非终端时自己在入口给出用法错误，不会挂住）
        Ok(Command::Provider(cmd)) => {
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            provider::run(&host, cmd, out, err).await
        }
        Ok(Command::Agent(cmd)) => {
            let host: Arc<dyn HostEnv> = Arc::new(CliHost::from_env());
            agent::run(&host, cmd, out, err).await
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
