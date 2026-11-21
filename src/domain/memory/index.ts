/**
 * 记忆领域常量（**前端只做镜像**，权威全在 Rust）：设置页与面板要静默显示，不值得每次都走 IPC。
 * ⚠️ 改值必须同步 `agent/memory/mod.rs` / `prompt.rs` / `redistill/mod.rs`；`# Memory` 段由 Rust 渲染下发。
 */

/** 给 AI 的软上限（提示词里的要求） */
export const MEMORY_SUMMARY_HINT_CHARS = 120

/** 落库硬上限：超过按码点截断（与 Rust `MEMORY_SUMMARY_MAX_CHARS` 同值） */
export const MEMORY_SUMMARY_MAX_CHARS = 150

/** 普通记忆注入条数默认值 */
export const MEMORY_NORMAL_TOP_K_DEFAULT = 20

/** 普通记忆注入条数上限（方案语义就是 top20） */
export const MEMORY_NORMAL_TOP_K_MAX = 20

/** `# Memory` 段总字符预算 */
export const MEMORY_PROMPT_MAX_CHARS = 4000

/** 记忆级别（普通参与 top-k 淘汰；永久全量注入） */
export const MEMORY_LEVELS = ['normal', 'permanent'] as const
export type MemoryLevel = (typeof MEMORY_LEVELS)[number]

/** 记忆分类（面板下拉；未知值由 Rust 侧收敛为 `fact`）
 *
 * 分类只说「这条记忆是什么」，**可见范围由 `projectPath` 表达**（任何分类都可带，也可不带）。
 * 旧的 `project` 分类已移除（老数据由 Rust 开库迁移改成 `fact`）。
 */
