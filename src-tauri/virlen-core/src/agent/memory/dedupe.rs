//! 记忆**写入前查重**与冲突判定（纯函数，零 I/O）
//!
//! 要解决的问题（`docs/memory-plan.md` 里「事实源唯一」那条的落地）：模型的记忆写入是**只追加**的，
//! 于是同一件事会被反复写成多条 ——「项目用 pnpm 构建」说三遍就是三条；后来改成 npm 也只是
//! 再追加一条，于是库里同时存在互斥的两条，注入时按分数排序，等于抛硬币。
//!
//! 三条判据（都不依赖模型，因此可测、可解释）：
//!
//! | 判定 | 条件 | 动作 | 为什么 |
//! |---|---|---|---|
//! | [`WriteDecision::Duplicate`] | 归一化后**逐字相同** | 不新建条目，把新信息（级别升级 / 详情正文）并到旧条目上 | 重复写入不该占预算、不该让同一条记忆挤掉别的记忆 |
//! | [`WriteDecision::Supersede`] | 归一化后**几乎相同**（字符编辑距离比 ≥ [`MEMORY_DEDUPE_REWRITE_SIMILARITY`]） | 新建条目，旧条目 `disabled + superseded_by = 新 id`（留作「改前版」） | 「同一句被改写」＝事实更新；旧版不删，模型仍可 `memory_recall` |
//! | 其余 | — | [`WriteDecision::Add`] | 见下面的「为什么不猜语义冲突」 |
//!
//! ## 为什么不猜语义冲突
//!
//! 「改写」的判定线画在**字符层面**（[`MEMORY_DEDUPE_REWRITE_SIMILARITY`]），它能抳住两类事：
//!
//! - 改了一个词：`用 pnpm 构建` → `用 npm 构建`（相似 0.89）；
//! - **同一位置换了值**：`用户偏好中文回复` → `用户偏好英文回复`（相似 0.875）——
//!   这类句子本身就差一个字，判成改写正好就是「新偏好覆盖旧偏好」。
//!
//! 它抳不住的是**真正换了说法的重述**（`项目用 pnpm 构建` → `构建工具选的是 pnpm`）：
//! 词序与用词都变了，字符相似度自然落在线下。这时结果是 [`WriteDecision::Add`] ——
//! 两条并存，而不是静默顶替旧的。这个偏置是故意的：并存至少两条都还能被检索到、被模型
//! 看到（新的排序靠前），而错顶替就是**静默丢事实**。重述合并交给模型（提示词已要求写入前
//! 先 `memory_search`）与再蒸馏（`redistill`，那是真让模型做合并的）。
//!
//! 短句另有限制（[`MEMORY_DEDUPE_MIN_CHARS`]）：`用 npm` / `用 pnpm` 只差一个字符，
//! 但那是一个字的插入造成的假像，只有逐字相同才合并。
//!
//! ## 作用域
//!
//! 只和**同一作用域**的条目比（调用方用 [`crate::session_db::MemoryRepo::active_in_scope`] 取候选）：
//! 别的项目的记忆被「顶替」等于跨项目丢事实，那是另一类事故。

use crate::session_db::{MemoryRecord, MEMORY_LEVEL_NORMAL, MEMORY_LEVEL_PERMANENT};

/// 一次写入最多拿多少条同作用域候选来比对
///
/// 记忆表只存 ≤150 字符的短句，几百行的本地查询在写路径上跑得起（这条路径本来就要写库）。
/// 上限的作用是**兜死**：真有人攒了上万条，也不能让一次 `memory_write` 变成全表扫描。
pub const MEMORY_DEDUPE_MAX_CANDIDATES: usize = 200;

/// 参与「改写」判定的最短长度（归一化后的字符数）
///
/// 太短的句子没有可比性：「用 npm」与「用 pnpm」只差一个字符，但那是**互斥结论**，
/// 按改写处理会静默丢掉前一条。短句只在**逐字相同**时才合并。
pub const MEMORY_DEDUPE_MIN_CHARS: usize = 8;

