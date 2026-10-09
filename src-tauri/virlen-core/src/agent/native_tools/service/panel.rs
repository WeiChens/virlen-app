//! service — **界面（聊天页右上角面板）用的公开 API**。
//!
//! 与四个工具的分工：工具面对**模型**（英文文案 + 消费已读游标 + 容量与重名管理），本模块面对
//! **用户面板**（P2 列表 / 终止，P3 终端弹窗）。两者**同一张注册表**，
//! 因此面板杀掉的正是模型那边的那份状态 —— 面板终止后模型 `get` / `kill` 会如实看到「被终止」。
//!
//! 与工具不同的地方只有三条，都必须守住：
//! 1. **只读**：不消费已读游标（面板刷一眼 / 终端弹窗回放都不能把「AI 还没读过的输出」抹掉）；
//! 2. **终止不摘条目**：工具 `kill` 确认退出后会把条目清出注册表（收尾输出已随结果交给模型），
//!    面板必须让它在「已结束」页里继续可见 —— 容量由 `ensure_capacity` 在下次 start 时顺手清理；
//! 3. **会话隔离与工具同源**：只认本会话的 id，跨会话 / 不存在一律按「本会话没有它」处理。
//!
//! P3（终端弹窗）的三条：
//! - [`read_service_console`]：读**合并流**（带绝对偏移，供终端增量续接）；用的是独立缓冲区，
//!   与模型的 stdout / stderr 两个窗口互不影响；
//! - [`write_service_console`] / [`resize_service_console`]：把用户键击 / 尺寸写进伪控制台；
//!   只对**跑在伪控制台里且仍在运行**的服务生效（管道模式 / 已结束一律 `false`）。
//!
//! P4（新对话页的**全局视图**）：[`list_all_service_snapshots`] 列出所有会话的服务、每行带
//! `sessionId` 归属 —— 聊天页没有选中会话时也得能看到（服务是活进程，切到新对话也不能「找不到」）。
//! 单会话口径不变：列表 / 终止 / 终端弹窗仍只认传入的会话 id。

use serde_json::{json, Value};

use super::common::base_ui;
use super::registry::{self, ServiceEntry};

/// 面板终止后的有界等待（ms）—— 等状态落定再回快照。
///
/// ⚠️ 比工具侧 `KILL_WAIT_MS`（3000）短：这是**用户点按钮**的一次交互，不该为一个赖着不退的进程
/// 卡三秒；等不到就如实回 `running`，下一次轮询（面板打开时 1s）会把真实状态带回来。
const PANEL_KILL_WAIT_MS: i64 = 1200;

/// 本会话的服务快照（按启动时间升序，与 `list_background_services` 同一口径）。
///
/// 字段形状与 `list_background_services` 工具的 `uiData.services` **完全同形**（同一份 `base_ui`
/// 加上 `unreadChars`）—— 前端面板因此能直接复用卡片那套语言无关的字段解析，不必再记一套字段名。
pub fn list_service_snapshots(session_id: &str) -> Vec<Value> {
    let now = crate::telemetry::now_ms();
    registry::list(session_id)
        .iter()
        .map(|e| snapshot(e, now))
        .collect()
}

/// 终止一个服务并回它的最新快照；`None` = 本会话里没有这个 id。
///
/// 幂等：已结束的服务不杀、只回现状（与 `kill_background_service` 同口径）。
pub async fn kill_service_snapshot(session_id: &str, id: &str) -> Option<Value> {
    let entry = registry::get(session_id, id)?;
    if entry.is_running() {
        entry.terminate();
        let confirmed = entry.state.wait_finished(PANEL_KILL_WAIT_MS).await;
        crate::telemetry::track(
            "tool.service.panel_kill",
            json!({ "status": if confirmed { "exited" } else { "signalled" } }),
        );
    }
    Some(snapshot(&entry, crate::telemetry::now_ms()))
}

/// 单条快照（`base_ui` 骨架 + 未读输出数）。
fn snapshot(entry: &ServiceEntry, now: i64) -> Value {
    let mut ui = base_ui(entry, now);
    if let Value::Object(map) = &mut ui {
        map.insert("unreadChars".into(), Value::Number(entry.unread().into()));
    }
    ui
}

