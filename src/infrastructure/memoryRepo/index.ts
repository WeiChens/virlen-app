/**
 * 长期记忆的持久化入口；权威实现在 Rust（`session_db/memory.rs` + `agent/memory/`），
 * 本文件只调命令 + 按环境降级 + 把失败变成可解释的空结果（记忆是增强，读不到不该阻塞建会话）。
 */
import { invoke } from '@tauri-apps/api/core'
import {
  MEMORY_PROMPT_MAX_CHARS,
  type MemoryPromptSection,
  type MemoryRecord,
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
 * `workspace`：`kind = 'project'` 时成为这条记忆的项目作用域（与 Rust 原生工具同口径，模型不必猜路径）。
 */
export async function writeMemory(params: {
  summary: string
  kind: string
  level?: string
  detail?: string
  /** 来源会话（记进 `source_session_id`，便于溯源） */
  sessionId?: string
  /** 会话工作目录（项目记忆的作用域） */
  workspace?: string
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
    })
  } catch (e: any) {
    return { content: `Error saving memory: ${e?.message || String(e)}`, uiData: { mode: 'error' } }
  }
}
