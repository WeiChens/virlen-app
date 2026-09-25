//! 用量账本（token 统计）：DTO + 写入 / 聚合 / 明细 / 回填
//!
//! 设计见 `docs/token-usage-stats.md`。一句话：每次 LLM 调用记一条流水，
//! 不走 messages 聚合（会话删除不丢历史、能覆盖不产生消息的调用）。
//!
//! 具体实现都在这里，`sqlite::SqliteSessionRepo` 只做转发。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

// ==================== 用量账本（token 统计） ====================
//
// 设计见 `docs/token-usage-stats.md`。一句话：每次 LLM 调用记一条流水，
// 不走 messages 聚合（会话删除不丢历史、能覆盖不产生消息的调用）。

/// 一次 LLM 调用的用量流水（写入单位）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UsageEntry {
    /// 调用完成时间（Unix ms）；不传则取当前时间
    pub ts: Option<i64>,
    pub session_id: Option<String>,
    /// `chat_round` 的幂等键（assistant 消息 id）
    pub message_id: Option<String>,
    pub model: String,
    pub provider_type: Option<String>,
    pub provider_config_id: Option<String>,
    /// chat_round | compress | title | verify | embedding | legacy
    pub kind: String,
    pub round: Option<i64>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// 缓存读/写（= total - prompt - completion）
    pub cached_tokens: i64,
    pub total_tokens: i64,
    /// 是否为本地估算值（非 API 返回）
    pub estimated: bool,
    /// LLM 请求耗时（ms）；未测量传 `None` / 0（UI 显示 `-` 而不是 0 tok/s）
    pub duration_ms: Option<i64>,
    pub trace_id: Option<String>,
}

/// 用量查询参数（聚合与明细共用同一套过滤条件）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UsageQuery {
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub kind: Option<String>,
    /// 分桶维度：day | week | month | model | session | kind | provider
    pub group_by: Option<String>,
    /// 明细分页（`usage_records`）
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// 一个聚合桶（`totals` 也复用此结构）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub key: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub total_tokens: i64,
    /// 调用次数
    pub calls: i64,
    /// 其中估算值条数（非 API 返回）
    pub estimated_calls: i64,
}

/// 聚合结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub buckets: Vec<UsageBucket>,
    /// 全部匹配流水的合计（不受 `limit` 影响）
    pub totals: UsageBucket,
    /// 账本内最早 / 最晚流水时间（供 UI 展示数据覆盖范围）
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
}

/// 一条用量明细（表格视图 / 导出用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: i64,
    pub ts: i64,
    pub session_id: Option<String>,
    /// 会话标题（JOIN sessions；会话已删除时为 None）
    pub session_title: Option<String>,
    pub message_id: Option<String>,
    pub model: String,
    pub provider_type: Option<String>,
    pub provider_config_id: Option<String>,
    pub kind: String,
    pub round: Option<i64>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub total_tokens: i64,
    pub estimated: bool,
    /// LLM 请求耗时（ms）；0 = 未测量（历史流水），UI 显示 `-`
    pub duration_ms: i64,
    pub trace_id: Option<String>,
}

/// 明细分页结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordPage {
    /// 按时间倒序（新 → 旧）
    pub records: Vec<UsageRecord>,
    /// 匹配总条数（用于分页）
    pub total: i64,
}