/// 「同一句被改写」的判定线：`1 - 编辑距离 / 较长串长度 ≥ 0.85`
///
/// 取 0.85 的含义是「改掉不超过 15% 的字符」：「项目用 pnpm 构建」→「项目用 npm 构建」
/// 是 1/9 ≈ 0.89（命中），而两个不同事实的模板化句子通常落在 0.5~0.7（不命中）。
///
/// ⚠️ 真正参与判定的是 **整数** 常量 [`REWRITE_ALLOWED_DISTANCE_PERCENT`]：`0.85` 在二进制里
/// 存不准，`1 - 3/20` 恰好落在阈值上时，`>=` 会因最后一位抖动而随机翻身。
/// 本常量只用于文档与展示，改它就要同步改百分比（有单测锁两者等价）。
pub const MEMORY_DEDUPE_REWRITE_SIMILARITY: f64 = 0.85;

/// 与 [`MEMORY_DEDUPE_REWRITE_SIMILARITY`] 等价的**整数**判定：编辑距离 ≤ 较长串长度的 15%
///
/// `距离 / 长度 ≤ 15/100` ⇔ `距离 * 100 ≤ 长度 * 15`，全整数运算，没有浮点边界。
const REWRITE_ALLOWED_DISTANCE_PERCENT: usize = 15;

/// 一次写入的判定输入
pub struct WriteFacts<'a> {
    /// 已按硬上限截断的正文（与落库的那份**逐字一致**，否则判定与入库会错位）
    pub summary: &'a str,
    /// 新条目的级别：`permanent` 的写入可以顶替永久记忆，普通写入不能
    pub level: &'a str,
}

/// 判定结论
#[derive(Debug, Clone)]
pub enum WriteDecision {
    /// 新事实：照常写入
    Add,
    /// 逐字重复：不新建条目（返回库里那条，调用方可以把级别升级 / 详情正文并上去）
    Duplicate { existing: MemoryRecord },
    /// 同一句被改写：新建条目，并把旧条目归档为「改前版」
    Supersede {
        old: MemoryRecord,
        /// 相似度（0~1，写进工具返回便于排障与埋点）
        similarity: f64,
    },
    /// 与**永久记忆**几乎相同：不由模型静默顶替，让用户裁决
    KeepPermanent { existing: MemoryRecord },
}

