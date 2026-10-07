/// 任务管理器 — 按 task_id 取消运行中的任务：每个任务关联一个 `Arc<AtomicBool>`（cancel flag），
/// 执行过程定期检查，`stop_task` 置 true 触发取消。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn task_map() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册任务并返回 cancel flag；同名 task_id 已存在则先取消旧的
pub fn register(task_id: &str) -> Arc<AtomicBool> {
    let mut map = task_map().lock().unwrap();
    if let Some(old) = map.remove(task_id) {
        old.store(true, Ordering::SeqCst);
    }
    let flag = Arc::new(AtomicBool::new(false));
    map.insert(task_id.to_string(), flag.clone());
    flag
}

/// 置 cancel flag = true 并移除注册；true = 找到并取消，false = 无此任务
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

/// 任务完成后清理（未被取消时调用）
pub fn unregister(task_id: &str) {
    let mut map = task_map().lock().unwrap();
    map.remove(task_id);
}
