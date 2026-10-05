//! 记忆注入段的**取数编排**（唯一实现，GUI 命令与 CLI 共用）
//!
//! 把三件事串起来：读开关 → 取记忆 → 选取并渲染。选中即返回 id 列表，供调用方在会话建成后
//! 记一次「被使用」（`hits += 1`）—— 「什么被注入了」是可观测的，top-k 的排序输入也才成立。
//!
//! 开关的**默认值是「开」**（已定稿）：表里没有该键（新老用户都可能没有）时按开处理，
//! 因此「没配过」不会静默变成「记忆功能不生效」。

use crate::agent::memory::{
    render_memory_section, select_for_inject, MEMORY_NORMAL_TOP_K_DEFAULT, MEMORY_NORMAL_TOP_K_MAX,
    MEMORY_PROMPT_MAX_CHARS,
};
use crate::session_db::{MemoryRepo, SettingsRepo};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `app_settings` 里记忆开关的键名 —— 与 TS `SettingsStore.memoryEnabled` **同名同层**
pub const MEMORY_ENABLED_KEY: &str = "memoryEnabled";

/// `app_settings` 里普通记忆注入条数的键名 —— 与 TS `SettingsStore.memoryNormalTopK` 同名
pub const MEMORY_NORMAL_TOP_K_KEY: &str = "memoryNormalTopK";

/// 注入段（IPC DTO）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPromptSection {
    /// 渲染好的 `# Memory` 段；空串 = 不注入
    pub text: String,
    /// 被注入的记忆 id（调用方据此 `touch`）
    pub ids: Vec<String>,
    /// 因预算被裁掉的普通记忆条数（>0 时应埋点告警）
    pub dropped_normal: usize,
    /// 因预算被裁掉的最旧永久记忆条数
    pub dropped_permanent: usize,
    /// 最终渲染出来的**字符数**（码点）—— 与裁剪判定用的是同一个数，面板直接显示它
    pub chars: usize,
    /// 段字符预算（[`MEMORY_PROMPT_MAX_CHARS`]）—— 随 DTO 下发，前端不写死常量
    pub budget: usize,
}

/// 「不注入」的空段（**仍带上预算**：面板要能显示「0 / 4000 字符」，而不是「预算未知」）
fn empty_section() -> MemoryPromptSection {
    MemoryPromptSection {
        budget: MEMORY_PROMPT_MAX_CHARS,
        ..Default::default()
    }
}

/// 记忆开关（缺键 / 类型不对 → **开**）
pub fn enabled_from_settings(settings: &Map<String, Value>) -> bool {
    settings
        .get(MEMORY_ENABLED_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// 普通记忆注入条数（缺键 / 非法 / 超上限 → 默认值；上限由方案语义固定为 20）
pub fn top_k_from_settings(settings: &Map<String, Value>) -> usize {
    settings
        .get(MEMORY_NORMAL_TOP_K_KEY)
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MEMORY_NORMAL_TOP_K_MAX))
        .unwrap_or(MEMORY_NORMAL_TOP_K_DEFAULT)
}

