/**
 * 消息格式修复 — 检测并修补「assistant 声明了 tool_calls，却缺少对应 tool 返回」的异常历史。
 *
 * 背景（线上故障）：应用在「LLM 已产出 tool_calls、工具还没返回」时被中断（崩溃/强杀），
 * assistant(tool_calls) 已落库（引擎刻意先落库再执行工具）但 tool 结果未写入，留下悬空 tool_calls，
 * 下次请求被服务端 400 拒绝：「An assistant message with 'tool_calls' must be followed by tool messages...」。
 *
 * 修复：为悬空 tool_call_id 补一条占位 tool 消息（内容「程序中断」，isError=true）；
 * 位置错乱的返回则归位，不重复补入。
 *
 * 只扫首/尾窗口（各 REPAIR_SCAN_WINDOW 条）：中断残留只可能出现在消息尾部（尾窗=主场景），
 * 首窗兜底「会话很早被中断、之后一直没发消息」。仅当确实要补占位时才按 toolCallId 全量查重。
 */

import { v4 } from '@/utils/uuid'
import type { Message } from '@/types'

/** 占位 tool 返回文案：应用异常中断，工具没有真实结果 */
export const INTERRUPTED_TOOL_RESULT = '程序中断'

/** 检测窗口：只扫描首/尾各 N 条消息（不扫全量历史） */
export const REPAIR_SCAN_WINDOW = 20

export interface RepairToolCallOptions {
  /** 检测窗口大小（首/尾各 N 条），默认 REPAIR_SCAN_WINDOW */
  window?: number
  /** 是否检测开头窗口（默认 true） */
  scanHead?: boolean
  /** 是否检测末尾窗口（默认 true） */
  scanTail?: boolean
}

export interface RepairToolCallResult {
  /** 修复后的消息列表（无异常时与入参同一引用，便于调用方判断是否变化） */
  messages: Message[]
  /** 补入的占位 tool 消息条数 */
  inserted: number
  /** 归位的错位 tool 消息条数 */
  moved: number
}

/** 本次修复是否改动了消息列表 */
export function isRepaired(result: RepairToolCallResult): boolean {
  return result.inserted > 0 || result.moved > 0
}

/** 构造「程序中断」占位 tool 返回消息 */
export function makeInterruptedToolResult(toolCallId: string): Message {
  return {
    id: v4(),
    role: 'tool',
    content: INTERRUPTED_TOOL_RESULT,
    toolCallId,
    isError: true,
    timestamp: Date.now(),
  }
}

/**
 * 收集需要检测的消息下标（首窗 + 尾窗，去重后**降序**）。
 *
 * 降序是必需的：修复会在 assistant 之后插入消息，若按升序遍历，后面的下标会整体偏移。
 */
function collectScanIndexes(
  length: number,
  window: number,
  scanHead: boolean,
  scanTail: boolean,
): number[] {
  const indexes = new Set<number>()
  if (scanHead) {
    for (let i = 0; i < Math.min(window, length); i++) indexes.add(i)
  }
  if (scanTail) {
    for (let i = Math.max(0, length - window); i < length; i++) indexes.add(i)
  }
  return [...indexes].sort((a, b) => b - a)
}

/**
 * 检测并修复「悬空 tool_calls」（纯函数，无副作用）。
 * @param messages 会话消息列表
 * @param options  检测窗口配置
 */
export function repairToolCallMessages(
  messages: Message[],
  options: RepairToolCallOptions = {},
): RepairToolCallResult {
  const length = messages.length
  if (length === 0) return { messages, inserted: 0, moved: 0 }

  const window = Math.max(1, Math.floor(options.window ?? REPAIR_SCAN_WINDOW))
  const indexes = collectScanIndexes(
    length,
    window,
    options.scanHead ?? true,
    options.scanTail ?? true,
  )

  let list = messages
  let dirty = false
  let inserted = 0
  let moved = 0

  for (const i of indexes) {
    const msg = list[i]
    if (!msg || msg.role !== 'assistant') continue
    const toolCalls = msg.toolCalls
    if (!toolCalls || toolCalls.length === 0) continue

    // 协议要求 tool 消息**紧跟在** assistant(tool_calls) 之后，故只看紧随其后的连续 tool 段
    let end = i + 1
    while (end < list.length && list[end]?.role === 'tool') end++
    const answered = new Set<string>()
    for (let k = i + 1; k < end; k++) {
      const id = list[k].toolCallId
      if (id) answered.add(id)
    }

    const pending = toolCalls.filter((tc) => tc.id && !answered.has(tc.id))
    if (pending.length === 0) continue

    if (!dirty) {
      // 惰性复制：无异常时保持入参引用不变（调用方可零成本判断「没改动」）
      list = [...messages]
      dirty = true
    }

    // 插入位置：紧随最后一个已存在的 tool 消息之后，保持 tool 段连续
    let cursor = end
    for (const tc of pending) {
      // 同 id 的返回消息「已存在但位置错乱」→ 归位（而不是补成重复项）
      const misplaced = list.findIndex(
        (m, idx) => idx >= end && m.role === 'tool' && m.toolCallId === tc.id,
      )
      if (misplaced !== -1) {
        const [resp] = list.splice(misplaced, 1)
        if (misplaced < cursor) cursor--
        list.splice(cursor, 0, resp)
        moved++
      } else {
        list.splice(cursor, 0, makeInterruptedToolResult(tc.id))
        inserted++
      }
      cursor++
    }
  }

  return { messages: list, inserted, moved }
}
