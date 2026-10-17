/**
 * DTO 投影（白名单）：绝不 {...session} 再删字段，只挑显式字段（防敏感字段泄露 / 流量事故）。
 * 富内容（图片 / 文件）降级为占位符；引用与文件自 §36 起结构化下行，不再展平进 text。
 */
import type { Message, MessageContent, Session } from '@/types'
import { agentStore, sessionRuntimeState, sessionStore, settingsState } from '@/ui/store'
import { toShortPath } from '@/utils/common'
import {
  baseNameOfPath,
  elideMiddle,
  formatToolArgs,
  summarizeToolArgs,
  TOOL_DETAIL_MAX,
  type MessageDTO,
  type MessageFileRef,
  type MessageQuote,
  type RunningToolDTO,
  type RuntimeDTO,
  type SessionSummaryDTO,
  type TransferTier,
} from 'virlen-remote'

/** 电脑侧 `MessageRole`（含 summary / feedback）→ 协议四角色白名单。 */
const ROLE_MAP: Record<Message['role'], MessageDTO['role']> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  summary: 'system',
  feedback: 'assistant',
}

/**
 * 消息内容 → 纯文本（剥离 base64 / 富内容），也用作 store-bridge 的消息指纹。
 * skipQuotes / skipFiles 跳过已结构化下行的块，否则手机会显示两遍；默认不跳以免指纹失真。
 */
export function projectContentToText(
  content: MessageContent,
  options: { skipQuotes?: boolean; skipFiles?: boolean } = {},
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image_url':
        parts.push('[图片]')
        break
      case 'file':
        if (options.skipFiles) break
        parts.push(`[文件] ${block.name ?? block.path}`)
        break
      case 'quote':
        if (options.skipQuotes) break
        parts.push(`[引用] ${block.text}`)
        break
      case 'skill':
        parts.push(`[技能] ${block.name}`)
        break
      case 'tool_use':
        parts.push(`[工具调用] ${block.name}`)
        break
      case 'tool_result':
        parts.push('[工具结果]')
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/** 取出结构化引用（展平后的文本再也拆不回来，手机要渲染成引用条）。 */
export function collectQuotes(content: MessageContent): MessageQuote[] {
  if (typeof content === 'string') return []
  if (!Array.isArray(content)) return []
  const quotes: MessageQuote[] = []
  for (const block of content) {
    if (block.type !== 'quote') continue
    quotes.push({ messageId: block.messageId, role: block.role, text: block.text })
  }
  return quotes
}

/**
 * 取出结构化文件引用：前缀只有名字没有路径与体积。name 的兜底与共享包一致（空则取路径末段）。
 */
export function collectFiles(content: MessageContent): MessageFileRef[] {
  if (typeof content === 'string') return []
  if (!Array.isArray(content)) return []
  const files: MessageFileRef[] = []
  for (const block of content) {
    if (block.type !== 'file') continue
    const name = block.name?.trim() || baseNameOfPath(block.path)
    files.push({
      path: block.path,
      name,
      ...(block.isDir !== undefined ? { isDir: block.isDir } : {}),
      ...(block.size !== undefined ? { size: block.size } : {}),
    })
  }
  return files
}

/**
 * 归一化工作目录（与 securityService.getWorkspace 同口径）：手机端拿它当同一性 key，
 * 两种写法会被当成两个目录。
 */
export function normalizeWorkspace(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || undefined
}

/** 触发某次工具调用的信息：tool 消息只有结果，名字与入参在发起它的 assistant 消息上。 */
export interface ToolCallInfo {
  name: string
  /** 工具入参（原始形状）；绝不下行，只用于生成一行摘要。 */
  input?: unknown
}

/** 构造 toolCallId → 工具调用索引（匹配规则与桌面 resolveJumpAnchorId 一致）。 */
export function buildToolCallIndex(messages: readonly Message[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call?.id && call.name) index.set(call.id, { name: call.name, input: call.input })
    }
  }
  return index
}

/**
 * 会话工作目录：工具入参的绝对路径据此缩短。取不到返回 undefined → 显示完整路径，而不是错的相对路径。
 */
function workspaceOfSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  return (
    sessionStore.getSession(sessionId)?.workspace || settingsState.value.defaultWorkspace || undefined
  )
}

/** 投影可选项（格式化上下文，与白名单字段无关）。 */
export interface MessageProjectionOptions {
  /** 会话 id：用于把工具入参里的绝对路径缩成相对路径；不传则原样。 */
  sessionId?: string
  /**
   * summary 投影：省掉工具输出正文与完整入参，受影响条目打 deferred，手机端随后再拉 full。
   * 与 tier:'lean' 不同（那个要重开会话才拿回），同时命中时以 deferred 为准。
   */
  summary?: boolean
}

/**
 * 消息投影（白名单）。
 *
 * tier 为 lean 时 tool 正文不下发（手机最大的流量且最难读），并打 detail:'omitted'，
 * 否则手机端会把「被省略」显示成「没有输出」。其余角色始终完整下发。
 * 默认 full：裁剪必须显式选择。toolArgs / toolArgsFull 不受档位影响。
 */
