//! `virlen-cli chat` —— 交互式会话：默认是**内联视口 TUI**，另有**顺序输出模式**兜底
//!
//! ```text
//! virlen-cli chat [--session <id>] [--workspace <path>] [--no-tui]
//! ```
//!
//! 与桌面端共用同一份会话库（`virlen.db`）；`--session <id>` 续连时开头先显示最近 5 条历史
//! （见 `history.rs`），退出时打印完整会话 id 与续连命令。
//!
//! 两条路径（TUI / 顺序输出）共用 `SessionRuntime` 与 `EventSink` 的应答约定，差别只在「事件怎么
//! 呈现」与「输入从哪来」—— 非终端（管道 / CI）或终端连续失败超 5s 时降级为顺序输出，不重实现
//! 任何判定（安全 / 工具 / 会话）。
//!
//! ## 线程与任务
//!
//! 主任务（tokio 当前线程）只 `select!` 两条无条件分支：用户动作 ← TUI 线程、回合结果 ← spawned
//! 任务。回合必须 spawn 出去（`send_message` 是长 future，主任务同时还要处理按键），用 channel 收
//! 结果，`select!` 才不需要「有回合才启用某分支」那种借来借去的写法。
//!
//! ## 交互（异步审批）
//!
//! `run` 同步阻塞读 stdin，TUI 不能这么做（会和输入框抢同一个 stdin）：事件出口把交互请求送进
//! UI → 按键产生 `Action::Reply` → 主任务用 `bridge::handle_user_interaction_response` 回执。
//!
//! ⚠️ 未知交互类型也必须应答，否则引擎一直等回执；授权是显式二选一（←/→ + Enter，默认「拒绝」），
//! 不能像 `run` 那样把空白输入当「允许」—— 用户此刻可能正在打字，一次误触 Enter 就放行了危险命令
//! （fail-open，见 `state/mod.rs::ConfirmChoice`）。


pub(crate) mod commands;
pub(crate) mod history;
pub(crate) mod input;
pub(crate) mod state;
pub(crate) mod term;
pub(crate) mod view;
pub(crate) mod app;
pub(crate) mod plain;
pub(crate) mod sink;

use crate::session_rt::{RunOptions, SessionRuntime};
use crate::{EXIT_ERROR, EXIT_OK};
use std::io::{BufRead, IsTerminal, Write};
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;

use std::time::Duration;

/// 输入轮询间隔（也是 spinner / 计时的节拍）
const POLL: Duration = Duration::from_millis(60);
/// 运行中重绘的最小间隔（spinner 与用时；不去抖的话每轮都画）
const REDRAW_EVERY: Duration = Duration::from_millis(100);

// glob 再导出：入口留在本文件、实现分散到子模块 —— `lib.rs` 与本文件 `mod tests` 的调用点
// **一行都不用改**。（`sink` / `history` 不在这里再导出：它们只有使用方直接 `use super::sink::…`
// / `use super::history::…`，无脑 glob 会带来「lib 目标下没人用」的警告。）
pub(crate) use self::app::*;
pub(crate) use self::plain::*;

// ==================== 参数 ====================

/// `chat` 的选项
#[derive(Debug, PartialEq, Eq, Default)]
pub(crate) struct ChatOptions {
    /// 续用已有会话
    pub session_id: Option<String>,
    pub workspace: Option<String>,
    /// 强制顺序输出模式（不打终端界面的主意）
    pub no_tui: bool,
}

/// 解析结果
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ChatCmd {
    Help,
    Chat(ChatOptions),
}

/// `chat` 的帮助文本（`chat --help` / `chat -h`）
pub const USAGE_CHAT: &str = "\
virlen-cli chat —— 交互式会话（与桌面端共用同一份配置与会话库）

用法:
  virlen-cli chat [选项]

选项:
  --session <id>        续用已有会话（默认新建；会话必须已存在）
  --workspace <path>    工作目录（默认当前目录；相对路径按当前目录解析）
                        ⚠️ 续用 --session 时以**会话记录**为准：记录非空且与本值不同会直接报错
                        （会话的工作目录创建后不可变更）；记录为空时依次回退「设置里的默认
                        工作目录」→ 当前目录，且**不写回会话**
  --no-tui              强制「顺序输出模式」（纯文本 + 行输入；管道 / CI / 排障时用）
  -h, --help            显示本帮助

界面内的命令:
  /help  /status  /new  /exit           （见 `chat` 内的 /help）
  按键: Enter 提交 · Esc 取消当前回合 · ↑↓ 历史 · Ctrl+C 取消/退出 · Ctrl+D 退出
  授权面板（命令需授权时弹出）: ←/→（或 ↑/↓）选择「拒绝 / 允许」· Enter 确认
                               默认选中「拒绝」—— 不动就回车 = 拒绝

