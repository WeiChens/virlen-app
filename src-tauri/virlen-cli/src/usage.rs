//! `usage` 子命令 —— 用量账本（token 统计）
//!
//! ```text
//! virlen-cli usage [--session <id>] [--model <m>] [--kind <k>]
//!                  [--since <日期>] [--until <日期>]
//!                  [--group-by day|hour|week|month|model|session|kind|provider]
//!                  [--records] [--limit N] [--json]
//! ```
//!
//! 为什么存在：桌面端有「用量统计」页，headless 侧此前只能看本进程实时 token；跨会话 / 按模型 / 按天的账本
//! 在 CLI 里看不到（`usage_stats` / `usage_records` 一直没接线）。
//!
//! ⚠️ 只报 token，不报钱：价目表在前端 TS，Rust 侧不持有价格（「Rust 只回 token 数，费用一律前端算」）。
//! 故本命令只输出 token 与调用次数，并说明「费用请在桌面端看」，不在这里再抄一份价目表。
//!
//! ## 三个数不能混（与桌面端同口径）
//!
//! - `prompt` / `completion` / `cached` / `cacheW` / `total`：**这一次调用**的花费（供应商回报值，
//!   `estimated=true` 的流水是本地估算，会单独计数）；
//! - `calls`：调用次数（同一 messageId 只记一条，幂等键在写入侧）；
//! - 数据范围（`first_ts` / `last_ts`）：账本覆盖的时间区间，**不受过滤条件影响** ——
//!   用来回答「我这份账本到底从什么时候开始有数据」。

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use virlen_core::agent::compress as agent_compress;
use virlen_core::agent::host::HostEnv;
use virlen_core::session_db::{open_session_db, SessionDb, UsageQuery, UsageRecordPage, UsageStats};

use crate::list::render::{brief, fmt_time, pad, pad_left};
use crate::{EXIT_ERROR, EXIT_OK};

/// 明细分页默认条数
const DEFAULT_RECORDS_LIMIT: usize = 20;
/// `--limit` 上限（`usage::records` 内部还会 clamp，这里先给用户一个可读边界）
const MAX_RECORDS_LIMIT: usize = 200;
/// 分桶维度白名单 —— 与 core `usage_group_expr` 的匹配表**逐字一致**
/// （core 对认不出的维度会**静默退回 day**，所以必须在入口挡掉：静默换维度
/// 会让用户看着「按模型」的表得出按天分桶的结论）。
const GROUP_BY: &[&str] = &["day", "hour", "week", "month", "model", "session", "kind", "provider"];
/// 流水类型白名单（写入侧 `UsageEntry::kind` 的全部取值）
const KINDS: &[&str] = &["chat_round", "compress", "title", "verify", "embedding", "legacy"];

/// `usage` 的命令形态
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UsageCmd {
    Help,
    Report(UsageOptions),
}

/// 报表选项（解析后即为 `UsageQuery` 的定型参数）
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UsageOptions {
    pub session: Option<String>,
    pub model: Option<String>,
    pub kind: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub group_by: String,
    pub records: bool,
    pub limit: usize,
    pub json: bool,
}

impl Default for UsageOptions {
    fn default() -> Self {
        Self {
            session: None,
            model: None,
            kind: None,
            from: None,
            to: None,
            group_by: "day".to_string(),
            records: false,
            limit: DEFAULT_RECORDS_LIMIT,
            json: false,
        }
    }
}

/// 帮助文本
pub const USAGE_USAGE: &str = "\
virlen-cli usage —— 用量账本（token 统计；与桌面端「用量统计」同一份 usage_ledger）

用法:
  virlen-cli usage [选项]

