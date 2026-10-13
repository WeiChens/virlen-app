//! 端侧「重活」的统一执行入口 —— **取消 / 并发闸 / 线程优先级只在这里实现一次**。
//!
//! 谁在用：CPU 密集的原生工具 —— `vision_analyze` 的 ONNX 推理、`parse_document` 的文档解析。
//! 新增长耗时工具时**直接用本模块**，别各写一份 `spawn_blocking + select`（§11.51 那串缺陷就是
//! 一个个工具各写一半、漏一半攒出来的）。
//!
//! 三件事各自的理由：
//! 1. **取消**：Rust 没有 thread kill，`spawn_blocking` 的 JoinHandle 丢掉**不会**停掉已开跑的任务
//!    （`abort` 只对 async task 有效）。所以取消必然是两层：本函数的 `select!` 保证**立刻返回、
//!    丢弃结果**（引擎随即收敛、UI 立刻有反馈），传进闭包的 `&AtomicBool` 让任务自己在检查点
//!    尽早退出。⚠️ 第三方库内部没有检查点的（`pdf-extract` / `office_oxide` / ONNX 单次推理）
//!    只能跑完当前那一段 —— 想「立即停 CPU」只有进程隔离一条路。
//! 2. **并发闸**：端侧模型只有一份、推理又是 CPU 密集，多个并跑会把 CPU 抢光（界面自己就卡了）。
//!    全局同时只放一个。
//! 3. **线程优先级**：干活**之前**把本线程降到 `BELOW_NORMAL`，让 UI 线程（`NORMAL`）优先拿到
//!    时间片。不用 `IDLE`：那会把任务拖慢好几倍。
//!    ⚠️ **实测边界（2026-10-12，Windows）**：只对**纯 Rust 段**（图片解码、文档解析、文本组装）
//!    有效。ONNX Runtime 的推理线程池**不继承**本线程优先级 —— quasivision 在加载模型时自建线程池
//!    （`with_intra_threads(4)` / `with_inter_threads(2)`，且不对外暴露配置），实测那 16 个常驻线程
//!    全程是 `NORMAL`。想让整段推理不跟 UI 抢 CPU，只有**进程隔离**（子进程 + 低优先级）一条路。

use crate::agent::cancellation::CancellationToken;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;

/// 端侧重推理的全局并发闸：同时只放一个（模型只有一份，且都是 CPU 密集）
static HEAVY_TASK_GATE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));

/// 「调用方没有取消诉求」时的令牌（GUI 命令壳等）—— 永不取消
pub(crate) static NEVER_CANCELLED: Lazy<CancellationToken> = Lazy::new(CancellationToken::new);

/// 重活的结局（三态必须分开：把 panic 混进「取消」会让真 bug 静默成「用户取消」）
pub(crate) enum Heavy<T> {
    /// 跑完了
    Done(T),
    /// 被取消：结果**丢弃**（调用方回自己的取消口径）
    Cancelled,
    /// 阻塞任务 panic / 被运行时丢弃
    Panicked(String),
}

/// 跑一个「可能跑很久、且无法被强行中断」的同步任务。
///
/// 闭包收到的 `&AtomicBool` 是取消标志：库调用之间的检查点看到它转 `true` 就该尽早返回。
pub(crate) async fn run_heavy<T, F>(cancel: &CancellationToken, task: F) -> Heavy<T>
where
    F: FnOnce(&AtomicBool) -> T + Send + 'static,
    T: Send + 'static,
{
    // 排队期间也要可取消：闸被别的重活占着时，用户点「停止」不能干等
    let permit = tokio::select! {
        _ = cancel.cancelled() => return Heavy::Cancelled,
        p = HEAVY_TASK_GATE.acquire() => match p {
            Ok(p) => p,
            // 闸被 close（只有进程收尾会出现）：按取消处理，不要 panic
            Err(_) => return Heavy::Cancelled,
        },
    };

    let flag = Arc::new(AtomicBool::new(false));
    let flag_in = flag.clone();
    let task_handle = tokio::task::spawn_blocking(move || {
        // 降优先级要在调用库**之前**：库里建的线程池会继承它
        lower_current_thread_priority();
        // 闸随任务结束（或被放弃的任务跑完）释放
        let _permit = permit;
        task(&flag_in)
    });

    tokio::select! {
        _ = cancel.cancelled() => {
            flag.store(true, Ordering::SeqCst);
            Heavy::Cancelled
        }
        r = task_handle => match r {
            Ok(v) => Heavy::Done(v),
            Err(e) => Heavy::Panicked(e.to_string()),
        },
    }
}

