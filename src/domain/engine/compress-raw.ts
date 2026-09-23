/**
 * 正文压缩（本地压缩）— 不调用 LLM 的上下文压缩
 *
 * 与 AI 摘要（compress-context.ts）互补：
 * - AI 摘要：一次模型调用，把历史「总结」成很短的一段（更省 token），但慢、且本身要花钱；
 * - 正文压缩：纯本地、毫秒级，**用户/助手正文一字不删**，只砍掉信息密度最低的部分：
 *   1. 深度思考（reasoningContent）整段丢弃 —— 过程性内容，对后续对话价值最低；
 *   2. 工具调用参数 / 工具结果超长则省略 —— 工具输出通常占了历史里绝大部分 token；
 *   3. 图片块进不了文本 → 降级为占位；若该消息做过本地视觉分析，保留分析文本。
 *
 * ⚠️ 产物仍是一条 `role='summary'` 消息（与 AI 摘要同构，Provider 侧处理方式完全一致），
 * 而 `buildRequest` 会丢弃 summary 之前的全部消息 —— 所以这里生成的文本必须**自包含**。
 */
import type { Message } from '@/types'
import {
  fileBlockToText,
  quoteBlockToText,
  skillBlockToText,
} from '@/types'
// ⚠️ 截断必须代理对安全：裸 slice 会把 emoji 切成孤立代理，
// 经 JSON.stringify + Rust serde_json 报 "unexpected end of hex escape"
import { sliceHead, sliceTail } from '@/utils/text'

/** 工具调用参数超过该长度即省略尾部（参数是结构化的，头部保留可读性最好） */
const TOOL_ARGS_MAX_CHARS = 300
/** 工具结果超过该长度即省略中间 */
const TOOL_RESULT_MAX_CHARS = 800
/** 工具结果省略时保留的头部 / 尾部长度（尾部常带报错、汇总等结论） */
const TOOL_RESULT_HEAD_CHARS = 500
const TOOL_RESULT_TAIL_CHARS = 200

/** 图片块占位（图片本身进不了文本上下文） */
const IMAGE_PLACEHOLDER = '[Image]'

/**
 * 省略标记 —— 模型可读的非 UI 文案，与 ATTACHED_FILE_LABEL 等同风格用英文，
 * 且必须显式告诉模型「这里被裁掉了多少」，否则它会以为内容本就这么短。
 */
function omitMark(chars: number): string {
  return `…(${chars} characters omitted)`
}

/** 角色标题（模型可读） */
const ROLE_HEADERS: Record<string, string> = {
  user: '## User',
  assistant: '## Assistant',
  summary: '## Earlier summary',
  feedback: '## Verification feedback',
}

export interface RawCompressResult {
  /** 压缩后的历史文本（写入 summary 消息的 content） */
  summary: string
  /** 被省略的总字符数（供埋点 / UI 说明） */
  omittedChars: number
}

/** 截断尾部：保留前 max 个字符（代理对安全，见 utils/text） */
function truncateTail(
  text: string,
  max: number,
): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 }
  const omitted = text.length - max
  return { text: `${sliceHead(text, max)}\n${omitMark(omitted)}`, omitted }
}

/** 截断中间：保留头 head + 尾 tail 个字符（代理对安全） */
function truncateMiddle(
  text: string,
  max: number,
  head: number,
  tail: number,
): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 }
  const omitted = text.length - head - tail
  return {
    text: `${sliceHead(text, head)}\n${omitMark(omitted)}\n${sliceTail(text, tail)}`,
    omitted,
  }
}

/** 参数对象 → JSON 字符串（循环引用 / 非序列化值兜底，不能因压缩失败而中断） */
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? ''
  } catch {
    return String(input)
  }
}

/**
 * 消息 content → 纯文本
 *
 * 正文（text 块）一字不删；file / quote / skill 块复用各协议共用的降级函数，
 * 保证「压缩后的历史」与「消息直接发给模型时」看到的是同一套文本形式。
 */
