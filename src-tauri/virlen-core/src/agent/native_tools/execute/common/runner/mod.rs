//! 统一运行器 —— 平台分发入口（Windows 走 ConPTY，其余平台走匿名管道）。
//!
//! - [`pipes`]   匿名管道运行器（非 Windows 主路径 / ConPTY 不可用时降级兜底）
//! - [`pty`]     ConPTY 运行器（Windows，命令在伪控制台里跑）
//! - [`sandbox`] 沙盒会话准备与沙盒内（管道）运行
//!
//! 本文件持有：平台分发入口 [`run_command_native`]、结果组装 [`build_command_result`]、
//! 超时/接管预算常量，以及沙盒运行模式判定 [`sandbox_mode`] / [`SandboxMode`]。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};
// `Duration` 只被下面那几个 ConPTY 专属常量用到 → 一起门禁（否则非 Windows 下是未使用导入）
#[cfg(target_os = "windows")]
use std::time::Duration;

use super::super::pty_session;
use super::terminal::process_terminal_output;

mod pipes;
#[cfg(target_os = "windows")]
mod pty;
mod sandbox;
#[cfg(test)]
mod tests;

/// Step 2 ④：判定「超时前全程几乎无输出」的输出上限（trim 后字符数）。
///
/// 低于此值即认为命令卡在等待输入（密码 / `y/n` / REPL）——这是 PTY 交互场景里
/// 最常见的超时原因，值得在结果里显式引导模型（与管道路径同样适用，见 D5）。
const TIMEOUT_IDLE_HINT_MAX_OUTPUT: usize = 16;

/// 超时且全程无输出时追加到结果末尾的引导文案（面向模型，非 i18n）。
const TIMEOUT_IDLE_HINT: &str = "(the command produced almost no output before timing out, which usually means it was waiting for input: a password / y/n confirmation / REPL. Ask the user to type into the terminal directly, or raise the timeout.)";

// ── 以下 5 项只服务 ConPTY 路径 ──────────────────────────────────────────────
//    调用者只有 `runner/pty.rs`（本文件里 `#[cfg(target_os = "windows")] mod pty;`）
//    与它同样带 Windows 门禁的测试 → 非 Windows 平台**必然无调用者**。
//    故选逐项门禁而非 `allow(dead_code)`：非 Windows 上它们确实不存在，比「压告警」更贴近事实。
//    ⚠️ 将来落 Unix PTY 时，这里要与 `mod pty;` 一起改成 `cfg(any(...))`。
#[cfg(target_os = "windows")]
/// PTY 路径「禁用分页器」用的通用取值 —— 对 git / gh 都表示「不分页」。
///
/// 背景：ConPTY 让子进程的 stdout 变成 **TTY**，于是会分页的工具（git / gh / bat…）启动
/// 分页器（`less` / `more`）停在界面等按键，命令明明跑完却卡在最后一行（AI 无法按 `q`）。
/// 改造前走匿名管道时 stdout 不是 TTY，自动不分页，所以看不到这个问题。
///
/// 各处取值见 `run_command_native_pty` 的 `env_extra`，逐条均有工具源码佐证：
///   - git `GIT_PAGER=cat`：`git_pager()` 对 `cat`/空串**硬编码特判** = 不分页；
///   - gh  `GH_PAGER=cat` ：`IOStreams.StartPager()` 见 `cat` 直接 return = 不分页；
///   - bat `BAT_PAGING=never`：等价 `--paging=never`（零外部依赖）。
///
/// 因此本值**不会真的去执行 `cat` 二进制**，Windows 没有 `cat` 也安全。
///
/// ⚠️ 刻意**不**设通用 `PAGER`：`gh`/`bat` 之外的工具（如 `aws`）会**真的 exec** `PAGER`，
/// Windows 上 `cat` 常不在 PATH → 反而报「找不到 cat」。要覆盖它们需另立方案（打包 cat 直通）。
const PAGER_DISABLED: &str = "cat";

#[cfg(target_os = "windows")]
/// ② 超时预算的心跳周期（接管冻结 / 预算扣减都按它推进，Step 2 ②）。
const TICK: Duration = Duration::from_millis(250);

#[cfg(target_os = "windows")]
/// ② 接管硬上限（对齐 WinkTerm 的 TTL，决策点 D3）：接管**不等于**无限期挂起。
const PTY_HOLD_MAX: Duration = Duration::from_secs(30 * 60);

