/**
 * 工具定义来源适配器（infrastructure）—— 实现 domain 的 `ToolDefinitionsLoader`
 *
 * 两条路径读的是**同一份物理文件** `src-tauri/src/agent/tool_defs/definitions.json`：
 *
 * | 环境 | 取值方式 | 说明 |
 * |---|---|---|
 * | Tauri 运行时 | `cmd_list_tool_definitions` | Rust 按当前平台返回；权威且只有一份 |
 * | 浏览器 dev / vitest | 动态 `import(...json?raw)` | 同一份文件，按平台快照选变体 |
 *
 * Rust 命令失败时**降级到内嵌契约**并打印警告（版本错配时不至于整个聊天不可用）。
 * 因为两条路径同源，这里不需要任何「差异检查」逻辑。
 */
import { invoke } from '@tauri-apps/api/core'
import type { ResolvedToolDefinition } from '@/domain/tools/types'
import {
  definitionsForPlatform,
  isUsableDefinitionsFile,
  type ToolDefinitionsFile,
} from '@/domain/tools/definitions'
import { platformSnapshot } from './execute/common'

/** 是否在 Tauri 环境（与 `services/rust-engine.ts::isTauriAvailable` 同一判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 读取内嵌的权威源文件（浏览器 / 测试路径）。
 *
 * ⚠️ 用**动态** import：Tauri 构建里这条分支不会执行，JSON 会被单独打成按需 chunk，
 * 不会把 100+ KB 的契约塞进主包。
 */
export async function loadDefinitionsFile(): Promise<ToolDefinitionsFile> {
  // ⚠️ 动态 import 必须让 Vite 处理 `?raw`（不能加 @vite-ignore，否则运行时会拿不到内容）
  const raw = (
    await import('../../../src-tauri/src/agent/tool_defs/definitions.json?raw')
  ).default
  return JSON.parse(raw) as ToolDefinitionsFile
}

/** 默认加载器：Tauri 优先命令，失败/非 Tauri 环境走内嵌契约 */
export async function loadToolDefinitions(): Promise<ResolvedToolDefinition[]> {
  if (isTauriEnv()) {
    try {
      return await invoke<ResolvedToolDefinition[]>('cmd_list_tool_definitions')
    } catch (e: any) {
      console.warn(
        `[tool-defs] cmd_list_tool_definitions 失败，降级到内嵌契约：${e?.message || String(e)}`,
      )
    }
  }
  const file = await loadDefinitionsFile()
  if (!isUsableDefinitionsFile(file)) {
    console.warn('[tool-defs] 内嵌契约不可用（无任何平台变体）')
    return []
  }
  return definitionsForPlatform(file, platformSnapshot())
}