/// 归一化：只留字母 / 数字 / 汉字，其余（空白、标点、括号、全角符号）一律丢掉，且小写
///
/// 为什么丢标点：模型复述同一件事时标点几乎必然不同（`用 pnpm` / `用 pnpm。` / `用「pnpm」`），
/// 带着标点比会把「同一条」判成「两条」。
pub fn normalize(summary: &str) -> String {
    summary
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 两句的比较结果
#[derive(Debug, Clone, Copy)]
struct Pairwise {
    /// `1 - 编辑距离 / 较长串长度`（0~1；供报告 / 埋点看）
    similarity: f64,
    /// 是否算「同一句被改写」（**整数**判定，不受浮点误差影响）
    rewrite: bool,
}

/// 两个归一化串的相似度：`1 - 编辑距离 / 较长串长度`（都空 → 1，一空一非空 → 0）
///
/// 用编辑距离而不是「词/字二元组 Jaccard」：改写通常只动一两个字（`pnpm`→`npm`、`旧`→`新`），
/// 编辑距离对「改了哪个字」敏感，而二元组会被大量共享的上下文稀释掉。
pub fn similarity(a: &str, b: &str) -> f64 {
    compare(a, b).similarity
}

/// 比一对句子：归一化 → 编辑距离 → 相似度 + 整数阈值判定
fn compare(a: &str, b: &str) -> Pairwise {
    let a: Vec<char> = normalize(a).chars().collect();
    let b: Vec<char> = normalize(b).chars().collect();
    let longest = a.len().max(b.len());
    if longest == 0 {
        return Pairwise {
            similarity: 1.0,
            rewrite: true,
        };
    }
    let distance = levenshtein(&a, &b);
    Pairwise {
        similarity: 1.0 - distance as f64 / longest as f64,
        rewrite: distance * 100 <= longest * REWRITE_ALLOWED_DISTANCE_PERCENT,
    }
}

/// 逐字相同的判定口径（与 [`similarity`] 一致：都先归一化）
pub fn is_identical(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

/// 判定一次写入该走哪条路
///
/// `candidates` 由调用方按**同一作用域 + 未停用**取好（见 [`crate::session_db::MemoryRepo::active_in_scope`]）；
/// 这里再挡一次 `disabled`（防御：判宽了会悄悄顶替一条用户自己停用/已归档的条目）。
pub fn classify(facts: &WriteFacts<'_>, candidates: &[MemoryRecord]) -> WriteDecision {
    let new_norm = normalize(facts.summary);
    if new_norm.is_empty() {
        return WriteDecision::Add;
    }

    let active = || candidates.iter().filter(|c| !c.disabled);

    // ① 逐字重复（不看长度：短句逐字相同也是同一条）
    if let Some(existing) = pick_best(active().filter(|c| normalize(&c.summary) == new_norm)) {
        return WriteDecision::Duplicate { existing };
    }

    // ② 「同一句被改写」：短句不参与（见 MEMORY_DEDUPE_MIN_CHARS 的说明）
    if new_norm.chars().count() < MEMORY_DEDUPE_MIN_CHARS {
        return WriteDecision::Add;
    }
    let best = active()
        .filter(|c| normalize(&c.summary).chars().count() >= MEMORY_DEDUPE_MIN_CHARS)
        .map(|c| (c, compare(facts.summary, &c.summary)))
        // 阈值判定用整数（`Pairwise::rewrite`），不用 `similarity >= 0.85`
        .filter(|(_, cmp)| cmp.rewrite)
        .max_by(|(ca, cmp_a), (cb, cmp_b)| {
            // 相似度高者优先；并列时用「热 → 新 → id」保证全序（同一份库永远同一结论）
            cmp_a
                .similarity
                .partial_cmp(&cmp_b.similarity)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| ca.hits.cmp(&cb.hits))
                .then_with(|| ca.created_at.cmp(&cb.created_at))
                .then_with(|| cb.id.cmp(&ca.id))
        });

    match best {
        None => WriteDecision::Add,
        // 永久记忆是用户钉住的：普通写入不静默顶替它
        Some((old, _))
            if old.level == MEMORY_LEVEL_PERMANENT && facts.level != MEMORY_LEVEL_PERMANENT =>
        {
            WriteDecision::KeepPermanent {
                existing: old.clone(),
            }
        }
        Some((old, cmp)) => WriteDecision::Supersede {
            old: old.clone(),
            similarity: cmp.similarity,
        },
    }
}

/// 多条并列时的择优顺序：命中多 → 新建 → id 升序（全序，可断言）
fn pick_best<'a>(items: impl Iterator<Item = &'a MemoryRecord>) -> Option<MemoryRecord> {
    items
        .max_by(|a, b| {
            a.hits
                .cmp(&b.hits)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| b.id.cmp(&a.id))
        })
        .cloned()
}