export const MEMORY_KINDS = ['user', 'decision', 'fact'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** 项目路径的长度上限（与 Rust `MEMORY_PROJECT_PATH_MAX_CHARS` 同值；超限服务端拒绝） */
export const MEMORY_PROJECT_PATH_MAX_CHARS = 500

/** `app_settings` 键名（与 Rust 侧同名同层，不建映射表） */
export const MEMORY_ENABLED_KEY = 'memoryEnabled'
export const MEMORY_NORMAL_TOP_K_KEY = 'memoryNormalTopK'
/**
 * 再蒸馏逃生开关（与 Rust `MEMORY_REDISTILL_ENABLED_KEY` 同值，缺键 = 开）。
 * ⚠️ 不进 UI，故意不做「纠正为 true」的 fixup —— 那会让开关失去意义。
 */
export const MEMORY_REDISTILL_ENABLED_KEY = 'memoryRedistillEnabled'

/** 记忆条目（与 Rust `session_db::memory::MemoryRecord` 同形） */
export interface MemoryRecord {
  id: string
  level: MemoryLevel | string
  kind: MemoryKind | string
  summary: string
  /**
   * 项目路径（选填，**任何分类都可带**）：只在「工作目录 = 它或子目录」时注入与召回；`null` = 跨项目通用。
   * ⚠️ 匹配在 Rust（`agent::memory::scope`），前端只传工作目录。
   */
  projectPath?: string | null
  detailKbId?: string | null
  detailDocId?: string | null
  tags?: string[]
  sourceDay?: string
  sourceSessionId?: string | null
  /** `model` | `user`（历史数据里还可能有产物标记 `distill`） */
  origin?: string
  hits?: number
  lastUsedAt?: number
  createdAt?: number
  updatedAt?: number
  disabled?: boolean
  /**
   * 被哪个新条目顶替（再蒸馏的软删标记）：非空 + `disabled` = 已归档。
   * `null` = 从未参与合并（用户手写的 / 被用户停用）—— 自动清理的护栏字段。
   */
  supersededBy?: string | null
  /**
   * 详情正文长到**永远装不进归档**（再蒸馏实测后回写）：这种条目不能被自动整理合并 ——
   * 停用来源的前提是原文进得了归档。它们也不计入触发阈值（否则闸门会永远判「越线了」）。
   */
  detailTooLong?: boolean
}

/** 注入段（`cmd_memory_prompt_section` 的返回） */
export interface MemoryPromptSection {
  /** 渲染好的 `# Memory` 段；空串 = 不注入 */
  text: string
  /** 被注入的记忆 id */
  ids: string[]
  /** 因预算被裁掉的普通记忆条数（>0 = 该提醒用户清理） */
  droppedNormal: number
  /** 因预算被裁掉的最旧永久记忆条数 */
  droppedPermanent: number
  /** 注入段的**真实字符数**（Rust 裁剪时顺带算出）：面板常驻行与「是否超预算」共用它，不会两处不一致。 */
  chars: number
  /** 段字符预算（Rust 下发，前端不写死常量） */
  budget: number
}

// ==================== 详情正文的引用完整性自检 ====================
//
// 记忆条目只存摘要，详情正文是知识库里的一篇文档（`detailKbId` + `detailDocId`）。
// 两侧各自都会「正常返回成功」，所以断链与孤儿都是**静默**的 —— 只能主动核验。
// 下面三个类型与 Rust `agent::memory::integrity` 同形（camelCase）。

/** 孤儿正文：在记忆详情库里、但没有任何记忆引用它 */
export interface MemoryOrphanDetail {
  docId: string
  docName: string
  /**
   * 名字带「记忆详情」前缀 = 确实像记忆正文（`清理孤儿正文` 会删）。
   * `false` 是用户自己导进这个库的文档：同样没被引用，但不是记忆的残留，只能人工判断。
   */
  looksLikeDetail: boolean
}

/** 断链：记忆的详情链接指向一个读不到的文档 */
export interface MemoryDanglingLink {
  memoryId: string
  /** 记忆摘要（界面要能让用户认出是哪条） */
  summary: string
  kbId: string
  docId: string
  /** `doc-missing`（库还在，文档没了）/ `kb-mismatch`（指向别的知识库，或那个库已不在） */
  reason: string
  /** 该条目是否已停用（停用的仍能被 `memory_recall` 读到，所以同样算断链） */
  disabled: boolean
}

/** 自检报告（`cmd_memory_integrity_check` / `_purge` 的返回） */
export interface MemoryIntegrityReport {
  /** 当前认定的「记忆详情」知识库 id（找不到就是 `null`） */
  kbId?: string | null
  /** RAG 是否可用：`false` = 本次没法核验知识库侧，报告**不代表**干净 */
  kbAvailable: boolean
  checkedMemories: number
  checkedDocs: number
  orphans: MemoryOrphanDetail[]
  dangling: MemoryDanglingLink[]
}

/** 报告是否真的干净（与 Rust `MemoryIntegrityReport::is_clean` 同口径：没核验过不算干净） */
export function isIntegrityClean(report: MemoryIntegrityReport): boolean {
  return (
    report.kbAvailable &&
    report.orphans.length === 0 &&
    report.dangling.length === 0
  )
}

/** 可以放心清理的孤儿篇数（名字带「记忆详情」前缀的那些） */
export function deletableOrphanCount(report: MemoryIntegrityReport): number {
  return report.orphans.filter((o) => o.looksLikeDetail).length
}

// ==================== 再蒸馏（记忆整理） ====================
//
// 同一件事的多条记忆会被合并成一条，旧条目归档（停用 + `supersededBy`）；归档正文里
// 保留合并前的原文，所以「合并」不是不可逆的删除。
// 自动触发阈值与批次上限下面这几个常量是**镜像**（面板文案要用，不值得为两句话走 IPC）。
// ⚠️ 改值必须同步 `agent/memory/redistill/mod.rs` 同名常量。

/** 攒够这么多条 AI 写下的记忆才会自动整理 */
export const MEMORY_REDISTILL_TRIGGER_COUNT = 100

/** 同一作用域内至少这么多条才值得合并（少于它调模型只是白花钱） */
export const MEMORY_REDISTILL_MIN_GROUP_ITEMS = 5

/** 一轮最多整理几个批次（每批一次模型调用）。与 Rust 同名常量同步（3 → 6：一批受归档预算限制只有 4–8 条） */
export const MEMORY_REDISTILL_MAX_BATCHES_PER_RUN = 6

/** 报告级状态（`RedistillReport.status`，与 Rust `REPORT_*` 同值） */
export type MemoryRedistillStatus =
  | 'ok'
  | 'disabled'
  | 'unavailable'
  | 'no-model'
  | 'nothing'

/** 批次级状态（`BatchReport.status`，与 Rust `MEMORY_REDISTILL_*` 同值） */
export type MemoryRedistillBatchStatus = 'done' | 'partial' | 'skipped' | 'failed'

/** 一批的结果（与 Rust `BatchReport` 同形） */
export interface MemoryRedistillBatch {
  fingerprint: string
  /** 作用域：空串 = 跨项目通用的那批 */
  scope: string
  status: MemoryRedistillBatchStatus | string
  itemsIn: number
  itemsOut: number
  /** 写进归档的合并说明条数 */
  details: number
  /** 模型给的结果与来源对不上的条数 */
  drifted: number
  /** 没能写进归档（因此没敢停用来源）的条数 */
  unarchived: number
  model?: string | null
  /** 跳过原因（`no-gain` / `no-rag` / `archive-too-long` / `too-few-items` / `already-done`） */
  reason?: string | null
  /** 失败原因 / 降级说明（不含记忆正文） */
  error?: string | null
}

/**
 * 一条整理流水（与 Rust `MemoryRedistillRun` 同形；面板只读最近一条，用来回答
 * 「上次自动整理为什么什么都没做」）。
 *
 * ⚠️ `fingerprint` 的两族特殊值：`gate:<reason>` = **闸门级跳过**（这一轮什么都没跑，
 * 没有批次指纹可写）；`purge` = 只清理归档那一行。
 */
export interface MemoryRedistillRun {
  fingerprint: string
  /** `running` | `done` | `partial` | `skipped` | `failed` */
  status: string
  itemsIn: number
  itemsOut: number
  purged: number
  purgedFailed: number
  /** 被护栏 ④ **保留**的条数（指向的新条目已不存在）：代码不会再动它们，只能人工处理 */
  purgedRetained: number
  attempts: number
  model?: string | null
  /** 跳过原因（机器标识）/ 闸门跳过的一句话说明（不含记忆正文） */
  error?: string | null
  startedAt: number
  finishedAt?: number | null
}

/** 一轮整理的结果（`cmd_memory_redistill` 的返回，与 Rust `RedistillReport` 同形） */
export interface MemoryRedistillReport {
  status: MemoryRedistillStatus | string
  /** `full`（清理 + 合并）/ `purge`（只清理归档） */
  task: string
  /** 删掉的超期归档条数 */
  purged: number
  /** 删除失败的归档条数 */
  purgedFailed: number
  /**
   * 被护栏 ④ **保留**的条数（它们指向的新条目已不存在 / 没有归档详情）。
   *
   * 既没删掉也不会再被自动删（代码不再动它们）—— 必须上报，否则面板只能报一句
   * 「没有需要清理的超期归档」，而真相是「有 N 条得人工处理」。
   */
  purgedRetained: number
  batches: MemoryRedistillBatch[]
  itemsIn: number
  itemsOut: number
  /** 实际发生的模型调用次数（= 花了几次钱） */
  calls: number
}

// ==================== 导出（P3） ====================

/** 导出信封的格式标识（与 Rust `MEMORY_EXPORT_FORMAT` 同值） */
export const MEMORY_EXPORT_FORMAT = 'virlen.memory'

/** 导出格式版本（与 Rust `MEMORY_EXPORT_SCHEMA_VERSION` 同值；改语义才 +1） */
export const MEMORY_EXPORT_SCHEMA_VERSION = 1

/**
 * 导出信封（与 Rust `MemoryExport` 同形）。⚠️ 不含详情正文（正文在知识库），
 * 要连正文备份请用知识库页的导出 zip。
 */
export interface MemoryExportFile {
  format: string
  schemaVersion: number
  /** 导出时刻（毫秒） */
  exportedAt: number
  count: number
  memories: MemoryRecord[]
}