/// **所有会话**的服务快照（按启动时间升序）—— 聊天页处于「新对话」（未选中会话）时的入口用。
///
/// 与 [`list_service_snapshots`] 的唯一差别：每行多一个 `sessionId`（归属）—— 用户必须一眼看得出
/// 「这条是谁的」。其余字段同形（同一份 `base_ui` + `unreadChars`），前端仍只维护一套解析。
///
/// ⚠️ 可见范围只对**界面**放开：模型侧四个工具仍严格会话隔离；跨会话的操作（终止 / 开终端弹窗）
/// 由用户显式点击触发，且必须带该行自己的 `sessionId`。
pub fn list_all_service_snapshots() -> Vec<Value> {
    let now = crate::telemetry::now_ms();
    registry::list_all()
        .iter()
        .map(|e| {
            let mut ui = snapshot(e, now);
            if let Value::Object(map) = &mut ui {
                map.insert("sessionId".into(), Value::String(e.session_id.clone()));
            }
            ui
        })
        .collect()
}

// ==================== 终端弹窗（P3） ====================

/// 读终端弹窗需要的**合并输出流**（自绝对偏移 `from` 起）；`None` = 本会话里没有这个 id。
///
/// 回答的字段（语言无关）：
/// - `text` / `reset` / `next`：增量续接协议 —— `reset=true`（首次读取 / 环形窗口已丢掉客户端持有的
///   开头）时 `text` 是**整个窗口**，客户端整段重放并把游标设到 `next`；否则只续接新增部分；
/// - `headDropped`：窗口开头是否已被环形丢弃（弹窗据此提示「更早的输出看不到了」）；
/// - `running` / `terminal` / `interactive`：运行状态、**是否（曾）跑在伪控制台里**（已结束的终端
///   服务仍为 `true` —— 弹窗据此把「服务已结束」与「管道模式」分开报）、**现在能否输入**
///   （`running && 控制台还活着`）—— 轮询这一条命令就能同时维护终端内容、输入开关与提示文案，
///   不必再对一遍列表。
///
/// ⚠️ 不消费已读游标（走 `LogBuffer::read_from`，只读），模型侧增量读不受影响。
pub fn read_service_console(session_id: &str, id: &str, from: u64) -> Option<Value> {
    let entry = registry::get(session_id, id)?;
    let (text, reset, next, head_dropped) =
        entry.state.console.lock().unwrap().read_from(from);
    let running = entry.is_running();
    // `terminal` 是**持久判定**（见 `ServiceState::pty_capable`）：控制台已随进程退出关闭的服务仍然是
    // 「终端服务」—— 不能让它看起来像管道模式（P3 实测 bug：Ctrl+C 结束服务后弹窗误报「管道模式」）。
    let terminal = entry.state.pty_capable();
    let interactive = running && entry.state.has_pty();
    Some(json!({
        "text": text,
        "reset": reset,
        "next": next,
        "headDropped": head_dropped,
        "running": running,
        "terminal": terminal,
        "interactive": interactive,
    }))
}

/// 把用户键入的字节写进服务的伪控制台。`false` = 没写进去（非本会话 / 已结束 / 没有控制台）。
///
/// ⚠️ **只记「发生了写」，不记内容**：PTY 里敲的常是密码 / token（与命令路径同一条红线）。
pub fn write_service_console(session_id: &str, id: &str, data: &str) -> bool {
    let Some(entry) = registry::get(session_id, id) else {
        return false;
    };
    if !entry.is_running() {
        return false;
    }
    match entry.state.pty() {
        Some(pty) => pty.write(data),
        None => false,
    }
}

/// 调整服务的伪控制台尺寸。`false` = 没有可调的控制台（非本会话 / 已结束 / 管道模式）。
///
/// 同尺寸重复上报由 `ServicePty` 内部的去重器吞掉（ConPTY 重绘补空行的坑，见 `pty.rs`）。
pub fn resize_service_console(session_id: &str, id: &str, cols: u16, rows: u16) -> bool {
    let Some(entry) = registry::get(session_id, id) else {
        return false;
    };
    if !entry.is_running() {
        return false;
    }
    match entry.state.pty() {
        Some(pty) => pty.resize(cols, rows),
        None => false,
    }
}