/// 字符级编辑距离（滚动两行，O(n·m) 时间 / O(m) 空间）
///
/// 正文 ≤150 字符，最坏 22500 次内层迭代 —— 相对一次库写入可忽略。
fn levenshtein(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 新写入的级别是不是「普通」（给调用方做提示文案用；也顺手把常量收在一处）
pub fn is_normal_level(level: &str) -> bool {
    level == MEMORY_LEVEL_NORMAL
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, summary: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: MEMORY_LEVEL_NORMAL.into(),
            kind: "fact".into(),
            summary: summary.into(),
            origin: "model".into(),
            hits: 0,
            created_at: 1_700_000_000_000,
            ..Default::default()
        }
    }

    fn facts(summary: &str) -> WriteFacts<'_> {
        WriteFacts {
            summary,
            level: MEMORY_LEVEL_NORMAL,
        }
    }

    fn facts_permanent(summary: &str) -> WriteFacts<'_> {
        WriteFacts {
            summary,
            level: MEMORY_LEVEL_PERMANENT,
        }
    }

    // ── 归一化 / 相似度 ──

    #[test]
    fn normalize_drops_spacing_punctuation_and_case() {
        assert_eq!(normalize("  用 pnpm。\n"), "用pnpm");
        assert_eq!(normalize("用「pnpm」"), "用pnpm");
        assert_eq!(normalize("Use Pnpm!"), "usepnpm");
        assert_eq!(normalize(""), "");
    }

    #[test]
    fn similarity_is_one_for_identical_and_zero_for_disjoint() {
        assert_eq!(similarity("用 pnpm。", "用pnpm"), 1.0);
        assert_eq!(similarity("abc", ""), 0.0);
        assert_eq!(similarity("", ""), 1.0);
    }

    /// 阈值判定必须是**整数**的：`0.85` 在浮点里存不准，`1 - 3/20` 恰好落在线上的那一对
    /// 不能因为最后一位抖动而随机翻身
    #[test]
    fn rewrite_threshold_is_exact_at_the_boundary() {
        // 长度 20、改 3 个字符 → 相似度恰好 0.85（在线上，算改写）
        let a = "abcdefghijklmnopqrst";
        let b = "abcdefghijklmnopqXYZ";
        let cmp = compare(a, b);
        assert!(cmp.rewrite, "0.85 是命中线（距离 ≤ 15%）");
        assert!(
            (cmp.similarity - MEMORY_DEDUPE_REWRITE_SIMILARITY).abs() < 1e-12,
            "相似度应当正好是 0.85，实际 {}",
            cmp.similarity
        );

        // 长度 20、改 4 个 → 0.80，线下
        let c = "abcdefghijklmnopWXYZ";
        assert!(!compare(a, c).rewrite, "0.80 不该命中");

        // 整数判定与浮点阈值在**随机长度**上也一致（除了浮点抖动的理论情形）
        for len in 1..40usize {
            for distance in 0..=len.min(6) {
                let left: String = "a".repeat(len);
                let right: String =
                    format!("{}{}", "a".repeat(len - distance), "b".repeat(distance));
                let cmp = compare(&left, &right);
                let by_float = cmp.similarity + 1e-12 >= MEMORY_DEDUPE_REWRITE_SIMILARITY;
                assert_eq!(
                    cmp.rewrite, by_float,
                    "整数判定与浮点阈值应等价（长度 {len}、距离 {distance}）"
                );
            }
        }
    }

    /// 改一个字（`pnpm` → `npm`）必须落在「改写」区间；两个不同的事实必须落在区间外
    #[test]
    fn similarity_separates_rewrites_from_different_facts() {
        let rewrite = similarity("项目用 pnpm 构建", "项目用 npm 构建");
        assert!(
            rewrite >= MEMORY_DEDUPE_REWRITE_SIMILARITY,
            "改写应命中，实际 {rewrite}"
        );

        let different = similarity("在 virlen-app 实现记忆功能", "在 virlen-app 实现知识库功能");
        assert!(
            different < MEMORY_DEDUPE_REWRITE_SIMILARITY,
            "不同事实不该被判成改写，实际 {different}"
        );

        // 同一位置换了值（偏好翻转）：只差一个字 → 判成改写，正好就是「新偏好覆盖旧偏好」
        let preference = similarity("用户偏好中文回复", "用户偏好英文回复");
        assert!(
            preference >= MEMORY_DEDUPE_REWRITE_SIMILARITY,
            "同一位置换值的句子应当落在改写区间，实际 {preference}"
        );

        // 真正换了说法的重述：落在区间外 → 两条并存（宁可重，不可丢）
        let rephrased = similarity("项目用 pnpm 构建", "构建工具选的是 pnpm");
        assert!(
            rephrased < MEMORY_DEDUPE_REWRITE_SIMILARITY,
            "换说法的重述不该被顶替，实际 {rephrased}"
        );
    }

    // ── 判定 ──

    #[test]
    fn identical_summary_is_a_duplicate_and_creates_nothing() {
        let all = [rec("m_a1", "在 virlen-app 实现记忆功能")];
        let d = classify(&facts("在virlen-app 实现记忆功能。"), &all);
        match d {
            WriteDecision::Duplicate { existing } => assert_eq!(existing.id, "m_a1"),
            other => panic!("应判重复，实际 {other:?}"),
        }
    }

    #[test]
    fn rewrite_supersedes_and_keeps_the_previous_version() {
        let all = [rec("m_old", "项目用 pnpm 构建")];
        let d = classify(&facts("项目用 npm 构建"), &all);
        match d {
            WriteDecision::Supersede { old, similarity } => {
                assert_eq!(old.id, "m_old");
                assert!(similarity >= MEMORY_DEDUPE_REWRITE_SIMILARITY);
                // 改前版仍在记录里（调用方据此写 superseded_by，条目本身不删）
                assert_eq!(old.summary, "项目用 pnpm 构建");
            }
            other => panic!("应判改写，实际 {other:?}"),
        }
    }

    #[test]
    fn different_fact_is_a_plain_add() {
        let all = [rec("m1", "在 virlen-app 实现记忆功能")];
        assert!(matches!(
            classify(&facts("在 virlen-app 实现知识库功能"), &all),
            WriteDecision::Add
        ));
    }

    #[test]
    fn short_summaries_only_merge_on_exact_match() {
        let all = [rec("m1", "用 pnpm")];
        // 一字符之差：互斥结论，不顶替
        assert!(matches!(
            classify(&facts("用 npm"), &all),
            WriteDecision::Add
        ));
        // 逐字相同：照旧合并
        assert!(matches!(
            classify(&facts("用 pnpm。"), &all),
            WriteDecision::Duplicate { .. }
        ));
    }

    #[test]
    fn permanent_memory_is_not_overwritten_by_a_normal_write() {
        let mut perm = rec("m_perm", "项目用 pnpm 构建");
        perm.level = MEMORY_LEVEL_PERMANENT.into();
        let all = [perm];

        match classify(&facts("项目用 npm 构建"), &all) {
            WriteDecision::KeepPermanent { existing } => assert_eq!(existing.id, "m_perm"),
            other => panic!("永久记忆不该被普通写入顶替，实际 {other:?}"),
        }
        // 用户钉住的级别写下来则可以顶替（同一权限）
        assert!(matches!(
            classify(&facts_permanent("项目用 npm 构建"), &all),
            WriteDecision::Supersede { .. }
        ));
    }

    #[test]
    fn disabled_candidates_are_never_touched() {
        let mut off = rec("m_off", "项目用 pnpm 构建");
        off.disabled = true;
        let all = [off];
        assert!(matches!(
            classify(&facts("项目用 pnpm 构建"), &all),
            WriteDecision::Add
        ));
    }

    #[test]
    fn empty_summary_is_never_a_match() {
        let all = [rec("m1", "任意")];
        assert!(matches!(classify(&facts("   "), &all), WriteDecision::Add));
    }

    /// 多条并列时结论必须**确定**（同一份输入永远同一结果）：热 → 新 → id
    #[test]
    fn duplicate_pick_is_fully_ordered() {
        let mut hot = rec("m_b", "项目用 pnpm 构建");
        hot.hits = 5;
        let colder = rec("m_a", "项目用pnpm构建");
        let all = [colder, hot];
        match classify(&facts("项目用 pnpm 构建"), &all) {
            WriteDecision::Duplicate { existing } => assert_eq!(existing.id, "m_b"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn level_helper_matches_the_normal_constant() {
        assert!(is_normal_level("normal"));
        assert!(!is_normal_level("permanent"));
    }
}
