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

/** 记忆分类（面板下拉；未知值由 Rust 侧收敛为 `fact`） */
export const MEMORY_KINDS = ['user', 'project', 'decision', 'fact'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * 项目分类（只有它才允许带 `projectPath`），与 Rust `MEMORY_KIND_PROJECT` 同值。
 * 非 `project` 带路径会被服务端清掉。
 */
export const MEMORY_KIND_PROJECT = 'project'

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
   * 项目路径（仅 `project` 有意义）：只在「工作目录 = 它或子目录」时注入与召回；`null` = 跨项目通用。
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