#[cfg(target_os = "windows")]
/// ② 取接管上限。单测用 `HOLD_MAX_OVERRIDE_SECS` 缩短，避免真等 30 分钟。
fn pty_hold_max() -> Duration {
    #[cfg(test)]
    {
        let secs = HOLD_MAX_OVERRIDE_SECS.load(std::sync::atomic::Ordering::SeqCst);
        if secs > 0 {
            return Duration::from_secs(secs);
        }
    }
    PTY_HOLD_MAX
}

#[cfg(target_os = "windows")]
/// 仅测试用：可注入的接管上限（秒；0 = 用默认 `PTY_HOLD_MAX`）。
#[cfg(test)]
static HOLD_MAX_OVERRIDE_SECS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// 伪控制台当前是否可用（Step 2 ①：决定「终端内确认」是否走终端呈现）。
///
/// 试建一个伪控制台再立即丢弃 —— 判定与真正执行时一致（同一 API / 同一令牌与环境）。
/// 不可用时 Rust **不下发** `presentation:"terminal"`，前端自动回落现有审批弹窗
/// （语义不变，降级可见）。非 Windows 平台无 PTY → 恒 false。
pub(crate) fn pty_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        use crate::sandbox::pty::{PseudoConsole, DEFAULT_COLS, DEFAULT_ROWS};
        // 试建成功即可；PseudoConsole 的 Drop 会关掉它，不留句柄。
        PseudoConsole::create(DEFAULT_COLS, DEFAULT_ROWS).is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 统一运行器 —— 平台分发入口。
///
/// - **Windows**：走 ConPTY 路径（`run_command_native_pty`）。命令在伪控制台里跑，于是
///   ANSI/中文输出正确、交互式提示可用、用户可经 `pty_write` 中途插键盘（Step 1 的全部收益）。
///   伪控制台不可用时降级回匿名管道路径。
/// - **其他平台**：仍走匿名管道路径（Unix PTY 留待后续，见 docs/pty-research.md §8）。
///
/// `bypass_sandbox`：调用方已完成用户审批的「不使用沙盒」请求（execute_command 的
/// `sandbox:"off"`）。为 true 时跳过沙盒、直接走裸跑路径；典型用途是沙盒下必然
/// 失败的场景：子进程需要用管道 stdio 拉起孙进程（vitest/vite/jest/node-gyp 等），
/// 受限令牌会使那次 spawn 报 EPERM（根因见 AGENTS §11.2）。
///
/// `pub(crate)`：除工具层外，TS 引擎路径经 `pty_run_command` 也复用本运行器（§7 #14）。
pub(crate) async fn run_command_native(
    ctx: &NativeToolCtx<'_>,
    cmd_str: &str,
    timeout_secs: i64,
    bypass_sandbox: bool,
) -> Result<NativeToolOutcome, String> {
    // 只读模式的最后一道闸：禁止绕过沙盒（覆盖所有调用路径，含 TS 引擎入口 pty_run_command）。
    // 工具层在审批之前已做同样判定（避免「弹窗批准后又被拒」），这里兜底。
    if bypass_sandbox && sandbox_mode(ctx) == SandboxMode::Readonly {
        return Err(
            "The sandbox is in read-only mode, so bypassing it is not allowed; switch the sandbox mode in settings first (or use a regular terminal)"
                .to_string(),
        );
    }
    #[cfg(target_os = "windows")]
    {
        return pty::run_command_native_pty(ctx, cmd_str, timeout_secs, bypass_sandbox).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        pipes::run_command_native_pipes(ctx, cmd_str, timeout_secs, bypass_sandbox).await
    }
}

