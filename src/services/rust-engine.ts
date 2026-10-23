/**
 * Rust 引擎适配器（实现 AgentEnginePort）。chat-service 无感知调用，事件契约与 agent:event 一致。
 * 工具执行 / 用户交互 / Gemini 走双向桥回 JS；原生 OpenAI / Anthropic 由 Rust 直调 HTTP。
 *
 * 桥协议：Rust → JS: agent:tool-request / user-interaction-request / provider-request；
 * JS → Rust: agent_tool_response / agent_user_interaction_response / provider_stream_*。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEnginePort } from '@/domain/ports'
import type { CompressMode, RunSnapshot, SendMessageOptions } from '@/domain/ports'
import { filterAllowedToolDefs, toolRegistry } from '@/domain/tools'
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

/** 会话级交互处理器（chat-service 注册） */
type InteractionHandler = (
  type: string,
  data: Record<string, any>,
) => Promise<any>

/** 轮次边界处理器：返回要注入下一次 LLM 请求的消息 */
type RoundBoundaryHandler = (sessionId: string) => Message[]

/**
 * 会话级交互处理器。值里带归属令牌：注销时必须回传，防止交错的 run 互删处理器。
 */
const sessionHandlers = new Map<
  string,
  { handler: InteractionHandler; token: object }
>()
let roundBoundaryHandler: RoundBoundaryHandler | null = null

/**
 * 注册轮次边界处理器（用注册而非 import：本模块已被 todo-service 引用，反向 import 会成环）。
 */
export function setRoundBoundaryHandler(
  handler: RoundBoundaryHandler | null,
): void {
  roundBoundaryHandler = handler
}

export function registerSessionToolHandler(
  sessionId: string,
  handler: InteractionHandler,
): object {
  const token = {}
  sessionHandlers.set(sessionId, { handler, token })
  return token
}
/**
 * 注销会话的交互处理器，归属令牌必须原样回传。
 * 不用令牌时交错的 run（重发 / 手机与桌面同时发 / 暂停恢复）会互相删表：
 * 先结束的把后一个的处理器删掉，用户没看到问题却收到「用户取消」。
 */
export function unregisterSessionToolHandler(
  sessionId: string,
  token?: object,
): void {
  const current = sessionHandlers.get(sessionId)
  if (token && current && current.token !== token) return
  sessionHandlers.delete(sessionId)
}

let bridgeStarted = false
let bridgeStartPromise: Promise<void> | null = null

/**
 * 当前命令的实时输出是否来自 PTY：Windows 后端已换 ConPTY，其余平台仍走管道。
 * 这里只做运行中预判，完成态以后端权威字段 uiData.pty 为准。
 */
function ptyLiveEnabled(): boolean {
  return platformSnapshot() === 'windows'
}

/**
 * 注册终止入口：先按 toolCallId 杀命令，杀不到（还在审批 / 沙盒准备）再退化为取消 run。
 * @returns true = 已请求杀进程；false = 不在运行中，已退化为取消本次运行
 */
function registerToolKill(
  toolCallId: string,
  toolName: string,
  sessionId: string,
): void {
  toolOutputStore.register(toolCallId, {
    toolName,
    output: '',
    pty: ptyLiveEnabled(),
    kill: async () => {
      let hit = false
      try {
        hit = await invoke<boolean>('agent_kill_command', { toolCallId })
      } catch {
        // IPC 异常也走兜底：用户已经点了终止，不能让这一下白点
      }
      if (!hit && sessionId) {
        await invoke('agent_cancel', { sessionId }).catch(() => {})
      }
      return hit
    },
  })
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
    // Rust 回问：工具回复后、下一次 LLM 请求前有没有要注入的消息
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

      // Rust 引擎下前端没走 JS executor，首次收到输出时注册带 kill 回调的 entry
      if (!toolOutputStore.get(payload.toolCallId)) {
        registerToolKill(
          payload.toolCallId,
          'execute_command',
          payload.sessionId,
        )
      }
      toolOutputStore.append(payload.toolCallId, chunk)
    })
    // 命令开始执行时下发本条命令的实际沙盒模式（运行中即可显示徽标）
    await listen('agent:tool-env', (e) => {
      const p = e.payload as {
        sessionId: string
        toolCallId: string
        sandbox: string
      }
      if (!p?.toolCallId || !p.sandbox) return
      toolOutputStore.setSandbox(p.toolCallId, p.sandbox)
    })
    bridgeStarted = true
  })()
  return bridgeStartPromise
}

// 桥接处理

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
      // 取消由 Rust 层控制（在步骤间检查）
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
        // 失败也把结构化 uiData 带回 Rust，否则中文界面下只能贴英文错误
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
 * 轮次边界回执：无论成败都立即回执（失败回空数组），超时兜底在 Rust 侧。
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
    // 孤立代理经 JSON.stringify 会变半个代理，serde_json 要求成对 → invoke 直接失败，必须清洗
    payload: { messages: sanitizeLoneSurrogates(messages) },
  }).catch(() => {})
}

