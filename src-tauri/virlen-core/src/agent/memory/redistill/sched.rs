//! 再蒸馏的**调度**：谁在跑、有没有待办、宿主怎么被唤醒
//!
//! 与「后台服务结束通知」（`native_tools/service/notice.rs`）同构：core 只发信号，
//! 「怎么跑」由宿主实现 [`MemoryRedistillRuntime`] 决定（GUI：`tauri::async_runtime::spawn` +
//! `DefaultProviderFactory`；CLI：`tokio::spawn` + `create_native_provider`）。
//! 宿主 trait 里**不出现** `MemoryRepo` / `SettingsRepo` —— 句柄在宿主实现里持有，core 只发信号。
//!
//! 三条硬约束（方案 §3.1）：
//! 1. **工具路径绝不能等 LLM**：[`request`] 只做「几条本地 SQLite 计数 + 入队」，毫秒级；
//! 2. **失败绝不牵连写入**：[`request`] 的任何错误只打日志（返回 `false`），调用方的返回值一字不改；
//! 3. **一次只跑一个任务**：进程内标志 + DB 指纹 claim 双保险（多窗口 / GUI + CLI 同开也只跑一次）。

use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use crate::agent::cancellation::CancellationToken;
use crate::agent::memory::prompt::enabled_from_settings;
use crate::agent::memory::redistill::models::{memory_model_candidates, MemoryProviderBuilder};
use crate::agent::memory::redistill::plan::{decide_trigger, Trigger};
use crate::agent::memory::redistill::{
    redistill_enabled_from_settings, run_at, RedistillDeps, RedistillReport, RedistillTask,
    MEMORY_REDISTILL_ARCHIVE_RETENTION_MS, MEMORY_REDISTILL_MIN_GROUP_ITEMS,
    MEMORY_REDISTILL_MODEL_MAX_CANDIDATES,
};
use crate::rag::rag_service::RagService;
use crate::session_db::{
    MemoryRepo, SessionRepo, SettingsRepo, MEMORY_REDISTILL_PURGE_FINGERPRINT,
};

/// 宿主派发一次后台整理。
///
/// 实现方在 `spawn_redistill` 里起一个后台任务，任务体调用 [`execute_pending`]（core 的流水线），
/// 拿到报告后由自己决定怎么用（GUI 埋点；CLI 打印）。
/// 返回 `false` = 这次不接（请求留在队列里，等下一次触发或下次启动）。
pub trait MemoryRedistillRuntime: Send + Sync {
    fn spawn_redistill(&self, cancel: CancellationToken) -> bool;
    /// 进程退出：宿主自己收摊（core 的 [`shutdown`] 已经取消令牌并清队列，这里只做宿主侧的事）
    fn shutdown(&self) {}
}

static HOST: LazyLock<Mutex<Option<Arc<dyn MemoryRedistillRuntime>>>> =
    LazyLock::new(|| Mutex::new(None));
/// 待办队列（最多留一个：一次只跑一个任务，多了也没有意义）
static QUEUE: LazyLock<Mutex<VecDeque<RedistillTask>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
/// 正在跑（进程内标志）
static RUNNING: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));
/// 当前任务的取消令牌（退出时取消它）
static CURRENT: LazyLock<Mutex<Option<CancellationToken>>> = LazyLock::new(|| Mutex::new(None));

/// 取「正在跑」标志（**对锁中毒免疫**）：panic 兜底的意义就在于「坏过一次之后还能接着用」，
/// 若这里 `unwrap()` 一下，一次 panic 就会把整个闸门变成永久 panic。
fn running_flag() -> MutexGuard<'static, bool> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// 手动触发时「已经有一轮在跑」的统一文案（命令层与 core 共用一份，避免两处措辞分叉）
pub const MEMORY_REDISTILL_BUSY: &str = "记忆整理正在进行中，请稍后再试";

