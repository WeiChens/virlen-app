//! per-repo 串行队列 —— 同一仓库的**写操作**必须排队。
//!
//! 为什么需要：git 的 index 是单文件 + `index.lock` 排他。两个写命令并发起跑，后者会直接
//! 报 `Unable to create '.../index.lock': File exists`；更糟的是它可能发生在「暂存完文件、
//! 提交前」这条链上，用户看到的是「点了暂存，结果提交说没东西」。
//!
//! 只读命令**不**走这里（也不需要）：它们带 `--no-optional-locks`，本来就不碰锁。
//!
//! 锁的粒度按**仓库根**（调用方传入的 key 必须是规范化后的仓库根，见 [`super::cli::GitCmd::write`]）：
//! 不同仓库互不阻塞。表里会按访问过的仓库数增长，仓库数是人有上限的量，不做回收。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

fn table() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取到 `key` 这把锁后执行 `f`（同 key 串行，不同 key 并行）。
///
/// ⚠️ 本函数会**阻塞当前线程**直到拿到锁 —— 调用方必须是 `spawn_blocking` 里的阻塞线程
/// （与既有命令的写法一致），不要放在 async 任务里直接调。
pub fn with_repo_lock<T>(key: &str, f: impl FnOnce() -> T) -> T {
    let lock = {
        let mut map = table().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(normalize_key(key)).or_default().clone()
    };
    // 被毒化（持锁线程 panic）不传染：锁保护的是「别的 git 进程」，与本次数据无关
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// Windows 路径大小写不敏感且分隔符两种写法都可能出现 → 归一化后再做 key，
/// 否则 `C:/repo` 与 `c:\repo` 会拿到两把不同的锁，串行就失效了。
fn normalize_key(key: &str) -> String {
    let unified = key.replace('\\', "/");
    if cfg!(target_os = "windows") {
        unified.to_lowercase()
    } else {
        unified
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// 同一 key 必须串行：并发跑 N 次，「同时在跑」的计数任何时刻都不该超过 1。
    #[test]
    fn same_repo_is_serialized() {
        let running = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let running = running.clone();
            let max_seen = max_seen.clone();
            handles.push(std::thread::spawn(move || {
                with_repo_lock("C:/repo/a", || {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(20));
                    running.fetch_sub(1, Ordering::SeqCst);
                })
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    }

    /// Windows 大小写 / 分隔符两种写法 = 同一把锁（否则串行静默失效）。
    #[cfg(target_os = "windows")]
    #[test]
    fn key_normalization_is_case_and_separator_insensitive() {
        assert_eq!(normalize_key("C:\\Repo\\A"), normalize_key("c:/repo/a"));
    }

    /// 不同仓库不该互相阻塞：两个 key 同时各跑一次，第二个不必等第一个睡完。
    #[test]
    fn different_repos_do_not_block_each_other() {
        let started = Arc::new(AtomicUsize::new(0));
        let hit_max = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for key in ["C:/repo/x", "C:/repo/y"] {
            let started = started.clone();
            let hit_max = hit_max.clone();
            handles.push(std::thread::spawn(move || {
                with_repo_lock(key, || {
                    let now = started.fetch_add(1, Ordering::SeqCst) + 1;
                    hit_max.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(30));
                })
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(hit_max.load(Ordering::SeqCst), 2);
    }
}