/// 把当前线程降到「低于正常」优先级（失败无副作用：只是拿不到「不抢 UI」的优待）。
///
/// ⚠️ 实测：**管不到第三方库自建的线程池** —— ONNX Runtime 在模型加载时创建推理线程池并自行设定
/// 优先级（实测 16 个线程恒为 `NORMAL`），本调用只覆盖纯 Rust 段。
fn lower_current_thread_priority() {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
    // 其它平台：CLI / headless 没有 GUI 抢调度的问题，交给系统调度器即可
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[tokio::test]
    async fn returns_the_task_value_when_not_cancelled() {
        let out = run_heavy(&NEVER_CANCELLED, |_flag| 7_u32).await;
        assert!(matches!(out, Heavy::Done(7)));
    }

    /// 预检：令牌已取消时**不该启动任务**（闭包一次都不执行）
    #[tokio::test]
    async fn cancel_before_start_does_not_run_the_task() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let ran = Arc::new(AtomicBool::new(false));
        let ran_in = ran.clone();

        let out = run_heavy(&cancel, move |_flag| {
            ran_in.store(true, Ordering::SeqCst);
        })
        .await;

        assert!(matches!(out, Heavy::Cancelled), "已取消应返回 Cancelled");
        assert!(!ran.load(Ordering::SeqCst), "已取消不该启动任务");
    }

    /// 中途取消：立刻返回 None，并把取消标志交给任务（任务自己找机会退出）
    #[tokio::test]
    async fn cancel_mid_flight_drops_the_result_and_sets_the_flag() {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let seen = Arc::new(AtomicBool::new(false));
        let seen_in = seen.clone();

        let handle = tokio::spawn(async move {
            run_heavy(&cancel, move |flag| {
                let _ = tx.send(());
                // 模拟「库调用之间的检查点」：等取消标志
                for _ in 0..2000 {
                    if flag.load(Ordering::SeqCst) {
                        seen_in.store(true, Ordering::SeqCst);
                        return "cancelled";
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                "finished"
            })
            .await
        });

        rx.await.expect("任务应已开始");
        trigger.cancel();
        let out = handle.await.unwrap();
        assert!(
            matches!(out, Heavy::Cancelled),
            "取消应返回 Cancelled（结果被丢弃）"
        );
        // 标志置位后任务会自己退出（给它一点时间）
        for _ in 0..500 {
            if seen.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("取消标志应已交给任务");
    }

    /// 并发闸：两个重活不会同时跑（端侧模型只有一份）
    #[tokio::test]
    async fn gate_serializes_heavy_tasks() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        fn task(running: Arc<AtomicUsize>, peak: Arc<AtomicUsize>) -> impl FnOnce(&AtomicBool) {
            move |_flag| {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(40));
                running.fetch_sub(1, Ordering::SeqCst);
            }
        }

        let a = run_heavy(&NEVER_CANCELLED, task(running.clone(), peak.clone()));
        let b = run_heavy(&NEVER_CANCELLED, task(running.clone(), peak.clone()));
        let _ = tokio::join!(a, b);

        assert_eq!(peak.load(Ordering::SeqCst), 1, "重活必须串行（闸=1）");
    }
}