/// 组装命令执行结果（三条路径共用）。`env_note` 为首行环境提示。
///
/// `pty`：是否来自伪控制台路径。uiData 里加这个标记后，UI 可据此走 xterm 单流渲染
/// （PTY 下 stdout/stderr 已合并，`[标准错误]` 分段与 `stream` 字段失去意义，§6.2）。
///
/// `waitReason`（Step 2 ④）：`exit` | `timeout` | `cancelled`。由结束原因直接推导，
/// **管道路径也下发**（D5：语义统一，UI 与模型侧都不必按路径分叉）。
///
/// `interventions`（Step 2 ②）：用户干预摘要（**只记计数，不记内容**，D4）。
/// PTY 路径传 `Some`；管道路径 / 无会话时传 `None`（则 uiData 不含该字段）。
/// `hold_timed_out`：是否因接管到达硬上限被终止（`waitReason=timeout` 的子情况）。
///
/// ⚠️ `#[allow(too_many_arguments)]`：参数就是命令结果的各独立字段（stdout / stderr /
/// 退出码 / 两种终止原因 / 超时 / 环境说明 / PTY 标志 / 干预计数 / 接管超时），无内聚可压。
#[allow(clippy::too_many_arguments)]
pub(super) fn build_command_result(
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    killed_by_user: bool,
    killed_by_timeout: bool,
    timeout_secs: i64,
    env_note: &str,
    pty: bool,
    interventions: Option<&pty_session::InterventionCounts>,
    hold_timed_out: bool,
) -> NativeToolOutcome {
    // 结束原因：用户终止 / 预算耗尽（含接管到顶）/ 进程自行退出
    let wait_reason = if killed_by_user {
        "cancelled"
    } else if killed_by_timeout {
        "timeout"
    } else {
        "exit"
    };
    let mut result = String::new();
    if !env_note.is_empty() {
        result.push_str(env_note);
        result.push('\n');
    }
    if killed_by_user {
        result.push_str("Command cancelled by the user\n");
    } else if killed_by_timeout {
        result.push_str(&format!("Command timed out after {:.3}s and was terminated\n", timeout_secs as f64));
    } else {
        result.push_str(&format!("Exit code: {}\n", exit_code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())));
    }
    if !stdout.is_empty() {
        result.push_str(&process_terminal_output(&stdout));
    }
    if !stdout.is_empty() && !stderr.is_empty() {
        result.push('\n');
    }
    if !stderr.is_empty() {
        result.push_str("[stderr]\n");
        result.push_str(&process_terminal_output(&stderr));
    }
    // ④：超时且全程几乎无输出 → 追加面向模型的引导（等待输入是最常见的原因）
    if wait_reason == "timeout"
        && stdout.trim().chars().count() <= TIMEOUT_IDLE_HINT_MAX_OUTPUT
    {
        result.push('\n');
        result.push_str(TIMEOUT_IDLE_HINT);
    }

    const MAX: usize = 32000;
    let out = if result.len() > MAX {
        format!("{}...(truncated, {} characters total)", &result[..MAX], result.len())
    } else {
        result
    };

    // 结构化 uiData 先建好 —— **成功与失败共用同一份**（D2 的失败侧）：
    // 以前退出码 >= 2 时直接 `Error(out)` 把它丢掉，UI 只能把英文失败报告直接贴给用户（L6）。
    let mut ui = json!({
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
        "pty": pty,
        // Step 2 ④：结束原因（exit | timeout | cancelled）
        "waitReason": wait_reason,
    });
    if let Value::Object(map) = &mut ui {
        // ② 用户干预摘要（只记计数，不记内容，D4）
        if let Some(iv) = interventions {
            map.insert(
                "userInterventions".into(),
                json!({
                    "keys": iv.keys,
                    "enters": iv.enters,
                    "ctrlC": iv.ctrl_c,
                    "heldSeconds": iv.held_seconds,
                }),
            );
        }
        if hold_timed_out {
            map.insert("holdTimedOut".into(), Value::Bool(true));
        }
    }

    if let Some(code) = exit_code {
        if code >= 2 {
            return NativeToolOutcome::error_with_ui(out, ui);
        }
    }

    NativeToolOutcome::Value {
        content: out,
        ui_data: Some(ui),
    }
}

/// 终端沙盒运行模式。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxMode {
    On,
    Off,
    Readonly,
}

/// 解析当前沙盒模式：环境变量 VIRLEN_SANDBOX 优先（临时覆盖），
/// 否则回退到 security.sandbox_mode（默认 on）。
pub(crate) fn sandbox_mode(ctx: &NativeToolCtx<'_>) -> SandboxMode {
    if let Ok(v) = std::env::var("VIRLEN_SANDBOX") {
        match v.to_ascii_lowercase().as_str() {
            "off" | "0" | "false" => return SandboxMode::Off,
            "readonly" | "ro" => return SandboxMode::Readonly,
            "on" | "1" | "true" => return SandboxMode::On,
            _ => {}
        }
    }
    match ctx.security.sandbox_mode.to_ascii_lowercase().as_str() {
        "off" | "0" | "false" => SandboxMode::Off,
        "readonly" | "ro" => SandboxMode::Readonly,
        _ => SandboxMode::On,
    }
}
