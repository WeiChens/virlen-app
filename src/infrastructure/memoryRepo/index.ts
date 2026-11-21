/**
 * 长期记忆的持久化入口；权威实现在 Rust（`session_db/memory.rs` + `agent/memory/`），
 * 本文件只调命令 + 按环境降级 + 把失败变成可解释的空结果（记忆是增强，读不到不该阻塞建会话）。
 */
import { invoke } from '@tauri-apps/api/core'
import {
  MEMORY_PROMPT_MAX_CHARS,
  type MemoryIntegrityReport,
  type MemoryPromptSection,
  type MemoryRecord,
  type MemoryRedistillReport,
  type MemoryRedistillRun,
} from '@/domain/memory'

/** Tauri 环境判定（与 `services/rust-engine.ts::isTauriAvailable` 同一口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const EMPTY_SECTION: MemoryPromptSection = {
  text: '',
  ids: [],
  droppedNormal: 0,
  droppedPermanent: 0,
  chars: 0,
  budget: MEMORY_PROMPT_MAX_CHARS,
}

/**
 * 取建会话用的注入段。失败 / 非 Tauri → 空段（不注入），不抛错。
 * `workspace`：生效工作目录（会话指定 > Agent 默认），Rust 据此筛掉别的项目的项目记忆；
 * `forPreview`：埋点据此区分「真实建会话的截断告警」与「用户在看面板」（否则每次开面板都抬高告警计数）。
 */
export async function loadMemorySection(
  forPreview = false,
  workspace?: string | null,
): Promise<MemoryPromptSection> {
  if (!isTauri()) return EMPTY_SECTION
  try {
    const section = await invoke<MemoryPromptSection>('cmd_memory_prompt_section', {
      forPreview,
      workspace: workspace ?? null,
    })
    return { ...EMPTY_SECTION, ...(section ?? {}) }
  } catch (e: any) {
    console.warn(`[memory] 读取记忆注入段失败，本次不注入：${e?.message || String(e)}`)
    return EMPTY_SECTION
  }
}

/** 列出记忆（设置页「记忆列表」弹窗的数据源）。失败 → 空列表 + 控制台告警 */
export async function listMemories(includeDisabled = true): Promise<MemoryRecord[]> {
  if (!isTauri()) return []
  try {
    return (await invoke<MemoryRecord[]>('cmd_memory_list', { includeDisabled })) ?? []
  } catch (e: any) {
    console.warn(`[memory] 读取记忆列表失败：${e?.message || String(e)}`)
    return []
  }
}

/** 新增 / 编辑一条记忆（正文长度由 Rust 侧按硬上限钳制） */
export async function upsertMemory(record: MemoryRecord): Promise<void> {
  if (!isTauri()) return
  await invoke('cmd_memory_upsert', { record })
}

/** 删除一条记忆；返回是否真的删到 */
export async function deleteMemory(id: string): Promise<boolean> {
  if (!isTauri()) return false
  return await invoke<boolean>('cmd_memory_delete', { id })
}

/** 切换级别（普通 ↔ 永久） */
export async function setMemoryLevel(id: string, level: string): Promise<boolean> {
  if (!isTauri()) return false
  return await invoke<boolean>('cmd_memory_set_level', { id, level })
}

/** 单条启用 / 禁用 */
export async function setMemoryDisabled(id: string, disabled: boolean): Promise<boolean> {
  if (!isTauri()) return false
  return await invoke<boolean>('cmd_memory_set_disabled', { id, disabled })
}

/**
 * 记录「这些记忆被注入了」（`hits += 1` / `last_used_at`）。调用方**不能 await**：
 * 统计失败不该拖着建会话。
 */
export function touchMemories(ids: string[]): void {
  if (!isTauri() || ids.length === 0) return
  invoke('cmd_memory_touch', { ids }).catch((e) => {
    console.warn(`[memory] 记录记忆使用失败：${e?.message || String(e)}`)
  })
}

/**
 * 导出全部记忆为 JSON 文本。只取文本不写文件（路径由保存对话框定）；失败 / 非 Tauri → `null`。
 */
export async function exportMemories(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    return (await invoke<string>('cmd_memory_export')) ?? null
  } catch (e: any) {
    console.warn(`[memory] 导出记忆失败：${e?.message || String(e)}`)
    return null
  }
}

/**
 * 核验「记忆 → 详情正文」的引用完整性（**只读**，不建库不删东西）。
 *
 * 失败 / 非 Tauri → `null`：面板据此说「没查成」，不要把「没检查」说成「干净」。
 */
export async function checkMemoryIntegrity(): Promise<MemoryIntegrityReport | null> {
  if (!isTauri()) return null
  try {
    return (await invoke<MemoryIntegrityReport>('cmd_memory_integrity_check')) ?? null
  } catch (e: any) {
    console.warn(`[memory] 记忆详情自检失败：${e?.message || String(e)}`)
    return null
  }
}

/**
 * 清掉孤儿正文（只删名字带「记忆详情」前缀的那些），返回**清理后**的报告。
 *
 * 后端在同一个命令里「清 → 重新核验」，所以返回的 `orphans` 是删失败后剩下的那几篇。
 */