运行模式:
  默认是内联视口 TUI（正文固化进终端原生滚动区，输入框钉在底部）。
  以下情况自动改用**顺序输出模式**：stdout / stdin 不是终端（重定向 / 管道 / CI）、
  指定了 --no-tui、或终端连续绘制失败超过 5 秒（降级，并在 stderr 说明原因）。

⚠️ 已知限制:
  - Provider 需与 `run` 一致：CLI 只支持 openai 兼容 / anthropic（Gemini 等需前端 JS 桥）。
  - 白名单 / 黑名单 / 跳过目录在桌面端 localStorage，CLI 读不到（按空处理）。
  - 退出即结束：当前回合会被取消（会话与消息已落库，可随时续跑）。退出时会打印
    会话 id 与续连命令（`virlen-cli chat --session <id>`）；用 `--session <id>` 重连时
    会先显示最近 5 条历史，方便预览上次说到哪。
";

/// 解析 `chat` 之后的参数。纯函数 —— 单测直接断言。
pub(crate) fn parse(args: Vec<&str>) -> Result<ChatCmd, String> {
    let mut opts = ChatOptions::default();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg {
            "-h" | "--help" => return Ok(ChatCmd::Help),
            "--no-tui" => opts.no_tui = true,
            "--session" | "--workspace" => {
                let value = it
                    .next()
                    .ok_or_else(|| format!("选项 {} 缺少取值", arg))?
                    .to_string();
                if value.is_empty() {
                    return Err(format!("选项 {} 的取值不能为空", arg));
                }
                match arg {
                    "--session" => opts.session_id = Some(value),
                    "--workspace" => opts.workspace = Some(value),
                    _ => unreachable!("选项已在 match 中穷举"),
                }
            }
            other if other.starts_with('-') => {
                return Err(format!(
                    "未知选项: {}（见 `virlen-cli chat --help`）",
                    other
                ));
            }
            other => {
                return Err(format!(
                    "`chat` 不接受位置参数: {}（交互式会话的提问在界面里输入；一次性提问请用 `virlen-cli run`）",
                    other
                ));
            }
        }
    }
    Ok(ChatCmd::Chat(opts))
}

// ==================== 输入来源 ====================

/// 顺序输出模式的输入来源。
///
/// 生产走 `Stdin`（**不长期持锁**：交互应答也读 stdin，持锁会死锁）；
/// 单测走 `Buf`（`Cursor`），因此「多轮 + 斜杠命令 + 退出」这条链是**可测**的。
pub(crate) enum Input<'a> {
    Stdin,
    /// 单测注入用（生产只走 `Stdin`）—— 保留它才知道「生产不持 stdin 锁」这条约束
    #[allow(dead_code)]
    Buf(&'a mut dyn BufRead),
}

impl Input<'_> {
    /// 读一行；返回读到的字节数（0 = EOF）
    pub(crate) fn read_line(&mut self, out: &mut String) -> usize {
        match self {
            Input::Stdin => std::io::stdin().lock().read_line(out).unwrap_or(0),
            Input::Buf(r) => r.read_line(out).unwrap_or(0),
        }
    }
}

// ==================== 入口 ====================

/// `chat` 子命令入口（生产路径：输入走 stdin）。返回进程退出码。
pub(crate) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: ChatCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut input = Input::Stdin;
    run_with(host, cmd, out, err, &mut input).await
}

/// 入口的可测版本（输入可注入）
pub(crate) async fn run_with(
    host: &Arc<dyn HostEnv>,
    cmd: ChatCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
    input: &mut Input<'_>,
) -> i32 {
    let opts = match cmd {
        ChatCmd::Help => {
            let _ = write!(out, "{}", USAGE_CHAT);
            return EXIT_OK;
        }
        ChatCmd::Chat(o) => o,
    };

    // 装配：与 `run` 同一条链（顺序敏感：先读会话记录的工作目录、再装配资源）
    let run_opts = RunOptions {
        session_id: opts.session_id.clone(),
        workspace: opts.workspace.clone(),
        ..Default::default()
    };
    let rt = match SessionRuntime::bootstrap_chat(host, run_opts).await {
        Ok(rt) => rt,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    if rt.workspace_inferred {
        let _ = writeln!(
            err,
            "[chat] 该会话没有记录工作目录 → 使用 {}（不写回会话）",
            rt.resources.workspace
        );
    }

    let tui_ok = !opts.no_tui && std::io::stdout().is_terminal() && std::io::stdin().is_terminal();
    if tui_ok {
        run_tui(host, rt, out, err, input).await
    } else {
        let reason = if opts.no_tui {
            "--no-tui".to_string()
        } else {
            "stdout / stdin 不是终端（被重定向、包在管道里，或来自 CI）".to_string()
        };
        run_plain(host, rt, out, err, input, Some(reason)).await
    }
}

#[cfg(test)]
mod tests;
