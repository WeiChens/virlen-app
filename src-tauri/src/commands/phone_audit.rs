//! 手机控制 —— 审计落盘（M4）
//!
//! 为什么需要它：审批分级取的是「宽松档」（手机可批全部授权，含沙箱脱壳 / 危险命令），
//! 若审计只在内存，**重启即失** → 高风险操作无痕（见 `docs/phone-control-bridge.md` §16.3-1）。
//!
//! 形态：`<data_dir>/phone-audit.jsonl` —— **一行一条 JSON**（append-only）。
//! - 追加是**旁路**：TS 侧 fire-and-forget，写失败不影响功能（只影响"事后可回溯"）；
//! - 不做压缩 / 轮转：条目很小（预览已截断到 200 字符），且这是安全账本，
//!   丢历史比占空间的代价大得多。需要轮转时再单独加。
//!
//! ⚠️ 本文件只做「行式追加 + 读回最后 N 行」，**不解析 JSON**：
//! 结构与语义的单一真源在 TS（`virlen-app/src/bridge/audit.ts`），Rust 只当字节搬运工。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tauri::AppHandle;

use virlen_core::host::HostEnv;

/// 读回条目的默认上限（防止设置页一次性渲染上万条）。
const DEFAULT_LIST_LIMIT: usize = 200;
/// 单行长度上限（防御：异常输入不得让单行无限增长）。
const MAX_LINE_LEN: usize = 4_000;

fn data_dir(app: &AppHandle) -> PathBuf {
    crate::host::TauriHost::new(app.clone()).data_dir()
}

fn file_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("phone-audit.jsonl")
}

/// 追加一条审计（一行 JSON）。行内换行会被替换为空格，保证「一行一条」的不变量。
#[tauri::command]
pub fn cmd_phone_audit_append(app: AppHandle, line: String) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }
    let mut sanitized: String = line
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if sanitized.len() > MAX_LINE_LEN {
        sanitized.truncate(MAX_LINE_LEN);
    }

    let path = file_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开审计文件失败: {}", e))?;
    writeln!(file, "{}", sanitized).map_err(|e| format!("写入审计失败: {}", e))?;
    Ok(())
}

/// 读回最近 N 条审计（新的在前）。文件不存在 → 空列表（不是错误）。
#[tauri::command]
pub fn cmd_phone_audit_list(app: AppHandle, limit: Option<usize>) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).min(2_000);
    let content = match fs::read_to_string(file_path(&app)) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取审计失败: {}", e)),
    };
    let mut lines: Vec<&str> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.len() > limit {
        lines.drain(0..lines.len() - limit);
    }
    lines.reverse();
    Ok(lines.into_iter().map(|l| l.to_string()).collect())
}

/// 清空审计（删除文件）。仅供用户在设置页「清空记录」时使用。
#[tauri::command]
pub fn cmd_phone_audit_clear(app: AppHandle) -> Result<(), String> {
    match fs::remove_file(file_path(&app)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清空审计失败: {}", e)),
    }
}