选项:
      --session <id>          只看一条会话
      --model <模型id>        只看一个模型
      --kind <类型>           只看一种调用：chat_round | compress | title | verify |
                              embedding | legacy
      --since <日期|毫秒>     起始（含）；`YYYY-MM-DD` = 当日 00:00（本地时区）
      --until <日期|毫秒>     截止（含）；`YYYY-MM-DD` = 当日 23:59:59.999（本地时区）
      --group-by <维度>       分桶：day（默认）| hour | week | month | model |
                              session | kind | provider
      --records               附上最近的流水明细（默认只出聚合表）
      --limit <N>             明细条数（默认 20，上限 200）
      --json                  输出 JSON（便于脚本）
  -h, --help                  显示本帮助

说明:
  ⚠️ 只统计 **token**，不显示费用 —— 价目表在前端 TS（Rust 侧不持价），请在桌面端
     「用量统计」里看金额；这样也避免 CLI 与桌面端各维护一份价格表。
  计数口径：同一 assistant 消息只记一条流水（幂等键 = messageId），`估算` 列 = 本地估算
  （非供应商回报）的条数。
  账本与消息解耦：删会话**不会**删流水（用量是已发生消费的事实记录）。
  「数据范围」不受过滤条件影响 —— 它回答的是「这份账本从什么时候开始有数据」。
";

/// 解析 `usage` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<UsageCmd, String> {
    if args.iter().any(|a| matches!(*a, "-h" | "--help")) {
        return Ok(UsageCmd::Help);
    }
    let mut opts = UsageOptions::default();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg {
            "--json" => opts.json = true,
            "--records" => opts.records = true,
            "--session" | "--model" | "--kind" | "--since" | "--until" | "--group-by" | "--limit" => {
                let raw = it
                    .next()
                    .ok_or_else(|| format!("选项 {} 缺少取值", arg))?;
                if raw.trim().is_empty() {
                    return Err(format!("选项 {} 的取值不能为空", arg));
                }
                match arg {
                    "--session" => opts.session = Some(raw.trim().to_string()),
                    "--model" => opts.model = Some(raw.trim().to_string()),
                    "--kind" => {
                        let k = raw.trim();
                        if !KINDS.contains(&k) {
                            return Err(format!(
                                "--kind 取值无效: {}（可选: {}）",
                                k,
                                KINDS.join(" | ")
                            ));
                        }
                        opts.kind = Some(k.to_string());
                    }
                    // `--since` 取当日 00:00，`--until` 取当日 23:59:59.999（日期区间的自然读法）
                    "--since" => opts.from = Some(parse_ts(raw, false)?),
                    "--until" => opts.to = Some(parse_ts(raw, true)?),
                    "--group-by" => {
                        let g = raw.trim().to_ascii_lowercase();
                        if !GROUP_BY.contains(&g.as_str()) {
                            return Err(format!(
                                "--group-by 取值无效: {}（可选: {}）",
                                raw,
                                GROUP_BY.join(" | ")
                            ));
                        }
                        opts.group_by = g;
                    }
                    "--limit" => {
                        let n: usize = raw
                            .parse()
                            .map_err(|_| format!("--limit 需要非负整数，收到: {}", raw))?;
                        if n == 0 || n > MAX_RECORDS_LIMIT {
                            return Err(format!("--limit 取值范围 1..={}", MAX_RECORDS_LIMIT));
                        }
                        opts.limit = n;
                    }
                    _ => unreachable!("选项已在 match 中穷举"),
                }
            }
            other => return Err(format!("未知选项: {}（见 `virlen-cli usage --help`）", other)),
        }
    }
    if let (Some(from), Some(to)) = (opts.from, opts.to) {
        if from > to {
            return Err(format!(
                "--since（{}）晚于 --until（{}），区间为空",
                fmt_time(from),
                fmt_time(to)
            ));
        }
    }
    Ok(UsageCmd::Report(opts))
}

