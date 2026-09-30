//! `session` 子命令 —— 会话管理（查看 / 检索 / 删除 / 回收孤儿消息）
//!
//! ```text
//! virlen-cli session show <id> [--messages N] [--json]
//! virlen-cli session search <关键词> [--session <id>] [--limit N] [--json]
//! virlen-cli session rm <id> [--yes]
//! virlen-cli session purge [--yes]
//! ```
//!
//! 存在的理由：CLI 此前只能「列会话」与「续跑会话」，既删不掉、也看不见一条会话里到底有什么 ——
//! 桌面端能做的这两件事在 headless 下没有替代品（只能手改 SQLite）。
//!
//! ## 与 `list-session --search` 的分工
//!
//! 名字像、语义不同，所以两处帮助文本都写死了这件事（不写，用户一定会以为是一个东西）：
//! - `list-session --search`：**只看会话元数据**（标题 / 工作目录 / 模型 / Agent 名），不碰正文；
//! - `session search`：**检索消息正文**（可跨会话，走 `SessionRepo::search_messages`），返回命中片段。
//!
//! ## 两条与桌面端一致的口径（写在这里，免得各处再解释一遍）
//!
//! 1. 删除会话 = 删会话行 + 它的全部消息；**用量账本不动** —— 用量是「已发生消费」的事实记录，
//!    删会话不清账（与 `SessionRepo::purge_orphan_messages` 的注释同一条约定）；
//! 2. `purge` 回收的是**孤儿消息**（`session_id` 指向不存在的会话）。
//!    ⚠️ `open_session_db` 本来就会在**后台**回收一次（`session_db/open.rs`），但那是 `spawn`
//!    出去的任务：CLI 是「跑完就 `process::exit`」的短命进程，后台任务可能来不及跑完。
//!    本命令把它**显式 `await`**，用途是「把清理真正落地 + 给出条数」，而不是「唯一会清理的地方」。
//!
//! ## 危险操作一律 fail-closed
//!
//! `rm` / `purge` 都要求确认：`--yes` 显式跳过；stdin 不是终端时**直接拒绝**（退出码 2），
//! 与 `provider rm` 同一条口径 —— 管道里静默删数据是最不该发生的事。

use std::io::{IsTerminal, Write};
use std::sync::Arc;
use virlen_core::agent::compress as agent_compress;
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::types::Session;
use virlen_core::session_db::{open_session_db, SessionDb, SessionStat};

use crate::list::render::{brief, fmt_time, session_json};
use crate::wizard::Prompter;
use crate::{EXIT_ERROR, EXIT_OK, EXIT_USAGE};

/// `session search` 默认返回条数（与桌面端检索默认页大小同量级）
const DEFAULT_SEARCH_LIMIT: usize = 20;
/// `session search --limit` 上限（再大也是刷屏，机器可读请用 `--json`）
const MAX_SEARCH_LIMIT: usize = 100;
/// `session show --messages N` 默认显示条数（0 = 只看元信息）
const DEFAULT_SHOW_MESSAGES: usize = 0;
/// `session show --messages N` 上限
const MAX_SHOW_MESSAGES: usize = 50;
/// 正文预览的显示列宽（与 `list-session` 的标题列同量级）
const PREVIEW_COLS: usize = 60;

/// `session` 的子命令
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionCmd {
    Help,
    /// 看一条会话：元信息 + 统计（可选最近 N 条消息）
    Show {
        id: String,
        messages: usize,
        json: bool,
    },
    /// 检索消息正文（`--session` 限定单会话；默认跨会话）
    Search {
        keyword: String,
        session: Option<String>,
        limit: usize,
        json: bool,
    },
    /// 删除会话（连带它的全部消息）
    Rm { id: String, yes: bool },
    /// 回收孤儿消息
    Purge { yes: bool },
}

/// 帮助文本（`session --help` / `session -h` / 用法错误时打印）
pub const USAGE_SESSION: &str = "\
virlen-cli session —— 会话管理（与桌面端同一份 virlen.db）

用法:
  virlen-cli session show <id> [--messages N] [--json]
                                 查看一条会话：标题 / Agent / 模型 / 工作目录 / 时间 /
                                 消息数 / 上下文占用；--messages N 附带最近 N 条消息预览
  virlen-cli session search <关键词> [--session <id>] [--limit N] [--json]
                                 检索消息正文（默认跨所有会话；按时间倒序）
  virlen-cli session rm <id> [--yes]
                                 删除会话及其全部消息（需确认；--yes 跳过）
  virlen-cli session purge [--yes]
                                 回收孤儿消息（session_id 指向已不存在会话的历史残留）
                                 并**等待它跑完**（开库时的后台回收在短命进程里可能来不及跑）
  -h, --help                     显示本帮助

