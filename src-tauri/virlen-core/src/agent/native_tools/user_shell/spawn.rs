//! user_shell — 起一个交互 shell（Windows：ConPTY；其他平台如实报错）。
//!
//! **默认脱壳**：这里走 `create_bare_process_pty`（当前用户令牌、无受限令牌、无写隔离），
//! 与 VS Code 的集成终端同一语义 —— 用户亲手敲的命令必须能 `npm install`、能 `git commit`。
//! 界面上有一枚「沙盒关闭」徽标把这件事说清；「AI 执行一律过沙盒」那条线在 `execute` / `service`
//! 里，两者不互相影响。
//!
//! 与 `service/runner.rs::spawn_service_pty` 的差别只有两处：
//! 1. **不 prepare 沙盒会话**（上面那条决策）；
//! 2. **命令是交互式 shell 本身**（`powershell -NoLogo`，不带 `-Command`），而不是一条命令。
//!
//! ## 四种 shell 走同一条路
//!
//! `cmd` / `powershell` / `pwsh` / `gitbash` 的差别只有「可执行文件 + 参数」这一对
//! （探测在 [`super::shells`]）：**从这里往下全部共用** —— 同一个伪控制台、同一份环境、
//! 同一个 Job 兜底、同一套输出推送。加第五种 shell 只需要在 `shells.rs` 里加一个 kind。

use std::path::Path;
use std::sync::Arc;

use super::super::execute::common::{kill_process_tree, Terminator};
use super::super::service::ServicePty;
use super::shells::{self, ShellKind};
use super::Spawned;

/// 起一个交互 shell。
///
/// `cols` / `rows` 只是**创建时**的尺寸：前端 xterm 挂载后立刻会上报真实尺寸
/// （`ServicePty` 内部去重，同尺寸不重绘）。
#[cfg(target_os = "windows")]
pub(super) fn spawn_shell(
    cwd: &Path,
    cols: u16,
    rows: u16,
    kind: ShellKind,
) -> Result<Spawned, String> {
    use crate::sandbox::pty::{
        create_bare_process_pty, current_env, PseudoConsole, INTERACTIVE_DESKTOP,
    };

    // 先解析：没装就**在创建伪控制台之前**失败，不留下半截资源
    let (program, args) = shells::resolve(kind)?;

    // 前端量不到尺寸时会传 0：夹到「能跑起来的最小终端」，真实尺寸随后就到。
    let cols = cols.clamp(20, 500) as i16;
    let rows = rows.clamp(5, 300) as i16;
    let mut pty = PseudoConsole::create(cols, rows)
        .map_err(|e| format!("创建伪控制台失败：{e}"))?;

    let mut argv = vec![program.to_string_lossy().to_string()];
    argv.extend(args);
    // 用户自己的环境原样传下去（不注入 PYTHONIOENCODING 之类的服务侧变量：
    // 那是给「AI 起的命令」用的，不该悄悄改用户的终端）。
    let env = current_env();
    let child = create_bare_process_pty(&argv, None, cwd, &env, INTERACTIVE_DESKTOP, pty.raw_hpc())
        .map_err(|e| format!("启动 {} 失败：{e}", program.display()))?;
    let pid = child.pid();
    let child = Arc::new(child);

    // Job（`KILL_ON_JOB_CLOSE`）：关标签 / 应用崩溃都不该留下孤儿 shell 与它跑起来的 dev server。
    // 裸跑路径的 `PtyChild` 本身不带 Job（见 `spawn.rs::create_bare_process_pty`），所以这里补一个，
    // 与 `service/runner.rs` 的裸跑分支同一条。（注册表摘条目时 `Terminator` 被放下 = 杀树。）
    let guard = crate::agent::process_tree::ProcessTreeGuard::create_kill_on_close().map(Arc::new);
    if let Some(g) = &guard {
        let _ = g.assign_pid(pid);
    }
    let guard_for_kill = guard.clone();
    let terminator: Terminator = Arc::new(move || {
        if let Some(g) = &guard_for_kill {
            g.terminate();
        }
        kill_process_tree(pid);
    });

    // ConPTY 下 stdout / stderr 已合并成一条流：只要取走输出读端与输入写端。
    let stdout = pty
        .take_output()
        .map(|f| Box::new(f) as Box<dyn std::io::Read + Send>);
    // ⚠️ `pty` 本体一并交给句柄：`HPCON` 必须在这个终端活着期间一直有效。
    let console = pty
        .take_input()
        .map(|input| Arc::new(ServicePty::new(input, pty, cols, rows)));
    let wait: Box<dyn FnOnce() -> Option<i32> + Send> = {
        let child = child.clone();
        Box::new(move || child.wait_and_read_exit_code())
    };

    Ok(Spawned {
        pid,
        shell: kind.id().to_string(),
        command: program.to_string_lossy().to_string(),
        stdout,
        terminator,
        wait,
        console,
    })
}

/// 非 Windows：没有 ConPTY 实现，**如实报错**而不是假装能用。
///
/// 为什么不退化成人管道 shell：`ls` / `git status` 能跑，但 `vim` / `top` / `npm run dev` 的
/// TUI 全都不工作，用户会以为是「终端坏了」。错误文案直说平台不支持，比半个终端好。
#[cfg(not(target_os = "windows"))]
pub(super) fn spawn_shell(
    _cwd: &Path,
    _cols: u16,
    _rows: u16,
    _kind: ShellKind,
) -> Result<Spawned, String> {
    Err("交互终端目前只支持 Windows（ConPTY 尚未移植到当前平台）。".to_string())
}
