/**
 * Rust 引擎适配器 — 实现与 TS AgentEngine 相同的 AgentEnginePort 接口
 *
 * 平滑过渡的关键：
 * - chat-service 无感知切换（getEngine() 按 settings.useRustEngine 选择）
 * - 事件契约与 TS 引擎完全一致（agent:event → onEvent）
 * - 工具执行 / 用户交互 / Gemini Provider 通过双向桥回 JS
 * - 原生 OpenAI / Anthropic 由 Rust 直接 HTTP 调用
 *
 * 桥协议（与 src-tauri/src/agent/bridge.rs 对应）：
 * - Rust → JS: agent:tool-request / agent:user-interaction-request / agent:provider-request
 * - JS → Rust: agent_tool_response / agent_user_interaction_response /
 *              agent_provider_stream_event / agent_provider_stream_done
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEnginePort } from '@/domain/ports'
import type { SendMessageOptions } from '@/domain/engine'
import type { RunSnapshot } from '@/domain/engine/types'
import { agentEngine } from '@/domain'
import { toolRegistry } from '@/domain/tools'
import { UserInteractionRequired } from '@/domain/tools/types'
import type { ToolDefinition } from '@/domain/tools/types'
import { createProviderInstance } from '@/infrastructure/provider'
import { securityRepo } from '@/infrastructure/securityRepo'
import { securityService } from '@/services/security-service'
import { getSkillsDirPath } from '@/skill/skillStore'
import { settingsState } from '@/ui/store'
import type { Message, Session } from '@/types'

/** 会话级用户交互处理器（chat-service 注册，桥接层使用） */
type InteractionHandler = (
  type: string,
  data: Record<string, any>,
) => Promise<any>

const sessionHandlers = new Map<string, InteractionHandler>()

export function registerSessionToolHandler(
  sessionId: string,
  handler: InteractionHandler,
): void {
  sessionHandlers.set(sessionId, handler)
}
export function unregisterSessionToolHandler(sessionId: string): void {
  sessionHandlers.delete(sessionId)
}

let bridgeStarted = false
let bridgeStartPromise: Promise<void> | null = null

/** 确保双向桥监听器已安装（只安装一次） */
function ensureBridgeStarted(): Promise<void> {
  if (bridgeStarted) return Promise.resolve()
  if (bridgeStartPromise) return bridgeStartPromise
  bridgeStartPromise = (async () => {
    await listen('agent:tool-request', (e) => {
      handleToolRequest(e.payload as any).catch(() => {})
    })
    await listen('agent:user-interaction-request', (e) => {
      handleUserInteractionRequest(e.payload as any).catch(() => {})
    })
    await listen('agent:provider-request', (e) => {
      handleProviderRequest(e.payload as any).catch(() => {})
    })
    bridgeStarted = true
  })()
  return bridgeStartPromise
}

// ==================== 桥接处理 ====================

async function handleToolRequest(payload: {
  requestId: string
  sessionId: string
  toolCallId: string
  toolName: string
  args: Record<string, any>
  skills?: string[]
}): Promise<void> {
  const { requestId, sessionId, toolCallId, toolName, args, skills } = payload
  try {
    const tool = await toolRegistry.get(toolName)
    if (!tool) {
      await invoke('agent_tool_response', {
        requestId,
        payload: {
          __kind: 'error',
          message: `Tool "${toolName}" not found`,
        },
      })
      return
    }
    const result = await tool.executor(args, {
      sessionId,
      toolCallId,
      // 取消由 Rust 层控制（Rust 在步骤间检查取消）
      abortSignal: new AbortController().signal,
      write: () => {},
      skills,
    })
    await invoke('agent_tool_response', {
      requestId,
      payload: serializeToolResult(result),
    })
  } catch (e: any) {
    await invoke('agent_tool_response', {
      requestId,
      payload: {
        __kind: 'error',
        message: e?.message || String(e),
      },
    })
  }
}

function serializeToolResult(result: any): Record<string, any> {
  if (result instanceof UserInteractionRequired) {
    return {
      __kind: 'interaction',
      interactionType: result.interactionType,
      interactionData: result.interactionData,
    }
  }
  if (result instanceof Error) {
    return { __kind: 'error', message: result.message }
  }
  if (result && typeof result === 'object' && 'content' in result) {
    return { __kind: 'value', value: result.content, uiData: result.uiData }
  }
  return { __kind: 'value', value: String(result) }
}

async function handleUserInteractionRequest(payload: {
  requestId: string
  sessionId: string
  type: string
  data: Record<string, any>
}): Promise<void> {
  const { requestId, sessionId, type, data } = payload
  const handler = sessionHandlers.get(sessionId)
  if (!handler) {
    await invoke('agent_user_interaction_response', {
      requestId,
      payload: { __kind: 'cancelled' },
    })
    return
  }
  try {
    const result = await handler(type, data)
    await invoke('agent_user_interaction_response', {
      requestId,
      payload: serializeInteractionResult(result),
    })
  } catch (e: any) {
    if (e?.name === 'InteractionShelved') {
      await invoke('agent_user_interaction_response', {
        requestId,
        payload: { __kind: 'shelved' },
      })
    } else {
      await invoke('agent_user_interaction_response', {
        requestId,
        payload: { __kind: 'cancelled' },
      })
    }
  }
}

function serializeInteractionResult(result: any): Record<string, any> {
  if (result instanceof Error) {
    return { __kind: 'error', message: result.message }
  }
  if (result && typeof result === 'object' && 'content' in result) {
    return { __kind: 'value', value: result.content, uiData: result.uiData }
  }
  return { __kind: 'value', value: String(result) }
}