/// 读取并渲染注入段。
///
/// 失败一律按「不注入」处理（返回空段而不是抛错）：记忆是**增强**，读不到不该让建会话失败
/// —— 与项目规则文件「读不到就不注入」同一取舍。
pub async fn load_memory_section(
    memories: &dyn MemoryRepo,
    settings: &dyn SettingsRepo,
    now_ms: i64,
) -> MemoryPromptSection {
    let settings_map = match settings.get_all().await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[memory] 读取设置失败，本次不注入记忆: {}", e);
            return empty_section();
        }
    };
    if !enabled_from_settings(&settings_map) {
        return empty_section();
    }
    let top_k = top_k_from_settings(&settings_map);

    let all = match memories.list(None, false).await {
        Ok(list) => list,
        Err(e) => {
            eprintln!("[memory] 读取记忆失败，本次不注入: {}", e);
            return empty_section();
        }
    };

    let selection = select_for_inject(&all, now_ms, top_k);
    MemoryPromptSection {
        text: render_memory_section(&selection.items),
        ids: selection.items.iter().map(|m| m.id.clone()).collect(),
        dropped_normal: selection.dropped_normal,
        dropped_permanent: selection.dropped_permanent,
        chars: selection.chars,
        budget: MEMORY_PROMPT_MAX_CHARS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::memory::MEMORY_SUMMARY_MAX_CHARS;
    use crate::session_db::{MemoryRecord, MEMORY_LEVEL_NORMAL, MEMORY_LEVEL_PERMANENT};

    fn settings_with(pairs: &[(&str, Value)]) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    #[test]
    fn enabled_defaults_to_true() {
        assert!(enabled_from_settings(&Map::new()), "缺键 = 开（已定稿默认值）");
        assert!(!enabled_from_settings(&settings_with(&[(
            MEMORY_ENABLED_KEY,
            Value::Bool(false)
        )])));
        // 类型不对（历史脏值）也不该把功能关掉
        assert!(enabled_from_settings(&settings_with(&[(
            MEMORY_ENABLED_KEY,
            Value::String("false".into())
        )])));
    }

    #[test]
    fn top_k_is_clamped_to_scheme_limit() {
        assert_eq!(top_k_from_settings(&Map::new()), MEMORY_NORMAL_TOP_K_DEFAULT);
        assert_eq!(top_k_from_settings(&settings_with(&[(MEMORY_NORMAL_TOP_K_KEY, Value::from(5))])), 5);
        assert_eq!(top_k_from_settings(&settings_with(&[(MEMORY_NORMAL_TOP_K_KEY, Value::from(999))])), MEMORY_NORMAL_TOP_K_MAX);
        assert_eq!(top_k_from_settings(&settings_with(&[(MEMORY_NORMAL_TOP_K_KEY, Value::from(0))])), 1, "0 会退化成「不注入普通记忆」，钳到 1");
        assert_eq!(top_k_from_settings(&settings_with(&[(MEMORY_NORMAL_TOP_K_KEY, Value::String("x".into()))])), MEMORY_NORMAL_TOP_K_DEFAULT);
    }

    /// 桩：记忆仓储（只实现本用例需要的 list）
    struct StubMemoryRepo(Vec<MemoryRecord>);

    #[async_trait::async_trait]
    impl MemoryRepo for StubMemoryRepo {
        async fn list(
            &self,
            _level: Option<&str>,
            _include_disabled: bool,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(self.0.clone())
        }
        async fn get(&self, id: &str) -> Result<Option<MemoryRecord>, String> {
            Ok(self.0.iter().find(|m| m.id == id).cloned())
        }
        async fn search(
            &self,
            _query: &str,
            _level: Option<&str>,
            _kind: Option<&str>,
            _limit: usize,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(self.0.clone())
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
        // 整理流水（P2）：注入链的用例不需要它，按「没有流水 / 不能跑」实现
        async fn get_run(&self, _day: &str) -> Result<Option<crate::session_db::MemoryRun>, String> {
            Ok(None)
        }
        async fn list_runs(
            &self,
            _limit: usize,
        ) -> Result<Vec<crate::session_db::MemoryRun>, String> {
            Ok(Vec::new())
        }
        async fn last_done_day(&self) -> Result<Option<String>, String> {
            Ok(None)
        }
        async fn claim_run(
            &self,
            _day: &str,
            _opts: crate::session_db::ClaimOptions,
        ) -> Result<Option<crate::session_db::MemoryRun>, String> {
            Ok(None)
        }
        async fn finish_run(&self, _run: &crate::session_db::MemoryRun) -> Result<(), String> {
            Ok(())
        }
        async fn delete_distilled_day(
            &self,
            _day: &str,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(Vec::new())
        }
    }

    /// 桩：设置仓储（返回固定的一份 app_settings）
    struct StubSettingsRepo(Map<String, Value>);

    #[async_trait::async_trait]
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

    fn sample_memories() -> Vec<MemoryRecord> {
        vec![
            MemoryRecord {
                id: "m_p1".into(),
                level: MEMORY_LEVEL_PERMANENT.into(),
                kind: "user".into(),
                summary: "用户偏好中文回复".into(),
                created_at: 1,
                ..Default::default()
            },
            MemoryRecord {
                id: "m_n1".into(),
                level: MEMORY_LEVEL_NORMAL.into(),
                kind: "project".into(),
                summary: "在 virlen-app 实现记忆功能".into(),
                created_at: 2,
                ..Default::default()
            },
            MemoryRecord {
                id: "m_n2".into(),
                level: MEMORY_LEVEL_NORMAL.into(),
                kind: "fact".into(),
                summary: "第二条普通记忆".into(),
                created_at: 3,
                ..Default::default()
            },
        ]
    }

    /// 端到端（桩）：永久 + 普通都进段，顺序 = 永久在前；开关关闭 → 空段
    #[tokio::test]
    async fn loads_section_and_respects_switch() {
        let memories = StubMemoryRepo(sample_memories());
        let settings = StubSettingsRepo(Map::new());

        let section = load_memory_section(&memories, &settings, 1_000).await;
        assert!(section.text.contains("## Permanent"));
        assert!(section.text.contains("用户偏好中文回复"));
        assert_eq!(
            section.ids,
            vec!["m_p1".to_string(), "m_n2".to_string(), "m_n1".to_string()],
            "永久在前；两条普通记忆同分（同为 30 分）→ 按创建时间新的在前"
        );

        let off = StubSettingsRepo(settings_with(&[(MEMORY_ENABLED_KEY, Value::Bool(false))]));
        let section = load_memory_section(&memories, &off, 1_000).await;
        assert!(section.text.is_empty(), "关掉开关必须完全不注入");
        assert!(section.ids.is_empty());
    }

    /// `memoryNormalTopK` 生效：只注入 1 条普通记忆（永久不受影响）
    #[tokio::test]
    async fn top_k_setting_limits_normal_memories() {
        let memories = StubMemoryRepo(sample_memories());
        let settings = StubSettingsRepo(settings_with(&[(
            MEMORY_NORMAL_TOP_K_KEY,
            Value::from(1),
        )]));
        let section = load_memory_section(&memories, &settings, 1_000).await;
        assert_eq!(section.ids.len(), 2, "永久 1 条 + 普通 1 条");
        assert!(section.ids.contains(&"m_p1".to_string()));
    }

    /// P3：段字符数 = **真实渲染结果**，预算随 DTO 下发（前端不写死常量）
    #[tokio::test]
    async fn section_reports_real_chars_and_budget() {
        let memories = StubMemoryRepo(sample_memories());
        let settings = StubSettingsRepo(Map::new());
        let section = load_memory_section(&memories, &settings, 1_000).await;
        assert_eq!(
            section.chars,
            section.text.chars().count(),
            "面板显示的字符数必须就是模型收到的那段文本的长度"
        );
        assert_eq!(section.budget, MEMORY_PROMPT_MAX_CHARS);
        assert_eq!(section.dropped_normal, 0);
        assert_eq!(section.dropped_permanent, 0);

        // 不注入时也带着预算：面板要能显示「0 / 4000」而不是「预算未知」
        let off = StubSettingsRepo(settings_with(&[(MEMORY_ENABLED_KEY, Value::Bool(false))]));
        let off_section = load_memory_section(&memories, &off, 1_000).await;
        assert_eq!(off_section.chars, 0);
        assert_eq!(off_section.budget, MEMORY_PROMPT_MAX_CHARS);
    }

    /// P3：预算被撑满时如实上报被裁条数（面板据此报警）
    #[tokio::test]
    async fn over_budget_reports_dropped_counts() {
        let mut all: Vec<MemoryRecord> = (0..3)
            .map(|i| MemoryRecord {
                id: format!("p{}", i),
                level: MEMORY_LEVEL_PERMANENT.into(),
                kind: "user".into(),
                summary: "永".repeat(MEMORY_SUMMARY_MAX_CHARS),
                created_at: i,
                ..Default::default()
            })
            .collect();
        all.extend((0..20).map(|i| MemoryRecord {
            id: format!("n{:02}", i),
            level: MEMORY_LEVEL_NORMAL.into(),
            kind: "fact".into(),
            summary: "字".repeat(MEMORY_SUMMARY_MAX_CHARS),
            created_at: 10,
            hits: i,
            ..Default::default()
        }));

        let memories = StubMemoryRepo(all);
        let settings = StubSettingsRepo(Map::new());
        let section = load_memory_section(&memories, &settings, 1_000).await;
        assert!(section.dropped_normal > 0, "必然要裁普通记忆");
        assert!(section.chars <= section.budget);
        assert_eq!(section.text.chars().count(), section.chars);
    }
}