export async function purgeMemoryOrphans(): Promise<MemoryIntegrityReport | null> {
  if (!isTauri()) return null
  try {
    return (await invoke<MemoryIntegrityReport>('cmd_memory_integrity_purge')) ?? null
  } catch (e: any) {
    console.warn(`[memory] 清理孤儿正文失败：${e?.message || String(e)}`)
    return null
  }
}

/**
 * 手动跑一轮记忆整理（再蒸馏）。`force` 默认 `true`：用户点按钮就是显式意图，
 * 不该被「30 分钟冷却 / 这批处理过」挡住而回一句「没有需要整理的东西」。
 *
 * ⚠️ 这里**不吞错**（与上面的读接口相反）：手动动作失败必须把原因说出来
 * （典型是「后台整理正在进行中」）—— 吞成 `null` 用户只能看到一句「失败」。
 */
export async function runMemoryRedistill(
  options: { task?: 'full' | 'purge'; force?: boolean } = {},
): Promise<MemoryRedistillReport | null> {
  if (!isTauri()) return null
  return await invoke<MemoryRedistillReport>('cmd_memory_redistill', {
    task: options.task ?? 'full',
    force: options.force ?? true,
  })
}

/**
 * 最近的整理流水（含闸门级跳过 `gate:*` 与清理行 `purge`），按时间倒序。
 *
 * 读不到 → `[]`（与其它读接口同口径）：它只用来在面板上多一行说明，
 * 没必要因为一行说明挂了整个设置页。
 */
export async function listMemoryRedistillRuns(limit = 5): Promise<MemoryRedistillRun[]> {
  if (!isTauri()) return []
  try {
    return (await invoke<MemoryRedistillRun[]>('cmd_memory_redistill_runs', { limit })) ?? []
  } catch (e: any) {
    console.warn(`[memory] 读取整理流水失败：${e?.message || String(e)}`)
    return []
  }
}

// 三个 `memory_*` 工具的 GUI 入口：语义全在 Rust（`agent::memory::tools`），这里只转交结果，
// 使回退路径执行器与 Rust 引擎下模型看到的行为逐字一致。

/** 工具 / 命令共用的返回形状（与 Rust `MemoryToolOutput` 同构） */
export interface MemoryToolOutput {
  /** 给模型看的英文文本 */
  content: string
  /** 给界面看的结构化字段 */
  uiData: Record<string, any>
}

/** 无后端时的统一回话（与 Rust `MEMORY_UNAVAILABLE` 逐字一致） */
const UNAVAILABLE: MemoryToolOutput = {
  content:
    'Long-term memory is unavailable in this environment (local storage is not accessible).',
  uiData: { available: false },
}

/**
 * `memory_search`：关键词检索。`workspace` 与注入同一套项目作用域（`uiData.hiddenByScope` 说明藏了几条）。
 */
export async function searchMemories(
  query: string,
  level?: string,
  kind?: string,
  limit?: number,
  workspace?: string,
): Promise<MemoryToolOutput> {
  if (!isTauri()) return UNAVAILABLE
  try {
    return await invoke<MemoryToolOutput>('cmd_memory_search', {
      query,
      level: level ?? null,
      kind: kind ?? null,
      limit: limit ?? null,
      workspace: workspace ?? null,
    })
  } catch (e: any) {
    return { content: `Error searching memories: ${e?.message || String(e)}`, uiData: { mode: 'error' } }
  }
}

/** `memory_recall`：按 id 取一条记忆的详情正文 */
export async function recallMemory(memoryId: string): Promise<MemoryToolOutput> {
  if (!isTauri()) return UNAVAILABLE
  try {
    return await invoke<MemoryToolOutput>('cmd_memory_recall', { memoryId })
  } catch (e: any) {
    return { content: `Error reading memory detail: ${e?.message || String(e)}`, uiData: { mode: 'error' } }
  }
}

/**
 * `memory_write`：写入一条记忆（`detail` 非空则详情落专用知识库）。
 * `workspace`：这条记忆的**默认**作用域（`projectPath` 不传时用它；分类 / 级别不改变这条规则）；
 * `projectPath`：显式指定（`"global"` = 跨项目通用）——与 Rust 原生工具同口径。
 */
export async function writeMemory(params: {
  summary: string
  kind: string
  level?: string
  detail?: string
  /** 来源会话（记进 `source_session_id`，便于溯源） */
  sessionId?: string
  /** 会话工作目录（没显式给 `projectPath` 时的默认作用域） */
  workspace?: string
  /** 显式作用域：`"global"` / `"none"` / 空串 = 跨项目通用；其他 = 该目录 */
  projectPath?: string
}): Promise<MemoryToolOutput> {
  if (!isTauri()) return UNAVAILABLE
  try {
    return await invoke<MemoryToolOutput>('cmd_memory_write', {
      summary: params.summary,
      kind: params.kind,
      level: params.level ?? null,
      detail: params.detail ?? null,
      sessionId: params.sessionId ?? null,
      workspace: params.workspace ?? null,
      projectPath: params.projectPath ?? null,
    })
  } catch (e: any) {
    return { content: `Error saving memory: ${e?.message || String(e)}`, uiData: { mode: 'error' } }
  }
}
