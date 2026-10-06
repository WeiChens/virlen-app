/**
 * DTO 投影（**白名单**）—— 手机控制「电脑侧接口层」的出参构造。
 *
 * 铁律（见 docs/phone-control-bridge.md §7-⑥/⑦）：**绝不 `{...session}` 再删字段**。
 * `Session` 含 `systemPrompt`（可达数十 KB）、`workspace`（本地绝对路径）、
 * `providerConfigId` / `allowedTools` / `params`，直接下行是数据泄露 + 流量事故。
 * 这里**只挑显式字段**，新增字段必须手动加入，杜绝"不小心多带"。
 *
 * 图片 / 文件等富内容一律降级为占位符（§7-⑦）：`ImageContent` 可能内嵌大段 base64，
 * 下行就是流量事故。图片引用（ref）留到二期。
 *
 * ⚠️ **一个例外：引用（`quote`）**。自 §36 起它以结构化字段 `MessageDTO.quotes` 下行
 * （手机端要把它渲染成引用条），**不再**展平进 `text` —— 两条路同时走就会显示两遍。
 * §37 的**文件引用**同理（`MessageDTO.files`）：展平后的 `[文件] <名字>` 只有名字没有路径，
 * 同一目录下的两个 `index.ts` 在手机上长得一模一样。
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
 * 把消息内容投影为纯文本（剥离 base64 / 富内容）。
 *
 * 同时被 store-bridge 用作「消息指纹」的一部分 —— 见 store-bridge 的下行 diff。
 *
 * `options.skipQuotes` / `options.skipFiles`：**跳过引用块 / 文件块**
 * （它们已结构化地下行到 `MessageDTO.quotes` / `MessageDTO.files`）。
 * 不跳的话手机端会把同一段引文 / 同一个附件显示两遍（引用条 + 正文里的 `[引用] …`），
 * 而「正文里本来就写着 `[引用]`」这种巧合无法用字符串判断去重。
 *
 * ⚠️ 两个开关都默认**不跳**（旧行为）：指纹仍把它们算进去，否则改了引用块 / 换了附件
 * 不会触发任何下行更新。
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

/**
 * 取出消息里的**结构化引用**（§36）：与 `QuoteContent` 同构，但只含协议要的四个字段。
 *
 * 为什么必须结构化下行（而不是继续靠 `[引用] …` 前缀）：手机端要把引用渲染成气泡上方的
 * 引用条（对应桌面 `QuoteChip`），而展平后的文本**再也拆不回来** —— 正文里本来就可能有
 * 同样的字样。
 */
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
 * 取出消息里的**文件引用**（§37）：与 `FileContent` 同构，但只含协议要的四个字段。
 *
 * 为什么必须结构化下行（而不是继续靠 `[文件] …` 前缀）：那个前缀**只有名字没有路径**，
 * 也没有体积 —— 手机上「附了哪个文件」就答不出来（同目录下两个 `index.ts` 长得一样）。
 * 与 §36 的 `collectQuotes` 同一条理由。
 *
 * `name` 用**与共享包同一个兜底口径**（`sanitizeFileRefs` 也是「空则取路径末段」）：
 * 老消息里 `name` 可能缺席（上传链路曾经不带它），而协议要求它必填。
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
 * 归一化工作目录：与桌面 `securityService.getWorkspace` **同口径**（反斜杠→`/`、去尾斜杠）。
 *
 * 必须归一化后再下行：手机端会把它当作「同一性」的 key（分组、回传给
 * `host.session.create`），两份不同写法（`E:\a` / `E:/a/`）会被当成两个目录。
 */
export function normalizeWorkspace(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || undefined
}

/**
 * 触发某次工具调用的信息（`toolCallId` → 工具名 + 入参）。
 *
 * 工具结果消息（`role:'tool'`）**只有结果文本**：名字与入参都在**发起该调用的 assistant
 * 消息**的 `toolCalls[]` 上。手机端要回答「这一步在干什么」（看的是哪个文件 / 执行的什么命令），
 * 就得靠这个索引把两者接起来。
 */
export interface ToolCallInfo {
  name: string
  /**
   * 工具入参（引擎给的原始形状）。
   *
   * ⚠️ **绝不下行**：`write_file.content` / `edit_file.edits[].old_string` 可能是整篇文章。
   * 它只用于生成一行摘要（`summarizeToolArgs`），摘要本身有长度硬上限。
   */
  input?: unknown
}

/**
 * 构造「toolCallId → 工具调用」索引。
 *
 * 匹配规则与桌面 `message-list/helpers.ts::resolveJumpAnchorId` **完全一致**（同一个
 * `toolCallId` 对应同一条调用），否则手机与电脑会显示不同的工具名 / 入参。
 */
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
 * 当前会话的工作目录：工具入参里的绝对路径按它缩短（与桌面卡片 `toShortPath` 同一口径）。
 *
 * 取不到就返回 `undefined`——`toShortPath` 遇到空 base 会原样返回路径，于是「拿不到工作
 * 目录」退化成「显示完整路径」，而不是拼出一个错的相对路径。
 */
function workspaceOfSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  return (
    sessionStore.getSession(sessionId)?.workspace || settingsState.value.defaultWorkspace || undefined
  )
}

/**
 * 投影的可选项（都是「格式化上下文」，与白名单字段无关）。
 */
export interface MessageProjectionOptions {
  /**
   * 会话 id：用于取工作目录，把工具入参里的**绝对路径**缩成相对路径
   * （与桌面工具卡片同一口径，见 `workspaceOfSession`）。不传 = 路径原样。
   */
  sessionId?: string
}

/**
 * 消息投影（白名单）。
 *
 * `tier` = 当前**传输档位**（§33）：`lean`（精简）时 `role:'tool'` 的正文**不下发** ——
 * 工具输出是手机上最大的一笔流量（`git diff` / 命令回显单条就几 KB），而它恰好是用户
 * 在手机屏上最难读完的东西。其余角色（assistant 正文 / 用户消息 / 压缩摘要）一律完整下发：
 * 那些就是「主要内容」，砍掉它比砍工具输出更贵（用户看不到 AI 说了什么）。
 *
 * 裁剪后正文为空 → 必须带 `detail:'omitted'`：手机端靠它区分「本来就没输出」与「被省略了」，
 * 否则会向用户显示一句不成立的「这次调用没有输出」。
 *
 * ⚠️ 默认 `full`（旧行为）：调用方不传档位时**绝不**少发东西 —— 裁剪必须是显式选择，
 * 不能因为“某处忘了传参”而静默发生。
 *
 * `toolArgs`（入参摘要）**不受档位影响**：它只有一行、且正好是「工具输出被略掉」时
 * 用户唯一还看得见的东西（“这一步在干什么”）。`toolArgsFull`（展开区完整入参）同理 —— 输出被
 * 略掉时，那一块反而是用户在手机上唯一还能看到的现场。
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
   * 入参的两种呈现：折叠态一行摘要（`summarizeToolArgs`）与展开态完整入参
   * （`formatToolArgs`）。**同一个 shortenPath 回调** —— 路径按工作目录缩短，
   * 且折叠 / 展开必须显示成同一个样子（点开卡片发现路径变了，用户会以为改坏了什么）。
   */
  const shortenPath = (path: string) => toShortPath(path, workspaceOfSession(options.sessionId))
  const toolArgs = call
    ? summarizeToolArgs(call.name, call.input, { shortenPath })
    : undefined
  const toolArgsFull = call ? formatToolArgs(call.input, { shortenPath }) : undefined
  // 引用块与文件块走结构化字段（§36 / §37）—— 投影正文时把它们跳过，否则手机端会各显示两遍
  const quotes = collectQuotes(message.content)
  const files = collectFiles(message.content)
  const rawText = projectContentToText(message.content, {
    skipQuotes: quotes.length > 0,
    skipFiles: files.length > 0,
  })
  /*
   * 工具输出与入参详情**同一条上限**（`TOOL_DETAIL_MAX` = 5000，超出中间省略）：
   * 手机上「拉开一看几千行」跟没有一样，而结论在两头（开头是命令，结尾是报错 / 汇总）。
   * 顺带省掉的是真金白银 —— `git diff` / 读大文件的输出动辄几十 KB。
   *
   * ⚠️ 只对 `role:'tool'` 做：assistant 正文是「主要内容」，砍它比砍工具输出更贵。
   * 被省略的字符数由 `elideMiddle` 写进正文（那一行才是「被砍过」的凭证）。
   */
  const text = message.role === 'tool' ? elideMiddle(rawText, TOOL_DETAIL_MAX) : rawText
  /*
   * 只有「确实有可见正文」才打省略标记：本来就空的输出不打 —— 那会让手机端把
   * 「这次调用真没输出」错报成「被省略了」（反过来撒谎，同样不行）。
   * 判据用 `trim()`，与手机端 `hasBody()` 同一口径（它也是按 trim 判空）。
   */
  const omit = tier === 'lean' && message.role === 'tool' && rawText.trim().length > 0
  return {
    id: message.id,
    role: ROLE_MAP[message.role] ?? 'system',
    text: omit ? '' : text,
    createdAt: message.timestamp,
    ...(omit ? { detail: 'omitted' as const } : {}),
    ...(toolName ? { toolName } : {}),
    // 拿不到就不带（旧电脑端 / 跨页工具调用）—— 手机端据此只显示工具名，不猜
    ...(toolArgs ? { toolArgs } : {}),
    // 展开区的完整入参（比摘要重得多）：只在用户点开卡片后才渲染，字段本身与摘要同源
    ...(toolArgsFull ? { toolArgsFull } : {}),
    // 无引用则整个字段不带（不为旧手机端凭空多出一个空数组）
    ...(quotes.length > 0 ? { quotes } : {}),
    // 文件引用同上：无则不带
    ...(files.length > 0 ? { files } : {}),
  }
}