选项:
      --session <id>   （仅 search）限定在一条会话内检索
      --limit <N>      （仅 search）最多 N 条（默认 20，上限 100）
      --messages <N>   （仅 show）附带最近 N 条消息（默认 0，上限 50）
      --json            输出 JSON（便于脚本）
      --yes             跳过删除确认（stdin 不是终端时**必须**给）

说明:
  「检索正文」用本命令的 search；「按会话元数据筛列表」用 `list-session --search`（两者不同）。
  检索默认只看 user / assistant 两类消息（与桌面端检索一致，不含工具结果）。
  删除会话**不会**删除用量账本（用量是已发生消费的事实记录，删会话不清账）。
  purge 在正常情况下应恒为 0 条（开库时也会后台回收一次）；非 0 说明历史上有过
  「删会话时还有 run 在跑」（早期版本缺 append_messages_if_alive 守卫）。

退出码:
  0 成功    1 失败（会话不存在 / 库打不开 / 读写失败）    2 用法错误（含「非终端下未给 --yes」）
";

/// 解析 `session` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<SessionCmd, String> {
    let mut it = args.into_iter();
    let Some(sub) = it.next() else {
        return Err("session 缺少子命令（可用: show / search / rm / purge）".to_string());
    };
    if matches!(sub, "-h" | "--help") {
        return Ok(SessionCmd::Help);
    }
    let rest: Vec<&str> = it.collect();

    match sub {
        "show" => {
            let mut id: Option<String> = None;
            let mut messages = DEFAULT_SHOW_MESSAGES;
            let mut json = false;
            let mut it = rest.into_iter();
            while let Some(arg) = it.next() {
                match arg {
                    "--json" => json = true,
                    "--messages" => {
                        let raw = it.next().ok_or("选项 --messages 缺少取值")?;
                        let n: usize = raw
                            .parse()
                            .map_err(|_| format!("--messages 需要非负整数，收到: {}", raw))?;
                        if n > MAX_SHOW_MESSAGES {
                            return Err(format!("--messages 上限为 {}", MAX_SHOW_MESSAGES));
                        }
                        messages = n;
                    }
                    other if other.starts_with('-') => {
                        return Err(format!("未知选项: {}（见 `virlen-cli session --help`）", other))
                    }
                    word => {
                        if id.is_some() {
                            return Err(format!("session show 只接受一个会话 id，多给了: {}", word));
                        }
                        id = Some(word.to_string());
                    }
                }
            }
            let id = id.ok_or(
                "用法: session show <id> [--messages N] [--json]（见 `virlen-cli session --help`）",
            )?;
            Ok(SessionCmd::Show { id, messages, json })
        }
        "search" => {
            let mut keyword: Option<String> = None;
            let mut session: Option<String> = None;
            let mut limit = DEFAULT_SEARCH_LIMIT;
            let mut json = false;
            let mut it = rest.into_iter();
            while let Some(arg) = it.next() {
                match arg {
                    "--json" => json = true,
                    "--session" => {
                        let raw = it.next().ok_or("选项 --session 缺少取值")?;
                        if raw.trim().is_empty() {
                            return Err("选项 --session 的取值不能为空".to_string());
                        }
                        session = Some(raw.to_string());
                    }
                    "--limit" => {
                        let raw = it.next().ok_or("选项 --limit 缺少取值")?;
                        let n: usize = raw
                            .parse()
                            .map_err(|_| format!("--limit 需要非负整数，收到: {}", raw))?;
                        if n == 0 || n > MAX_SEARCH_LIMIT {
                            return Err(format!("--limit 取值范围 1..={}", MAX_SEARCH_LIMIT));
                        }
                        limit = n;
                    }
                    other if other.starts_with('-') => {
                        return Err(format!("未知选项: {}（见 `virlen-cli session --help`）", other))
                    }
                    word => {
                        // 关键词允许带空格：多个位置参数按空格拼起来（与 `run` 的 prompt 同口径）
                        match keyword.as_mut() {
                            Some(k) => {
                                k.push(' ');
                                k.push_str(word);
                            }
                            None => keyword = Some(word.to_string()),
                        }
                    }
                }
            }
            let keyword = keyword.ok_or(
                "用法: session search <关键词> [--session <id>]（见 `virlen-cli session --help`）",
            )?;
            if keyword.trim().is_empty() {
                return Err("关键词不能为空".to_string());
            }
            Ok(SessionCmd::Search {
                keyword,
                session,
                limit,
                json,
            })
        }
        "rm" => {
            let (id, yes) = parse_one_id_and_yes(rest, "session rm <id> [--yes]（见 `virlen-cli session --help`）")?;
            Ok(SessionCmd::Rm { id, yes })
        }
        "purge" => {
            let mut yes = false;
            for arg in rest {
                match arg {
                    "--yes" | "-y" => yes = true,
                    other => {
                        return Err(format!(
                            "未知参数: {}（用法: session purge [--yes]）",
                            other
                        ))
                    }
                }
            }
            Ok(SessionCmd::Purge { yes })
        }
        other => Err(format!(
            "session 未知子命令: {}（可用: show / search / rm / purge）",
            other
        )),
    }
}

