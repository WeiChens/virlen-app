/**
 * Rust 引擎适配器 — 实现与 TS AgentEngine 相同的 AgentEnginePort 接口
 *
 * 平滑过渡的关键：
 * - chat-service 无感知切换（getEngine() 按 settings.useRustEngine 选择）
 * - 事件契约与 TS 引擎完全一致（agent:event → onEvent）
 * - 工具执行 / 用户交互 / Gemini Provider 通过双向桥回 JS
 * - 原生 OpenAI / Anthropic 由 Rust 直接 HTTP 调用
 *
 * 桥协议（与 src-tauri/virlen-core/src/agent/bridge.rs 对应）：
 * - Rust → JS: agent:tool-request / agent:user-interaction-request / agent:provider-request
 * - JS → Rust: agent_tool_response / agent_user_interaction_response /
 *              agent_provider_stream_event / agent_provider_stream_done
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEnginePort } from '@/domain/ports'
import type { SendMessageOptions } from '@/domain/engine'
import type { CompressMode } from '@/domain/engine'
import type { RunSnapshot } from '@/domain/engine/types'
import { toolRegistry } from '@/domain/tools'
import { ToolError, UserInteractionRequired } from '@/domain/tools/types'
import type { ToolDefinition } from '@/domain/tools/types'
import { createProviderInstance } from '@/infrastructure/provider'
import { securityRepo } from '@/infrastructure/securityRepo'
import { securityService } from '@/services/security-service'
import { getSkillsDirPath } from '@/skill/skillStore'
import { settingsState } from '@/ui/store'
import { platformSnapshot } from '@/infrastructure/tools/execute/common'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import { trackError, getSessionTrace } from '@/utils/telemetry'
import { sanitizeLoneSurrogates } from '@/utils/text'
import type { Message, Session } from '@/types'

/** 会话级用户交互处理器（chat-service 注册，桥接层使用） */
type InteractionHandler = (
  type: string,
  data: Record<string, any>,
) => Promise<any>

/** 轮次边界处理器（chat-service 注册）—— 返回要注入下一次 LLM 请求的消息 */
type RoundBoundaryHandler = (sessionId: string) => Message[]

const sessionHandlers = new Map<string, InteractionHandler>()
let roundBoundaryHandler: RoundBoundaryHandler | null = null

/**
 * 注册轮次边界处理器。
 *
 * ⚠️ 用注册而不是直接 import `services/todo-service`：本模块已被 todo-service 引用
 * （`isRustEngineEnabled`），直接反向 import 会形成循环依赖。
 */
export function setRoundBoundaryHandler(
  handler: RoundBoundaryHandler | null,
): void {
  roundBoundaryHandler = handler
}

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

/**
 * 当前命令的实时输出是否来自 PTY（伪控制台）。
 *
 * 后端在 Windows 上已把 `execute_command` 的 stdio 换成 ConPTY（docs/pty-research.md §8 Step 1），
 * 输出是带光标控制的 VT 流，必须交给 xterm；其他平台仍是匿名管道，继续走 `<pre>`。
 *
 * 这里只能做到「运行中」的预判（平台），完成态以后端权威字段 `uiData.pty` 为准。
 * 若伪控制台创建失败，后端会降级回管道并下发 `pty: false`，UI 会在结束瞬间切回 `<pre>`。
 */