/**
 * 会话摘要投影。
 *
 * ⚠️ 读运行时状态时**只读不建**（`sessionRuntimeState.value.sessions[id]?.working`）：
 * `getSessionRuntime()` 会在缺失时创建条目，而本函数会在 mobx reaction 的推导里被调用 ——
 * 在推导中写观测值会触发 MobX 告警 / 重入。这里用可选链规避。
 *
 * ⚠️ `working` 字段只映射引擎 run（**不并入**本地的 `preparing`，见 sessionRuntimeStore）：
 * 桌面端本地识别图片的那几秒，手机看到的是「空闲」，但它这时候发消息会被宿主侧以
 * `E_BUSY` 拦下（`host-source.send` 用 `isSessionRuntimeBusy`）—— 拦得住不够不成两个 run，
 * 只是提示晚一步出现。
 */
export function toSessionSummaryDTO(session: Session): SessionSummaryDTO {
  const rt = sessionRuntimeState.value.sessions[session.id]
  // 只读查询（`getAgent` 是纯查表，不会创建条目）；未关联 Agent / 服务商被删时字段缺省
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
 * 「**正在执行中**的工具」——已声明、但结果消息还没到的那些调用（§27 的姊妹投影）。
 *
 * 为什么需要（2026-10 真机反馈：电脑上有一张呼吸点卡片，手机上只剩「正在思考」）：
 * 工具消息（`role:'tool'`）只在**执行完之后**才作为消息下行 —— 从「参数生成完、工具开跑」
 * 到「结果到达」这段静默期，手机端本来**没有任何东西可看**（隔壁那个 `toolProgress`
 * 只管**累积参数**那段，工具一开跑就被清掉）。
 *
 * 判据与桌面 pending 卡片**逐字一致**（`message-list/use-virtual-list.ts::toolResultsFor`）：
 * assistant 消息 `toolCalls[]` 里的 id，减去已有结果的 tool 消息的 `toolCallId`，剩下的就是
 * 正在执行的（同一条规则才能保证「电脑上看到的几个正在跑」与「手机上列出的几行」对得上）。
 *
 * ⚠️ **线性扫描（不建索引、不缓存）是故意的**：会话消息是**追加**的，而这里要在
 * `store-bridge` 的 reaction 推导里被调用 —— 一次 O(n) 扫描（只看 `role` / `toolCallId` /
 * `toolCalls` 三个字段，不碰正文）比维护一份要同步失效的索引安全得多。
 */
export function runningToolsOf(sessionId: string): RunningToolDTO[] {
  const messages = sessionStore.getSession(sessionId)?.messages ?? []
  if (messages.length === 0) return []
  // 已有结果的 toolCallId（有结果 = 不再「执行中」）
  const settled = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) settled.add(message.toolCallId)
  }
  const shortenPath = (path: string) => toShortPath(path, workspaceOfSession(sessionId))
  const out: RunningToolDTO[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call?.id || !call.name || settled.has(call.id)) continue
      // 摘要与工具消息的 `toolArgs` 同一个格式化口径（同一个 shortenPath 回调）——
      // 同一份路径不能在「执行中」与「已完成」两张卡上显示成两个样子
      const args = summarizeToolArgs(call.name, call.input, { shortenPath })
      out.push({ toolCallId: call.id, name: call.name, ...(args ? { args } : {}) })
    }
  }
  return out
}

export function toRuntimeDTO(sessionId: string): RuntimeDTO {
  const rt = sessionRuntimeState.value.sessions[sessionId]
  /*
   * 执行中的工具**只在 run 跑着的时候**投影：`working` 是「有一个引擎 run 在跑」的锁，
   * 它一落下来（崩了 / 被取消 / 重启后残留的悬空 tool_calls）那些没有结果的调用就只是
   * **历史遗留**，不是「正在执行」—— 否则手机会一直挂着一行点不动的「正在执行…」。
   */
  const runningTools = rt?.working === true ? runningToolsOf(sessionId) : []
  return {
    working: rt?.working === true,
    ...(rt?.paused ? { paused: true } : {}),
    ...(rt?.error ? { error: rt.error } : {}),
    ...(rt?.compacting ? { compacting: true } : {}),
    // 工具参数生成进度（§27）：有才带，无则不带字段（手机端 `undefined` = 无进度）
    ...(rt?.toolProgress ? { toolProgress: rt.toolProgress } : {}),
    // 执行中的工具（§27 姊妹）：同一套「有才带」的口径（字段缺席 = 此刻没有在跑的工具）
    ...(runningTools.length > 0 ? { runningTools } : {}),
  }
}
