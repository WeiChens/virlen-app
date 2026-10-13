/**
 * 消息格式修复 — 检测并修补「assistant 声明了 tool_calls，却缺少对应 tool 返回」的异常历史。
 *
 * 背景（线上故障）：应用在「LLM 已产出 tool_calls、工具还没返回」时被中断（崩溃/强杀），
 * assistant(tool_calls) 已落库（引擎刻意先落库再执行工具）但 tool 结果未写入，留下悬空 tool_calls，
 * 下次请求被服务端 400 拒绝：「An assistant message with 'tool_calls' must be followed by tool messages...」。
 *
 * 修复：
 * 1. 为悬空 tool_call_id 补一条占位 tool 消息（内容「程序中断」，isError=true）；
 * 2. 同一 tool_call_id 写了两条 tool 消息（占位先落库、真实结果后到，见去重函数）→ 只留真实结果；
 * 3. 没有 tool_call_id 的孤儿 tool 消息（老版本残留）→ 丢弃；
 * 4. 位置错乱的返回则归位，不重复补入。
 *
 * 窗口策略：②③ 全量线性扫描（合法性只取决于消息自身，且重复项可能是「占位在前、真实结果后到」）；
 * ①④ 只扫首/尾窗口（各 REPAIR_SCAN_WINDOW 条）—— 中断残留只可能出现在消息尾部（尾窗=主场景），
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
  /** 删掉的重复 tool 返回条数（同一 toolCallId 多条） */
  removedDuplicates: number
  /** 删掉的孤儿 tool 消息条数（没有 toolCallId） */
  removedOrphans: number
}

/** 本次修复是否改动了消息列表 */
export function isRepaired(result: RepairToolCallResult): boolean {
  return (
    result.inserted > 0 ||
    result.moved > 0 ||
    result.removedDuplicates > 0 ||
    result.removedOrphans > 0
  )
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

/** 是否为「程序中断」占位（去重时真实结果优先于它） */
function isInterruptedResult(msg: Message): boolean {
  return msg.content === INTERRUPTED_TOOL_RESULT
}

/** 同 id 的重复 tool 返回里，candidate 是否应取代 kept（真实结果优先；同类留最新） */
function isBetterToolResult(candidate: Message, kept: Message): boolean {
  return !(isInterruptedResult(candidate) && !isInterruptedResult(kept))
}

/**
 * 去重 + 丢孤儿（全量线性扫描，不改动无关消息的顺序）。
 *
 * 两类脏数据都会让服务端直接 400（「tool 消息必须应答前置的 tool_calls」）：
 * - 同一 toolCallId 有两条 tool 返回 —— 占位先落库、真实结果后到（线上现场），第二条无可应答的调用；
 * - tool 消息没有 toolCallId（老版本残留）—— 无从应答。
 *
 * 不做窗口裁剪：一条 tool 消息是否合法只取决于它自己，与服务端报错的位置无关。
 */
function dedupeToolResults(messages: Message[]): {
  messages: Message[]
  removedDuplicates: number
  removedOrphans: number
} {
  const survivors = new Map<string, number>()
  const dropped = new Set<number>()
  let removedDuplicates = 0
  let removedOrphans = 0

  messages.forEach((msg, i) => {
    if (msg.role !== 'tool') return
    const id = msg.toolCallId
    if (!id) {
      dropped.add(i)
      removedOrphans++
      return
    }
    const kept = survivors.get(id)
    if (kept === undefined) {
      survivors.set(id, i)
      return
    }
    removedDuplicates++
    if (isBetterToolResult(msg, messages[kept])) {
      dropped.add(kept)
      survivors.set(id, i)
    } else {
      dropped.add(i)
    }
  })

  if (dropped.size === 0) return { messages, removedDuplicates, removedOrphans }
  return {
    messages: messages.filter((_, i) => !dropped.has(i)),
    removedDuplicates,
    removedOrphans,
  }
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
  // 第一步：去重 + 丢孤儿（与窗口无关，全量）
  const deduped = dedupeToolResults(messages)
  let list = deduped.messages
  let dirty = list !== messages
  let inserted = 0
  let moved = 0

  const window = Math.max(1, Math.floor(options.window ?? REPAIR_SCAN_WINDOW))
  const indexes = collectScanIndexes(
    list.length,
    window,
    options.scanHead ?? true,
    options.scanTail ?? true,
  )

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
      list = [...list]
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

  return {
    messages: list,
    inserted,
    moved,
    removedDuplicates: deduped.removedDuplicates,
    removedOrphans: deduped.removedOrphans,
  }
}
