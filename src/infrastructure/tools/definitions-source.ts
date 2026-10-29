/**
 * 工具定义来源适配器（infrastructure）—— 实现 domain 的 ToolDefinitionsLoader。
 *
 * 两条路径读**同一份物理文件** src-tauri/virlen-core/src/agent/tool_defs/definitions.json：
 * Tauri 运行时走 cmd_list_tool_definitions（Rust 按当前平台返回，权威且只有一份）；浏览器 dev / vitest 走
 * 动态 import(...json?raw)（同一份，按平台快照选变体）。Rust 命令失败时降级到内嵌契约并告警
 *（版本错配时不至于整个聊天不可用）。因两路径同源，无需差异检查。
 *
 * ⚠️ MCP 工具**不在契约里**（运行期动态定义，见 `docs/mcp-plan.md`）：它由 Rust 单独生成，
 * 这里只往后拼一段，且失败时降级为空（服务器挂了不能让聊天不可用）。顺序固定为
 * 「内置（契约顺序）在前，MCP 按公开名排序在后」—— 提示词前缀稳定，KV cache 不抖。
 *
 * ⚠️ MCP 名字里已经没有服务器名（`public_tool_name(raw)`）：归属由 Rust 随定义一起下发
 *（`mcpServer` / `rawName`），这里顺手写进名称目录，供卡片标题、编辑器分组、旧数据展示查。
 */
import { invoke } from '@tauri-apps/api/core'
import type { ResolvedToolDefinition } from '@/domain/tools/types'
import {
  definitionsForPlatform,
  isUsableDefinitionsFile,
  type ToolDefinitionsFile,
} from '@/domain/tools/definitions'
import { platformSnapshot } from './execute/common'
import { setMcpToolCatalog } from '@/domain/mcp/naming'

/** 是否在 Tauri 环境（与 `services/rust-engine.ts::isTauriAvailable` 同一判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** `cmd_mcp_tool_definitions` 的一行（Rust `McpToolDefinitionOut`：定义 + 归属） */
interface McpToolDefinitionRow extends ResolvedToolDefinition {
  mcpServer: string
  rawName: string
}

/**
 * 读取内嵌的权威源文件（浏览器 / 测试路径）。用动态 import：Tauri 构建里这条分支不执行，JSON 会被单独打成
 * 按需 chunk，不会把 100+ KB 的契约塞进主包。
 */
export async function loadDefinitionsFile(): Promise<ToolDefinitionsFile> {
  // 动态 import 必须让 Vite 处理 `?raw`（不能加 @vite-ignore，否则运行时拿不到内容）
  const raw = (
    await import('../../../src-tauri/virlen-core/src/agent/tool_defs/definitions.json?raw')
  ).default
  return JSON.parse(raw) as ToolDefinitionsFile
}

/** 默认加载器：Tauri 优先命令，失败/非 Tauri 环境走内嵌契约；最后拼接 MCP 工具 */
export async function loadToolDefinitions(): Promise<ResolvedToolDefinition[]> {
  const builtin = await loadBuiltinToolDefinitions()
  const mcp = await loadMcpToolDefinitions()
  return [...builtin, ...mcp]
}

/** 内置 39 个工具（契约 ∩ 平台） */
async function loadBuiltinToolDefinitions(): Promise<ResolvedToolDefinition[]> {
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

/**
 * MCP 工具定义（Rust 当前快照）。
 *
 * ⚠️ 失败一律降级为空数组：MCP 是**增强能力**，一台服务器连不上不能让整个聊天不可用。
 * 不在这里排序 —— Rust 已按公开名排好（`McpManager::republish`）。
 *
 * `mcpServer` / `rawName` 是 Rust 随定义一起下发的归属信息（名字里已经没有服务器名了）：
 * 编辑器按服务器分组、说明书注入按服务器折算、卡片标题显示原始名都要它。
 * 名称目录**只在成功时**替换：拉取失败时保留上一份，历史会话的卡片还能认出服务器。
 */
async function loadMcpToolDefinitions(): Promise<ResolvedToolDefinition[]> {
  if (!isTauriEnv()) return []
  try {
    const rows = await invoke<McpToolDefinitionRow[]>('cmd_mcp_tool_definitions')
    setMcpToolCatalog(
      rows.map((row) => ({ name: row.name, server: row.mcpServer, raw: row.rawName })),
    )
    return rows.map(({ mcpServer, rawName: _rawName, ...def }) => ({
      ...def,
      origin: 'mcp' as const,
      mcpServer,
    }))
  } catch (e: any) {
    console.warn(
      `[tool-defs] cmd_mcp_tool_definitions 失败，MCP 工具暂不可见：${e?.message || String(e)}`,
    )
    return []
  }
}
