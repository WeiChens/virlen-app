/// 任务管理器 — 支持按 task_id 取消正在运行的任务
///
/// 原理：
/// - 每个任务关联一个 Arc<AtomicBool>（cancelled flag）
/// - 任务执行过程中定期检查 flag
/// - stop_task 设置 flag = true 来触发取消
/// - Tauri command 通过 IPC 传回已收集的部分结果
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn task_map() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一个新任务，返回 Arc<AtomicBool>（cancel flag）
/// 如果同名 task_id 已存在，先取消旧的
pub fn register(task_id: &str) -> Arc<AtomicBool> {
    let mut map = task_map().lock().unwrap();
    if let Some(old) = map.remove(task_id) {
        old.store(true, Ordering::SeqCst);
    }
    let flag = Arc::new(AtomicBool::new(false));
    map.insert(task_id.to_string(), flag.clone());
    flag
}

/// 停止任务：设置 cancel flag = true，并移除注册
/// 返回 true 表示找到并取消了该任务；false 表示没有此任务
pub fn stop(task_id: &str) -> bool {
    let mut map = task_map().lock().unwrap();
    match map.remove(task_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// 任务完成后清理（不会被取消时调用）
pub fn unregister(task_id: &str) {
    let mut map = task_map().lock().unwrap();
    map.remove(task_id);
}