/// 时间参数：`YYYY-MM-DD`（本地时区）或毫秒时间戳。
///
/// `end_of_day`：日期形式取当日 **23:59:59.999**（`--until` 的语义）而不是 00:00 ——
/// 「--until 今天」如果只在今天零点截止，用户会漏掉今天的所有流水。
fn parse_ts(raw: &str, end_of_day: bool) -> Result<i64, String> {
    let t = raw.trim();
    if t.chars().all(|c| c.is_ascii_digit()) {
        return t
            .parse::<i64>()
            .map_err(|_| format!("毫秒时间戳超出范围: {}", t));
    }
    let date = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .map_err(|_| format!("时间格式应为 YYYY-MM-DD 或毫秒时间戳，收到: {}", t))?;
    let (h, m, s) = if end_of_day { (23, 59, 59) } else { (0, 0, 0) };
    let naive = date
        .and_hms_opt(h, m, s)
        .ok_or_else(|| format!("时间不合法: {}", t))?;
    // 夏令时切换当刻可能「本机时区不存在这个本地时间」→ earliest() 取一个存在的近似值
    let dt = chrono::TimeZone::from_local_datetime(&chrono::Local, &naive)
        .earliest()
        .ok_or_else(|| format!("该时间在本机时区不存在（夏令时切换？）: {}", t))?;
    Ok(dt.timestamp_millis() + if end_of_day { 999 } else { 0 })
}

// ==================== 执行 ====================

fn open_db(host: &Arc<dyn HostEnv>) -> Result<SessionDb, String> {
    open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    })
}

/// `usage` 子命令入口。返回进程退出码。
pub(super) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: UsageCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let opts = match cmd {
        UsageCmd::Help => {
            let _ = write!(out, "{}", USAGE_USAGE);
            return EXIT_OK;
        }
        UsageCmd::Report(o) => o,
    };

    let db = match open_db(host) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
            return EXIT_ERROR;
        }
    };

    let query = UsageQuery {
        from_ts: opts.from,
        to_ts: opts.to,
        session_id: opts.session.clone(),
        model: opts.model.clone(),
        kind: opts.kind.clone(),
        group_by: Some(opts.group_by.clone()),
        // 明细条数只对 `usage_records` 生效（聚合不受 limit 影响）
        limit: Some(opts.limit),
        offset: None,
    };

    let stats = match db.repo.usage_stats(&query).await {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(err, "错误: 读取用量统计失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let records: Option<UsageRecordPage> = if opts.records {
        match db.repo.usage_records(&query).await {
            Ok(p) => Some(p),
            Err(e) => {
                let _ = writeln!(err, "[warn] 读取用量明细失败（只显示聚合表）: {}", e);
                None
            }
        }
    } else {
        None
    };
    // 按会话分桶时把 uuid 换成人看得懂的标题（每次都读一次会话表：本地 SQLite，几百行以内）
    let titles: HashMap<String, String> = if opts.group_by == "session" {
        db.repo
            .list_sessions()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|s| {
                let t = if s.title.trim().is_empty() {
                    crate::session_rt::UNTITLED.to_string()
                } else {
                    s.title.clone()
                };
                (s.id, t)
            })
            .collect()
    } else {
        HashMap::new()
    };

    if opts.json {
        let payload = serde_json::json!({
            "query": {
                "sessionId": opts.session,
                "model": opts.model,
                "kind": opts.kind,
                "fromTs": opts.from,
                "toTs": opts.to,
                "groupBy": opts.group_by,
            },
            "stats": serde_json::to_value(&stats).unwrap_or(serde_json::Value::Null),
            "records": records
                .as_ref()
                .map(|p| serde_json::to_value(p).unwrap_or(serde_json::Value::Null)),
            // 显式标注「本命令不含费用」——脚本作者不必去翻文档
            "costIncluded": false,
        });
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        );
        return EXIT_OK;
    }

    render_report(&opts, &stats, records.as_ref(), &titles, out, err)
}

