/**
 * 消息行模型：消息数组 → 列表的「行」（虚拟列表需要稳定的记账单位）。
 *
 * 两条规则：连续的工具调用合成一组（≥2 次才成组）；`role:'tool'` 结果不占地、不打断工具段。
 * 组的边界 = 中段带正文的 assistant + 不带工具调用的消息（正文是看得见的边界）。
 *
 * 尾部段（tools 行的 tail）：后面再没有可见气泡时默认展开，否则用户看不到进展。
 */
import type { Message } from '@/types'
import { VISION_IMAGE_ROLE } from '@/types'
import {
  messageHasAttachmentBlocks,
  messageHasBody,
  messageHasVisibleContent,
} from '@/utils/messageContent'
import { tpl } from '@/ui/i18n'

/** 列表的一行。 */
export type ListRow =
  /** 一条自己成行的消息。 */
  | { kind: 'one'; key: string; messageIndex: number }
  /**
   * 一段连续的工具调用（≥2 次才成组），成员是 messages 下标。
   * tail = 后面再没有可见气泡 —— 默认展开。
   */
  | { kind: 'tools'; key: string; messageIndexes: number[]; tail: boolean }

/**
 * 组行 key 前缀：用首条成员的 id 加前缀。
 * 头插续页时首条会换（key 也换），折叠态回默认 —— 那时用户本就在往上翻历史，可接受。
 */
export const TOOL_GROUP_PREFIX = 'tools:'

/**
 * 是否属于「这段连续工具调用」：role==='assistant' 且至少一个 toolCalls。
 * 正文不作排除项；但带引用 / 文件 / 技能 / 图片块的不并入（那些块在气泡里另有渲染，会被藏掉）。
 */
export function isToolCallMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false
  if (!message.toolCalls || message.toolCalls.length === 0) return false
  // 带引用 / 图片 / 文件 / 技能块的不并入：会被折叠组藏掉
  if (messageHasAttachmentBlocks(message.content)) return false
  return true
}

/**
 * 切行：连续工具调用合成一组，tool 消息不占行；顺序保持原样。
 * @param groupTools 为 false 时每条消息各占一行（含 tool），与旧行为一致。
 */
export function buildRows(
  messages: readonly Message[],
  groupTools: boolean,
): ListRow[] {
  const rows: ListRow[] = []
  /** 正在攒的工具段（存 messages 下标，遇到看得见的东西就收口）。 */
  let run: number[] = []
  const flush = () => {
    if (run.length === 0) return
    // 阈值按「工具调用总数」而非消息条数：一条 assistant 并行发多个调用同样应成组
    let calls = 0
    for (const i of run) calls += messages[i].toolCalls?.length ?? 0
    if (calls >= 2) {
      rows.push({
        kind: 'tools',
        key: TOOL_GROUP_PREFIX + messages[run[0]].id,
        messageIndexes: run,
        tail: false, // 尾部段判定要等行切完，见文末反向扫描
      })
    } else {
      // 只有一次工具调用：保持单卡（不套折叠头）。
      // run 成员都至少 1 个 toolCalls，故 calls < 2 只可能在 run.length === 1 时成立。
      rows.push({ kind: 'one', key: messages[run[0]].id, messageIndex: run[0] })
    }
    run = []
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    // 「工具把图片交给模型」的注入消息：**永不渲染**（用户没发这张图，工具结果里已有文字交代）。
    // 放在 tool 之前判：这条不论是否开启折叠都不占行。
    if (message.role === VISION_IMAGE_ROLE) continue
    // 启用折叠时：tool 消息不渲染，不占行也不打断工具段
    if (groupTools && message.role === 'tool') continue
    // 带工具调用的 assistant：并入当前段。中段再遇带正文的宿主就收口（正文是看得见的边界）
    if (groupTools && isToolCallMessage(message)) {
      if (run.length > 0 && messageHasBody(message)) flush()
      run.push(index)
      continue
    }
    // 不占工具行的消息（user / system / 无 toolCalls 的 assistant）：收口后自占一行
    flush()
    rows.push({ kind: 'one', key: message.id, messageIndex: index })
  }
  flush()

  // 尾部段：从后往前扫，看每行之后有没有可见气泡。
  // 只有「可见」的才打断扫描：tool 结果与空壳 assistant 都不算，否则会闪一下折叠、尾段误判成已收尾。
  // 组自己的段首正文对前面的行也算可见，否则中段切开的两段会双双被当成尾段。
  let visibleAfter = false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.kind === 'tools') {
      row.tail = !visibleAfter
      const lead = messages[row.messageIndexes[0]]
      if (lead && messageHasVisibleContent(lead)) visibleAfter = true
    } else if (messageHasVisibleContent(messages[row.messageIndex])) {
      visibleAfter = true
    }
  }
  return rows
}

/**
 * 「消息下标 → 行下标」映射（长度 = messages.length）。
 * tool 消息不占行，未映射的下标向前填到最近一个已映射行。
 */
