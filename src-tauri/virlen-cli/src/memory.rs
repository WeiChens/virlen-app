//! `memory` 子命令 —— 长期记忆（查看 / 蒸馏整理 / 导出）
//!
//! ```text
//! virlen-cli memory list [--level normal|permanent] [--limit N] [--json]
//! virlen-cli memory consolidate [--day YYYY-MM-DD] [--force] [--json]
//! virlen-cli memory export [--out PATH]
//! ```
//!
//! 存在的理由：蒸馏（「第二天把摘要提炼成记忆」）在 GUI 里是启动时非阻塞触发的，用户**看不见它到底跑没跑、
//! 为什么没产出**；CLI 给出一个可以当场跑、当场看结果的入口（与桌面端共用同一份库、同一份 core 实现）。
//!
//! ## 两条与桌面端一致的口径
//!
//! 1. **幂等**：同一天已整理过就不会再跑（`memory_runs` 主键 = 幂等键）；要覆盖用 `--force`
//!    （它会先删掉该天旧的蒸馏产出与详情文档，用户手写的记忆不动）。
//! 2. **模型**：按「压缩会话时用得最多的模型」排序（`usage_ledger.kind='compress'`），3 次尝试全失败才退出；
//!    ⚠️ CLI 是 headless，**只支持 openai 兼容 / anthropic** 两种协议（gemini 等桥接协议需要前端 JS 宿主）
//!    —— 候选里遇到桥接协议会跳过并试下一个。
//!
//! ## 详情（知识库）
//!
//! 记忆的详情正文落在专用知识库（「记忆详情」）。CLI 这里**沿用与 GUI 同一个目录**做懒初始化
//! （`rag::ensure_service(host.data_dir())`），因此 CLI 产出的详情在桌面端能直接看到；RAG 起不来时
//! 退化为「只存摘要」，不牵连记忆条目本身。

use std::io::Write;
use std::sync::Arc;

use virlen_core::agent::cancellation::CancellationToken;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::memory::consolidate::{
    consolidate_now, ConsolidateDeps, ConsolidateOptions, ConsolidateReport,
};
use virlen_core::agent::memory::export::export_json;
use virlen_core::agent::memory::models::DistillProviderBuilder;
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
    /// 整理（不指定 `--day` 时按「上次处理的次日 → 昨天」补跑）
    Consolidate {
        day: Option<String>,
        force: bool,
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
  virlen-cli memory consolidate [--day YYYY-MM-DD] [--force] [--json]
                                 整理记忆：把某一天各会话的摘要 / 正文摘录蒸馏成记忆条目
                                 不带 --day 时按「上次整理成功的次日 → 昨天」逐日补跑（每天最多跑一次）
  virlen-cli memory export [--out PATH]
                                 导出全部记忆为 JSON（含停用项；不带 --out 则打到标准输出）
                                 格式：{ format, schemaVersion, exportedAt, count, memories[] }
  -h, --help                     显示本帮助

选项:
      --day <YYYY-MM-DD>   仅整理指定的那一天（本地日）
      --force              重新整理（覆盖该天旧的蒸馏产出；用户手写的记忆不受影响）
      --level <值>         仅列出该级别（normal / permanent）
      --limit <N>          （仅 list）最多显示 N 条（默认 50，上限 500）
      --out <PATH>         （仅 export）写到文件（UTF-8）；父目录不存在会报错
      --json               输出 JSON（便于脚本；export 恒为 JSON）

说明:
  「整理」一次最多处理 7 天（补跑有界，剩下的下次继续）；同一天已整理过会直接跳过，
  失败的日期最多自动重试 2 次（之后请用 --force 手动重试）。
  蒸馏调用会记入用量账本（类型「记忆整理」），可在 `virlen-cli usage` 或桌面端「用量统计」里看到。
  CLI 是 headless：蒸馏模型只支持 openai 兼容 / anthropic 协议（gemini 等需要桌面端 JS 宿主）。

退出码:
  0 成功（含「没有需要整理的日期」）    1 失败（库打不开 / 调用失败）    2 用法错误
";

/// 解析 `memory` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<MemoryCmd, String> {
    let mut it = args.into_iter();
    let Some(sub) = it.next() else {
        return Err("memory 缺少子命令（可用: list / consolidate / export）".to_string());
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
        "consolidate" | "distill" => {
            let mut day: Option<String> = None;
            let mut force = false;
            let mut json = false;
            let mut it = rest.into_iter();
            while let Some(arg) = it.next() {
                match arg {
                    "--json" => json = true,
                    "--force" => force = true,
                    "--day" => {
                        let raw = it.next().ok_or("选项 --day 缺少取值")?;
                        day = Some(raw.to_string());
                    }
                    other => return Err(format!("未知选项: {}（见 `virlen-cli memory --help`）", other)),
                }
            }
            Ok(MemoryCmd::Consolidate { day, force, json })
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
            "未知子命令: {}（可用: list / consolidate / export）",
            other
        )),
    }
}