/// 把守「跑完必复位」：`RUNNING = false` / `CURRENT = None`。
///
/// ⚠️ 复位必须绑在 Drop 上。若只写在 `run_at(...).await` 之后，后台任务里任何一处 panic
/// （release 下被 runtime 吞掉，只留一个 `spawn` 的 Err 日志）都会让 `RUNNING` **永久为 true** ——
/// 之后本进程内所有 [`request`] / [`pump`] 立即 `return false`，表现就是「这一整天自动整理彻底
/// 消失，重启后又好了」。
struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        *running_flag() = false;
        *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// 挂上宿主（GUI 在引擎初始化时调一次）。重复挂载以最后一次为准，并立刻尝试排空队列。
pub fn attach_host(rt: Arc<dyn MemoryRedistillRuntime>) {
    *HOST.lock().unwrap() = Some(rt);
    // 启动时补跑：上次退出没跑完 / 本次启动就已越线的库（不引入定时器）
    pump();
}

/// 尝试把队列里的待办交给宿主；没有宿主 / 宿主不接 → 留在队列（下次启动或下次触发再来）。
pub fn pump() -> bool {
    if *running_flag() {
        return false;
    }
    if QUEUE.lock().unwrap().is_empty() {
        return false;
    }
    let Some(host) = HOST.lock().unwrap().clone() else {
        return false;
    };
    host.spawn_redistill(CancellationToken::new())
}

/// 是否有一轮正在跑（面板手动触发前先问一句，避免与后台自动整理同时改同一批记忆）。
///
/// ⚠️ 只覆盖**进程内**的后台任务：GUI 与 CLI 同开时另靠 DB 指纹 claim 兜底
/// （`claim_redistill_run`），这里不是唯一防线。
pub fn is_running() -> bool {
    *running_flag()
}

/// 退出点（`app.exit` / 引擎销毁 / CLI 结束）：取消正在跑的任务并清空队列。
pub fn shutdown() {
    if let Some(tok) = CURRENT.lock().unwrap().take() {
        tok.cancel();
    }
    QUEUE.lock().unwrap().clear();
}

/// 闸门（**唯一**的入队入口）：条数越线 → 全流程；只剩超期归档 → 只清理。
///
/// 返回是否入了队（测试用）。**任何错误都只打日志** —— 记忆写入是主流程，闸门坏了不该牵连它。
pub async fn request(memory: &dyn MemoryRepo, settings: &dyn SettingsRepo, now_ms: i64) -> bool {
    if !memory.is_available() {
        return false; // 没有本地库（浏览器 dev / 库打不开）：如实不跑
    }
    // 节流：已有待办 / 正在跑 → 这一次不再入队
    if *running_flag() || !QUEUE.lock().unwrap().is_empty() {
        return false;
    }
    let settings_map = match settings.get_all().await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[memory] 读取设置失败，本次不检查再蒸馏: {}", e);
            return false;
        }
    };
    if !enabled_from_settings(&settings_map) {
        return false;
    }
    // 逃生开关（D5）：缺键 = 开（默认开、不进 UI；想关掉就手改库一行）
    if !redistill_enabled_from_settings(&settings_map) {
        return false;
    }

    let stats = match memory
        .redistill_stats(
            now_ms,
            MEMORY_REDISTILL_ARCHIVE_RETENTION_MS,
            MEMORY_REDISTILL_MIN_GROUP_ITEMS,
        )
        .await
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[memory] 统计再蒸馏候选失败，本次不触发: {}", e);
            return false;
        }
    };
    let last_run = memory.last_redistill_run().await.ok().flatten();
    let last_purge_at = memory
        .get_redistill_run(MEMORY_REDISTILL_PURGE_FINGERPRINT)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.finished_at);

    let trigger = decide_trigger(
        now_ms,
        stats.candidates,
        stats.purge_candidates,
        stats.has_group,
        last_run.as_ref(),
        last_purge_at,
    );
    match trigger {
        Trigger::None => false,
        Trigger::Full => {
            QUEUE.lock().unwrap().push_back(RedistillTask::Full);
            pump();
            true
        }
        Trigger::PurgeOnly => {
            QUEUE.lock().unwrap().push_back(RedistillTask::PurgeOnly);
            pump();
            true
        }
    }
}

