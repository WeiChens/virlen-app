/**
 * 记忆领域常量（**前端只做镜像**，权威实现全在 Rust）
 *
 * 为什么还要有一份：设置页要显示上限提示、面板要给出枚举下拉。它们都必须是**类型安全的中文枚举值**，
 * 从 Rust 现取一次 IPC 只为拿几个常量不划算。
 *
 * ⚠️ 与 Rust 侧必须一次改两边：
 * - `src-tauri/virlen-core/src/agent/memory/mod.rs`（`MEMORY_SUMMARY_HINT_CHARS` / `MEMORY_SUMMARY_MAX_CHARS`
 *   / `MEMORY_NORMAL_TOP_K_*` / `MEMORY_PROMPT_MAX_CHARS` / `MEMORY_DETAIL_MIN_CHARS`）
 * - `src-tauri/virlen-core/src/agent/memory/prompt.rs`（`memoryEnabled` / `memoryNormalTopK` 键名）
 * - `src-tauri/virlen-core/src/agent/memory/models.rs`（`memoryModel` 键名）
 *
 * ⚠️ **注入段的渲染与选取规则不在前端**：`# Memory` 段由 Rust 渲染好后经 `cmd_memory_prompt_section`
 * 下发，前端只把它插进系统提示词（选取规则再来一份 = 两侧静默分叉）。
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

/** 记忆分类（面板下拉；未知值由 Rust 侧收敛为 `fact`） */
export const MEMORY_KINDS = ['user', 'project', 'decision', 'fact'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * 项目分类（只有它才允许带 `projectPath`）—— 与 Rust `MEMORY_KIND_PROJECT` 同值。
 *
 * 不变量（两侧都守）：非 `project` 的记忆带上路径会被服务端清掉 —— 那种记忆会变成
 * 「只在某个目录下可见」，用户到别的项目里根本找不到它。
 */
export const MEMORY_KIND_PROJECT = 'project'

/** 项目路径的长度上限（与 Rust `MEMORY_PROJECT_PATH_MAX_CHARS` 同值；超限服务端拒绝） */
export const MEMORY_PROJECT_PATH_MAX_CHARS = 500

/** `app_settings` 键名（与 Rust 侧同名同层，不建映射表） */
export const MEMORY_ENABLED_KEY = 'memoryEnabled'
export const MEMORY_NORMAL_TOP_K_KEY = 'memoryNormalTopK'
/**
 * 蒸馏模型首选（可选；置顶降级链）。空 = 按「压缩会话时用得最多的模型」自动选。
 *
 * 与 Rust `agent::memory::models::MEMORY_MODEL_KEY` 同名同层；目前只能在 CLI
 * （`virlen-cli config set memoryModel '{"providerConfigId":"…","modelId":"…"}'`）里设。
 */
export const MEMORY_MODEL_KEY = 'memoryModel'

/** 详情正文的最小长度（低于它只存摘要）—— 与 Rust `MEMORY_DETAIL_MIN_CHARS` 同值 */
export const MEMORY_DETAIL_MIN_CHARS = 200

export const MEMORY_ORIGIN_DISTILL = 'distill'

/** 整理流水的状态（与 Rust `session_db::memory::MEMORY_RUN_*` 同名） */
export const MEMORY_RUN_STATUSES = ['running', 'done', 'skipped', 'partial', 'failed'] as const
export type MemoryRunStatus = (typeof MEMORY_RUN_STATUSES)[number]

/** 一天的整理流水（与 Rust `session_db::memory::MemoryRun` 同形） */
export interface MemoryRun {
  /** `YYYY-MM-DD`（本地日） */
  day: string
  status: MemoryRunStatus | string
  items: number
  details: number
  /** 被近重复合并掉、没有新增的条数（P3） */
  merged?: number
  sourceSessions: number
  /** 实际使用的模型（`providerConfigId/modelId`） */
  model?: string | null
  /** 失败 / 降级原因（给用户看；不含记忆正文） */
  error?: string | null
  attempts: number
  startedAt: number
  finishedAt?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
}

/** 一次整理的总体结果（`cmd_memory_consolidate` 的返回，与 Rust `ConsolidateReport` 同形） */
export interface ConsolidateReport {
  /** `ok` | `disabled` | `unavailable` | `no-model` | `nothing` */
  status: string
  days: Array<{
    day: string
    status: string
    items: number
    details: number
    /** 被近重复合并掉、没有新增的条数（P3） */
    merged?: number
    sourceSessions: number
    model?: string | null
    error?: string | null
  }>
  items: number
  details: number
  /** 本次被近重复合并掉的条数（P3） */
  merged?: number
  /** 实际发生的模型调用次数 */
  calls: number
}

/** 记忆条目（与 Rust `session_db::memory::MemoryRecord` 同形） */
export interface MemoryRecord {
  id: string
  level: MemoryLevel | string
  kind: MemoryKind | string
  summary: string
  /**
   * 项目路径（仅 `kind === 'project'` 才有意义）：该记忆只在「会话工作目录 = 它 或 它之下的子目录」
   * 时注入与召回；`null` / 空 = 不限定项目（跨项目通用）。
   *
   * ⚠️ 匹配在 Rust 侧（`agent::memory::scope`）：真实建会话时传会话工作目录，面板预览传设置里的
   * 默认工作目录 —— 前端不自己判路径，只负责把工作目录传下去。
   */
  projectPath?: string | null
  detailKbId?: string | null
  detailDocId?: string | null
  tags?: string[]
  sourceDay?: string
  sourceSessionId?: string | null
  /** `distill` | `model` | `user` */
  origin?: string
  hits?: number
  lastUsedAt?: number
  createdAt?: number
  updatedAt?: number
  disabled?: boolean
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
  /**
   * 注入段的**真实字符数**（由 Rust 在裁剪时顺带算出；不是前端数的）
   *
   * 面板常驻行显示它 —— 与「是否超预算」用的是同一个数，不会出现「面板显示 3000、实际 4200」。
   */
  chars: number
  /** 段字符预算（Rust 下发，前端不写死常量） */
  budget: number
}

// ==================== 导出（P3） ====================

/** 导出信封的格式标识（与 Rust `MEMORY_EXPORT_FORMAT` 同值） */
export const MEMORY_EXPORT_FORMAT = 'virlen.memory'

/** 导出格式版本（与 Rust `MEMORY_EXPORT_SCHEMA_VERSION` 同值；改语义才 +1） */
export const MEMORY_EXPORT_SCHEMA_VERSION = 1

/**
 * 导出信封（与 Rust `agent::memory::export::MemoryExport` 同形）
 *
 * ⚠️ 导出**不含详情正文**：正文在知识库「记忆详情」里，要连正文一起备份用知识库页的导出 zip。
 */
export interface MemoryExportFile {
  format: string
  schemaVersion: number
  /** 导出时刻（毫秒） */
  exportedAt: number
  count: number
  memories: MemoryRecord[]
}