function ptyLiveEnabled(): boolean {
  return platformSnapshot() === 'windows'
}

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
    // Rust 在「工具回复后、下一次 LLM 请求前」回问：有没有要注入本次请求的消息
    // （AI 回复期间用户已应用的任务清单变更）
    await listen('agent:round-boundary', (e) => {
      handleRoundBoundary(e.payload as any).catch(() => {})
    })
    await listen('agent:provider-request', (e) => {
      handleProviderRequest(e.payload as any).catch(() => {})
    })
    // Rust 原生 execute_command 的实时输出推送（对齐 JS ctx.write → toolOutputStore）
    await listen('agent:tool-output', (e) => {
      const payload = e.payload as {
        sessionId: string
        toolCallId: string
        stream: 'stdout' | 'stderr'
        chunk: string
      }
      if (!payload?.toolCallId) return
      const chunk =
        payload.stream === 'stderr' ? `[stderr] ${payload.chunk}` : payload.chunk

      // Rust 引擎下前端没有走 JS executor，不会 register entry；
      // 首次收到输出时注册带 kill 回调的 entry（对齐 JS 端 toolOutputStore.register）
      if (!toolOutputStore.get(payload.toolCallId)) {
        const toolCallId = payload.toolCallId
        toolOutputStore.register(toolCallId, {
          toolName: 'execute_command',
          output: '',
          pty: ptyLiveEnabled(),
          kill: () => {
            invoke('agent_kill_command', { toolCallId }).catch(() => {})
          },
        })
      }
      toolOutputStore.append(payload.toolCallId, chunk)
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
      // 支持 execute_command 回退到 JS 桥执行时也能推送实时输出
      write: (chunk: string) => {
        toolOutputStore.append(toolCallId, chunk)
      },
      skills,
    })
    await invoke('agent_tool_response', {
      requestId,
      payload: serializeToolResult(result),
    })
  } catch (e: any) {
    trackError('error.bridge', e, {
      props: {
        direction: 'js2rust',
        kind: 'tool-request',
        tool_name: toolName,
        request_id: requestId,
      },
    })
    await invoke('agent_tool_response', {
      requestId,
      payload: {
        __kind: 'error',
        message: e?.message || String(e),
        // 失败也把结构化 uiData 带回 Rust（D2 失败侧；L6）——
        // 没有它，中文界面下只能把模型侧英文错误文本直接贴给用户。
        uiData: e instanceof ToolError ? e.uiData : undefined,
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
    return {
      __kind: 'error',
      message: result.message,
      uiData: result instanceof ToolError ? result.uiData : undefined,
    }
  }
  if (result && typeof result === 'object' && 'content' in result) {
    return { __kind: 'value', value: result.content, uiData: result.uiData }
  }
  return { __kind: 'value', value: String(result) }
}

/**
 * 轮次边界回执：Rust 在「工具回复后、下一次 LLM 请求前」回问有没有要注入的消息。
 *
 * 无论成败都立即回执（失败回空数组），让 Rust 不再等待 —— 超时兜底在 Rust 侧。
 */
async function handleRoundBoundary(payload: {
  requestId: string
  sessionId: string
}): Promise<void> {
  const { requestId, sessionId } = payload
  let messages: Message[] = []
  try {
    messages = roundBoundaryHandler ? roundBoundaryHandler(sessionId) : []
  } catch (e: any) {
    trackError('error.bridge', e, {
      props: {
        direction: 'js2rust',
        kind: 'round-boundary',
        request_id: requestId,
      },
    })
  }
  await invoke('agent_round_boundary_response', {
    requestId,
    // 孤立代理（被截断的半个 emoji）经 JSON.stringify 会变成 `\ud83d`，
    // 而 Rust 侧 serde_json 要求代理对成对 → 整个 invoke 直接失败（然后走 5s 超时）。
    // 注入内容含用户手写的任务正文，必须与发送消息同一条防线。
    payload: { messages: sanitizeLoneSurrogates(messages) },
  }).catch(() => {})
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
    return {
      __kind: 'error',
      message: result.message,
      uiData: result instanceof ToolError ? result.uiData : undefined,
    }
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

/**
 * 解析工具定义（对齐 TS `#resolveToolDefs`）
 *
 * ⚠️ 异步：定义来自权威源（机制 C）——Tauri 下首次读取可能要走一次 IPC
 * `cmd_list_tool_definitions`；调用方必须 await。
 */
export async function resolveToolDefs(
  enableTools: boolean,
  session: Session,
): Promise<ToolDefinition[]> {
  if (!enableTools) return []
  const allToolDefs = await toolRegistry.listDefinitions()
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
      // 权限三态表（终端命令 / 脚本执行）——取代旧的单一 approvalMode
      permissions: settingsState.value.permissions,
      skipDirs,
      blacklist: config.blacklist ?? [],
      whitelist: config.whitelist ?? [],
      skillsDir,
      sandboxMode: settingsState.value.sandboxMode ?? 'on',
      // 「忽略沙盒命令」规则**全量**下发（与 permissions / blacklist 同一套做法）。
      // 判定完全在 Rust 侧：text / regex 原生求值，js 交内嵌 QuickJS（S7）——
      // 不再有 `sandbox_rule_check` 内部交互，也没有 IPC 往返。
      sandboxIgnoreRules: config.sandboxIgnoreRules ?? [],
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
          // Rust 原生 execute_command 执行完毕（tool_call 事件携带 result）时
          // 清理实时输出缓存，避免 RunningOutput 残留
          if (payload.event?.type === 'tool_call') {
            const data = payload.event.data ?? {}
            const id = data.id
            if (data.result != null) {
              if (id) toolOutputStore.flush(id)
              if (id) toolOutputStore.remove(id)
            } else if (
              id &&
              (data.name === 'execute_command' ||
                data.name === 'execute_script') &&
              !toolOutputStore.get(id)
            ) {
              // 工具刚宣布/即将执行：立即注册 kill 入口。
              // Rust 原生 execute_command / execute_script 若长时间无输出（如 sleep、慢启动），
              // 等第一条 agent:tool-output 才注册的话会一直没有「终止」按钮。
              const toolCallId = id
              toolOutputStore.register(toolCallId, {
                toolName: data.name,
                output: '',
                pty: ptyLiveEnabled(),
                kill: () => {
                  invoke('agent_kill_command', { toolCallId }).catch(() => {})
                },
              })
            }
          }
          onEvent?.(payload.event)
        }
      })
    } catch {
      // 非 Tauri 环境
    }

    try {
      await ensureBridgeStarted()
      // 兜底防线：孤立代理（被截断的半个 emoji）经 JSON.stringify 会变成 `\ud83d`，
      // 而 Rust 侧 serde_json 要求代理对成对 → 整次 invoke 直接失败（报错只有列号，
      // 形如 "unexpected end of hex escape at line 1 column N"，极难定位）。
      // 源头已统一改用 utils/text 的安全截断；这里再兜一层：
      // 未命中时零开销（只做一次线性扫描，不复制任何对象）。
      const safeSession = sanitizeLoneSurrogates(session)
      const safeMessages = sanitizeLoneSurrogates(messages)
      if (safeMessages !== messages || safeSession !== session) {
        console.warn(
          '[rust-engine] 消息/会话中含孤立代理（半个 emoji），已在 IPC 前清洗',
        )
      }
      await invoke('agent_send_message', {
        options: {
          session: safeSession,
          messages: safeMessages,
          provider: resolveProviderConnection(session),
          toolDefs: await resolveToolDefs(enableTools, session),
          enableTools,
          maxTokens,
          resumeFromSnapshot: resumeFromSnapshot ?? null,
          reasoningEffort: reasoningEffort ?? null,
          maxToolRounds,
          iterationGoal: iterationGoal ?? null,
          maxIterations,
          sessionId,
          security: await resolveSecurityConfig(session),
          traceId: getSessionTrace(sessionId) ?? null,
        },
      })
    } catch (e: any) {
      const msg = e?.message || String(e)
      // 用户取消是预期操作（Rust 侧已正常返回，此处兜底），不应弹 error-banner
      if (/cancelled/i.test(msg)) return
      trackError('error.rust.command', msg, {
        traceId: getSessionTrace(sessionId),
        props: {
          command_name: 'agent_send_message',
          args_keys: ['options'],
        },
      })
      onEvent?.({ type: 'error', error: msg })
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
    mode?: CompressMode,
  ): Promise<{ summary?: string; messages: Message[] }> {
    // 统一到 core：与 CLI 共用 `virlen_core::agent::compress`（命令 `cmd_compress_context`）。
    // - `raw` 纯本地渲染；`ai` 用原生 Provider（openai / anthropic）或桥接
    //   （gemini 经 `agent:provider-request`，与正常聊天同一条路）。
    // - **记账在后端完成**（与 CLI 同一入口 `agent::usage::record_usage`，kind = "compress"）；
    //   落库仍由 chat-service 负责（`cmd_replace_session_messages`），与压缩前后一致。
    const result = await invoke<{ summary: string; message: Message }>(
      'cmd_compress_context',
      {
        session: sanitizeLoneSurrogates(session),
        messages: sanitizeLoneSurrogates(allMessages),
        toolDefs: await resolveToolDefs(true, session),
        mode: mode ?? 'ai',
        provider: resolveProviderConnection(session),
      },
    )
    return {
      summary: result.summary,
      messages: [...allMessages, result.message],
    }
  },

  async generateTitle(
    session: Session,
    messages: Message[],
  ): Promise<string> {
    // 统一到 core：与 CLI 共用 `virlen_core::agent::title`（命令 `cmd_generate_title`）。
    // - 记账在后端完成（同一入口 `agent::usage::record_usage`，kind = "title"）；
    //   落库（写回会话标题）仍由 chat-service 负责（与压缩前后一致）。
    // - 与正常聊天同一条 provider 通道（openai/anthropic 原生、gemini 经双向桥）。
    const provider = resolveProviderConnection(session)
    if (!provider) {
      throw new Error('会话没有可用的 Provider，无法生成标题')
    }
    const result = await invoke<{ title: string }>('cmd_generate_title', {
      session: sanitizeLoneSurrogates(session),
      messages: sanitizeLoneSurrogates(messages),
      provider,
    })
    return result.title
  },
}
