//! `memory` 子命令 —— 长期记忆（查看 / 再蒸馏 / 导出）
//!
//! ```text
//! virlen-cli memory list [--level normal|permanent] [--limit N] [--json]
//! virlen-cli memory redistill [--purge] [--force] [--dry-run] [--json]
//! virlen-cli memory runs [--limit N] [--json]
//! virlen-cli memory export [--out PATH]
//! ```
//!
//! 与桌面端共用同一份库（`HostEnv::data_dir()` 下的 `virlen.db`）与**同一份 core 实现**：
//! `list` / `export` 直接读 `memories` 表；`redistill` 走 `agent::memory::redistill`（与 GUI 后台任务同一个
//! `run_at`）；`runs` 看整理流水。
//!
//! 再蒸馏在 GUI 里是「用户无感的后台任务」，CLI 给出可当场跑、当场看结果的入口：
//! `--dry-run` 只算计划不写库（先看看会动多少条）；`--force` 忽略冷却与「这批处理过」的幂等判定。
//! ⚠️ CLI 是 headless：只支持 openai 兼容 / anthropic 两种协议（gemini 等桥接协议需要桌面端 JS 宿主）。

use std::io::Write;
use std::sync::Arc;

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::memory::export::export_json;
use virlen_core::agent::memory::redistill::models::MemoryProviderBuilder;
use virlen_core::agent::memory::redistill::plan::{group_candidates, pick_batch};
use virlen_core::agent::memory::redistill::sched::run_direct;
use virlen_core::agent::memory::redistill::{
    RedistillReport, RedistillTask, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS,
    MEMORY_REDISTILL_BATCH_MAX_ITEMS, MEMORY_REDISTILL_MAX_BATCHES_PER_RUN,
    MEMORY_REDISTILL_MAX_INPUT_CHARS, MEMORY_REDISTILL_MIN_GROUP_ITEMS,
};
use virlen_core::agent::memory::MEMORY_SUMMARY_MAX_CHARS;
use virlen_core::agent::provider::{create_native_provider, Provider};
use virlen_core::agent::types::ProviderConnection;
use virlen_core::session_db::{open_session_db, MemoryRecord, SessionDb, MEMORY_LEVEL_PERMANENT};

use crate::{EXIT_ERROR, EXIT_OK};

/// `memory list` 默认最多显示多少条
const DEFAULT_LIST_LIMIT: usize = 50;
/// `memory list --limit` 上限（再大也是刷屏；机器可读请用 `--json`）
const MAX_LIST_LIMIT: usize = 500;

/// `memory` 的子命令
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MemoryCmd {
    Help,
    /// 列出记忆（默认含已停用 —— 否则用户会以为「记忆丢了」）
    List {
        level: Option<String>,
        limit: usize,
        json: bool,
    },
    /// 再蒸馏：把 AI 写下的记忆合并成更少的条目（后台能力的手动入口）
    Redistill {
        /// 只清理归档超期的旧条目（不调模型）
        purge: bool,
        /// 忽略冷却与「这批处理过」的幂等判定
        force: bool,
        /// 只算计划、不写库（先看看会动多少条）
        dry_run: bool,
        json: bool,
    },
    /// 整理流水（排障）
    Runs {
        limit: usize,
        json: bool,
    },
    /// 导出全部记忆为 JSON（不带 `--out` 就打到 stdout）
    Export {
        out: Option<String>,
    },
}

/// 帮助文本（`memory --help` / 用法错误时打印）
pub const USAGE_MEMORY: &str = "\
virlen-cli memory —— 长期记忆（与桌面端同一份 virlen.db）

用法:
  virlen-cli memory list [--level normal|permanent] [--limit N] [--json]
                                 列出记忆（默认含已停用；永久在前）
  virlen-cli memory redistill [--purge] [--force] [--dry-run] [--json]
                                 再蒸馏：把 AI 写下的记忆合并成更少的条目（只动 AI 产出的，用户手写的不碰）
                                 旧条目只停用不删除，原文全部归档进新条目的详情；保留 30 天后自动清理
                                 默认跑全流程（先清理再合并）；--purge 只清理；--dry-run 只算计划不写库
  virlen-cli memory runs [--limit N] [--json]
                                 看整理流水（时间 / 状态 / 条数 / 模型 / 原因）
  virlen-cli memory export [--out PATH]
                                 导出全部记忆为 JSON（含停用项；不带 --out 则打到标准输出）
                                 格式：{ format, schemaVersion, exportedAt, count, memories[] }
  -h, --help                     显示本帮助

