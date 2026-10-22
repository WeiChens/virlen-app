/**
 * 轨迹投影：`Message[]` → 轮次 / 分组 / 记录行。
 *
 * ## 为什么可以「纯前端投影」
 *
 * virlen 的会话是**行式快照**（每条消息一行，顺序即 rowid），不像 dsh 那样有 turn/step 事件。
 * 但轨迹视图要的骨架恰好能从消息角色推出来，而且只有两条规则：
 *
 * 1. **每条 `role='user'` 消息开一个新轮**（virlen 的语义就是「用户一次请求 = 一轮」）；
 * 2. **每条 `role='assistant'` 消息 = 该轮的一步**（一次 LLM 请求 —— 引擎每轮都会先落一条
 *    未定稿占位再整行覆盖，所以「一条 assistant 消息 = 一次请求」是成立的）。
 *
 * 剩下的都是配音：工具调用从 `assistant.toolCalls` 展开成独立行，结果按 `toolCallId` 配对；
 * `role='summary'` 单独成一段「压缩」；`role='feedback'` 是模型看不见的注入消息（任务清单 /
 * 后台服务通知），归到 `context` 行。
 *
 * ## 耗时口径（重要）
 *
 * 只给**真实可算**的耗时，算不出来一律 `null`（表格显示 `—`）。绝不拿「下一条消息时间戳 -
 * 本条时间戳」充数：那段时间里混着用户阅读、切窗口、走开的时间，画进概览就是一根巨大的假横条。
 *
 * - 工具行：结果消息的 `elapsedMs`（引擎实测）；开始时刻 = `timestamp - elapsedMs`
 * - 助手行：**优先用量账本的实测请求耗时**（`usage_ledger.duration_ms`，含首字延迟）。
 *   账本里查不到时（旧会话 / 非 Tauri 环境）才退回到「请求发出 → 本轮最早那个工具开跑」
 *   反推，并标 `durationSource: 'derived'` —— 那条路径没工具调用时依然算不出来 → `null`
 * - 用户 / 系统 / 上下文 / 压缩行：0 或 `null`（不占时间轴宽度）
 */
import type { Message, ToolUseContent } from '@/types'
import {
  getFileBlocks,
  getImageUrls,
  getQuoteBlocks,
  getSkillBlocks,
  messageBodyText,
} from '@/utils/messageContent'
import { argumentsBrief, contentText, singleLine } from './text'
import type {
  TrajectoryAttachments,
  TrajectoryBuildInput,
  TrajectoryDurationSource,
  TrajectoryGroup,
  TrajectoryGroupTitle,
  TrajectoryLedgerStats,
  TrajectoryRecord,
  TrajectoryRequestFacts,
  TrajectoryRequestInfo,
  TrajectoryRequestTotals,
  TrajectoryTurn,
  TrajectoryTurnTitle,
  TrajectoryWindowStats,
} from './types'
import { RECORD_TEXT_MAX } from './types'

/** 单个工具调用的结果消息（按 callId 索引，遍历前一次建好） */
type ResultIndex = Map<string, Message>

/** 工具调用的开始时刻（callId → ms）—— 助手行的耗时要靠它反推 */
type StartIndex = Map<string, number>

/** 请求流水索引：assistant / summary 消息 id → 那一次请求的事实 */
type UsageIndex = Map<string, TrajectoryRequestFacts>

/**
 * 建请求流水索引（`messageId → facts`）。
 *
 * 只收**带 messageId** 的流水：标题 / 校验 / 记忆类调用没有归属消息，只能进统计合计。
 * 同 id 多条时取**耗时已测到的那条**（同一个 assistant 消息可能先写过一条 0 耗时的旧流水）；
 * 都没有耗时时保留先出现的那条（账本按时间倒序，即取最近的）。
 */
function indexUsage(usage: readonly TrajectoryRequestFacts[]): UsageIndex {
  const index: UsageIndex = new Map()
  for (const facts of usage) {
    if (!facts.messageId) continue
    const existing = index.get(facts.messageId)
    if (!existing) {
      index.set(facts.messageId, facts)
      continue
    }
    const existingMs = existing.durationMs ?? 0
    const nextMs = facts.durationMs ?? 0
    if (nextMs > existingMs) index.set(facts.messageId, facts)
  }
  return index
}

