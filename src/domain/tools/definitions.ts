/**
 * 工具定义契约 — 权威源的形状与选取规则（纯逻辑，无任何 I/O）
 *
 * **权威源只有一份**：`src-tauri/src/agent/tool_defs/definitions.json`
 *   - Rust 侧：`agent::tool_defs`（`include_str!` + 懒解析）
 *   - 前端：Tauri 运行时走命令 `cmd_list_tool_definitions`；
 *     浏览器 dev / vitest 直读**同一份 JSON**（见 `infrastructure/tools/definitions-source.ts`）
 * 因为是同一个物理文件，所以不存在「快照与源码漂移」，也不需要 CI 差异检查。
 *
 * 本模块只回答两件事：这份文件的形状是什么、怎么按平台取。
 *
 * ⚠️ 契约里**不含 `label`**：`label` 是 UI 文案（走 i18n `t()`），属前端职责。
 *    若把它固定进契约，英文界面会退化成中文（Rust 不做翻译）。
 */
import type { ResolvedToolDefinition } from './types'

/** 契约文件版本（结构变更时递增，Rust 侧同名字段会校验） */
export const TOOL_DEFINITIONS_SCHEMA_VERSION = 1

/** 平台键：与 `std::env::consts::OS`、TS `platformSnapshot()` 同词表（无需映射表） */
export const PLATFORM_KEYS = ['windows', 'macos', 'linux'] as const
export type PlatformKey = (typeof PLATFORM_KEYS)[number]

/** 契约文件结构（= Rust `DefinitionsFile`） */
export interface ToolDefinitionsFile {
  schemaVersion: number
  note?: string
  /** 平台 → 该平台的工具定义；**数组顺序即契约顺序**（作提示词里工具的排列顺序） */
  variants: Record<string, ResolvedToolDefinition[]>
}

/**
 * 定义加载器（端口）：由 infrastructure 层提供实现 —
 * Tauri 走 Rust 命令，其它环境读内嵌的同一份 JSON。
 * 返回**已按当前平台选好**的定义列表，domain 不需要知道平台变体的存在。
 */
export type ToolDefinitionsLoader = () => Promise<ResolvedToolDefinition[]>

/** 取指定平台的定义；未知平台回退 `linux`（与 Rust `list_tool_definitions_for` 同语义） */
export function definitionsForPlatform(
  file: ToolDefinitionsFile,
  platform: string,
): ResolvedToolDefinition[] {
  const variants = file?.variants ?? {}
  const picked = variants[platform] ?? variants.linux ?? []
  // 防御性剔除 label：万一契约里带了 UI 文案，也不能让它在界面里顶掉 i18n 的结果
  return picked.map(({ label, ...rest }) => rest as ResolvedToolDefinition)
}

/** 契约文件是否可用的最小校验（启动自检用；不合法时调用方决定降级策略） */
export function isUsableDefinitionsFile(
  file: unknown,
): file is ToolDefinitionsFile {
  const f = file as ToolDefinitionsFile | null
  return (
    !!f &&
    typeof f === 'object' &&
    !!f.variants &&
    PLATFORM_KEYS.some((k) => Array.isArray(f.variants[k]) && f.variants[k].length > 0)
  )
}