/// 人类可读报表（纯渲染：数据全部由调用方备好）
fn render_report(
    opts: &UsageOptions,
    stats: &UsageStats,
    records: Option<&UsageRecordPage>,
    titles: &HashMap<String, String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // 头部：过滤条件 + 账本覆盖范围
    let mut filters: Vec<String> = Vec::new();
    if let Some(s) = &opts.session {
        filters.push(format!("会话 {}", s));
    }
    if let Some(m) = &opts.model {
        filters.push(format!("模型 {}", m));
    }
    if let Some(k) = &opts.kind {
        filters.push(format!("类型 {}", k));
    }
    if let Some(f) = opts.from {
        filters.push(format!("从 {}", fmt_time(f)));
    }
    if let Some(t) = opts.to {
        filters.push(format!("到 {}", fmt_time(t)));
    }
    let _ = writeln!(
        out,
        "用量账本{}",
        if filters.is_empty() {
            String::new()
        } else {
            format!("（{}）", filters.join(" · "))
        }
    );
    if stats.first_ts.is_some() || stats.last_ts.is_some() {
        let _ = writeln!(
            out,
            "数据范围: {} ~ {}（不受过滤条件影响）",
            stats.first_ts.map(fmt_time).unwrap_or_else(|| "-".into()),
            stats.last_ts.map(fmt_time).unwrap_or_else(|| "-".into())
        );
    }

    if stats.totals.calls == 0 {
        let _ = writeln!(out, "\n没有匹配的流水（账本可能是空的：只有跑过对话 / 压缩后才有记录）");
        return EXIT_OK;
    }

    let dim = match opts.group_by.as_str() {
        "session" => "会话",
        "model" => "模型",
        "kind" => "类型",
        "provider" => "Provider",
        "hour" => "小时",
        "week" => "周",
        "month" => "月",
        _ => "日",
    };
    let _ = writeln!(out, "\n按{}分桶:", dim);
    let _ = writeln!(
        out,
        "  {}  {}  {}  {}  {}  {}  {}  {}",
        pad(&format!("{}（{}）", dim, opts.group_by), COL_KEY),
        pad_left("次数", COL_CALLS),
        pad_left("total", COL_TOKENS),
        pad_left("prompt", COL_TOKENS),
        pad_left("completion", COL_TOKENS),
        pad_left("cached", COL_SMALL),
        // cacheW = 缓存**写入**量（目前只有 Anthropic 有，1.25x 输入价）。
        // 与 cached（命中，0.1x）必须分开看：四段之和才等于 total
        pad_left("cacheW", COL_SMALL),
        pad_left("估算", COL_SMALL),
    );
    for b in &stats.buckets {
        let _ = writeln!(
            out,
            "  {}  {}  {}  {}  {}  {}  {}  {}",
            pad(&bucket_label(&opts.group_by, &b.key, titles), COL_KEY),
            pad_left(&b.calls.to_string(), COL_CALLS),
            pad_left(&agent_compress::format_tokens(b.total_tokens), COL_TOKENS),
            pad_left(&agent_compress::format_tokens(b.prompt_tokens), COL_TOKENS),
            pad_left(
                &agent_compress::format_tokens(b.completion_tokens),
                COL_TOKENS
            ),
            pad_left(&agent_compress::format_tokens(b.cached_tokens), COL_SMALL),
            pad_left(
                &agent_compress::format_tokens(b.cache_write_tokens),
                COL_SMALL,
            ),
            pad_left(&b.estimated_calls.to_string(), COL_SMALL),
        );
    }
    let t = &stats.totals;
    let _ = writeln!(
        out,
        "  {}  {}  {}  {}  {}  {}  {}  {}",
        pad("合计", COL_KEY),
        pad_left(&t.calls.to_string(), COL_CALLS),
        pad_left(&agent_compress::format_tokens(t.total_tokens), COL_TOKENS),
        pad_left(&agent_compress::format_tokens(t.prompt_tokens), COL_TOKENS),
        pad_left(
            &agent_compress::format_tokens(t.completion_tokens),
            COL_TOKENS
        ),
        pad_left(&agent_compress::format_tokens(t.cached_tokens), COL_SMALL),
        pad_left(
            &agent_compress::format_tokens(t.cache_write_tokens),
            COL_SMALL,
        ),
        pad_left(&t.estimated_calls.to_string(), COL_SMALL),
    );
    let _ = writeln!(
        out,
        "\n合计 {} 次调用 · {} token（精确值见 --json）",
        t.calls,
        t.total_tokens
    );

    if let Some(page) = records {
        if page.records.is_empty() {
            let _ = writeln!(out, "\n没有明细。");
        } else {
            let _ = writeln!(
                out,
                "\n最近 {} 条明细（共 {} 条）:",
                page.records.len(),
                page.total
            );
            let _ = writeln!(
                out,
                "  {}  {}  {}  {}  {}  {}  {}  {}",
                pad("时间", COL_TIME),
                pad("会话", COL_SESSION),
                pad("模型", COL_MODEL),
                pad("类型", COL_KIND),
                pad_left("total", COL_TOKENS),
                pad_left("prompt", COL_TOKENS),
                pad_left("completion", COL_TOKENS),
                pad_left("耗时", COL_SMALL),
            );
            for r in &page.records {
                let session = match r.session_id.as_deref() {
                    Some(id) => titles
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| brief(id, COL_SESSION)),
                    None => "-".to_string(),
                };
                let _ = writeln!(
                    out,
                    "  {}  {}  {}  {}  {}  {}  {}  {}",
                    pad(&fmt_time(r.ts), COL_TIME),
                    pad(&session, COL_SESSION),
                    pad(&brief(&r.model, COL_MODEL), COL_MODEL),
                    pad(&r.kind, COL_KIND),
                    pad_left(&agent_compress::format_tokens(r.total_tokens), COL_TOKENS),
                    pad_left(&agent_compress::format_tokens(r.prompt_tokens), COL_TOKENS),
                    pad_left(
                        &agent_compress::format_tokens(r.completion_tokens),
                        COL_TOKENS
                    ),
                    pad_left(
                        // 0 = 未测量（历史流水）—— 显示 `-` 而不是 `0ms`
                        &if r.duration_ms > 0 {
                            format!("{}ms", r.duration_ms)
                        } else {
                            "-".to_string()
                        },
                        COL_SMALL
                    ),
                );
            }
        }
    }

    // 费用说明走 stderr：stdout 只放数据（脚本可整块解析），提示不该混进去
    let _ = writeln!(
        err,
        "提示: 本命令只统计 token —— 费用（按价目表算）请在桌面端「用量统计」里看（Rust 侧不持价目表）"
    );
    EXIT_OK
}

/// 桶名 → 展示文本。
///
/// 两条特例都要处理，否则表格里会出现**空单元格**（看着像排版错位）：
/// - `group_by=session` 时把 uuid 换成会话标题（`COALESCE(session_id, '')` 的空 key = 没有会话）；
/// - 其它维度拿不到 id 时（如 `provider` 未记录）也是空 key。
fn bucket_label(dim: &str, key: &str, titles: &HashMap<String, String>) -> String {
    if key.is_empty() {
        return if dim == "session" {
            "（无会话）".to_string()
        } else {
            "（未记录）".to_string()
        };
    }
    if dim == "session" {
        if let Some(t) = titles.get(key) {
            return brief(t, COL_KEY);
        }
    }
    brief(key, COL_KEY)
}

// 列宽（显示列数；与 `list/render.rs` 同一套 `pad` / `pad_left` 口径）
const COL_KEY: usize = 24;
const COL_CALLS: usize = 6;
const COL_TOKENS: usize = 11;
const COL_SMALL: usize = 7;
const COL_TIME: usize = 16;
const COL_SESSION: usize = 20;
const COL_MODEL: usize = 18;
const COL_KIND: usize = 10;

#[cfg(test)]
mod tests;