/// `rm` 的参数：一个 id + 可选的 `--yes`
fn parse_one_id_and_yes(rest: Vec<&str>, usage: &str) -> Result<(String, bool), String> {
    let mut id: Option<String> = None;
    let mut yes = false;
    // 本循环不需要消费「下一个参数」（`--yes` 与 id 都是单 token），所以用 `for` 而不是 `while let`
    for arg in rest {
        match arg {
            "--yes" | "-y" => yes = true,
            other if other.starts_with('-') => {
                return Err(format!("未知选项: {}（见 `virlen-cli session --help`）", other))
            }
            word => {
                if id.is_some() {
                    return Err(format!("只接受一个会话 id，多给了: {}", word));
                }
                id = Some(word.to_string());
            }
        }
    }
    let id = id.ok_or_else(|| format!("用法: {}", usage))?;
    Ok((id, yes))
}

// ==================== 执行 ====================

/// 打开库（与 `config` / `run` / `list-session` 同一条推导链：`host.data_dir()/virlen.db`）
fn open_db(host: &Arc<dyn HostEnv>) -> Result<SessionDb, String> {
    open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    })
}

/// `session` 子命令入口。返回进程退出码。
pub(super) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: SessionCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if let SessionCmd::Help = cmd {
        let _ = write!(out, "{}", USAGE_SESSION);
        return EXIT_OK;
    }

    let db = match open_db(host) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
            return EXIT_ERROR;
        }
    };

    match cmd {
        SessionCmd::Help => unreachable!("help 已在上面返回"),
        SessionCmd::Show { id, messages, json } => show(&db, &id, messages, json, out, err).await,
        SessionCmd::Search {
            keyword,
            session,
            limit,
            json,
        } => search(&db, &keyword, session.as_deref(), limit, json, out, err).await,
        SessionCmd::Rm { id, yes } => rm(&db, &id, yes, out, err).await,
        SessionCmd::Purge { yes } => purge(&db, yes, out, err).await,
    }
}

/// 取当前会话的统计（读不到就按「无数据」处理 —— `list-session` 的同一取舍）
async fn stats_of(db: &SessionDb, session_id: &str) -> Option<SessionStat> {
    db.repo
        .session_stats()
        .await
        .ok()?
        .into_iter()
        .find(|s| s.session_id == session_id)
}

/// 「100% 对应多少」来自 `app_settings.contextWindowTokens`（与桌面端同一键；缺失 → 默认 200k）。
/// 读不到配置不阻断命令：回退默认窗口即可。
async fn window_of(db: &SessionDb) -> i64 {
    match db.settings.get_all().await {
        Ok(all) => agent_compress::window_tokens_from_settings(&all),
        Err(_) => agent_compress::CONTEXT_WINDOW_TOKENS,
    }
}