选项:
      --level <值>         仅列出该级别（normal / permanent）
      --limit <N>          （仅 list / runs）最多显示 N 条（list 默认 50、上限 500）
      --purge              （仅 redistill）只做归档清理，不调模型
      --force              （仅 redistill）忽略冷却与幂等判定（排障 / 手动重跑）
      --dry-run            （仅 redistill）只打印计划（分组 / 批大小 / 预计调用数），**不写库**
      --out <PATH>         （仅 export）写到文件（UTF-8）；父目录不存在会报错
      --json               输出 JSON（便于脚本；export 恒为 JSON）

说明:
  再蒸馏只在「AI 写下的候选 ≥ 100 条」时才值得跑（自动触发就是这么判的）；手动跑不看阈值，
  但一轮最多 3 批（每批最多 40 条来源，见 MEMORY_REDISTILL_MAX_BATCHES_PER_RUN /
  MEMORY_REDISTILL_BATCH_MAX_ITEMS），每批一次模型调用。
  调用会记入用量账本（类型「记忆整理」），可在 `virlen-cli usage` 里看到。
  ⚠️ CLI 是 headless：只支持 openai 兼容 / anthropic 协议；gemini 等需要桌面端 JS 宿主。

退出码:
  0 成功（含「没有需要整理的东西」）    1 失败（库打不开 / 调用失败）    2 用法错误
";

/// 解析 `memory` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<MemoryCmd, String> {
    let mut it = args.into_iter();
    let Some(sub) = it.next() else {
        return Err("memory 缺少子命令（可用: list / redistill / runs / export）".to_string());
    };
    if matches!(sub, "-h" | "--help") {
        return Ok(MemoryCmd::Help);
    }
    let rest: Vec<&str> = it.collect();

    match sub {
        "list" => {
            let mut level: Option<String> = None;
            let mut limit = DEFAULT_LIST_LIMIT;
            let mut json = false;
            let mut it = rest.into_iter();
            while let Some(arg) = it.next() {
                match arg {
                    "--json" => json = true,
                    "--level" => {
                        let raw = it.next().ok_or("选项 --level 缺少取值")?;
                        if raw != virlen_core::session_db::MEMORY_LEVEL_NORMAL
                            && raw != MEMORY_LEVEL_PERMANENT
                        {
                            return Err(format!(
                                "--level 只能是 normal 或 permanent，收到: {}",
                                raw
                            ));
                        }
                        level = Some(raw.to_string());
                    }
                    "--limit" => {
                        let raw = it.next().ok_or("选项 --limit 缺少取值")?;
                        let n: usize = raw
                            .parse()
                            .map_err(|_| format!("--limit 需要正整数，收到: {}", raw))?;
                        if n == 0 || n > MAX_LIST_LIMIT {
                            return Err(format!("--limit 取值范围为 1..={}", MAX_LIST_LIMIT));
                        }
                        limit = n;
                    }
                    other => return Err(format!("未知选项: {}（见 `virlen-cli memory --help`）", other)),
                }
            }
            Ok(MemoryCmd::List { level, limit, json })
        }
        "redistill" => {
            let mut purge = false;
            let mut force = false;
            let mut dry_run = false;
            let mut json = false;
            // 这几个选项都不吃值 → 直接遍历（不用 `while let … next()`）
            for arg in rest {
                match arg {
                    "--purge" => purge = true,
                    "--force" => force = true,
                    "--dry-run" => dry_run = true,
                    "--json" => json = true,
                    other => return Err(format!("未知选项: {}（见 `virlen-cli memory --help`）", other)),
                }
            }
            Ok(MemoryCmd::Redistill {
                purge,
                force,
                dry_run,
                json,
            })
        }
        "runs" => {
            let mut limit = 20usize;
            let mut json = false;
            let mut it = rest.into_iter();
            while let Some(arg) = it.next() {
                match arg {
                    "--json" => json = true,
                    "--limit" => {
                        let raw = it.next().ok_or("选项 --limit 缺少取值")?;
                        let n: usize = raw
                            .parse()
                            .map_err(|_| format!("--limit 需要正整数，收到: {}", raw))?;
                        if n == 0 || n > MAX_LIST_LIMIT {
                            return Err(format!("--limit 取值范围为 1..={}", MAX_LIST_LIMIT));
                        }
                        limit = n;
                    }
                    other => return Err(format!("未知选项: {}（见 `virlen-cli memory --help`）", other)),
                }
            }
            Ok(MemoryCmd::Runs { limit, json })
        }
        "export" => {
            let mut out: Option<String> = None;
            let mut it = rest.into_iter();
            while let Some(arg) = it.next() {
                match arg {
                    "--out" => {
                        let raw = it.next().ok_or("选项 --out 缺少取值")?;
                        if raw.trim().is_empty() {
                            return Err("--out 需要一个非空路径".to_string());
                        }
                        out = Some(raw.to_string());
                    }
                    // export 的输出**恒为** JSON，`--json` 接受但无效果（脚本从 list 切过来不会报错）
                    "--json" => {}
                    other => return Err(format!("未知选项: {}（见 `virlen-cli memory --help`）", other)),
                }
            }
            Ok(MemoryCmd::Export { out })
        }
        other => Err(format!(
            "未知子命令: {}（可用: list / redistill / runs / export）",
            other
        )),
    }
}