/// 执行一个待办任务（宿主派发的后台任务体）。
///
/// `cancel` 由 [`pump`] 创建并交给宿主再传回来 —— 这样「谁在取消」只有一处（core），
/// 而宿主不必知道令牌怎么用（它只负责把它带回来）。
///
/// 返回 `None` = 没有待办（已被别的窗口取走 / 正在跑）；`Some(Err)` = 编排层报错（宿主自己决定怎么报）。
pub async fn execute_pending(
    memory: &dyn MemoryRepo,
    sessions: &dyn SessionRepo,
    settings: &dyn SettingsRepo,
    rag: Option<&'static RagService>,
    builder: &dyn MemoryProviderBuilder,
    cancel: CancellationToken,
) -> Option<Result<RedistillReport, String>> {
    let task = {
        let mut running = running_flag();
        if *running {
            return None;
        }
        let task = QUEUE.lock().unwrap().pop_front()?;
        *running = true;
        task
    };
    // 置位之后立刻上守卫：从这一刻到函数退出（含 unwind）之间任何路径出事都能复位
    let guard = RunningGuard;
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());

    let deps = RedistillDeps {
        memory,
        sessions,
        settings,
        rag,
        builder,
        cancel: &cancel,
    };
    let report = run_at(deps, task, crate::telemetry::now_ms(), false).await;

    // 先复位再 pump（pump 第一件事就是看 RUNNING）
    drop(guard);
    // 跑的过程中可能又来了待办（闸门在 RUNNING 期间不入队，所以这里最多再跑一个）
    pump();
    Some(report)
}

/// 跑一轮（不经过队列）—— 面板 / CLI 的显式触发用（`force` = 忽略冷却与指纹幂等）。
///
/// ⚠️ 与后台任务**双向互斥**：手动路径同样占 `RUNNING`。只让命令层先问一句 [`is_running`]
/// 是**单向**的 —— 手动在跑时后台 `pump()` 照样能开跑，而 `force` 会绕过指纹 claim，
/// 于是同一批被合并两次（双倍模型费用 + 两份归档详情 + 重复软删）。
pub async fn run_direct(
    memory: &dyn MemoryRepo,
    sessions: &dyn SessionRepo,
    settings: &dyn SettingsRepo,
    rag: Option<&'static RagService>,
    builder: &dyn MemoryProviderBuilder,
    task: RedistillTask,
    force: bool,
) -> Result<RedistillReport, String> {
    // 置位在**持锁期间**完成：之后到达的 request / pump / run_direct 都看得见（与 execute_pending 同序）
    {
        let mut running = running_flag();
        if *running {
            return Err(MEMORY_REDISTILL_BUSY.to_string());
        }
        *running = true;
    }
    let cancel = CancellationToken::new();
    let guard = RunningGuard;
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());

    let deps = RedistillDeps {
        memory,
        sessions,
        settings,
        rag,
        builder,
        cancel: &cancel,
    };
    let report = run_at(deps, task, crate::telemetry::now_ms(), force).await;

    // 先复位再 pump（pump 第一件事就是看 RUNNING）
    drop(guard);
    pump();
    report
}

/// 候选模型（CLI / GUI 报告用；与流水线内部同一份实现）
pub fn model_candidates_for_report(settings: &serde_json::Map<String, serde_json::Value>) -> usize {
    memory_model_candidates(settings, MEMORY_REDISTILL_MODEL_MAX_CANDIDATES).len()
}