export function toMessageDTO(
  message: Message,
  toolCalls?: ReadonlyMap<string, ToolCallInfo>,
  tier: TransferTier = 'full',
  options: MessageProjectionOptions = {},
): MessageDTO {
  const call =
    message.role === 'tool' && message.toolCallId
      ? toolCalls?.get(message.toolCallId)
      : undefined
  const toolName = call?.name
  /*
   * 入参两种呈现：折叠态一行摘要与展开态完整入参。共用同一个 shortenPath，
   * 否则点开卡片会发现路径变了。
   */
  const shortenPath = (path: string) => toShortPath(path, workspaceOfSession(options.sessionId))
  const toolArgs = call
    ? summarizeToolArgs(call.name, call.input, { shortenPath })
    : undefined
  const toolArgsFull = call ? formatToolArgs(call.input, { shortenPath }) : undefined
  // 引用 / 文件走结构化字段，投影正文时跳过，否则手机端各显示两遍
  const quotes = collectQuotes(message.content)
  const files = collectFiles(message.content)
  const rawText = projectContentToText(message.content, {
    skipQuotes: quotes.length > 0,
    skipFiles: files.length > 0,
  })
  const summary = options.summary === true
  /*
   * 工具输出统一上限（TOOL_DETAIL_MAX，超出中间省略）：结论在两头。只对 tool 做，
   * assistant 正文砍了更贵。
   */
  const text = message.role === 'tool' ? elideMiddle(rawText, TOOL_DETAIL_MAX) : rawText
  /*
   * 只有确实有可见正文才打省略标记：空输出打标记等于反向撒谎。判据用 trim()，
   * 与手机端 hasBody() 同口径。
   */
  const omit = tier === 'lean' && message.role === 'tool' && rawText.trim().length > 0
  /*
   * 两阶段加载：把工具正文与完整入参延后（deferred = 马上补发，区别于 lean 的挡位省略）。
   */
  const deferredToolText = summary && message.role === 'tool' && rawText.trim().length > 0
  const deferredArgsFull = summary && toolArgsFull != null
  const deferred = deferredToolText || deferredArgsFull
  return {
    id: message.id,
    role: ROLE_MAP[message.role] ?? 'system',
    text: omit || deferredToolText ? '' : text,
    createdAt: message.timestamp,
    // summary 下用 deferred 表达稍后补发，不写 omitted
    ...(omit && !deferredToolText ? { detail: 'omitted' as const } : {}),
    ...(toolName ? { toolName } : {}),
    // 拿不到就不带（旧电脑端 / 跨页工具调用）
    ...(toolArgs ? { toolArgs } : {}),
    // 展开区的完整入参（与摘要同源）
    ...(toolArgsFull && !deferredArgsFull ? { toolArgsFull } : {}),
    // 详细内容被延后（summary）——手机端显示「正在加载详细内容…」
    ...(deferred ? { deferred: true } : {}),
    // 失败标记：true 才带（手机端据此打 ✓/✗，不靠正文反推）
    ...(message.isError ? { isError: true } : {}),
    // 无引用则整个字段不带（不为旧手机端凭空多出一个空数组）
    ...(quotes.length > 0 ? { quotes } : {}),
    // 文件引用同上：无则不带
    ...(files.length > 0 ? { files } : {}),
  }
}

/**
 * 会话摘要投影。只读不建运行时条目（在 mobx 推导里被调，写入会告警 / 重入）。
 * working 只映射引擎 run，不含本地 preparing。
 */
export function toSessionSummaryDTO(session: Session): SessionSummaryDTO {
  const rt = sessionRuntimeState.value.sessions[session.id]
  // 只读查表，不建条目；Agent / 服务商缺失时字段缺省
  const agent = agentStore.getAgent(session.agentId)
  const provider = session.providerConfigId
    ? settingsState.value.providers.find((p) => p.id === session.providerConfigId)
    : undefined
  const workspace = normalizeWorkspace(session.workspace)
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    working: rt?.working === true,
    pinned: session.pinned === true,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(agent ? { agentName: agent.name } : {}),
    ...(workspace ? { workspace } : {}),
    ...(session.providerConfigId ? { providerConfigId: session.providerConfigId } : {}),
    ...(provider ? { providerName: provider.name } : {}),
    ...(session.modelId ? { modelId: session.modelId } : {}),
  }
}

/**
 * 正在执行的工具：已声明但结果还没到的调用（与桌面 pending 卡片同一判据）。
 * 线性扫描是故意的：它在 reaction 推导里跑，只三个字段，比维护索引安全。
 */
export function runningToolsOf(sessionId: string): RunningToolDTO[] {
  const messages = sessionStore.getSession(sessionId)?.messages ?? []
  if (messages.length === 0) return []
  // 已有结果的 toolCallId（有结果 = 不再执行中）
  const settled = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) settled.add(message.toolCallId)
  }
  const shortenPath = (path: string) => toShortPath(path, workspaceOfSession(sessionId))
  const out: RunningToolDTO[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call?.id || !call.name || settled.has(call.id)) continue
      // 与工具消息的 toolArgs 同一个格式化口径，同一路径不能两张卡显示成两个样子
      const args = summarizeToolArgs(call.name, call.input, { shortenPath })
      out.push({ toolCallId: call.id, name: call.name, ...(args ? { args } : {}) })
    }
  }
  return out
}

export function toRuntimeDTO(sessionId: string): RuntimeDTO {
  const rt = sessionRuntimeState.value.sessions[sessionId]
  /*
   * 执行中的工具只在 run 跑着时投影：working 一落，那些没结果的调用就只是历史遗留，
   * 否则手机一直挂着一行点不动的「正在执行…」。
   */
  const runningTools = rt?.working === true ? runningToolsOf(sessionId) : []
  return {
    working: rt?.working === true,
    ...(rt?.paused ? { paused: true } : {}),
    ...(rt?.error ? { error: rt.error } : {}),
    ...(rt?.compacting ? { compacting: true } : {}),
    // 工具参数生成进度（有才带）
    ...(rt?.toolProgress ? { toolProgress: rt.toolProgress } : {}),
    // 执行中的工具：字段缺席 = 此刻没有在跑的工具
    ...(runningTools.length > 0 ? { runningTools } : {}),
  }
}
