/**
 * 消息**行模型**：消息数组 → 列表的「行」。
 *
 * 为何要中间一层：虚拟列表需要「行」是稳定的记账单位（折叠态按行的 `key` 记账），而「一条消息 = 一行」
 * 在真机上不成立（与移动端 `virlen-mobile/src/lib/message-rows.ts` 同源）：
 * 1. **连续的工具调用**（一路 `read_file` / `search_text_in_files` 把对话流刷屏）→ 合成**一组**，折叠剩一行；
 * 2. **tool 消息**（`role:'tool'` 的结果文本）在气泡里**永远渲染 null** → 不该单独成行，也不该打断工具段。
 *
 * ⚠️ 与移动端的差异：移动端工具调用就是 `role:'tool'` 消息；桌面端工具卡片挂在 **assistant 消息**的
 * `toolCalls` 上，结果另存为 `tool` 消息按 `toolCallId` 回填。故这里「一段连续工具调用」= 连续的**带工具调用
 * 的 assistant 消息**（判据 `isToolCallMessage`），中间的 `tool` 结果消息不打断合并。
 *
 * ⚠️ 引擎每轮先落一条 assistant，真机上 `assistant(工具) → tool → assistant(工具) → tool …` 是常态。
 * 对**正文**：**段首**宿主带正文 → 允许（显示在组头之上，不随折叠隐藏）；**中段**再遇带正文的宿主 → 收口
 * （正文是看得见的边界，另起一段，不把前后两截强行并组）。故组的边界 = 中段带正文的 assistant +
 * 不带工具调用的消息（`user` / `system` / 最终回答）。
 *
 * 纯函数：可单测（`tests/ui/tool-group-rows.test.ts`），组件只负责摆 HTML。
 */
import type { Message } from '@/types'
import { messageHasAttachmentBlocks, messageHasBody } from '@/utils/messageContent'
import { tpl } from '@/ui/i18n'

/** 列表的一行。 */
export type ListRow =
  /** 一条自己成行的消息。`key` 直接用消息 id。`messageIndex` = 它在 messages 里的下标。 */
  | { kind: 'one'; key: string; messageIndex: number }
  /** 一段连续的工具调用（≥2 条才成组，见 `buildRows`）。成员是 messages 的下标数组。 */
  | { kind: 'tools'; key: string; messageIndexes: number[] }

/**
 * 组行的 `key` 前缀。组没有「一条消息的 id」可用（成员会往后长），但折叠态需要稳定 key：
 * 用**首条成员**的 id 加前缀 —— 尾部继续长大时首条不变，折叠态就跟着它走。
 *
 * ⚠️ 头插（上拉续页）把更早的工具调用接到组前时首条会换、key 也就换 —— 那一次折叠态回默认，
 * 虚拟库的测量缓存也按 key 失效。可接受：那种情况用户本来就在往上翻历史。
 */
export const TOOL_GROUP_PREFIX = 'tools:'

/**
 * 一条消息是否属于「这段连续工具调用」（= 带工具调用的 assistant）：`role==='assistant'` + 至少一个 `toolCalls`。
 * **正文不再是排除项**（段首正文显示在组头之上；中段正文的收口在 `buildRows`）。
 *
 * 仍排除带引用 / 文件 / 技能 / 图片块的消息：那些块在气泡里另有可见渲染，吞进折叠组会连带藏掉它们。
 */
export function isToolCallMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false
  if (!message.toolCalls || message.toolCalls.length === 0) return false
  // 带引用 / 图片 / 文件 / 技能块的不并入：那些块在气泡里另有可见渲染，
  // 吞进折叠组会连带把它们藏掉（判据与气泡同源，见 messageHasAttachmentBlocks）。
  if (messageHasAttachmentBlocks(message.content)) return false
  return true
}

/**
 * 切行：连续的工具调用合成一组，`tool` 消息不占行、不打断；顺序保持原样（只做「合并 / 跳过」两种减法）。
 * @param groupTools 为 false 时每条消息各占一行（含 `tool` 消息），与改动前行为一致 —— 折叠仅在
 *   设置「隐藏工具调用的思考过程消息」开启时启用。
 */