/// `memory` 子命令入口（返回进程退出码）
pub(super) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: MemoryCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if let MemoryCmd::Help = cmd {
        let _ = write!(out, "{}", USAGE_MEMORY);
        return EXIT_OK;
    }

    let db = match open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    }) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
            return EXIT_ERROR;
        }
    };

    match cmd {
        MemoryCmd::Help => unreachable!("help 已在上面返回"),
        MemoryCmd::List { level, limit, json } => {
            list(&db, level.as_deref(), limit, json, out, err).await
        }
        MemoryCmd::Redistill {
            purge,
            force,
            dry_run,
            json,
        } => {
            if dry_run {
                dry_run_plan(&db, json, out, err).await
            } else {
                redistill(host, &db, purge, force, json, out, err).await
            }
        }
        MemoryCmd::Runs { limit, json } => runs(&db, limit, json, out, err).await,
        MemoryCmd::Export { out: path } => export(&db, path.as_deref(), out, err).await,
    }
}

/// `memory list`：默认含已停用（否则用户会以为「记忆丢了」）
async fn list(
    db: &SessionDb,
    level: Option<&str>,
    limit: usize,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let items = match db.memory.list(level, true).await {
        Ok(items) => items,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取记忆失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let shown: Vec<&MemoryRecord> = items.iter().take(limit).collect();
    if json {
        match serde_json::to_string_pretty(&shown) {
            Ok(s) => {
                let _ = writeln!(out, "{}", s);
            }
            Err(e) => {
                let _ = writeln!(err, "错误: 序列化失败: {}", e);
                return EXIT_ERROR;
            }
        }
        return EXIT_OK;
    }
    if items.is_empty() {
        let _ = writeln!(out, "（没有记忆）");
        return EXIT_OK;
    }
    let _ = writeln!(out, "共 {} 条（显示 {} 条）：", items.len(), shown.len());
    for m in shown {
        let mut flags = vec![m.level.clone(), m.kind.clone()];
        if m.source_day.trim().is_empty() {
            flags.push("手动".to_string());
        } else {
            flags.push(m.source_day.clone());
        }
        // 老数据：曾经由「记忆整理」产出的条目（功能已移除，历史条目的 origin 仍是 distill）
        if m.origin == "distill" {
            flags.push("蒸馏".to_string());
        }
        if m.disabled {
            flags.push("已停用".to_string());
        }
        if m.detail_doc_id.is_some() {
            flags.push("有详情".to_string());
        }
        let _ = writeln!(
            out,
            "  [{}] {}  （命中 {} 次，{} 字符）",
            flags.join(" / "),
            m.summary,
            m.hits,
            m.summary.chars().count()
        );
    }
    let _ = writeln!(
        out,
        "\n注：记忆正文硬上限 {} 字符（超出会截断）；详情正文在知识库「记忆详情」里。",
        MEMORY_SUMMARY_MAX_CHARS
    );
    EXIT_OK
}

/// `memory export`：与 GUI 的「导出 JSON」**同一份** `agent::memory::export`
///
/// 不带 `--out` 就打到 stdout（便于管道：`memory export > mem.json`）。
async fn export(
    db: &SessionDb,
    path: Option<&str>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let items = match db.memory.list(None, true).await {
        Ok(items) => items,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取记忆失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let json = match export_json(&items, virlen_core::telemetry::now_ms()) {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };

    match path {
        Some(p) => match std::fs::write(p, &json) {
            Ok(()) => {
                let _ = writeln!(out, "已导出 {} 条记忆 → {}", items.len(), p);
                EXIT_OK
            }
            Err(e) => {
                // 不替用户建目录：路径写错就是写错，建目录反而会掩盖手滑
                let _ = writeln!(err, "错误: 写入 {} 失败: {}", p, e);
                EXIT_ERROR
            }
        },
        None => {
            let _ = writeln!(out, "{}", json);
            EXIT_OK
        }
    }
}

/// CLI 侧的 Provider 构建器：只支持**原生**协议（headless 没有 JS 宿主）
struct CliRedistillBuilder;

impl MemoryProviderBuilder for CliRedistillBuilder {
    fn build(&self, conn: &ProviderConnection) -> Result<Box<dyn Provider>, String> {
        create_native_provider(conn)
    }
}

/// `memory redistill`：与 GUI 的后台任务走**同一份** `agent::memory::redistill::run_at`
async fn redistill(
    host: &Arc<dyn HostEnv>,
    db: &SessionDb,
    purge_only: bool,
    force: bool,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // 知识库：懒初始化（与 GUI 同一个目录）—— 起不来就**不会合并**
    //（没有归档就不许停用来源），同时清理也跳过（删了条目会留下孤儿详情文档）
    let rag = virlen_core::rag::ensure_service(host.data_dir()).ok();
    if rag.is_none() {
        let _ = writeln!(
            err,
            "提示: 知识库不可用 → 本轮不会合并、也不会清理任何记忆（没有归档就不许停用来源）"
        );
    }
    let builder = CliRedistillBuilder;
    let task = if purge_only {
        RedistillTask::PurgeOnly
    } else {
        RedistillTask::Full
    };
    let report = match run_direct(
        db.memory.as_ref(),
        db.repo.as_ref(),
        db.settings.as_ref(),
        rag,
        &builder,
        task,
        force,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(err, "错误: 再蒸馏失败: {}", e);
            return EXIT_ERROR;
        }
    };

    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(s) => {
                let _ = writeln!(out, "{}", s);
            }
            Err(e) => {
                let _ = writeln!(err, "错误: 序列化失败: {}", e);
                return EXIT_ERROR;
            }
        }
    } else {
        print_report(&report, out);
    }
    // 有失败的批次 → 退出码 1（脚本能据此判断），但结果已打印
    if report.batches.iter().any(|b| b.status == "failed") {
        EXIT_ERROR
    } else {
        EXIT_OK
    }
}

