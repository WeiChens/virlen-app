/**
 * 记忆领域常量（**前端只做镜像**，权威实现全在 Rust）。
 *
 * 为何保留一份：设置页要显示上限、面板要给出枚举下拉，从 Rust 现取一次 IPC 不划算。
 *
 * ⚠️ 与 Rust 一次改两边：`agent/memory/mod.rs`（各常量值）、`prompt.rs`（`memoryEnabled` /
 * `memoryNormalTopK` 键名）、`models.rs`（`memoryModel` 键名）。
 * ⚠️ `# Memory` 段由 Rust 经 `cmd_memory_prompt_section` 渲染下发，前端只负责插入。
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
 * 项目分类（只有它才允许带 `projectPath`），与 Rust `MEMORY_KIND_PROJECT` 同值。
 * 不变量：非 `project` 的记忆带路径会被服务端清掉（否则它只在某目录可见、用户别处找不到）。
 */
export const MEMORY_KIND_PROJECT = 'project'

/** 项目路径的长度上限（与 Rust `MEMORY_PROJECT_PATH_MAX_CHARS` 同值；超限服务端拒绝） */
export const MEMORY_PROJECT_PATH_MAX_CHARS = 500

/** `app_settings` 键名（与 Rust 侧同名同层，不建映射表） */
export const MEMORY_ENABLED_KEY = 'memoryEnabled'
export const MEMORY_NORMAL_TOP_K_KEY = 'memoryNormalTopK'
/**
 * 蒸馏模型首选（可选，置顶降级链）；空 = 按「压缩会话时用得最多的模型」自动选。
 * 与 Rust `MEMORY_MODEL_KEY` 同名同层；目前只能用 CLI
 * （`virlen-cli config set memoryModel '{"providerConfigId":"…","modelId":"…"}'`）设。
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
   * 项目路径（仅 `kind === 'project'` 有意义）：该记忆只在「会话工作目录 = 它或其子目录」时注入与召回；
   * `null` / 空 = 跨项目通用。
   * ⚠️ 匹配在 Rust（`agent::memory::scope`），前端只负责把工作目录传下去。
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
  /** 注入段的**真实字符数**（Rust 裁剪时顺带算出）：面板常驻行与「是否超预算」共用它，不会两处不一致。 */
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
 * 导出信封（与 Rust `MemoryExport` 同形）。⚠️ 不含详情正文（正文在知识库「记忆详情」里，
 * 要连正文一起备份用知识库页的导出 zip）。
 */
export interface MemoryExportFile {
  format: string
  schemaVersion: number
  /** 导出时刻（毫秒） */
  exportedAt: number
  count: number
  memories: MemoryRecord[]
}
