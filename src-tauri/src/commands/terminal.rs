//! 用户终端的 Tauri 命令层（右侧面板「新建终端」）：只做转交，语义全在
//! `virlen_core::agent::native_tools::user_shell`。
//!
//! 与 `commands/service.rs` 的分工：那边是「AI 起的后台服务 + 用户接管」，这边是**用户自己的 shell**。
//! 两者共用同一套 ConPTY 句柄与输出窗口，但**注册表、会话归属、生命周期各自独立** ——
//! 关掉终端不会动到任何后台服务，反之亦然。
//!
//! 三条硬约束：
//! 1. **默认脱壳**：终端里的命令跑在用户环境里（与 VS Code 一致），不经过沙盒与审批。
//!    界面上用「沙盒：关闭」徽标如实标注 —— 「AI 执行必须过沙盒」那条线不因此放宽。
//! 2. **不记输入内容**：键击里常是密码 / token（与 `pty_write` 同一条红线），这里只回布尔。
//! 3. ⚠️ 新增命令必须登记到 `lib.rs` 的 `generate_handler![...]`（铁律 4）。
//!
//! ## 输出走推送（`terminal:output`），读命令只做补帧
//!
//! 前端**不再靠轮询看回显**：轮询间隔就是键入延迟（ConPTY 把输入回显进输出流，只有
//! `cmd_terminal_read` 那一跳才看得见）—— 350ms 的轮询 = 「敲一下等一帧」。现在 core 里的
//! 推送任务每段新输出就发一帧（带 `[from, next)` 绝对偏移，16ms 前沿节流合并突发），
//! 这里只是把 core 的宿主出口接到 Tauri 事件上（与 `agent:service-exit` 同一种写法）。
//! `cmd_terminal_read` 仍然是权威：前端发现偏移断档（事件丢了 / 慢了一帧）就照旧补读。
//! 事件名不进 `AgentEventType`（它只描述模型侧事件）。
//!
//! 平台：只有 Windows 有交互终端（ConPTY）。其他平台 `cmd_terminal_start` 返回明确错误，
//! 前端会把原话显示出来（不假装能用）。

use serde_json::{Value, json};

use virlen_core::agent::native_tools::{
    kill_terminal, list_shells, list_terminals, read_terminal, resize_terminal, start_terminal,
    write_terminal, ConsoleDelta, TerminalOutputHost,
};

/// 终端输出推送的事件名（前端 `onUserTerminalOutput` 订阅）
const OUTPUT_EVENT: &str = "terminal:output";

/// 终端输出的 GUI 出口：把 core 推来的帧原样转发给主窗口。
///
/// 载荷与 `cmd_terminal_read` 的应答同形（`from` 多一个「这段的起点」），前端两种来源
/// 因此能共用同一套偏移续接逻辑：事件带消息就追加，偏移对不上就回头调读命令。
pub struct TauriTerminalOutputHost {
    app: tauri::AppHandle,
}

impl TauriTerminalOutputHost {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl TerminalOutputHost for TauriTerminalOutputHost {
    fn push_terminal_output(&self, session_id: &str, id: &str, delta: &ConsoleDelta) {
        use tauri::Emitter;
        // 发不出去（窗口已关）就算了：下一次补读会拿到同一段内容
        let _ = self.app.emit(
            OUTPUT_EVENT,
            json!({
                "sessionId": session_id,
                "id": id,
                "from": delta.from,
                "next": delta.next,
                "text": delta.text,
                "reset": delta.reset,
                "running": delta.running,
            }),
        );
    }
}

/// 起一个终端：`cwd` 必须是存在的绝对目录（宿主按「会话工作区 → 已选目录 → 全局默认」解析）。
///
/// `shell` 是 shell 类型 id（`cmd` / `powershell` / `pwsh` / `gitbash`）：`null` / 省略 = 默认
/// （Windows PowerShell）；认不出的 id 与「认得但没装」都返回**给用户看的**中文原因
///（对着 `cmd_terminal_shells` 的 `available` 就不会走到这条路）。
///
/// 返回 `{ id, shell, command, cwd, pid, startedAt }`。
#[tauri::command]
pub async fn cmd_terminal_start(
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<Value, String> {
    start_terminal(&session_id, &cwd, cols, rows, shell.as_deref())
}

/// 这台机器上支持哪些 shell、装没装（界面菜单据此渲染：未安装的灰显 + 标「未安装」）。
///
/// 每项：`{ id, exe, available, command, args, default, hint }`。
/// 探测顺序（先已知安装目录，再 PATH）见 core 的 `user_shell/shells.rs`。
#[tauri::command]
pub async fn cmd_terminal_shells() -> Vec<Value> {
    list_shells()
}

/// 读终端输出（自偏移 `from` 起的增量）。`None` = 本会话已无此终端（标签据此收尾）。
/// `reset=true` 时回整个窗口（首次读取 / 环形已丢掉开头），前端整段重放。
#[tauri::command]
pub async fn cmd_terminal_read(
    session_id: String,
    id: String,
    from: u64,
) -> Option<Value> {
    read_terminal(&session_id, &id, from)
}

/// 把键击（或粘贴）写进伪控制台。`false` = 没写进去（非本会话 / 已结束）。
/// ⚠️ 只回「写没写进去」，**不记内容**。
#[tauri::command]
pub async fn cmd_terminal_write(session_id: String, id: String, data: String) -> bool {
    write_terminal(&session_id, &id, &data)
}

/// 调整伪控制台尺寸。`false` = 没有可调的控制台（非本会话 / 已结束）。
/// 同尺寸重复上报由 Rust 侧去重（ConPTY 重绘补空行的坑）。
#[tauri::command]
pub async fn cmd_terminal_resize(
    session_id: String,
    id: String,
    cols: u16,
    rows: u16,
) -> bool {
    resize_terminal(&session_id, &id, cols, rows)
}

/// 关掉一个终端：杀整棵进程树 + 摘条目（幂等）。`false` = 本会话没有这个 id。
///
/// 与服务的「终止」不同：终端关掉就该消失（没有「已结束但仍要看列表」的需求）。
#[tauri::command]
pub async fn cmd_terminal_kill(session_id: String, id: String) -> bool {
    kill_terminal(&session_id, &id)
}

/// 列本会话的终端（诊断 / 以后做「恢复上次终端」）。不参与轮询。
#[tauri::command]
pub async fn cmd_terminal_list(session_id: String) -> Vec<Value> {
    list_terminals(&session_id)
}