/// `session show`：元信息 + 统计（+ 可选最近 N 条消息预览）
async fn show(
    db: &SessionDb,
    id: &str,
    messages: usize,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let session: Session = match db.repo.get_session(id).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            let _ = writeln!(err, "错误: 会话不存在: {}", id);
            return EXIT_ERROR;
        }
        Err(e) => {
            let _ = writeln!(err, "错误: 读取会话失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let stat = stats_of(db, id).await;
    let window = window_of(db).await;

    // 消息预览：只取尾部一页（`get_message_page` 就是按 rowid 取尾部窗口，不读全量历史）
    let page = if messages > 0 {
        match db.repo.get_message_page(id, messages, None).await {
            Ok(p) => Some(p),
            Err(e) => {
                let _ = writeln!(err, "[warn] 读取消息预览失败（只显示元信息）: {}", e);
                None
            }
        }
    } else {
        None
    };

    if json {
        let items: Vec<serde_json::Value> = page
            .as_ref()
            .map(|p| {
                p.messages
                    .iter()
                    .map(|m| {
                        serde_json::json!({
                            "id": m.id,
                            "role": m.role,
                            "timestamp": m.timestamp,
                            "preview": brief(&crate::session_rt::message_text(&m.content), PREVIEW_COLS),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let payload = serde_json::json!({
            "session": session_json(&session, stat.as_ref(), window),
            // `messagesRequested` 与数组长度一起看才能区分「没要预览」与「真没有消息」
            "messagesRequested": messages,
            "messages": items,
        });
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        );
        return EXIT_OK;
    }

    let _ = writeln!(out, "会话    : {}", session.id);
    let _ = writeln!(
        out,
        "标题    : {}",
        if session.title.trim().is_empty() {
            crate::session_rt::UNTITLED
        } else {
            session.title.trim()
        }
    );
    let _ = writeln!(
        out,
        "Agent   : {}",
        session.agent_id.as_deref().unwrap_or("未指定")
    );
    let _ = writeln!(out, "Provider: {}", session.provider_config_id);
    let _ = writeln!(out, "模型    : {}", session.model_id);
    let _ = writeln!(
        out,
        "工作目录: {}",
        session
            .workspace
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .unwrap_or("未设置")
    );
    let _ = writeln!(out, "创建    : {}", fmt_time(session.created_at));
    let _ = writeln!(out, "更新    : {}", fmt_time(session.updated_at));
    let _ = writeln!(
        out,
        "消息数  : {}",
        stat.as_ref().map(|s| s.messages).unwrap_or(0)
    );
    let _ = writeln!(
        out,
        "上下文  : {}",
        match stat.as_ref().and_then(|s| s.context_tokens) {
            // 无用量数据时显示 `-`（而不是 0%）—— 0% 会被读成「上下文是空的」
            Some(n) => format!(
                "{}% ({} / {})",
                agent_compress::context_percent(n, window),
                agent_compress::format_tokens(n),
                agent_compress::format_tokens(window)
            ),
            None => "-（从未拿到用量数据）".to_string(),
        }
    );

    if let Some(p) = &page {
        if !p.messages.is_empty() {
            let _ = writeln!(out, "\n最近 {} 条消息:", p.messages.len());
            for m in &p.messages {
                let _ = writeln!(
                    out,
                    "  {}  {:<9}  {}",
                    fmt_time(m.timestamp),
                    m.role,
                    brief(&crate::session_rt::message_text(&m.content), PREVIEW_COLS)
                );
            }
        }
    }
    EXIT_OK
}

/// `session search`：检索消息正文（跨会话或单会话）
async fn search(
    db: &SessionDb,
    keyword: &str,
    session_id: Option<&str>,
    limit: usize,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // `role = None` → 仓储只返回 user + assistant（与桌面端检索一致，不含 tool 结果）
    let page = match db
        .repo
        .search_messages(keyword, session_id, None, limit, None)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(err, "错误: 检索失败: {}", e);
            return EXIT_ERROR;
        }
    };

    if json {
        let payload = serde_json::json!({
            "query": keyword,
            "sessionId": session_id,
            "limit": limit,
            "count": page.items.len(),
            "hasMore": page.has_more,
            "items": page.items.iter().map(|i| serde_json::json!({
                "id": i.id,
                "sessionId": i.session_id,
                "sessionTitle": i.session_title,
                "role": i.role,
                "timestamp": i.timestamp,
                "workspace": i.workspace,
                "text": i.text,
            })).collect::<Vec<_>>(),
        });
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        );
        return EXIT_OK;
    }

    if page.items.is_empty() {
        let _ = writeln!(
            out,
            "没有命中（关键词「{}」，范围：{}）",
            keyword,
            match session_id {
                Some(id) => format!("会话 {}", id),
                None => "全部会话".to_string(),
            }
        );
        return EXIT_OK;
    }

    let _ = writeln!(
        out,
        "命中 {} 条（关键词「{}」，范围：{}，按时间倒序）{}",
        page.items.len(),
        keyword,
        match session_id {
            Some(id) => format!("会话 {}", id),
            None => "全部会话".to_string(),
        },
        if page.has_more {
            format!("（还有更多，--limit 可加到 {}）", MAX_SEARCH_LIMIT)
        } else {
            String::new()
        }
    );
    for i in &page.items {
        // 跨会话时标题才有意义（单会话检索里每行都写一遍原标题是噪音）
        let where_ = if session_id.is_some() {
            String::new()
        } else {
            format!("  [{}]", brief(&i.session_title, 24))
        };
        let _ = writeln!(
            out,
            "\n  {}  {:<9}{}",
            fmt_time(i.timestamp),
            i.role,
            where_
        );
        let _ = writeln!(out, "      {}", brief(&i.text, 100));
    }
    EXIT_OK
}

/// 「非终端 + 未给 `--yes`」= 用法错误（fail-closed 的那条红线）。
///
/// 抽成纯函数只为一件事：这条红线必须**可被单测覆盖**，而真实路径要读 stdin ——
/// 在真终端里跑测试会把它挂住（`provider/tests.rs` 只测解析的前例就是为此）。
fn needs_yes_gate(yes: bool, interactive: bool) -> Result<(), i32> {
    if yes || interactive {
        Ok(())
    } else {
        Err(EXIT_USAGE)
    }
}

/// 危险操作确认：`--yes` 直接放行；否则要求真终端（管道里一律拒绝，fail-closed）。
///
/// 与 `provider rm` 同一口径（同样的文案骨架、同样的退出码），差别只在提示语由调用方给。
fn confirm(prompt: &str, yes: bool, out: &mut dyn Write, err: &mut dyn Write) -> Result<(), i32> {
    if let Err(code) = needs_yes_gate(yes, std::io::stdin().is_terminal()) {
        let _ = writeln!(
            err,
            "错误: 该操作需要确认，但 stdin 不是终端。确认要执行就加 `--yes`"
        );
        return Err(code);
    }
    if yes {
        return Ok(());
    }
    let mut input = std::io::stdin().lock();
    // 走到这里 stdin 一定是终端（`needs_yes_gate` 刚刚放过）
    let mut p = Prompter::new(&mut input, &mut *out, true);
    match p.confirm(prompt, false) {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = writeln!(err, "已取消，未改动任何数据");
            Err(EXIT_ERROR)
        }
        // EOF（管道被关）：绝不当作「确认」——`Prompter` 已给出可读原因
        Err(e) => {
            let _ = writeln!(err, "{}", e);
            Err(EXIT_ERROR)
        }
    }
}

/// `session rm`：删除会话及其全部消息
async fn rm(
    db: &SessionDb,
    id: &str,
    yes: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let session = match db.repo.get_session(id).await {
        Ok(Some(s)) => s,
        // 不存在就是失败：静默成功会让脚本以为「删掉了」
        Ok(None) => {
            let _ = writeln!(err, "错误: 会话不存在: {}", id);
            return EXIT_ERROR;
        }
        Err(e) => {
            let _ = writeln!(err, "错误: 读取会话失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let count = stats_of(db, id).await.map(|s| s.messages).unwrap_or(0);
    let title = if session.title.trim().is_empty() {
        crate::session_rt::UNTITLED.to_string()
    } else {
        session.title.trim().to_string()
    };

    if let Err(code) = confirm(
        &format!("确定删除会话「{}」（{}，{} 条消息）？", title, id, count),
        yes,
        out,
        err,
    ) {
        return code;
    }

    match db.repo.delete_session(id).await {
        Ok(()) => {
            let _ = writeln!(out, "已删除会话 {}（「{}」，{} 条消息）", id, title, count);
            // 用量账本不动（见文件头）；但用户容易以为「删会话 = 清账」，所以要说明
            let _ = writeln!(err, "提示: 用量账本不受影响（用量是已发生消费的记录，见 `session --help`）");
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: 删除会话失败: {}", e);
            EXIT_ERROR
        }
    }
}

/// `purge` 的结果行（纯函数）。
///
/// 为什么单独抽出来：真端到端**造不出「有孤儿」的确定性场景** —— `open_session_db` 会 spawn
/// 一次后台回收，与本命令的前台回收谁先跑完不确定（测试会 flaky）。而「非 0 怎么显示」
/// 必须有确定覆盖（它是这条命令唯一有信息量的分支），所以把渲染拆成纯函数。
pub(crate) fn purge_line(n: usize) -> String {
    if n == 0 {
        "没有孤儿消息（0 条）—— 正常情况就该是这个结果".to_string()
    } else {
        format!("已回收 {} 条孤儿消息", n)
    }
}

/// `session purge`：回收孤儿消息（显式 await，不依赖开库时的后台任务）
async fn purge(db: &SessionDb, yes: bool, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    if let Err(code) = confirm(
        "确定回收孤儿消息（session_id 指向已不存在会话的历史残留）？",
        yes,
        out,
        err,
    ) {
        return code;
    }
    match db.repo.purge_orphan_messages().await {
        Ok(n) => {
            let _ = writeln!(out, "{}", purge_line(n));
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: 回收孤儿消息失败: {}", e);
            EXIT_ERROR
        }
    }
}

#[cfg(test)]
mod tests;