/// `--dry-run`：只算计划、**不写库、不调模型**（先看看会动多少条）
async fn dry_run_plan(db: &SessionDb, json: bool, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let now = virlen_core::telemetry::now_ms();
    let all = match db.memory.list(None, true).await {
        Ok(v) => v,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取记忆失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let stats = match db
        .memory
        .redistill_stats(now, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS, MEMORY_REDISTILL_MIN_GROUP_ITEMS)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(err, "错误: 统计候选失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let groups = group_candidates(&all, now);
    let planned: Vec<(String, usize, usize)> = groups
        .iter()
        .map(|g| {
            let batch = pick_batch(
                &g.items,
                MEMORY_REDISTILL_BATCH_MAX_ITEMS,
                MEMORY_REDISTILL_MAX_INPUT_CHARS,
            );
            (g.scope.clone(), g.items.len(), batch.len())
        })
        .collect();
    let estimated_calls = planned.len().min(MEMORY_REDISTILL_MAX_BATCHES_PER_RUN);

    if json {
        let payload = serde_json::json!({
            "candidates": stats.candidates,
            "purgeCandidates": stats.purge_candidates,
            "groups": planned
                .iter()
                .map(|(scope, items, batch)| serde_json::json!({
                    "scope": scope,
                    "items": items,
                    "batch": batch,
                }))
                .collect::<Vec<_>>(),
            "maxBatchesPerRun": MEMORY_REDISTILL_MAX_BATCHES_PER_RUN,
            "estimatedCalls": estimated_calls,
        });
        match serde_json::to_string_pretty(&payload) {
            Ok(s) => {
                let _ = writeln!(out, "{}", s);
            }
            Err(e) => {
                let _ = writeln!(err, "错误: 序列化失败: {}", e);
                return EXIT_ERROR;
            }
        }
        return EXIT_OK;
    }

    let _ = writeln!(
        out,
        "候选（AI 写下且未停用）：{} 条（阈值 {})",
        stats.candidates, 100
    );
    let _ = writeln!(
        out,
        "可合并的组（组内 ≥ {} 条）：{} 个",
        MEMORY_REDISTILL_MIN_GROUP_ITEMS,
        planned.len()
    );
    for (scope, items, batch) in planned.iter().take(MEMORY_REDISTILL_MAX_BATCHES_PER_RUN) {
        let _ = writeln!(
            out,
            "  {}  {} 条 → 本批合并 {} 条",
            if scope.is_empty() { "(不限项目)" } else { scope.as_str() },
            items,
            batch
        );
    }
    let _ = writeln!(out, "归档超期（可清理）：{} 条", stats.purge_candidates);
    let _ = writeln!(
        out,
        "预计模型调用：{} 次（每轮上限 {} 次）",
        estimated_calls, MEMORY_REDISTILL_MAX_BATCHES_PER_RUN
    );
    let _ = writeln!(out, "（--dry-run：未写库、未调模型）");
    EXIT_OK
}

/// `memory runs`：整理流水（与将来面板的「整理记录」同一份数据）
async fn runs(
    db: &SessionDb,
    limit: usize,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let items = match db.memory.list_redistill_runs(limit).await {
        Ok(v) => v,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取整理流水失败: {}", e);
            return EXIT_ERROR;
        }
    };
    if json {
        match serde_json::to_string_pretty(&items) {
            Ok(s) => {
                let _ = writeln!(out, "{}", s);
            }
            Err(e) => {
                let _ = writeln!(err, "错误: 序列化失败: {}", e);
                return EXIT_ERROR;
            }
        }
        return EXIT_OK;
    }
    if items.is_empty() {
        let _ = writeln!(out, "（还没有整理记录）");
        return EXIT_OK;
    }
    for r in &items {
        let day = chrono::DateTime::from_timestamp_millis(r.finished_at.unwrap_or(r.started_at))
            .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| "-".to_string());
        let scope = if r.scope.trim().is_empty() { "(不限项目)" } else { r.scope.trim() };
        let note = r.error.clone().unwrap_or_default();
        if r.fingerprint == virlen_core::session_db::MEMORY_REDISTILL_PURGE_FINGERPRINT {
            let _ = writeln!(
                out,
                "  {}  清理  归档超期 {} 条（失败 {}）",
                day, r.purged, r.purged_failed
            );
            continue;
        }
        let _ = writeln!(
            out,
            "  {}  [{}] {}  {} 条 → {} 条（{} 条归档，漂移 {}），模型 {}{}",
            day,
            scope,
            r.status,
            r.items_in,
            r.items_out,
            r.details,
            r.drifted,
            r.model.as_deref().unwrap_or("-"),
            if note.is_empty() { String::new() } else { format!("（{}）", note) }
        );
    }
    let _ = writeln!(out, "\n共 {} 条记录（最多显示 {} 条）", items.len(), limit);
    EXIT_OK
}