/// 从 `messages.usage` 回填历史用量到 `usage_ledger`（v1 → v2 迁移，幂等）。
///
/// - 幂等键是 `message_id`（唯一索引 + `INSERT OR IGNORE`）：重复执行不会产生重复流水；
/// - 历史数据无法区分调用类型，统一记为 `legacy`，避免污染新口径
///   （`summary` 消息是上下文压缩产物，记为 `compress` 并标 `estimated=1`，因为它是本地估算值）；
/// - 模型名优先取 `messages.model`，为空时回退到会话的 `model_id`
///   （保存消息时从未写过 `messages.model`，不回退的话历史流水全是空模型 → 无处取价 → 费用恒为 0）；
/// - 单条 SQL 完成（`INSERT ... SELECT`），不逐行循环，避免大库首次升级时拖慢启动。
pub(crate) fn backfill_usage_ledger(conn: &Arc<Mutex<Connection>>) -> Result<(), String> {
    // 账本已有内容（用户已用过新版）→ 不重复回填
    let guard = conn.lock().unwrap();
    let already: bool = guard
        .query_row("SELECT EXISTS(SELECT 1 FROM usage_ledger)", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        != 0;
    if already {
        return Ok(());
    }
    guard
        .execute(
            r#"
INSERT OR IGNORE INTO usage_ledger (
  ts, session_id, message_id, model, kind,
  prompt_tokens, completion_tokens, total_tokens, estimated
)
SELECT m.timestamp,
       m.session_id,
       m.id,
       COALESCE(NULLIF(m.model, ''), s.model_id, ''),
       CASE m.role WHEN 'summary' THEN 'compress' ELSE 'legacy' END,
       COALESCE(json_extract(m.usage, '$.promptTokens'), 0),
       COALESCE(json_extract(m.usage, '$.completionTokens'), 0),
       COALESCE(json_extract(m.usage, '$.totalTokens'), 0),
       CASE m.role WHEN 'summary' THEN 1 ELSE 0 END
FROM messages m
LEFT JOIN sessions s ON s.id = m.session_id
WHERE m.usage IS NOT NULL AND m.usage != 'null'
"#,
            [],
        )
        .map_err(|e| format!("回填用量账本失败: {}", e))?;
    Ok(())
}

/// v2 → v3：修补 `usage_ledger.model` 为空的流水。
///
/// 背景：保存消息时从未写过 `messages.model`，所以 v2 回填出来的历史流水 `model` 全是空串
/// —— 明细里模型显 '-'、预算取不到单价 → **历史用量的费用恒为 0**
/// （用户看到的现象：“恢复内置价之后全是 0”）。会话的 `model_id` 就是当时用的模型，用它兜底。
///
/// 幂等：只动 `model = ''` 的行；会话已删除的流水永远补不上（`model` 保持空，详见已知局限）。
pub(crate) fn repair_usage_ledger_model(conn: &Arc<Mutex<Connection>>) -> Result<(), String> {
    let guard = conn.lock().unwrap();
    guard
        .execute(
            r#"
UPDATE usage_ledger
   SET model = (
         SELECT s.model_id FROM sessions s WHERE s.id = usage_ledger.session_id
       )
 WHERE model = ''
   AND session_id IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM sessions s
          WHERE s.id = usage_ledger.session_id AND COALESCE(s.model_id, '') != ''
       )
"#,
            [],
        )
        .map_err(|e| format!("修补用量流水的模型名失败: {}", e))?;
    Ok(())
}

// ==================== 用量账本查询辅助 ====================

/// 构造用量查询的 WHERE 子句（含前导空格）与绑定参数。
///
/// `alias` 为表别名（聚合查询传 `usage_ledger`，明细 JOIN 查询传 `u`），
/// 显式加前缀避免 JOIN 后的列名歧义；所有值均走绑定参数，不拼接字面量。
fn usage_where(
    query: &UsageQuery,
    alias: &str,
) -> (String, Vec<Box<dyn rusqlite::ToSql + Send>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql + Send>> = Vec::new();

    if let Some(from) = query.from_ts {
        params.push(Box::new(from));
        clauses.push(format!("{}.ts >= ?{}", alias, params.len()));
    }
    if let Some(to) = query.to_ts {
        params.push(Box::new(to));
        clauses.push(format!("{}.ts <= ?{}", alias, params.len()));
    }
    if let Some(sid) = query.session_id.as_deref().filter(|s| !s.is_empty()) {
        params.push(Box::new(sid.to_string()));
        clauses.push(format!("{}.session_id = ?{}", alias, params.len()));
    }
    if let Some(model) = query.model.as_deref().filter(|s| !s.is_empty()) {
        params.push(Box::new(model.to_string()));
        clauses.push(format!("{}.model = ?{}", alias, params.len()));
    }
    if let Some(kind) = query.kind.as_deref().filter(|s| !s.is_empty()) {
        params.push(Box::new(kind.to_string()));
        clauses.push(format!("{}.kind = ?{}", alias, params.len()));
    }

    if clauses.is_empty() {
        (String::new(), params)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), params)
    }
}