/**
 * 处理 Rust 发来的用户交互请求。导出仅为单测能直接驱动这条回执路径。
 */
export async function handleUserInteractionRequest(payload: {
  requestId: string
  sessionId: string
  type: string
  data: Record<string, any>
}): Promise<void> {
  const { requestId, sessionId, type, data } = payload
  const entry = sessionHandlers.get(sessionId)
  if (!entry) {
    /*
     * 不能静默回 cancelled：那会把「没人能应答」伪装成「用户取消」，AI 顺势跳过这一步，
     * 界面上不留痕迹。故留痕 + 回 error（作为工具失败结果，消息流里看得见）。
     */
    console.warn(
      '[rust-engine] 收到用户交互请求，但该会话没有注册处理器 —— ' +
        `AI 的提问/授权请求从未展示给用户（sessionId=${sessionId} type=${type}）`,
    )
    trackError('error.bridge', new Error('no interaction handler for this session'), {
      traceId: getSessionTrace(sessionId),
      props: {
        direction: 'rust2js',
        kind: 'user-interaction-orphan',
        session_id: sessionId,
        interaction_type: type,
      },
    })
    await invoke('agent_user_interaction_response', {
      requestId,
      payload: {
        // 给模型的英文说明（模型侧英文、UI 侧结构化）
        __kind: 'error',
        message:
          'Failed to ask the user: no interaction handler is attached to this session, ' +
          'so the question was never shown. Do not retry this call; tell the user instead.',
      },
    })
    return
  }
  try {
    const result = await entry.handler(type, data)
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
    } else if (e?.name === 'InteractionEnded') {
      /*
       * 运行结束时被收敛（桌面点停止 / 手机取消 / 引擎放弃）：不是用户点了取消。
       * 同上面那条纪律 —— 如实回一条工具级失败，而不是伪装成 [User cancelled]。
       */
      await invoke('agent_user_interaction_response', {
        requestId,
        payload: {
          __kind: 'error',
          message:
            'The interaction was ended before it was answered (the run was cancelled or the session was deleted). ' +
            'The user never answered this question; do not retry this call.',
        },
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

// Rust 引擎适配器

/** 是否在 Tauri 环境（非 Tauri：浏览器 dev / vitest） */
export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 解析工具定义（异步：定义来自权威源，Tauri 下首次可能走 IPC） */
export async function resolveToolDefs(
  enableTools: boolean,
  session: Session,
): Promise<ToolDefinition[]> {
  if (!enableTools) return []
  // 白名单过滤只在 domain 一处实现（轨迹检查器的工具目录同口径）
  return filterAllowedToolDefs(
    await toolRegistry.listDefinitions(),
    session.allowedTools,
  )
}

/** 解析 Provider 连接信息（前端持有 apiKey / baseUrl，传给 Rust） */
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
 * 解析原生工具所需的安全配置；失败返回 null → Rust 回退到 JS 桥执行。
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
      // 权限三态表（终端命令 / 脚本执行）
      permissions: settingsState.value.permissions,
      skipDirs,
      blacklist: config.blacklist ?? [],
      whitelist: config.whitelist ?? [],
      skillsDir,
      sandboxMode: settingsState.value.sandboxMode ?? 'on',
      // 规则全量下发，判定完全在 Rust 侧（text / regex / 内嵌 QuickJS），无 IPC 往返
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

    // 注册交互处理器，并留下本次 run 的归属令牌（注销时回传，否则交错的 run 会互相删表）
    const handlerToken = onUserInteraction
      ? registerSessionToolHandler(sessionId, onUserInteraction)
      : null

    // 监听 Rust 引擎事件
    let unlisten: UnlistenFn | null = null
    try {
      unlisten = await listen('agent:event', (e) => {
        const payload = e.payload as { sessionId: string; event: any }
        if (payload.sessionId === sessionId) {
          // tool_call 携带 result = 执行完毕，清理实时输出缓存
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
              // 工具刚宣布即注册 kill 入口：无输出的长命令也要有「终止」按钮
              registerToolKill(id, data.name, sessionId)
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
      // 兜底防线：孤立代理会让 serde_json 报错（只有列号，极难定位），源头已安全截断，这里再兜一层
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
      // 用户取消是预期操作，不应弹 error-banner
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
      // 只注销自己注册的那一次；已被别人顶替时也删不掉别人的处理器
      if (handlerToken) unregisterSessionToolHandler(sessionId, handlerToken)
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
    // 统一到 core：与 CLI 共用 compress。记账在后端，落库（cmd_replace_session_messages）由 chat-service 负责。
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
    // 统一到 core：与 CLI 共用 title。记账在后端，落库（写回标题）由 chat-service 负责。
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