function contentToText(msg: Message): string {
  const c = msg.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''

  const parts: string[] = []
  // 视觉分析结果属于消息级、不该在多张图片时重复膨胀，只挂在第一张图上
  let visionUsed = false
  const visionText = msg.imageVisionAnalyzeResult

  for (const block of c) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        parts.push(block.text || '')
        break
      case 'file':
        parts.push(fileBlockToText(block))
        break
      case 'quote':
        parts.push(quoteBlockToText(block))
        break
      case 'skill':
        parts.push(skillBlockToText(block))
        break
      case 'tool_result':
        parts.push(block.content || '')
        break
      case 'tool_use':
        parts.push(`- [tool call] ${block.name}: ${safeStringify(block.input)}`)
        break
      case 'image_url':
        if (visionText && !visionUsed) {
          visionUsed = true
          parts.push(`${IMAGE_PLACEHOLDER}\n${visionText}`)
        } else {
          parts.push(IMAGE_PLACEHOLDER)
        }
        break
    }
  }
  return parts.filter(Boolean).join('\n')
}

/** 是否有图片块（决定要不要加占位说明） */
function hasImageBlock(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b && typeof b === 'object' && b.type === 'image_url'),
  )
}

/**
 * toolCallId → 工具名。
 *
 * 工具结果消息只带 toolCallId，不带工具名；映射后摘要里能写出
 * `## Tool result: read_file` 而不是一串无意义 id，模型可读性显著更好。
 */
function collectToolNames(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    for (const tc of msg.toolCalls || []) {
      if (tc?.id) map.set(tc.id, tc.name)
    }
  }
  return map
}

/** 头部说明：告诉模型这段历史被怎么处理过（省略量显式写出） */
function buildPreamble(hasImage: boolean, omittedChars: number): string {
  const notes = [
    'Locally compressed historical context: reasoning content removed; user and assistant messages kept verbatim; oversized tool arguments and results truncated.',
  ]
  if (hasImage) {
    notes.push('Images are represented as placeholders (analysis text kept when available).')
  }
  if (omittedChars > 0) {
    notes.push(`Truncated ${omittedChars} characters in total.`)
  }
  return `# Conversation history\n\n${notes
    .map((n) => `> ${n}`)
    .join('\n')}`
}

/**
 * 把历史消息渲染成一段自包含的纯文本（正文压缩的核心）
 *
 * @param messages 需要被压缩的消息（调用方可先做「最后一个 summary 起算」的切片）
 */
export function buildRawSummary(messages: Message[]): RawCompressResult {
  const toolNames = collectToolNames(messages)
  const blocks: string[] = []
  let omittedChars = 0

  for (const msg of messages) {
    // 工具结果：只保留头尾，中间省略（工具输出占了历史里的大头）
    if (msg.role === 'tool') {
      const name = msg.toolCallId ? toolNames.get(msg.toolCallId) : undefined
      const r = truncateMiddle(
        contentToText(msg),
        TOOL_RESULT_MAX_CHARS,
        TOOL_RESULT_HEAD_CHARS,
        TOOL_RESULT_TAIL_CHARS,
      )
      omittedChars += r.omitted
      const header = `## Tool result${name ? `: ${name}` : ''}${
        msg.isError ? ' (error)' : ''
      }`
      blocks.push(r.text ? `${header}\n${r.text}` : header)
      continue
    }

    const header = ROLE_HEADERS[msg.role] ?? `## ${msg.role}`
    const lines = [header]
    const body = contentToText(msg)
    if (body) lines.push(body)

    // 助手发起的工具调用：保留「调用了哪个工具 + 参数」，参数超长只截尾部。
    // 深度思考（reasoningContent）按需求**整段丢弃**，连占位都不写（头部的说明已交代）。
    for (const tc of msg.toolCalls || []) {
      const args = truncateTail(safeStringify(tc.input), TOOL_ARGS_MAX_CHARS)
      omittedChars += args.omitted
      lines.push(`- [tool call] ${tc.name}: ${args.text}`)
    }

    blocks.push(lines.join('\n'))
  }

  const summary = [
    buildPreamble(hasImageBlock(messages), omittedChars),
    ...blocks,
  ].join('\n\n')

  return { summary, omittedChars }
}