/** 工具结果的开始时刻：`timestamp` 是**结束**时刻，减去自身耗时才是开始 */
function resultStartedAt(result: Message): number | undefined {
  if (!Number.isFinite(result.timestamp) || result.timestamp <= 0) return undefined
  const elapsed = result.elapsedMs
  if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) {
    return result.timestamp - elapsed
  }
  return result.timestamp
}

/** 会话里的工具结果索引（`role='tool'` + `toolCallId`） */
function indexResults(messages: readonly Message[]): ResultIndex {
  const results: ResultIndex = new Map()
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolCallId) continue
    // 同 id 重复时后者覆盖：与引擎的 upsert 语义一致
    results.set(message.toolCallId, message)
  }
  return results
}

/** 工具调用开始时刻索引（从配对结果反推） */
function indexStarts(results: ResultIndex): StartIndex {
  const starts: StartIndex = new Map()
  for (const [callId, result] of results) {
    const startedAt = resultStartedAt(result)
    if (startedAt !== undefined) starts.set(callId, startedAt)
  }
  return starts
}

/**
 * 账本流水 → 记录上的请求事实。
 *
 * `tokensPerSecond` 在耗时**不足 1 秒**时刻意不算：那点时间里首字延迟占了绝大部分，
 * 除出来的 tok/s 会被放大成几万，比不给值更误导（与总览页的 tok/s 口径一致）。
 *
 * @param facts 账本流水（没查到就不挂 request）
 * @param output 该次请求的补全 token（用来算吞吐）
 */