/// CLI 侧的 Provider 构建器：只支持**原生**协议（headless 没有 JS 宿主）
struct CliProviderBuilder;

impl DistillProviderBuilder for CliProviderBuilder {
    fn build(&self, conn: &ProviderConnection) -> Result<Box<dyn Provider>, String> {
        create_native_provider(conn)
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
        MemoryCmd::Consolidate { day, force, json } => {
            consolidate(host, &db, day.as_deref(), force, json, out, err).await
        }
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

/// `memory consolidate`：与 GUI 走**同一份** `agent::memory::consolidate`
async fn consolidate(
    host: &Arc<dyn HostEnv>,
    db: &SessionDb,
    day: Option<&str>,
    force: bool,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // 知识库：懒初始化（与 GUI 同一个目录）—— 起不来就退化为「只存摘要」，不影响记忆条目
    let rag = virlen_core::rag::ensure_service(host.data_dir()).ok();
    if rag.is_none() {
        let _ = writeln!(
            err,
            "提示: 知识库不可用，本次只保存摘要（不落详情正文）"
        );
    }
    let builder = CliProviderBuilder;
    let cancel = CancellationToken::new();
    let deps = ConsolidateDeps {
        memory: db.memory.as_ref(),
        sessions: db.repo.as_ref(),
        settings: db.settings.as_ref(),
        rag,
        builder: &builder,
        cancel: &cancel,
    };
    let report = match consolidate_now(
        deps,
        ConsolidateOptions {
            only_day: day.map(str::to_string),
            force,
        },
    )
    .await
    {
        Ok(report) => report,
        Err(e) => {
            let _ = writeln!(err, "错误: 整理失败: {}", e);
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
        // 有失败的天数 → 退出码 1（脚本能据此判断），但结果已打印
        return if report.days.iter().any(|d| d.status == "failed") {
            EXIT_ERROR
        } else {
            EXIT_OK
        };
    }

    print_report(&report, out);
    if report.days.iter().any(|d| d.status == "failed") {
        EXIT_ERROR
    } else {
        EXIT_OK
    }
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

/// 人类可读的结果（中文；JSON 由 `--json` 走另一条路）
fn print_report(report: &ConsolidateReport, out: &mut dyn Write) {
    match report.status.as_str() {
        "disabled" => {
            let _ = writeln!(
                out,
                "记忆功能已关闭（设置里的「启用记忆」）→ 未做任何整理。"
            );
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
            let _ = writeln!(out, "没有需要整理的日期（已整理到昨天）。");
            return;
        }
        _ => {}
    }

    if report.days.is_empty() {
        let _ = writeln!(out, "本次没有需要整理的日期。");
        return;
    }
    for d in &report.days {
        match d.status.as_str() {
            "done" | "partial" => {
                // 「合并 N 条」只在真的发生过时出现（否则是噪音）
                let merged = if d.merged > 0 {
                    format!("，合并 {} 条", d.merged)
                } else {
                    String::new()
                };
                let _ = writeln!(
                    out,
                    "  {}  {} → {} 条（{} 条详情{}），素材来自 {} 个会话，模型 {}",
                    d.day,
                    if d.status == "partial" { "部分成功" } else { "完成" },
                    d.items,
                    d.details,
                    merged,
                    d.source_sessions,
                    d.model.as_deref().unwrap_or("-")
                );
            }
            "skipped" => {
                let _ = writeln!(out, "  {}  跳过（当天没有可用的对话素材）", d.day);
            }
            _ => {
                let _ = writeln!(
                    out,
                    "  {}  失败: {}",
                    d.day,
                    d.error.as_deref().unwrap_or("未知原因")
                );
            }
        }
    }
    let _ = writeln!(
        out,
        "\n合计：{} 条记忆（{} 条详情），模型调用 {} 次。",
        report.items, report.details, report.calls
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
    fn parse_consolidate_options() {
        assert_eq!(
            parse(vec!["consolidate"]),
            Ok(MemoryCmd::Consolidate {
                day: None,
                force: false,
                json: false
            })
        );
        assert_eq!(
            parse(vec!["consolidate", "--day", "2026-10-04", "--force", "--json"]),
            Ok(MemoryCmd::Consolidate {
                day: Some("2026-10-04".into()),
                force: true,
                json: true
            })
        );
        assert_eq!(parse(vec!["distill"]), parse(vec!["consolidate"]), "别名");
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
        assert!(parse(vec!["consolidate", "--day"]).is_err());
        assert!(parse(vec!["consolidate", "--day"]).is_err());
        assert!(parse(vec!["consolidate", "--nope"]).is_err());
        assert!(parse(vec!["export", "--out"]).is_err());
        assert!(parse(vec!["export", "--out", "  "]).is_err());
        assert!(parse(vec!["export", "--nope"]).is_err());
    }
}