/// 人类可读的结果（中文；JSON 由 `--json` 走另一条路）
fn print_report(report: &RedistillReport, out: &mut dyn Write) {
    match report.status.as_str() {
        "disabled" => {
            let _ = writeln!(out, "记忆功能或再蒸馏已关闭（设置里的开关）→ 未做任何整理。");
            return;
        }
        "unavailable" => {
            let _ = writeln!(out, "本地存储不可用 → 未做任何整理。");
            return;
        }
        "no-model" => {
            let _ = writeln!(
                out,
                "没有可用的模型配置（先在桌面端配置服务商，或先用 `virlen-cli config` 写入 providers）。"
            );
            return;
        }
        "nothing" => {
            let _ = writeln!(
                out,
                "没有需要整理的东西（没越线 / 最近刚整理过 / 没有可合并的组）。"
            );
            if report.purged > 0 || report.purged_failed > 0 {
                let _ = writeln!(
                    out,
                    "本轮清理归档超期条目：{} 条（失败 {}）。",
                    report.purged, report.purged_failed
                );
            }
            return;
        }
        _ => {}
    }

    if report.purged > 0 || report.purged_failed > 0 {
        let _ = writeln!(
            out,
            "清理归档超期条目：{} 条（失败 {}）。",
            report.purged, report.purged_failed
        );
    }
    for b in &report.batches {
        let scope = if b.scope.trim().is_empty() { "(不限项目)" } else { b.scope.trim() };
        match b.status.as_str() {
            "done" | "partial" => {
                let _ = writeln!(
                    out,
                    "  [{}] {}  {} 条 → {} 条（{} 条归档，漂移 {}，未停用 {}），模型 {}",
                    scope,
                    if b.status == "partial" { "部分成功" } else { "完成" },
                    b.items_in,
                    b.items_out,
                    b.details,
                    b.drifted,
                    b.unarchived,
                    b.model.as_deref().unwrap_or("-")
                );
                if let Some(err) = b.error.as_deref() {
                    let _ = writeln!(out, "      ↳ {}", err);
                }
            }
            "skipped" => {
                let _ = writeln!(
                    out,
                    "  [{}] {} 条候选被跳过（{}）",
                    scope,
                    b.items_in,
                    b.reason.as_deref().unwrap_or("未知原因")
                );
            }
            _ => {
                let _ = writeln!(
                    out,
                    "  [{}] 失败：{}",
                    scope,
                    b.error.as_deref().unwrap_or("未知原因")
                );
            }
        }
    }
    let _ = writeln!(
        out,
        "\n合计：{} 条 → {} 条，模型调用 {} 次。",
        report.items_in, report.items_out, report.calls
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_list_options() {
        assert_eq!(
            parse(vec!["list"]),
            Ok(MemoryCmd::List {
                level: None,
                limit: DEFAULT_LIST_LIMIT,
                json: false
            })
        );
        assert_eq!(
            parse(vec!["list", "--level", "permanent", "--limit", "10", "--json"]),
            Ok(MemoryCmd::List {
                level: Some("permanent".into()),
                limit: 10,
                json: true
            })
        );
    }

    #[test]
    fn parse_redistill_options() {
        assert_eq!(
            parse(vec!["redistill"]),
            Ok(MemoryCmd::Redistill {
                purge: false,
                force: false,
                dry_run: false,
                json: false
            })
        );
        assert_eq!(
            parse(vec!["redistill", "--purge", "--force", "--dry-run", "--json"]),
            Ok(MemoryCmd::Redistill {
                purge: true,
                force: true,
                dry_run: true,
                json: true
            })
        );
    }

    #[test]
    fn parse_runs_options() {
        assert_eq!(
            parse(vec!["runs"]),
            Ok(MemoryCmd::Runs {
                limit: 20,
                json: false
            })
        );
        assert_eq!(
            parse(vec!["runs", "--limit", "5", "--json"]),
            Ok(MemoryCmd::Runs {
                limit: 5,
                json: true
            })
        );
    }

    #[test]
    fn parse_export_options() {
        assert_eq!(
            parse(vec!["export"]),
            Ok(MemoryCmd::Export { out: None })
        );
        assert_eq!(
            parse(vec!["export", "--out", "mem.json"]),
            Ok(MemoryCmd::Export {
                out: Some("mem.json".into())
            })
        );
        // `--json` 接受但无效果（export 恒为 JSON）
        assert_eq!(
            parse(vec!["export", "--json"]),
            Ok(MemoryCmd::Export { out: None })
        );
    }

    #[test]
    fn usage_errors_are_reported() {
        assert_eq!(parse(vec!["--help"]), Ok(MemoryCmd::Help));
        assert!(parse(vec![]).is_err());
        assert!(parse(vec!["nope"]).is_err());
        assert!(parse(vec!["list", "--level", "high"]).is_err());
        assert!(parse(vec!["list", "--limit", "0"]).is_err());
        assert!(parse(vec!["list", "--limit", "999"]).is_err());
        assert!(parse(vec!["list", "--limit"]).is_err());
        assert!(parse(vec!["redistill", "--nope"]).is_err());
        assert!(parse(vec!["runs", "--limit", "0"]).is_err());
        assert!(parse(vec!["runs", "--limit"]).is_err());
        assert!(parse(vec!["export", "--out"]).is_err());
        assert!(parse(vec!["export", "--out", "  "]).is_err());
        assert!(parse(vec!["export", "--nope"]).is_err());
    }
}
