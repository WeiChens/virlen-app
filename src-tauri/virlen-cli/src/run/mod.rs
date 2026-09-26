//! `run` 子命令 —— 无界面跑一次 agent（headless 对话）
//!
//! ```text
//! virlen-cli run [选项] <prompt>
//! ```
//!
//! - 一次性：发一条用户消息，跑完整个 agent 循环（含工具调用）后退出，没有 REPL。
//! - 与桌面端同一份数据：库路径 = `host.data_dir()/virlen.db`；消息由引擎先落库再 emit，因此
//!   `--session <id>` 续跑读到的就是桌面端那份历史。
//! - 无 JS：28 个工具全部原生化（`is_native_tool` 是全集）。⚠️ 但必须下发 `security`（`Some(..)`）——
//!   `tool_executor` 用 `security.is_some()` 决定走原生还是走 JS 桥，缺了它 CLI 会去请求一个不存在的
//!   JS 宿主而挂起；未原生化能力（`BridgedProvider`，目前只有 Gemini）在装配阶段直接拒绝，给可读错误。
//!
//! ## 输出约定（stdout 只放正文，方便管道）
//!
//! stdout 放助手正文流式增量（`--json` 时改为每行一个 `AgentEvent` 的 JSON Lines）；stderr 放工具进度 /
//! 交互提示 / 错误 / 收尾摘要。
//!
//! 事件文本由 [`render_event`]（纯函数）产出后经无界通道交给 `run()` 的 select 循环写入注入的
//! `out` / `err`：`EventSink` 是同步 trait 且要求 `Send + Sync`，无法借用 `&mut dyn Write`；走通道既
//! 满足 trait 约束，又保住了「输出走注入的 Write → 单测能断言」这条既有约定。
//!
//! ## 交互（用户拍板方案 A）
//!
//! 权限为 `ask` 的命令授权（`confirm_command_native`）与 `user_choice` 都在终端里问：stdin 是 TTY →
//! 提示后读一行（`y` / `yes` 放行，其余按拒绝）；不是 TTY（管道 / CI）→ 一律拒绝（fail-closed）。
//!
//! ⚠️ 每种交互类型（含未知类型）都必须应答：引擎等回执时是 `rx.await`，不回就永远不返回。