async function handleProviderRequest(payload: {
  requestId: string
  providerType: string
  providerId: string
  apiKey: string
  baseUrl: string
  request: any
  stream: boolean
}): Promise<void> {
  const { requestId, providerType, providerId, apiKey, baseUrl, request, stream } = payload
  try {
    const provider = createProviderInstance({
      id: providerId,
      name: providerId,
      type: providerType,
      apiKey,
      baseUrl,
    })
    if (!provider) {
      throw new Error('Provider 创建失败')
    }
    if (stream) {
      await provider.chatStream(request, (event) => {
        invoke('agent_provider_stream_event', { requestId, event }).catch(
          () => {},
        )
      })
      await invoke('agent_provider_stream_done', {
        requestId,
        result: null,
        error: null,
      })
    } else {
      const message = await provider.chat(request)
      await invoke('agent_provider_stream_done', {
        requestId,
        result: message,
        error: null,
      })
    }
  } catch (e: any) {
    await invoke('agent_provider_stream_done', {
      requestId,
      result: null,
      error: e?.message || String(e),
    })
  }
}

// ==================== Rust 引擎适配器 ====================

/** 是否在 Tauri 环境（不在则回退 TS 引擎） */
export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 是否启用 Rust 引擎 */
export function isRustEngineEnabled(): boolean {
  return settingsState.value.useRustEngine && isTauriAvailable()
}

/** 解析工具定义（对齐 TS #resolveToolDefs） */
export function resolveToolDefs(
  enableTools: boolean,
  session: Session,
): ToolDefinition[] {
  if (!enableTools) return []
  const allToolDefs = toolRegistry.listDefinitions()
  if (session.allowedTools === undefined) return allToolDefs
  if (session.allowedTools.length === 0) return []
  return allToolDefs.filter((t) => session.allowedTools!.includes(t.name))
}

/** 解析 Provider 连接信息（前端持有 apiKey/baseUrl，传给 Rust） */
export function resolveProviderConnection(session: Session) {
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  if (!providerCfg) return null
  return {
    providerType: providerCfg.type,
    providerId: providerCfg.id,
    apiKey: providerCfg.apiKey,
    baseUrl: providerCfg.baseUrl,
  }
}

/**
 * 解析原生工具所需的安全配置（Rust 侧 native_tools 使用）
 * 与 securityService.resolveSafePath / securityPort.isPathAllowed 对齐。
 * 解析失败时返回 null → Rust 侧自动回退到 JS 桥执行工具。
 */
export async function resolveSecurityConfig(
  session: Session,
): Promise<Record<string, any> | null> {
  try {
    const workspace = await securityService.getWorkspace(session.id)
    const approvalMode = await securityService.getCommandApprovalMode()
    const skipDirs = await securityService.getSkipEachDirs()
    const config = securityRepo.load()
    let skillsDir: string | null = null
    try {
      skillsDir = await getSkillsDirPath()
    } catch {
      // 非 Tauri 环境
    }
    return {
      workspace,
      approvalMode,
      skipDirs,
      blacklist: config.blacklist ?? [],
      whitelist: config.whitelist ?? [],
      skillsDir,
    }
  } catch {
    return null
  }
}

/** Rust 引擎 — 实现 AgentEnginePort 接口 */
export const rustEngine: AgentEnginePort = {
  async sendMessage(options: SendMessageOptions): Promise<void> {
    const {
      session,
      messages,
      onEvent,
      enableTools = true,
      onUserInteraction,
      resumeFromSnapshot,
      reasoningEffort,
      maxToolRounds = 30,
      iterationGoal,
      maxIterations = 5,
      maxTokens,
    } = options
    const sessionId = session.id

    // 注册用户交互处理器（供桥接层使用）
    if (onUserInteraction) {
      registerSessionToolHandler(sessionId, onUserInteraction)
    }

    // 监听 Rust 引擎事件
    let unlisten: UnlistenFn | null = null
    try {
      unlisten = await listen('agent:event', (e) => {
        const payload = e.payload as { sessionId: string; event: any }
        if (payload.sessionId === sessionId) {
          onEvent?.(payload.event)
        }
      })
    } catch {
      // 非 Tauri 环境
    }

    try {
      await ensureBridgeStarted()
      await invoke('agent_send_message', {
        options: {
          session,
          messages,
          provider: resolveProviderConnection(session),
          toolDefs: resolveToolDefs(enableTools, session),
          enableTools,
          maxTokens,
          resumeFromSnapshot: resumeFromSnapshot ?? null,
          reasoningEffort: reasoningEffort ?? null,
          maxToolRounds,
          iterationGoal: iterationGoal ?? null,
          maxIterations,
          sessionId,
          security: await resolveSecurityConfig(session),
        },
      })
    } catch (e: any) {
      onEvent?.({ type: 'error', error: e?.message || String(e) })
    } finally {
      unlisten?.()
      unregisterSessionToolHandler(sessionId)
    }
  },

  async getRunSnapshot(sessionId: string): Promise<RunSnapshot | null> {
    try {
      const snap = await invoke('agent_get_run_snapshot', { sessionId })
      return (snap as RunSnapshot) || null
    } catch {
      return null
    }
  },

  async clearRunSnapshot(sessionId: string): Promise<void> {
    try {
      await invoke('agent_clear_run_snapshot', { sessionId })
    } catch {
      // 忽略
    }
  },

  async cancel(sessionId: string): Promise<void> {
    try {
      await invoke('agent_cancel', { sessionId })
    } catch {
      // 忽略
    }
  },

  async compressContext(
    session: Session,
    allMessages: Message[],
  ): Promise<{ summary?: string; messages: Message[] }> {
    // 上下文压缩暂由 TS 引擎提供（非聊天循环核心）
    return agentEngine.compressContext(session, allMessages)
  },
}
