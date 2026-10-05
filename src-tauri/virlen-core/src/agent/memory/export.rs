//! 记忆**导出**（P3）—— 版本化信封 + 全序排序 + 序列化（纯函数，零 I/O）
//!
//! 导出的定位是「可解释性 + 备份」：一份**条目级**快照，可 diff、可交给外部工具。
//! ⚠️ **不含详情正文**：详情正文在专用知识库（可能几千字一条），要连正文一起备份用知识库页的
//! 导出 zip —— 否则导出文件会从「一屏能看完」变成「几 MB 的混合体」。
//!
//! 全序排序（永久在前，按 `created_at` 升序 = 注入顺序；普通按 `created_at` 降序 = 最新在前；
//! `id` 升序兜底）：同一份库两次导出**逐字节相同**，用户才能用 `git diff` 看出「昨天多记住了什么」。

use crate::session_db::{MemoryRecord, MEMORY_LEVEL_PERMANENT};
use serde::{Deserialize, Serialize};

/// 导出信封的格式标识（外部工具 / 未来的导入靠它判断「这是不是记忆导出」）
pub const MEMORY_EXPORT_FORMAT: &str = "virlen.memory";

/// 导出格式版本：**改语义才 +1**（只增字段、不动既有字段含义时保持不变）
pub const MEMORY_EXPORT_SCHEMA_VERSION: u32 = 1;

/// 导出信封
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExport {
    /// [`MEMORY_EXPORT_FORMAT`]
    pub format: String,
    /// [`MEMORY_EXPORT_SCHEMA_VERSION`]
    pub schema_version: u32,
    /// 导出时刻（毫秒）—— 与每条记录的 `created_at` / `updated_at` 并列，便于判断备份有多旧
    pub exported_at: i64,
    /// `memories` 的实际条数（冗余字段：脚本不必先数数组）
    pub count: usize,
    pub memories: Vec<MemoryRecord>,
}

/// 导出顺序（全序，见模块头注释）。
pub fn sort_for_export(records: &[MemoryRecord]) -> Vec<MemoryRecord> {
    let mut out = records.to_vec();
    out.sort_by(|a, b| {
        let a_perm = a.level == MEMORY_LEVEL_PERMANENT;
        let b_perm = b.level == MEMORY_LEVEL_PERMANENT;
        b_perm
            .cmp(&a_perm)
            .then_with(|| {
                if a_perm {
                    // 永久区：旧 → 新（与注入段一致，读起来就是模型看到的顺序）
                    a.created_at.cmp(&b.created_at)
                } else {
                    // 普通区：新 → 旧（用户最常看「最近记住了什么」）
                    b.created_at.cmp(&a.created_at)
                }
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// 生成导出 JSON（pretty：人能读、diff 友好）。
pub fn export_json(records: &[MemoryRecord], now_ms: i64) -> Result<String, String> {
    let memories = sort_for_export(records);
    let payload = MemoryExport {
        format: MEMORY_EXPORT_FORMAT.to_string(),
        schema_version: MEMORY_EXPORT_SCHEMA_VERSION,
        exported_at: now_ms,
        count: memories.len(),
        memories,
    };
    serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化记忆失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::MEMORY_LEVEL_NORMAL;

    fn rec(id: &str, level: &str, created_at: i64) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: level.into(),
            kind: "project".into(),
            summary: format!("记忆 {}", id),
            created_at,
            updated_at: created_at,
            ..Default::default()
        }
    }

    #[test]
    fn permanent_comes_first_old_to_new_then_normal_newest_first() {
        let all = vec![
            rec("n_old", MEMORY_LEVEL_NORMAL, 10),
            rec("p_new", MEMORY_LEVEL_PERMANENT, 200),
            rec("n_new", MEMORY_LEVEL_NORMAL, 300),
            rec("p_old", MEMORY_LEVEL_PERMANENT, 100),
        ];
        let sorted = sort_for_export(&all);
        let ids: Vec<&str> = sorted.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["p_old", "p_new", "n_new", "n_old"]);
    }

    #[test]
    fn same_level_and_time_falls_back_to_id_for_a_total_order() {
        let all = vec![rec("m_b", MEMORY_LEVEL_NORMAL, 5), rec("m_a", MEMORY_LEVEL_NORMAL, 5)];
        let sorted = sort_for_export(&all);
        let ids: Vec<&str> = sorted.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m_a", "m_b"], "同分按 id：同一份输入永远同一份输出");
    }

    #[test]
    fn export_is_byte_stable_and_carries_the_envelope() {
        let all = vec![
            rec("m_1", MEMORY_LEVEL_PERMANENT, 1),
            rec("m_2", MEMORY_LEVEL_NORMAL, 2),
        ];
        let a = export_json(&all, 1_700_000_000_000).unwrap();
        let b = export_json(&all, 1_700_000_000_000).unwrap();
        assert_eq!(a, b, "同一份输入两次导出逐字节相同（可 diff）");

        let parsed: MemoryExport = serde_json::from_str(&a).unwrap();
        assert_eq!(parsed.format, MEMORY_EXPORT_FORMAT);
        assert_eq!(parsed.schema_version, MEMORY_EXPORT_SCHEMA_VERSION);
        assert_eq!(parsed.exported_at, 1_700_000_000_000);
        assert_eq!(parsed.count, 2);
        assert_eq!(parsed.memories.len(), 2);
        // camelCase 字段名（与前端 / CLI --json 同一套）
        assert!(a.contains("\"schemaVersion\""));
        assert!(a.contains("\"detailKbId\""));
    }

    #[test]
    fn empty_export_is_still_a_valid_envelope() {
        let json = export_json(&[], 5).unwrap();
        let parsed: MemoryExport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.count, 0);
        assert!(parsed.memories.is_empty());
    }
}