export function buildRowIndexMap(
  messages: readonly Message[],
  rows: readonly ListRow[],
): number[] {
  const map = new Array<number>(messages.length).fill(-1)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (row.kind === 'one') {
      map[row.messageIndex] = rowIndex
    } else {
      for (const messageIndex of row.messageIndexes) map[messageIndex] = rowIndex
    }
  }
  /** 未映射（tool / vision_image 消息）：向前填到宿主所在行 */
  let last = 0
  for (let i = 0; i < map.length; i++) {
    if (map[i] >= 0) last = map[i]
    else map[i] = last
  }
  return map
}

/** 工具组头部展示的聚合状态（决定状态点颜色）。 */
export type ToolGroupStatus = 'done' | 'pending' | 'error'

/** 头部最多预览几个工具名（多出来的折成 +N）。 */
export const TOOL_GROUP_PREVIEW_MAX = 3

/** 工具组折叠态的视图模型（组件只负责摆 HTML，这里决定「显示什么」）。 */
export interface ToolGroupView {
  /** 折叠态的计数文案（`3 次工具调用`）。 */
  label: string
  /** 段内出现过的工具名（去重、保持顺序、最多 TOOL_GROUP_PREVIEW_MAX 个）。 */
  tools: string[]
  /** 被折叠掉、未进 `tools` 的工具名个数（渲染成 `+N`）。 */
  moreTools: number
  /** 聚合状态：任一结果缺失 → pending；任一失败 → error；否则 done。 */
  status: ToolGroupStatus
  /**
   * 这段工具调用**实际占用**的时间跨度（ms）：AI 开始思考（组内第一轮 LLM 请求发出）→
   * 最后一个工具执行结束。
   *
   * 不是各工具耗时之和：把「AI 思考 + 首 token 等待 + 工具参数生成」和各轮之间的停顿全算在内 ——
   * 用户看到的「这段工具跑了那么久」本就是一个墙钟区间。
   *
   * 起点取组内最早的成员 `timestamp`：引擎是在发请求**之前**就把 timestamp 打在 assistant 消息上的
   * （`llm_round.rs`），所以「模型思考到决定调这个工具」这段全落在起点之后 —— 只按工具自己的开始
   * （`结果 timestamp - elapsedMs`）起算会把它整段漏掉，看着就像只加了几个工具的执行时间。
   * 终点由结果消息反推：`result.timestamp` 是工具**结束**时刻，`result.elapsedMs` 是它自己的
   * 执行耗时，故该工具的开始 = `timestamp - elapsedMs`（Rust `tool_executor` 就是这样记的），
   * 取它与成员 timestamp 的更早者、以及所有结束时刻的更晚者。
   * 没记耗时 / 没结果（还在跑）的一律不参与端点：宁可少算一个端点，也不要拿「补的占位结果」
   * （取消、程序中断，timestamp 是补偿时刻）去把跨度撑成好几天。
   */
  spanMs: number
}

/**
 * 工具组折叠态视图模型。resultsOf 把 assistant 消息映射到与 toolCalls 一一对应的结果数组。
 */
export function toolGroupView(
  messages: readonly Message[],
  resultsOf: (message: Message) => readonly (Message | undefined)[],
): ToolGroupView {
  let calls = 0
  let hasPending = false
  let hasError = false
  /**
   * 起点：AI 开始思考的时刻（组内最早成员的 timestamp）/ 末端：最后一个工具结束的时刻（毫秒时间戳）
   */
  let spanStart: number | undefined
  let spanEnd: number | undefined
  const tools: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    // 成员 = 一轮 LLM 请求的 assistant 消息，它的 timestamp 是发请求前打的时间戳：
    // 「AI 思考 + 首 token 等待 + 生成工具参数」全在这之后，故它才是这段工具调用的真实起点
    const roundStart = message.timestamp
    if (
      typeof roundStart === 'number' &&
      roundStart > 0 &&
      (spanStart === undefined || roundStart < spanStart)
    ) {
      spanStart = roundStart
    }
    const toolCalls = message.toolCalls ?? []
    calls += toolCalls.length
    const results = resultsOf(message)
    for (let i = 0; i < toolCalls.length; i++) {
      const name = toolCalls[i].name
      if (name && !seen.has(name)) {
        seen.add(name)
        if (tools.length < TOOL_GROUP_PREVIEW_MAX) tools.push(name)
      }
      const result = results[i]
      if (!result) {
        hasPending = true
      } else if (result.isError) {
        hasError = true
      }
      const ms = result?.elapsedMs
      const end = result?.timestamp
      if (
        typeof ms === 'number' &&
        ms > 0 &&
        typeof end === 'number' &&
        end > 0
      ) {
        const start = end - ms
        if (spanStart === undefined || start < spanStart) spanStart = start
        if (spanEnd === undefined || end > spanEnd) spanEnd = end
      }
    }
  }
  return {
    label: tpl('$__count__ 次工具调用', { count: calls }),
    tools,
    moreTools: Math.max(0, seen.size - tools.length),
    status: hasError ? 'error' : hasPending ? 'pending' : 'done',
    spanMs:
      spanStart !== undefined && spanEnd !== undefined
        ? Math.max(0, spanEnd - spanStart)
        : 0,
  }
}