/// 某个 fingerprint 是否已处理过（排障 / 测试辅助）
#[cfg(test)]
pub(crate) fn queued_tasks() -> Vec<RedistillTask> {
    QUEUE.lock().unwrap().iter().copied().collect()
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    QUEUE.lock().unwrap().clear();
    *running_flag() = false;
    *CURRENT.lock().unwrap() = None;
    *HOST.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::memory::redistill::MEMORY_REDISTILL_TRIGGER_COUNT;
    use crate::session_db::{MemoryRecord, RedistillStats};
    use async_trait::async_trait;
    use serde_json::{Map, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const NOW: i64 = 1_700_000_000_000;

    /// 桩：只覆写闸门用得到的几个方法（其余走 trait 默认实现 / 安全默认值）
    struct StubRepo {
        available: bool,
        candidates: i64,
        purge_candidates: i64,
        has_group: bool,
    }

    #[async_trait]
    impl MemoryRepo for StubRepo {
        fn is_available(&self) -> bool {
            self.available
        }
        async fn redistill_stats(
            &self,
            _now_ms: i64,
            _retention_ms: i64,
            _min_group_items: usize,
        ) -> Result<RedistillStats, String> {
            Ok(RedistillStats {
                candidates: self.candidates,
                purge_candidates: self.purge_candidates,
                has_group: self.has_group,
            })
        }
        async fn list(
            &self,
            _level: Option<&str>,
            _include_disabled: bool,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(Vec::new())
        }
        async fn get(&self, _id: &str) -> Result<Option<MemoryRecord>, String> {
            Ok(None)
        }
        async fn upsert(&self, _record: &MemoryRecord) -> Result<(), String> {
            Ok(())
        }
        async fn delete(&self, _id: &str) -> Result<bool, String> {
            Ok(false)
        }
        async fn set_level(&self, _id: &str, _level: &str) -> Result<bool, String> {
            Ok(false)
        }
        async fn set_disabled(&self, _id: &str, _disabled: bool) -> Result<bool, String> {
            Ok(false)
        }
        async fn touch(&self, _ids: &[String], _now_ms: i64) -> Result<(), String> {
            Ok(())
        }
        async fn search(
            &self,
            _query: &str,
            _level: Option<&str>,
            _kind: Option<&str>,
            _limit: usize,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(Vec::new())
        }
    }

    struct StubSettingsRepo(Map<String, Value>);

    #[async_trait]
    impl SettingsRepo for StubSettingsRepo {
        async fn get_all(&self) -> Result<Map<String, Value>, String> {
            Ok(self.0.clone())
        }
        async fn upsert(&self, _entries: Map<String, Value>) -> Result<(), String> {
            Ok(())
        }
        async fn import_if_empty(&self, _entries: Map<String, Value>) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// 宿主桩：记下被唤醒几次；`accept = false` 模拟「这次不接」（请求留在队列）
    struct RecordingHost {
        calls: Arc<AtomicUsize>,
        accept: bool,
    }

    impl MemoryRedistillRuntime for RecordingHost {
        fn spawn_redistill(&self, _cancel: CancellationToken) -> bool {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.accept
        }
    }

    fn repo(available: bool, candidates: i64, purge: i64, has_group: bool) -> StubRepo {
        StubRepo {
            available,
            candidates,
            purge_candidates: purge,
            has_group,
        }
    }

    /// 闸门 / 队列 / 宿主的完整行为
    ///
    /// ⚠️ 这是一个测试函数而不是四个：队列与宿主是**进程级单例**（与 `service/notice.rs` 同构），
    /// 拆开并行跑会互相干扰（一个测试刚清的队列被另一个测试的 request 填上）。
    #[tokio::test]
    async fn gate_queue_and_host_behaviour() {
        reset_for_tests();
        let settings = StubSettingsRepo(Map::new());
        let many = || repo(true, MEMORY_REDISTILL_TRIGGER_COUNT as i64, 0, true);

        // ── ① 没到阈值 / 没有值得合并的组 → 不跑，也不入队 ──
        assert!(!request(&repo(true, 99, 0, true), &settings, NOW).await);
        assert!(!request(&repo(true, 100, 0, false), &settings, NOW).await);
        assert!(queued_tasks().is_empty());

        // ── ② 越线且值得合并 → 入队一次；已有待办则节流 ──
        assert!(request(&many(), &settings, NOW).await);
        assert_eq!(queued_tasks(), vec![RedistillTask::Full]);
        assert!(!request(&many(), &settings, NOW).await, "一次只发一次");
        assert_eq!(queued_tasks().len(), 1);

        // ── ③ 条数没越线，但归档超期 → 只清理 ──
        reset_for_tests();
        assert!(request(&repo(true, 3, 7, false), &settings, NOW).await);
        assert_eq!(queued_tasks(), vec![RedistillTask::PurgeOnly]);

        // ── ④ 开关与可库性 ──
        reset_for_tests();
        assert!(
            !request(&repo(false, 1_000, 0, true), &settings, NOW).await,
            "没有本地库（Noop）：如实不跑"
        );
        let mut off = Map::new();
        off.insert("memoryEnabled".to_string(), Value::Bool(false));
        assert!(!request(&many(), &StubSettingsRepo(off), NOW).await, "记忆总开关关掉");
        let mut esc = Map::new();
        esc.insert(
            super::super::MEMORY_REDISTILL_ENABLED_KEY.to_string(),
            Value::Bool(false),
        );
        assert!(
            !request(&many(), &StubSettingsRepo(esc), NOW).await,
            "逃生开关：只关再蒸馏，记忆功能照旧"
        );
        let mut on = Map::new();
        on.insert(
            super::super::MEMORY_REDISTILL_ENABLED_KEY.to_string(),
            Value::Bool(true),
        );
        assert!(request(&many(), &StubSettingsRepo(on), NOW).await);

        // ── ⑤ 唤醒宿主；宿主不接（CLI / headless）→ 请求留在队列里 ──
        reset_for_tests();
        let calls = Arc::new(AtomicUsize::new(0));
        attach_host(Arc::new(RecordingHost {
            calls: calls.clone(),
            accept: false,
        }));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "挂载时队列是空的：不空跑");
        assert!(request(&many(), &settings, NOW).await);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "入队即尝试唤醒宿主");
        assert_eq!(queued_tasks().len(), 1, "宿主没接 → 请求留在队列里");

        // ── ⑥ 手动路径也必须占 RUNNING（双向互斥）──
        //
        // 只让命令层先问一句 `is_running()` 是**单向**的：手动在跑时后台 `pump()` 照样能开跑，
        // 而 `force` 会绕过指纹 claim → 同一批记忆被两条路径各合并一次
        //（双倍模型费用 + 两份归档详情 + 重复软删）。
        //
        // 不拆成独立用例：队列 / 宿主 / RUNNING 都是进程级单例，拆开并行跑会互相干扰。
        reset_for_tests();
        struct RefusingBuilder;
        impl MemoryProviderBuilder for RefusingBuilder {
            fn build(
                &self,
                _conn: &crate::agent::types::ProviderConnection,
            ) -> Result<Box<dyn crate::agent::provider::Provider>, String> {
                Err("本用例不该真的调模型".to_string())
            }
        }
        let memory = repo(true, MEMORY_REDISTILL_TRIGGER_COUNT as i64, 0, true);
        let sessions = crate::session_db::NoopSessionRepo;

        // 空闲时放行，且**自己复位**（否则这一整天自动整理彻底消失）
        let ok = run_direct(
            &memory,
            &sessions,
            &settings,
            None,
            &RefusingBuilder,
            RedistillTask::Full,
            true,
        )
        .await;
        assert!(ok.is_ok(), "空闲时该放行：{:?}", ok.err());
        assert!(!is_running(), "run_direct 跑完必须复位 RUNNING");

        // 已经有一轮在跑 → 直接拒（不碰库、不调模型），且不能把别人的标志改掉
        *running_flag() = true;
        let busy = run_direct(
            &memory,
            &sessions,
            &settings,
            None,
            &RefusingBuilder,
            RedistillTask::Full,
            true,
        )
        .await;
        assert_eq!(busy.unwrap_err(), MEMORY_REDISTILL_BUSY);
        assert!(is_running(), "拒绝时不得清掉别人占着的标志");

        // 互斥不是永久拉黑：标志复位后又能跑
        *running_flag() = false;
        assert!(!is_running());

        reset_for_tests();
        assert!(queued_tasks().is_empty());
    }
}