function requestInfo(
  facts: TrajectoryRequestFacts | undefined,
  output: number | undefined,
): TrajectoryRequestInfo | undefined {
  if (!facts) return undefined
  const measured =
    facts.durationMs !== undefined && Number.isFinite(facts.durationMs) && facts.durationMs > 0
      ? Math.round(facts.durationMs)
      : undefined
  const tokensPerSecond =
    measured !== undefined && measured >= 1000 && output !== undefined && output > 0
      ? Math.round((output * 1000) / measured)
      : undefined
  return {
    ...(facts.id !== undefined ? { id: facts.id } : {}),
    ...(facts.model ? { model: facts.model } : {}),
    ...(facts.provider ? { provider: facts.provider } : {}),
    kind: facts.kind,
    ...(facts.round !== undefined ? { round: facts.round } : {}),
    ...(measured !== undefined ? { durationMs: measured } : {}),
    ...(facts.estimated === true ? { estimated: true } : {}),
    ...(facts.traceId ? { traceId: facts.traceId } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  }
}

/** 用户消息的附件计数（四个都为 0 时返回 undefined，避免表格里挂一串 0） */
function countAttachments(content: Message['content']): TrajectoryAttachments | undefined {
  const images = getImageUrls(content).length
  const files = getFileBlocks(content).length
  const quotes = getQuoteBlocks(content).length
  const skills = getSkillBlocks(content).length
  if (images + files + quotes + skills === 0) return undefined
  return { images, files, quotes, skills }
}

/** `uiData.contextTokens`（压缩后上下文大小，Rust 压缩产物才有） */
function contextTokensOf(message: Message): number | undefined {
  const value = message.uiData?.contextTokens
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

/** 消息是否仍在本轮里「未定稿」（流式中 / 崩溃残留） */
function isRunning(message: Message): boolean {
  return message.streaming === true || message.uiData?.pending === true
}

/** 崩溃中断（`repair_tail` 打上的标记） */
function isInterrupted(message: Message): boolean {
  return message.uiData?.interrupted === true
}

/** 一次构建过程的全部可变状态（把「往哪个组里塞」的规则收在一处） */
interface BuildState {
  turns: TrajectoryTurn[]
  /** 当前打开着的轮（null = 还没遇到 user / 只遇到压缩） */
  turn: TrajectoryTurn | null
  /** 当前打开着的组 */
  group: TrajectoryGroup | null
  /** 行号（1 基，跨轮连续） */
  index: number
  /** 轮次序号 */
  turnNo: number
  /** 压缩段序号 */
  compactionNo: number
  /** 当前轮内已开的步数 */
  stepNo: number
  /** 上一条**带模型信息**的请求用的模型（用来在换模型处打徽章） */
  lastModel?: string
}

function newGroup(key: string, title: TrajectoryGroupTitle): TrajectoryGroup {
  return { key, title, records: [], knownMs: null }
}

function newTurn(key: string, turn: number | null, title: TrajectoryTurnTitle): TrajectoryTurn {
  return { key, turn, title, groups: [], input: null, output: null, knownMs: null }
}

/** 会话开头（窗口从中间截断 / 以压缩段开场）—— 没有 user 可归属时的落点 */
function ensureStartTurn(state: BuildState): TrajectoryTurn {
  if (state.turn) return state.turn
  const turn = newTurn('start', null, { kind: 'start' })
  state.turns.push(turn)
  state.turn = turn
  return turn
}

/**
 * 「会话开始」section 里的 Message 组（懒建）。
 *
 * 懒建是必需的：窗口从 assistant 开始时，若预先塞一个空的「消息」组，轨迹表里就会
 * 多出一条没有任何记录的组头（看起来像 bug）。
 */
function startGroup(state: BuildState): TrajectoryGroup {
  const turn = ensureStartTurn(state)
  const existing = turn.groups[turn.groups.length - 1]
  if (existing) return existing
  const group = newGroup(`${turn.key}:message`, { kind: 'message' })
  turn.groups.push(group)
  return group
}

/** 开一个新轮（遇到 user 消息） */
function openTurn(state: BuildState, message: Message): TrajectoryGroup {
  state.turnNo += 1
  state.stepNo = 0
  const turn = newTurn(`turn:${state.turnNo}`, state.turnNo, {
    kind: 'turn',
    turn: state.turnNo,
  })
  const group = newGroup(`${turn.key}:message`, { kind: 'message' })
  turn.groups.push(group)
  state.turns.push(turn)
  state.turn = turn
  state.group = group
  return group
}

/** 开一步（遇到 assistant 消息）：一轮里的第 N 次 LLM 请求 */
function openStep(state: BuildState): TrajectoryGroup {
  // 没有轮（窗口从 assistant 开始）：先把「会话开始」section 建出来
  const turn = ensureStartTurn(state)
  state.stepNo += 1
  const group = newGroup(`${turn.key}:step:${state.stepNo}`, {
    kind: 'step',
    step: state.stepNo,
  })
  turn.groups.push(group)
  state.group = group
  return group
}

/** 当前该往哪个组里写（上下文注入 / 窗口里没有宿主的工具结果等兜底） */
function currentGroup(state: BuildState): TrajectoryGroup {
  return state.group ?? startGroup(state)
}

/**
 * 往组里追加一条记录并返回它（行号在这里统一分配）。
 * @param patch 除 `index` 外的全部字段
 */
function push(
  state: BuildState,
  group: TrajectoryGroup,
  patch: Omit<TrajectoryRecord, 'index'>,
): TrajectoryRecord {
  state.index += 1
  const record: TrajectoryRecord = { ...patch, index: state.index }
  group.records.push(record)
  return record
}

/** 用户消息 → 一条 `user` 行 */
function userRecord(message: Message): Omit<TrajectoryRecord, 'index'> {
  const text = singleLine(messageBodyText(message.content), RECORD_TEXT_MAX)
  const attachments = countAttachments(message.content)
  return {
    key: `m:${message.id}`,
    kind: 'user',
    text,
    ...(text ? {} : { emptyReason: 'noContent' as const }),
    ...(attachments ? { attachments } : {}),
    messageId: message.id,
    startedAt: message.timestamp > 0 ? message.timestamp : undefined,
    // 用户消息本身不「耗时」：它是一轮的边界，不是一次操作
    durationMs: 0,
    message,
  }
}

/** 上下文注入消息（`role='feedback'`）→ 一条 `context` 行 */
function contextRecord(message: Message): Omit<TrajectoryRecord, 'index'> {
  const type = message.uiData?.type
  return {
    key: `m:${message.id}`,
    kind: 'context',
    text: singleLine(messageBodyText(message.content), RECORD_TEXT_MAX),
    messageId: message.id,
    startedAt: message.timestamp > 0 ? message.timestamp : undefined,
    durationMs: 0,
    ...(type === 'todo' ? { noteKind: 'todo' as const } : {}),
    ...(type === 'service'
      ? {
          noteKind: 'service' as const,
          ...(typeof message.uiData?.name === 'string'
            ? { noteName: message.uiData.name }
            : {}),
        }
      : {}),
    message,
  }
}

/** 压缩摘要（`role='summary'`）→ 一条 `compacted` 行 */
function compactionRecord(
  message: Message,
  facts: TrajectoryRequestFacts | undefined,
): Omit<TrajectoryRecord, 'index'> {
  const text = singleLine(messageBodyText(message.content), RECORD_TEXT_MAX)
  const usage = message.usage
  const request = requestInfo(facts, usage?.completionTokens)
  return {
    key: `m:${message.id}`,
    kind: 'compacted',
    text,
    ...(text ? {} : { emptyReason: 'noContent' as const }),
    messageId: message.id,
    startedAt: message.timestamp > 0 ? message.timestamp : undefined,
    // 压缩请求的实测耗时（历史回填的 compress 流水带 messageId 时才拿得到）
    durationMs: request?.durationMs ?? null,
    ...(request?.durationMs !== undefined ? { durationSource: 'usage' as const } : {}),
    ...(request ? { request } : {}),
    ...(contextTokensOf(message) !== undefined
      ? { contextTokens: contextTokensOf(message) }
      : {}),
    ...(usage?.promptTokens !== undefined ? { input: usage.promptTokens } : {}),
    ...(usage?.completionTokens !== undefined ? { output: usage.completionTokens } : {}),
    message,
  }
}

/**
 * 助手消息 → 一条 `message` 行。
 *
 * 耗时**优先账本实测**（`usage_ledger.duration_ms`，含首字延迟与工具参数生成，纯文本回复也有值）；
 * 账本里没有这条流水时才退回到「请求发出 → 第一个工具开跑」的反推，并标 `derived`。
 *
 * @param starts 工具开始时刻索引（反推耗时用）
 * @param facts 这条 assistant 消息对应的账本流水（没有就不用）
 */
function assistantRecord(
  message: Message,
  starts: StartIndex,
  facts: TrajectoryRequestFacts | undefined,
): Omit<TrajectoryRecord, 'index'> {
  const calls = message.toolCalls ?? []
  const body = singleLine(messageBodyText(message.content), RECORD_TEXT_MAX)
  const usage = message.usage
  const request = requestInfo(facts, usage?.completionTokens)
  // 反推路径：本轮最早那个工具开跑的时刻（工具结果自带 elapsedMs）
  let earliest: number | undefined
  for (const call of calls) {
    const startedAt = starts.get(call.id)
    if (startedAt === undefined) continue
    if (earliest === undefined || startedAt < earliest) earliest = startedAt
  }
  const derived =
    earliest !== undefined && message.timestamp > 0 && earliest >= message.timestamp
      ? earliest - message.timestamp
      : undefined
  const measured = request?.durationMs
  const durationMs = measured ?? derived ?? null
  const durationSource: TrajectoryDurationSource | undefined =
    measured !== undefined ? 'usage' : derived !== undefined ? 'derived' : undefined
  const running = isRunning(message)
  return {
    key: `m:${message.id}`,
    kind: 'message',
    text: body,
    ...(body
      ? {}
      : { emptyReason: calls.length > 0 ? ('toolCallOnly' as const) : ('noContent' as const) }),
    messageId: message.id,
    startedAt: message.timestamp > 0 ? message.timestamp : undefined,
    // 进行中的行不编造耗时（dsh 同规矩：只画起点）
    durationMs: running ? null : durationMs,
    ...(running || durationSource === undefined ? {} : { durationSource }),
    ...(request ? { request } : {}),
    ...(typeof message.reasoningElapsedMs === 'number' &&
    message.reasoningElapsedMs > 0
      ? { thinkingMs: message.reasoningElapsedMs }
      : {}),
    ...(usage?.promptTokens !== undefined ? { input: usage.promptTokens } : {}),
    ...(usage?.completionTokens !== undefined ? { output: usage.completionTokens } : {}),
    ...(usage?.cachedTokens !== undefined ? { cached: usage.cachedTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined
      ? { cacheWrite: usage.cacheWriteTokens }
      : {}),
    ...(running ? { running: true } : {}),
    ...(isInterrupted(message) ? { isError: true } : {}),
    ...(calls.length > 0 ? { toolName: calls[0].name } : {}),
    message,
  }
}

/** 一次工具调用 + 它的结果 → 一条 `tool` 行 */
function toolRecord(
  host: Message,
  call: ToolUseContent,
  results: ResultIndex,
): Omit<TrajectoryRecord, 'index'> {
  const result = results.get(call.id)
  const resultText = result
    ? singleLine(contentText(result.content), RECORD_TEXT_MAX)
    : ''
  const startedAt = result ? resultStartedAt(result) : undefined
  const durationMs =
    result && typeof result.elapsedMs === 'number' && result.elapsedMs >= 0
      ? result.elapsedMs
      : null
  const args = argumentsBrief(call.input)
  return {
    key: `t:${call.id}`,
    kind: 'tool',
    text: args ? `${call.name} ${args}` : call.name,
    ...(args ? { argsText: args } : {}),
    ...(resultText ? { resultText } : {}),
    // 跳回聊天时定位宿主 assistant（工具行自己没有气泡）
    messageId: host.id,
    callId: call.id,
    toolName: call.name,
    ...(startedAt !== undefined ? { startedAt } : {}),
    durationMs,
    ...(durationMs !== null ? { durationSource: 'tool' as const } : {}),
    ...(result?.isError === true ? { isError: true } : {}),
    ...(result ? {} : { running: true }),
    toolCall: call,
    ...(result
      ? {
          result: {
            message: result,
            text: resultText,
            isError: result.isError === true,
          },
        }
      : {}),
  }
}

/**
 * 窗口里没有宿主的工具结果（分页截断 / 宿主被删）→ 单独一行。
 * `toolName` 无从得知，表格显示「工具结果」占位。
 */
function orphanToolRecord(message: Message): Omit<TrajectoryRecord, 'index'> {
  const text = singleLine(contentText(message.content), RECORD_TEXT_MAX)
  const startedAt = resultStartedAt(message)
  return {
    key: `m:${message.id}`,
    kind: 'tool',
    text: '',
    emptyReason: 'noContent',
    ...(text ? { resultText: text } : {}),
    messageId: message.id,
    ...(message.toolCallId ? { callId: message.toolCallId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    durationMs:
      typeof message.elapsedMs === 'number' && message.elapsedMs >= 0
        ? message.elapsedMs
        : null,
    ...(typeof message.elapsedMs === 'number' && message.elapsedMs >= 0
      ? { durationSource: 'tool' as const }
      : {}),
    ...(message.isError === true ? { isError: true } : {}),
    ...(message.uiData?.interrupted === true ? { isError: true } : {}),
    message,
  }
}

/** 合计：组内已知耗时 / 轮内 token 与已知耗时（`null` = 一项都不知道） */
function finalize(turns: TrajectoryTurn[]): TrajectoryTurn[] {
  for (const turn of turns) {
    let input: number | null = null
    let output: number | null = null
    let turnMs: number | null = null
    for (const group of turn.groups) {
      let groupMs: number | null = null
      for (const record of group.records) {
        if (record.input !== undefined) input = (input ?? 0) + record.input
        if (record.output !== undefined) output = (output ?? 0) + record.output
        if (record.durationMs !== null && Number.isFinite(record.durationMs)) {
          groupMs = (groupMs ?? 0) + record.durationMs
        }
      }
      group.knownMs = groupMs
      if (groupMs !== null) turnMs = (turnMs ?? 0) + groupMs
    }
    turn.input = input
    turn.output = output
    turn.knownMs = turnMs
  }
  return turns
}

/**
 * 把一段消息投影成轨迹表。
 *
 * @param input 消息（会话顺序）+ 系统提示词 + 可选的用量流水
 * @returns 轮次数组；没有消息时返回空数组（空会话不显示「系统提示词」孤行）
 */
export function buildTrajectory(input: TrajectoryBuildInput): TrajectoryTurn[] {
  const { messages } = input
  if (messages.length === 0) return []

  const results = indexResults(messages)
  const starts = indexStarts(results)
  const usage = indexUsage(input.usage ?? [])
  /** 已经被某个 assistant 认领过的工具结果（避免同一结果出两行） */
  const claimed = new Set<string>()

  const state: BuildState = {
    turns: [],
    turn: null,
    group: null,
    index: 0,
    turnNo: 0,
    compactionNo: 0,
    stepNo: 0,
  }

  // 系统提示词：只占一行，挂在「会话开始」section 里（不属于任何一轮）
  const systemPrompt = input.systemPrompt?.trim() ?? ''
  if (systemPrompt) {
    const group = startGroup(state)
    push(state, group, {
      key: 'system',
      kind: 'system',
      text: '',
      durationMs: 0,
      systemPrompt,
    })
  }

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const group = openTurn(state, message)
        push(state, group, userRecord(message))
        break
      }
      case 'assistant': {
        const group = openStep(state)
        const record = assistantRecord(message, starts, usage.get(message.id))
        // 换模型（含第一条请求）在投影里打标记：表格只在这些位置显示模型徽章
        if (record.request?.model && record.request.model !== state.lastModel) {
          state.lastModel = record.request.model
          record.request = { ...record.request, modelShift: true }
        }
        push(state, group, record)
        for (const call of message.toolCalls ?? []) {
          claimed.add(call.id)
          push(state, group, toolRecord(message, call, results))
        }
        break
      }
      case 'summary': {
        state.compactionNo += 1
        const turn = newTurn(`compaction:${state.compactionNo}`, null, {
          kind: 'compaction',
          index: state.compactionNo,
        })
        const group = newGroup(`${turn.key}:body`, {
          kind: 'compaction',
          index: state.compactionNo,
        })
        turn.groups.push(group)
        state.turns.push(turn)
        // 压缩段是旁挂的：不改 `state.turn`，后续消息继续落在原轮里
        push(state, group, compactionRecord(message, usage.get(message.id)))
        break
      }
      case 'feedback': {
        push(state, currentGroup(state), contextRecord(message))
        break
      }
      case 'tool': {
        if (message.toolCallId && claimed.has(message.toolCallId)) break
        if (message.toolCallId) claimed.add(message.toolCallId)
        push(state, currentGroup(state), orphanToolRecord(message))
        break
      }
      default:
        break
    }
  }

  return finalize(state.turns)
}

/**
 * 从已加载的轨迹记录聚合「窗口口径」的统计。
 *
 * ⚠️ 它**不是会话题量**：会话是分页加载的（回补历史才会前插更早的记录），窗口外的轮次
 * 根本不在这里。界面上必须标成「已加载」而不是「全部」—— 与账本口径（`requestStatsFromTotals`）
 * 是两个数，不能混着说。
 *
 * @param turns `buildTrajectory` 的输出
 */
export function summarizeTrajectory(
  turns: readonly TrajectoryTurn[],
): TrajectoryWindowStats {
  let turnCount = 0
  /** 「回复」行数 = 已加载窗口里的 LLM 请求数 */
  let steps = 0
  let tools = 0
  let failures = 0
  let input = 0
  let output = 0
  let cached = 0
  let cacheWrite = 0
  let measuredMs: number | null = null
  let measuredCalls = 0

  for (const turn of turns) {
    // `turn === null` 是「会话开始」/ 压缩段：它们不参与「第 N 轮」编号，也不该计入轮次
    if (turn.turn !== null) turnCount += 1
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (record.input !== undefined) input += record.input
        if (record.output !== undefined) output += record.output
        if (record.cached !== undefined) cached += record.cached
        if (record.cacheWrite !== undefined) cacheWrite += record.cacheWrite
        if (record.isError === true) failures += 1
        if (record.kind === 'tool') tools += 1
        if (record.kind === 'message') steps += 1
        // 只有账本实测的耗时进统计：反推值与工具耗时不是「请求耗时」，混进来会让均值失真
        const measured = record.request?.durationMs
        if (measured !== undefined) {
          measuredMs = (measuredMs ?? 0) + measured
          measuredCalls += 1
        }
      }
    }
  }

  return {
    turns: turnCount,
    steps,
    tools,
    failures,
    measuredMs,
    measuredCalls,
    input,
    output,
    cached,
    cacheWrite,
    // 与账本口径同一个分母（`input + cached + cacheWrite`），否则两条路径的百分比会不一样
    cacheHitRatio:
      input + cached + cacheWrite > 0
        ? Math.min(cached / (input + cached + cacheWrite), 1)
        : null,
  }
}

/**
 * 账本聚合桶 → 会话级请求统计（纯换算，UI 不自己算命中率）。
 *
 * 命中率分母用 `prompt + cached + cacheWrite`：账本口径约定
 * `prompt + cached + cache_write + completion = total`（OpenAI 的 `promptTokens` 已扣除缓存，
 * Anthropic 的 `input_tokens` 本就不含），所以这三项之和才是「这次请求一共看了多少输入 token」。
 *
 * @param totals 账本 totals（`statsRepo.stats()`，未受分页影响）
 */
export function requestStatsFromTotals(
  totals: TrajectoryRequestTotals,
): TrajectoryLedgerStats {
  const denominator = totals.promptTokens + totals.cachedTokens + totals.cacheWriteTokens
  return {
    calls: totals.calls,
    chatCalls: totals.chatCalls,
    estimatedCalls: totals.estimatedCalls,
    input: totals.promptTokens,
    output: totals.completionTokens,
    cached: totals.cachedTokens,
    cacheWrite: totals.cacheWriteTokens,
    cacheHitRatio:
      denominator > 0 ? Math.min(totals.cachedTokens / denominator, 1) : null,
  }
}