use virlen_core::agent::bridge::AgentBridgeState;
use virlen_core::agent::engine::AgentEngine;
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::provider::DefaultProviderFactory;
use std::io::{IsTerminal, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

// glob 导入是「纯搬移」的护栏：装配 / 会话装载的函数搬到 `session_rt` 后用同一批名字重新引入，
// 本文件的调用点与 `mod tests` 都不需要改。
use crate::session_rt::*;
use crate::{EXIT_ERROR, EXIT_OK};


/// `run` 的帮助文本（`run --help` / `run -h`）
pub const USAGE_RUN: &str = "\
virlen-cli run —— 无界面跑一次 agent（与桌面端共用同一份配置与会话库）

用法:
  virlen-cli run [选项] <prompt>

选项:
  --session <id>                 续用已有会话（默认新建；会话必须已存在）
  --provider <id>                指定 Provider 配置 id（默认 app_settings.defaultSelectModel）
  --model <id>                   指定模型 id（默认 app_settings.defaultSelectModel）
  --workspace <path>             工作目录（默认当前目录；相对路径按当前目录解析）
                                 ⚠️ 续用 --session 时以**会话记录**为准：记录非空且与本值
                                 不同会直接报错（会话的工作目录创建后不可变更）；
                                 记录为空时依次回退「设置里的默认工作目录」→ 当前目录，
                                 且**不写回会话**
  --append-system-prompt <text>  在组装好的系统提示词之后追加一段指令
  --max-rounds <n>               最大工具调用轮数（默认取 app_settings.maxToolRounds）
  --no-tools                     不启用工具（纯问答）
  --json                         事件按 JSON Lines 输出到 stdout
  -h, --help                     显示本帮助

输出:
  stdout  助手正文（流式）；--json 时每行一个 AgentEvent
  stderr  工具进度 / 交互提示 / 错误

交互（权限为 ask 时）:
  命令授权与 user_choice 会在终端提示并读 stdin（y/yes = 放行）；
  stdin 不是 TTY（管道 / CI）时一律拒绝；
  ⚠️ 重定向 stdout/stderr 后 stdin 仍是终端 → CLI 会等待输入（看起来像卡住）；
     不需要交互时请同时重定向 stdin（Windows: `< NUL`，POSIX: `< /dev/null`），
     或把对应权限改为 allow / deny（设置 → 安全 → 权限管理）。

⚠️ 已知限制:
  - 白名单 / 黑名单 / 跳过目录存在桌面端 localStorage，CLI 读不到（按空处理）；
    路径安全仍由「工作目录 + 沙盒 + 权限三态」兜底。
  - Gemini 等未原生化的 Provider 需要前端 JS 桥，CLI 不支持（装配阶段报错）。
";


// ==================== 子模块 ====================
//
// 切分口径（每个文件只放一件事，详见 §「为什么这么切」在 `docs/AGENTS.md` §12）：
//
// | 文件 | 放什么 |
// |---|---|
// | 本文件 | 命令入口：参数解析（`RunCmd` / `parse`）与驱动（`run`）—— 这两块是**界面入参**，
// | | 也是 `tui` 需要的名字，所以必须留在模块根上 |
// | `render.rs` | 「引擎事件 → 文本」的**纯函数**（`render_event`）与 `Rendered` / `flush_rendered` |
// | `ask.rs` | 交互应答（授权 / 选择）—— 终端问一句答一句，fail-closed |
// | `sink.rs` | 事件出口 `CliEventSink`：把事件渲染成文本推给输出循环，并就地应答桥请求 |
// | `tests.rs` | 测试（`#[cfg(test)] mod tests;`） |

pub(crate) mod ask;
pub(crate) mod render;
pub(crate) mod sink;

// glob 再导出：`crate::run::CliEventSink` / `run::Rendered` / `run::flush_rendered` 这些
// 外部（`tui`）与本文件 `mod tests` 的 `use super::*` 都靠它**保持原样** ——
// 搬了文件，但没搬任何调用点。
pub(crate) use self::ask::*;
pub(crate) use self::render::*;
pub(crate) use self::sink::*;

// ==================== 参数解析 ====================

/// 解析结果（`RunOptions` 本体住在 `session_rt`：它与将来的 `chat` 共用）
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunCmd {
    Help,
    Run(RunOptions),
}

/// 解析 `run` 之后的参数。纯函数 —— 单测直接断言它。
///
/// 位置参数（不含前导 `-` 的 token）全部拼进 `prompt`：`run 解释 一下 README` 与
/// `run "解释一下 README"` 等价，省掉一层 shell 引号心智负担。
pub(crate) fn parse(args: Vec<&str>) -> Result<RunCmd, String> {
    let mut opts = RunOptions::default();
    let mut words: Vec<String> = Vec::new();
    let mut it = args.into_iter();

    while let Some(arg) = it.next() {
        match arg {
            "-h" | "--help" => return Ok(RunCmd::Help),
            "--no-tools" => opts.no_tools = true,
            "--json" => opts.json = true,
            "--session" | "--provider" | "--model" | "--workspace" | "--append-system-prompt"
            | "--max-rounds" => {
                let value = it
                    .next()
                    .ok_or_else(|| format!("选项 {} 缺少取值", arg))?
                    .to_string();
                if value.is_empty() {
                    return Err(format!("选项 {} 的取值不能为空", arg));
                }
                match arg {
                    "--session" => opts.session_id = Some(value),
                    "--provider" => opts.provider_id = Some(value),
                    "--model" => opts.model_id = Some(value),
                    "--workspace" => opts.workspace = Some(value),
                    "--append-system-prompt" => opts.append_system_prompt = Some(value),
                    "--max-rounds" => {
                        let n: i64 = value
                            .parse()
                            .map_err(|_| format!("--max-rounds 需要整数，收到: {}", value))?;
                        if n < 1 {
                            return Err("--max-rounds 必须 >= 1".to_string());
                        }
                        opts.max_rounds = Some(n);
                    }
                    _ => unreachable!("选项已在 match 中穷举"),
                }
            }
            other if other.starts_with("--") => {
                return Err(format!("未知选项: {}（见 `virlen-cli run --help`）", other));
            }
            word => words.push(word.to_string()),
        }
    }

    if words.is_empty() {
        return Err("缺少 prompt（用法: virlen-cli run [选项] <prompt>）".to_string());
    }
    opts.prompt = words.join(" ");
    Ok(RunCmd::Run(opts))
}

// ==================== 驱动 ====================

/// `run` 子命令入口。返回进程退出码。
pub(super) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: RunCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let opts = match cmd {
        RunCmd::Help => {
            let _ = write!(out, "{}", USAGE_RUN);
            return EXIT_OK;
        }
        RunCmd::Run(opts) => opts,
    };

    // 装配：**顺序敏感**（先读会话记录的工作目录、再装配资源）——全套逻辑在 `session_rt` 里，
    // 与将来的 `chat`（TUI）共用同一份实现（曾经的 bug 就是顺序反了，见 `resolve_workspace`）
    let rt = match SessionRuntime::bootstrap(host, opts).await {
        Ok(rt) => rt,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    // 会话记录里没有工作目录（桌面端建会话时未选）→ 本次用推出的值，但**不写回会话**，
    // 好让「创建时没有」这件事保持原样（否则桌面端会措手不及）
    if rt.workspace_inferred {
        let _ = writeln!(
            err,
            "[run] 该会话没有记录工作目录 → 本次使用 {}（不写回会话）",
            rt.resources.workspace
        );
    }

    let _ = writeln!(
        err,
        "[run] session={} model={} tools={} workspace={}",
        rt.session.id,
        rt.resources.model_id,
        if rt.resources.enable_tools {
            rt.resources.tool_defs.len().to_string()
        } else {
            "off".to_string()
        },
        rt.resources.workspace
    );

    let interactive = std::io::stdin().is_terminal();
    let (tx, mut rx) = mpsc::unbounded_channel::<Rendered>();
    let bridge = Arc::new(AgentBridgeState::default());
    let sink: Arc<dyn EventSink> = Arc::new(CliEventSink::new(
        bridge.clone(),
        tx,
        rt.opts.json,
        interactive,
    ));

    let engine = AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        rt.db.repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
        host.clone(),
        rt.db.settings.clone(),
    );

    // `session_id` 与 `session.id` 必须一致（桌面端 `rust-engine.ts` 也是这么传的）：
    // 引擎用 `session_id` 发事件 / 落库，用 `session.id` 取会话元数据。
    // 入参的字段映射只有 `SessionRuntime::send_options` 一份。
    let options = rt.send_options(rt.messages.clone());

    let started = virlen_core::telemetry::now_ms();
    let mut fut = Box::pin(engine.send_message(options));
    let result = loop {
        tokio::select! {
            res = &mut fut => break res,
            maybe = rx.recv() => {
                match maybe {
                    Some(r) => flush_rendered(&mut *out, &mut *err, r),
                    // 发送端未 drop（`sink` 由本函数持有）→ 实际不可达；留着只为穷举
                    None => break Ok(()),
                }
                // 一次唤醒把积压全部写出去，避免高频率增量下打印滞后
                while let Ok(r) = rx.try_recv() {
                    flush_rendered(&mut *out, &mut *err, r);
                }
            }
        }
    };
    // 收尾：drain 残余事件（sender 由 engine/sink 持有，可能还有几条）
    drop(sink);
    while let Ok(r) = rx.try_recv() {
        flush_rendered(&mut *out, &mut *err, r);
    }
    let _ = out.flush();
    let _ = err.flush();

    let elapsed_ms = virlen_core::telemetry::now_ms() - started;
    match result {
        Ok(()) => {
            let _ = writeln!(err, "[done] 用时 {} ms", elapsed_ms);
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "\n[error] {}", e);
            let _ = writeln!(err, "[failed] 用时 {} ms", elapsed_ms);
            EXIT_ERROR
        }
    }
}


#[cfg(test)]
mod tests;
