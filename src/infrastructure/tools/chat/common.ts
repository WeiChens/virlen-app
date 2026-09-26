/**
 * chat — 会话消息分类公共函数（分类 id: chat）
 *
 * 供 `list_messages` / `read_messages` 复用：硬上限常量（与 Rust 侧 `MSG_QUERY_*` 对齐，服务端另有一份
 * clamp 兜底）、面向模型的英文文本格式化（不是 UI 文案、不进 i18n）、单会话字符预算（滑窗，防止模型反复
 * 查询把上下文刷爆）。
 *
 * ⚠️ Step 2 起两个工具已在 Rust 侧原生化（`native_tools/chat/`）—— 本文件的格式化 / 上限 / 预算逻辑有了
 * 第二份实现，改一边必须同步另一边（铁律 1）。
 */
import type {
  MessageTimelinePage,
  MessageWindow,
} from '@/infrastructure/sessionRepo'
import { sliceHead } from '@/utils/text'

/** 概览单页条数：默认 / 上限（Rust 侧亦按 MSG_QUERY_MAX_LIMIT clamp） */
export const LIST_DEFAULT_LIMIT = 30
export const LIST_MAX_LIMIT = 50

/** 窗口相对偏移：默认前后各 5 条；单侧上限与 Rust 侧 MSG_QUERY_MAX_BACK/FWD 对齐 */
export const WINDOW_DEFAULT_SPAN = 5
export const WINDOW_MAX_BACK = 20
export const WINDOW_MAX_FWD = 20

/** 单次调用输出总字符上限（超出则截断并提示缩小窗口） */
export const CALL_OUTPUT_MAX_CHARS = 30000

/** 单会话滑窗预算：窗口内累计返回的字符上限 */
export const BUDGET_WINDOW_MS = 60_000
export const BUDGET_MAX_CHARS = 60_000

// ==================== 单会话字符预算（滑窗） ====================

interface BudgetEntry {
  windowStart: number
  chars: number
}

const budgets = new Map<string, BudgetEntry>()

/**
 * 判断本次还能否返回 `chars` 个字符，并从预算中扣除。
 *
 * StormBreaker 只能拦「同名 + 同参」的重复调用，模型换个锚点 id 就能绕开；
 * 因此这里再加一道按会话的滑窗预算，做到「不能把历史一次性刷出来」。
 */
export function consumeBudget(sessionId: string, chars: number): boolean {
  const now = Date.now()
  pruneBudgets(now)
  let entry = budgets.get(sessionId)
  if (!entry || now - entry.windowStart > BUDGET_WINDOW_MS) {
    entry = { windowStart: now, chars: 0 }
    budgets.set(sessionId, entry)
  }
  if (entry.chars + chars > BUDGET_MAX_CHARS) return false
  entry.chars += chars
  return true
}

/** 清空预算（仅测试用） */
export function resetBudget(): void {
  budgets.clear()
}

/** 惰性清理过期会话，避免 Map 随会话数无限增长 */
function pruneBudgets(now: number): void {
  if (budgets.size < 64) return
  for (const [id, entry] of budgets) {
    if (now - entry.windowStart > BUDGET_WINDOW_MS) budgets.delete(id)
  }
}

// ==================== 文本上限 ====================

/** 全量输出截断（超出追加提示，引导模型缩小窗口） */
export function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= CALL_OUTPUT_MAX_CHARS) return { text, truncated: false }
  return {
    text:
      sliceHead(text, CALL_OUTPUT_MAX_CHARS) +
      '\n…[output truncated — narrow the window or reduce limit]',
    truncated: true,
  }
}

/** 概览行首提示：说明「可查询区间」与「已在上下文的部分」 */
function timelineHeader(page: MessageTimelinePage): string[] {
  const boundary = page.boundarySeq
  const queryable = boundary === null ? 0 : boundary - 1
  return [
    `Queryable history: #1..#${queryable} (${queryable} messages); conversation total: ${page.total}.`,
    `Messages from #${boundary} onward (the compression summary and later) are already in your current context — they are NOT repeated by this tool.`,
    '',
  ]
}

// ==================== 格式化 ====================

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 时序概览 → 模型可读文本（升序，一行一条，含 id 便于接着用 read_messages） */
export function formatTimeline(page: MessageTimelinePage): string {
  const lines = timelineHeader(page)
  for (const it of page.items) {
    const tools = it.toolNames.length ? ` tools(${it.toolNames.join(',')})` : ''
    lines.push(
      `#${it.seq} [${it.role}] ${formatTime(it.timestamp)}${tools} | ${it.preview}`,
    )
    lines.push(`    id: ${it.id}`)
  }
  lines.push('')
  lines.push(
    page.hasMore
      ? `To see older messages, call list_messages again with cursor=${page.nextCursor}.`
      : 'This is the oldest page of the queryable history.',
  )
  return lines.join('\n')
}

/** 窗口消息 → 模型可读文本（升序；正文全文，工具详情已截断，思考已剔除） */
export function formatWindow(win: MessageWindow): string {
  const lines: string[] = [
    `Window #${win.startSeq}..#${win.endSeq} around anchor #${win.anchorSeq} (conversation total: ${win.total}).`,
  ]
  if (win.clampedByBoundary) {
    lines.push(
      `The window was cut at #${win.endSeq}: everything after that is already in your context.`,
    )
  }
  lines.push('')
  for (const m of win.messages) {
    lines.push(`#${m.seq} [${m.role}] ${formatTime(m.timestamp)} (id: ${m.id})`)
    for (const tc of m.toolCalls) {
      lines.push(`  tool: ${tc.name} ${tc.inputBrief}`)
    }
    if (m.toolCallId) {
      lines.push(`  toolCallId: ${m.toolCallId}${m.isError ? ' (error)' : ''}`)
    }
    if (m.hasReasoning) {
      lines.push('  [deep-thinking present, omitted]')
    }
    lines.push(m.text ? m.text : '(no text)')
    if (m.hasAttachments) {
      lines.push('  [message has attachments]')
    }
    lines.push('')
  }
  return lines.join('\n')
}