export function buildRows(
  messages: readonly Message[],
  groupTools: boolean,
): ListRow[] {
  const rows: ListRow[] = []
  /** 正在攒的工具调用段（遇到看得见的东西就收口）。存的是 messages 下标。 */
  let run: number[] = []
  const flush = () => {
    if (run.length === 0) return
    // 阈值按「**工具调用总数**」而非消息条数：一次 assistant 并行发多个工具调用同样应合成一组
    let calls = 0
    for (const i of run) calls += messages[i].toolCalls?.length ?? 0
    if (calls >= 2) {
      rows.push({
        kind: 'tools',
        key: TOOL_GROUP_PREFIX + messages[run[0]].id,
        messageIndexes: run,
      })
    } else {
      // 只有一次工具调用：保持原来那张单卡（不套一层折叠头）。
      // ⚠️ 不变量：run 的每个成员都至少 1 个 toolCalls（见 isToolCallMessage），所以 `calls < 2` 只可能
      // 在 run.length === 1 时成立 —— 丢弃 run[1..] 是安全的。将来若放宽 isToolCallMessage，必须同步改这里。
      rows.push({ kind: 'one', key: messages[run[0]].id, messageIndex: run[0] })
    }
    run = []
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    // 启用折叠时：tool 消息不渲染（高度 0），不占行也不打断工具段；未启用时照旧自占一行
    if (groupTools && message.role === 'tool') continue
    // 带工具调用的 assistant：并入当前工具段（仅在启用折叠时）
    if (groupTools && isToolCallMessage(message)) {
      // 段首宿主可带正文（显示在组头之上）；但**中段**再遇带正文的宿主就收口 —— 正文是看得见的边界
      if (run.length > 0 && messageHasBody(message)) flush()
      run.push(index)
      continue
    }
    // 不带工具调用的东西（user / system / 无 toolCalls 的 assistant…）：收口后自占一行
    flush()
    rows.push({ kind: 'one', key: message.id, messageIndex: index })
  }
  flush()
  return rows
}

/**
 * 建立「消息下标 → 行下标」的映射（长度 = messages.length）。虚拟库与滚动 / 跳转控制器按**行下标**工作，
 * 而锚点、检索命中等入口拿到的是**消息下标**，两者必须能换算。
 *
 * `tool` 消息不占行，故未映射的下标**向前填充到最近一个已映射行**（tool 结果紧跟在宿主之后，语义上同一行）。
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
/** 未映射（tool 消息 / 前导 tool）：向前填充，落到宿主所在的同一行 */
  let last = 0
  for (let i = 0; i < map.length; i++) {
    if (map[i] >= 0) last = map[i]
    else map[i] = last
  }
  return map
}

/** 工具组头部展示的聚合状态（决定状态点颜色）。 */
export type ToolGroupStatus = 'done' | 'pending' | 'error'

/** 头部最多预览几个工具名（多出来的折成 `+N`）。 */
export const TOOL_GROUP_PREVIEW_MAX = 3

/** 工具组折叠态的视图模型（组件只负责摆 HTML，这里决定「显示什么」）。 */
export interface ToolGroupView {
  /** 折叠态的计数文案（`3 次工具调用`）。 */
  label: string
  /** 段内出现过的工具名（去重、保持顺序、最多 `TOOL_GROUP_PREVIEW_MAX` 个）。 */
  tools: string[]
  /** 被折叠掉、未进 `tools` 的工具名个数（渲染成 `+N`）。 */
  moreTools: number
  /** 聚合状态：任一结果缺失 → `pending`；任一失败 → `error`；否则 `done`。 */
  status: ToolGroupStatus
}

/**
 * 工具组的折叠态视图模型。`resultsOf` 把 assistant 消息映射到与 `toolCalls` 一一对应的结果数组
 *（与列表里的 `toolResultsFor` 同源）—— 组件与测试都只依赖这一个口径。
 */
export function toolGroupView(
  messages: readonly Message[],
  resultsOf: (message: Message) => readonly (Message | undefined)[],
): ToolGroupView {
  let calls = 0
  let hasPending = false
  let hasError = false
  const tools: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
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
    }
  }
  return {
    label: tpl('$__count__ 次工具调用', { count: calls }),
    tools,
    moreTools: Math.max(0, seen.size - tools.length),
    status: hasError ? 'error' : hasPending ? 'pending' : 'done',
  }
}