/// 用量分桶表达式（白名单匹配，绝不把用户输入拼进 SQL）。
///
/// 时间桶用 `'localtime'`：`ts` 是 Unix ms，不转本地时区的话「今日」会按 UTC 切分。
fn usage_group_expr(group_by: Option<&str>) -> &'static str {
    match group_by.unwrap_or("day") {
        "hour" => "strftime('%Y-%m-%d %H', ts / 1000, 'unixepoch', 'localtime')",
        "week" => "strftime('%Y-%W', ts / 1000, 'unixepoch', 'localtime')",
        "month" => "strftime('%Y-%m', ts / 1000, 'unixepoch', 'localtime')",
        "model" => "model",
        "session" => "COALESCE(session_id, '')",
        "kind" => "kind",
        "provider" => "COALESCE(provider_type, provider_config_id, '')",
        _ => "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')",
    }
}

pub(crate) async fn append(
    conn: Arc<Mutex<Connection>>,
    entries: &[UsageEntry],
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let entries = entries.to_vec();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = conn.lock().unwrap();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启事务失败: {}", e))?;
        {
            let mut stmt = tx
                .prepare(
                    r#"
INSERT OR IGNORE INTO usage_ledger (
  ts, session_id, message_id, model, provider_type, provider_config_id,
  kind, round, prompt_tokens, completion_tokens, cached_tokens, total_tokens,
  estimated, duration_ms, trace_id
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
"#,
                )
                .map_err(|e| format!("准备用量写入失败: {}", e))?;
            for e in &entries {
                stmt.execute(params![
                    e.ts.unwrap_or_else(crate::telemetry::now_ms),
                    e.session_id,
                    e.message_id,
                    e.model,
                    e.provider_type,
                    e.provider_config_id,
                    e.kind,
                    e.round,
                    e.prompt_tokens,
                    e.completion_tokens,
                    e.cached_tokens,
                    e.total_tokens,
                    e.estimated as i64,
                    e.duration_ms.unwrap_or(0).max(0),
                    e.trace_id,
                ])
                .map_err(|err| format!("写入用量流水失败: {}", err))?;
            }
        }
        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}

pub(crate) async fn stats(
    conn: Arc<Mutex<Connection>>,
    query: &UsageQuery,
) -> Result<UsageStats, String> {
    let query = query.clone();
    tokio::task::spawn_blocking(move || -> Result<UsageStats, String> {
        let conn = conn.lock().unwrap();
        let (where_sql, filter_params) = usage_where(&query, "usage_ledger");
        let key_expr = usage_group_expr(query.group_by.as_deref());

        // 分桶聚合
        let sql = format!(
            r#"
SELECT {key_expr} AS bucket_key,
   COALESCE(SUM(prompt_tokens), 0),
   COALESCE(SUM(completion_tokens), 0),
   COALESCE(SUM(cached_tokens), 0),
   COALESCE(SUM(total_tokens), 0),
   COUNT(*),
   COALESCE(SUM(estimated), 0)
FROM usage_ledger{where_sql}
GROUP BY bucket_key
ORDER BY bucket_key ASC
"#
        );
        let mut buckets: Vec<UsageBucket> = Vec::new();
        {
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("准备用量聚合失败: {}", e))?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(filter_params.iter().map(|p| p.as_ref())),
                    |row| {
                        Ok(UsageBucket {
                            key: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                            prompt_tokens: row.get(1)?,
                            completion_tokens: row.get(2)?,
                            cached_tokens: row.get(3)?,
                            total_tokens: row.get(4)?,
                            calls: row.get(5)?,
                            estimated_calls: row.get(6)?,
                        })
                    })
                .map_err(|e| e.to_string())?;
            for b in rows {
                buckets.push(b.map_err(|e| e.to_string())?);
            }
        }

        // 合计（不受分组 / 分页影响）
        let totals_sql = format!(
            r#"
SELECT COALESCE(SUM(prompt_tokens), 0),
   COALESCE(SUM(completion_tokens), 0),
   COALESCE(SUM(cached_tokens), 0),
   COALESCE(SUM(total_tokens), 0),
   COUNT(*),
   COALESCE(SUM(estimated), 0)
FROM usage_ledger{where_sql}
"#
        );
        let totals = conn
            .query_row(
                &totals_sql,
                rusqlite::params_from_iter(filter_params.iter().map(|p| p.as_ref())),
                |row| {
                    Ok(UsageBucket {
                        key: String::new(),
                        prompt_tokens: row.get(0)?,
                        completion_tokens: row.get(1)?,
                        cached_tokens: row.get(2)?,
                        total_tokens: row.get(3)?,
                        calls: row.get(4)?,
                        estimated_calls: row.get(5)?,
                    })
                },
            )
            .map_err(|e| format!("读取用量合计失败: {}", e))?;

        // 账本数据覆盖范围（不看过滤条件，供 UI 提示「数据自 X 起」）
        let (first_ts, last_ts): (Option<i64>, Option<i64>) = conn
            .query_row("SELECT MIN(ts), MAX(ts) FROM usage_ledger", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap_or((None, None));

        Ok(UsageStats {
            buckets,
            totals,
            first_ts,
            last_ts,
        })
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}

pub(crate) async fn records(
    conn: Arc<Mutex<Connection>>,
    query: &UsageQuery,
) -> Result<UsageRecordPage, String> {
    let query = query.clone();
    tokio::task::spawn_blocking(move || -> Result<UsageRecordPage, String> {
        let conn = conn.lock().unwrap();
        let (where_sql, filter_params) = usage_where(&query, "u");
        let limit = query.limit.unwrap_or(200).clamp(1, 5000) as i64;
        let offset = query.offset.unwrap_or(0) as i64;

        // ⚠️ COUNT 的表**必须与 `usage_where` 用的别名一致**：过滤条件里的列都写成
        // `u.ts` / `u.session_id`（明细查询有 JOIN，必须带前缀）。若这里写
        // `FROM usage_ledger`（无别名），只要带了任何过滤条件，SQLite 就会报
        // `no such column: u.ts` → 明细与 CSV 导出在「今日 / 近 7 天 / 近 30 天」下
        // 全部空白（只有「全部」不过滤才正常）。
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM usage_ledger u{where_sql}"),
                rusqlite::params_from_iter(filter_params.iter().map(|p| p.as_ref())),
                |row| row.get(0),
            )
            .map_err(|e| format!("读取用量条数失败: {}", e))?;

        // 会话标题在会话已删除时为 NULL（流水保留，标题置空）
        let sql = format!(
            r#"
SELECT u.id, u.ts, u.session_id, s.title, u.message_id, u.model,
   u.provider_type, u.provider_config_id, u.kind, u.round,
   u.prompt_tokens, u.completion_tokens, u.cached_tokens, u.total_tokens,
   u.estimated, u.duration_ms, u.trace_id
FROM usage_ledger u
LEFT JOIN sessions s ON s.id = u.session_id{where_sql}
ORDER BY u.ts DESC, u.id DESC
LIMIT ?{limit_idx} OFFSET ?{offset_idx}
"#,
            limit_idx = filter_params.len() + 1,
            offset_idx = filter_params.len() + 2,
        );
        let mut all_params = filter_params;
        all_params.push(Box::new(limit));
        all_params.push(Box::new(offset));

        let mut records: Vec<UsageRecord> = Vec::new();
        {
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("准备用量明细查询失败: {}", e))?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(all_params.iter().map(|p| p.as_ref())),
                    |row| {
                        Ok(UsageRecord {
                            id: row.get(0)?,
                            ts: row.get(1)?,
                            session_id: row.get(2)?,
                            session_title: row.get(3)?,
                            message_id: row.get(4)?,
                            model: row.get(5)?,
                            provider_type: row.get(6)?,
                            provider_config_id: row.get(7)?,
                            kind: row.get(8)?,
                            round: row.get(9)?,
                            prompt_tokens: row.get(10)?,
                            completion_tokens: row.get(11)?,
                            cached_tokens: row.get(12)?,
                            total_tokens: row.get(13)?,
                            estimated: row.get::<_, i64>(14)? != 0,
                            duration_ms: row.get(15)?,
                            trace_id: row.get(16)?,
                        })
                    })
                .map_err(|e| e.to_string())?;
            for r in rows {
                records.push(r.map_err(|e| e.to_string())?);
            }
        }
        Ok(UsageRecordPage { records, total })
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}

pub(crate) async fn clear(conn: Arc<Mutex<Connection>>) -> Result<i64, String> {
    tokio::task::spawn_blocking(move || -> Result<i64, String> {
        let conn = conn.lock().unwrap();
        let n = conn
            .execute("DELETE FROM usage_ledger", [])
            .map_err(|e| format!("清空用量账本失败: {}", e))?;
        Ok(n as i64)
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}
