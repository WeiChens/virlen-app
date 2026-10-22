/**
 * 会话导出：把会话转成一份独立完整的 HTML 文档并保存。
 *
 * 用 HTML 不用 Markdown：正文本身就是 Markdown，模板与正文会互相干扰。
 * 行模型与气泡逐条移植自聊天区（rows.ts / message-bubble / tool-call），保证导出与聊天区同构；
 * 纯静态（无 JS，折叠走 <details>），所以默认展开态在渲染时算好写进 HTML。
 * 图片（image_url 块）不导出：base64 会馆文档体积。
 */
import { createElement } from 'react'
import { t, tpl, getCurrentLanguage } from '@/ui/i18n'
import { formatDuration } from '@/utils/time'
import type {
  Message,
  Session,
  FileContent,
  QuoteContent,
  SkillContent,
  ToolUseContent,
} from '@/types'
import {
  getFileBlocks,
  getQuoteBlocks,
  getSkillBlocks,
  messageBodyText,
  messageHasAttachmentBlocks,
  messageHasBody,
  messageHasVisibleContent,
} from '@/utils/messageContent'
import { sessionStore } from '@/ui/store'
import { agentRepo } from '@/infrastructure/agentRepo'

export interface ExportOptions {
  /** 是否省略工具调用信息（tool_use + tool_result） */
  omitToolCalls: boolean
  /** 是否省略思考文本（reasoningContent） */
  omitThinking: boolean
}

const DEFAULT_OPTIONS: ExportOptions = {
  omitToolCalls: false,
  omitThinking: false,
}

/** Markdown → HTML 片段转换器（测试可注入桩）。 */
export type MarkdownToHtml = (markdown: string) => string

/** HTML 转义：会话数据插值一律过一遍。 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* 图标直接取自应用自己的 icon 组件（只留 path，颜色交 currentColor）。 */

/** 折叠箭头（`CollapsedSvg`）：收起朝右 / 展开朝下 */
const CARET_PATH =
  'M225.792 353.792a42.6496 42.6496 0 0 1 60.416 0L512 579.7376l225.792-225.8432a42.6496 42.6496 0 1 1 60.416 60.3136l-256 256a42.6496 42.6496 0 0 1-60.416 0l-256-256a42.6496 42.6496 0 0 1 0-60.3136z'

/** 思考过程图标（`ThinkSvg`） */
const THINK_PATH =
  'M675.67 530.1l44.14 22.73a110.93 110.93 0 0 1 97.57-58.44c61.47 0 111.14 50.33 111.14 112.22s-49.67 112.21-111.14 112.21-111.14-50.33-111.14-112.21v-3.37l-48.15-24.79A175.66 175.66 0 0 1 582 652.37l21.62 76.68h2.26C667.31 729 717 779.36 717 841.24s-49.69 112.22-111.17 112.22-111.14-50.33-111.14-112.22a112.37 112.37 0 0 1 59.5-99.39l-20.81-73.78a173 173 0 0 1-133.73-33.68l-94 81.69a112.85 112.85 0 0 1 8.68 43.55c0 61.89-49.67 112.22-111.14 112.22S92 821.52 92 759.63s49.66-112.22 111.14-112.22a110.1 110.1 0 0 1 72.48 27.14l88.55-76.9a177.69 177.69 0 0 1-10.28-190.43l-109.55-80.57a109.86 109.86 0 0 1-61.6 18.8c-61.48 0-111.15-50.33-111.15-112.22S121.26 121 182.74 121s111.14 50.33 111.14 112.22A112.48 112.48 0 0 1 279.21 289l105.94 77.9A172.7 172.7 0 0 1 606 351l37.41-47.38a112.45 112.45 0 0 1-28-74.42c0-61.89 49.67-112.22 111.14-112.22s111.14 50.33 111.14 112.22-49.58 112.17-111.05 112.17a110 110 0 0 1-41.64-8.13l-42.18 53.43a176.44 176.44 0 0 1 36.43 107.72 178.73 178.73 0 0 1-3.58 35.71z m-170.51 74c59.43 0 107.79-49 107.79-109.67s-48.36-109.71-107.79-109.71-107.79 49-107.79 109.67 48.36 109.67 107.79 109.67z m221.48-323.9c27.49 0 49.93-22.75 49.93-51s-22.44-51-49.93-51-49.93 22.75-49.93 51 22.44 50.96 49.93 50.96z m-543.9 4.08c27.48 0 49.93-22.75 49.93-51s-22.45-51-49.93-51-49.94 22.75-49.94 51 22.45 50.96 49.94 50.96z m634.64 373.34c27.49 0 49.93-22.75 49.93-51s-22.44-51-49.93-51-49.93 22.75-49.93 51 22.44 51 49.93 51zM605.83 892.25c27.49 0 49.94-22.75 49.94-51s-22.45-51-49.94-51-49.93 22.74-49.93 51 22.45 51 49.93 51z m-402.69-81.61c27.49 0 49.93-22.75 49.93-51s-22.44-51-49.93-51-49.94 22.75-49.94 51 22.45 51 49.94 51z'

/** 引用 chip 里「引用的是用户」的图标（`UserSvg`，两个 path） */
const USER_PATHS = [
  'M563.323289 661.336738a330.663562 330.663562 0 1 0-330.531877-330.663562 331.190306 331.190306 0 0 0 330.531877 330.663562z',
  'M1106.528066 975.53955c-16.724123-134.319727-137.611877-293.001365-273.38015-373.066457a381.889419 381.889419 0 0 1-539.912627-0.65843C157.335331 679.246035 18.274908 834.635523 0.365611 975.53955a42.797952 42.797952 0 0 0 37.26714 48.065392h1031.628175A43.061324 43.061324 0 0 0 1106.528066 975.53955z',
]

/** 引用 chip 里「引用的是 AI」的图标（`AgentSvg`） */
const AGENT_PATH =
  'M482.816 64a127.104 127.104 0 0 1 39.616 247.872l-0.128 43.776h106.368a272.96 272.96 0 0 1 256.064 178.56 39.552 39.552 0 0 1-74.24 27.392 193.92 193.92 0 0 0-181.888-126.784H336.896a193.856 193.856 0 0 0-193.856 193.792v58.432a193.856 193.856 0 0 0 193.92 193.856h291.712a39.552 39.552 0 1 1 0 79.04H336.896A272.96 272.96 0 0 1 64 686.912V628.48a272.96 272.96 0 0 1 272.96-272.768h106.304v-43.904A127.104 127.104 0 0 1 482.752 64h0.064z m323.392 593.728a16.192 16.192 0 0 1 13.376 13.376 140.16 140.16 0 0 0 104.512 114.24l12.16 2.432a16 16 0 0 1 0 31.808c-55.552 8.768-100.608 49.92-114.24 104.512l-2.432 12.16a16 16 0 0 1-31.808 0 140.16 140.16 0 0 0-104.576-114.24l-12.096-2.432a16 16 0 0 1 0-31.808 140.16 140.16 0 0 0 114.24-104.576l2.432-12.096a16 16 0 0 1 18.432-13.312zM336.96 570.304a58.368 58.368 0 1 1 3.84 116.736 58.368 58.368 0 0 1-3.84-116.736z m291.776 0a58.368 58.368 0 1 1 4.032 116.736 58.368 58.368 0 0 1-4.096-116.736z m-145.92-427.136a48 48 0 1 0-3.2 96 48 48 0 0 0 3.2-96z'

/** 技能图标（`SkillSvg`） */
const SKILL_PATH =
  'M476.736 51.2a152 152 0 0 1 137.408 133.952l0.832 13.184h107.392c23.68 0 46.592 7.296 65.728 20.672l7.936 6.08 7.488 6.784c18.816 18.816 30.4 43.392 33.024 69.632l0.576 11.264-0.064 107.008 9.6 0.512a152.128 152.128 0 0 1 93.952 43.328l8.192 8.768 6.912 8.64a151.232 151.232 0 0 1 0 180.48c-24.128 32.448-59.456 53.12-97.536 59.264l-11.52 1.472-9.6 0.448v106.88c0.128 23.68-7.168 46.592-20.48 65.728l-6.144 7.936-6.848 7.488c-18.816 18.816-43.52 30.4-69.824 33.024l-11.392 0.576H555.904a32 32 0 0 1-30.144-42.752l4.096-11.52a70.144 70.144 0 0 0-24.448-79.872 70.528 70.528 0 0 0-83.84 0 70.144 70.144 0 0 0-26.752 71.872l2.304 8.064 4.096 11.52a32 32 0 0 1-30.08 42.688H204.288a114.88 114.88 0 0 1-114.24-103.36l-0.512-11.264v-165.568a32 32 0 0 1 42.56-30.208l11.648 4.096c29.056 10.176 61.376 0.192 79.616-24.512a69.824 69.824 0 0 0 0-83.136c-16.64-22.4-44.8-32.64-71.616-26.752l-8 2.304-11.648 4.032a32 32 0 0 1-42.56-30.208V313.6a114.56 114.56 0 0 1 105.344-114.048l9.408-0.384H311.68l0.704-11.648a151.04 151.04 0 0 1 14.528-50.816l6.4-11.84 6.208-9.408a151.68 151.68 0 0 1 62.336-50.88L412.608 60.16l3.2-1.024c10.752-3.2 19.968-5.312 27.712-6.4C451.2 51.712 462.336 51.2 476.736 51.2z m-1.6 96.64l-4.352-0.64-12.032 0.512a36.608 36.608 0 0 0-2.048 0.192l-7.04 1.472-4.992 1.344a58.496 58.496 0 0 0-21.504 13.44l-3.328 3.84-4.288 6.4a60.8 60.8 0 0 0-6.592 15.36l-0.768 3.968-4.672 71.424a32 32 0 0 1-31.936 29.888H204.352a18.688 18.688 0 0 0-18.24 14.272l-0.512 4.224V407.04l7.872 1.024c38.08 6.144 73.6 25.472 99.648 55.808l7.488 9.408a165.824 165.824 0 0 1-107.136 262.528l-7.872 1.024v93.056c0 3.2 0.832 6.336 2.432 9.088l2.944 3.84a18.816 18.816 0 0 0 9.6 5.12l3.776 0.384 93.76-0.064 1.024-7.68a166.144 166.144 0 0 1 55.936-100.096l9.536-7.552a166.528 166.528 0 0 1 263.232 107.712l0.96 7.616 93.568 0.064a26.24 26.24 0 0 0 9.28-1.92l1.152-0.512 4.032-4.288a18.176 18.176 0 0 0 3.776-7.616l0.512-4.352-0.064-167.808a32 32 0 0 1 30.4-32l67.008-3.2a55.936 55.936 0 0 0 40.192-22.4 55.616 55.616 0 0 0 5.824-57.216l-3.648-5.952-4.736-5.952a57.472 57.472 0 0 0-27.392-17.664l-7.04-1.28-70.272-3.648a32 32 0 0 1-30.336-32v-167.68a25.472 25.472 0 0 0-1.792-8.96l-0.512-1.088-4.288-4.032a18.816 18.816 0 0 0-7.68-3.84l-4.48-0.576H545.6a32 32 0 0 1-31.872-34.56l4.992-62.528-0.448-4.8a55.168 55.168 0 0 0-5.12-15.296l-4.224-7.04a55.936 55.936 0 0 0-33.792-22.208z'

/** 文件夹图标（`FolderSvg`） */
const FOLDER_PATH =
  'M855.04 385.024q19.456 2.048 38.912 10.24t33.792 23.04 21.504 37.376 2.048 54.272q-2.048 8.192-8.192 40.448t-14.336 74.24-18.432 86.528-19.456 76.288q-5.12 18.432-14.848 37.888t-25.088 35.328-36.864 26.112-51.2 10.24l-567.296 0q-21.504 0-44.544-9.216t-42.496-26.112-31.744-40.96-12.288-53.76l0-439.296q0-62.464 33.792-97.792t95.232-35.328l503.808 0q22.528 0 46.592 8.704t43.52 24.064 31.744 35.84 12.288 44.032l0 11.264-53.248 0q-40.96 0-95.744-0.512t-116.736-0.512-115.712-0.512-92.672-0.512l-47.104 0q-26.624 0-41.472 16.896t-23.04 44.544q-8.192 29.696-18.432 62.976t-18.432 61.952q-10.24 33.792-20.48 65.536-2.048 8.192-2.048 13.312 0 17.408 11.776 29.184t29.184 11.776q31.744 0 43.008-39.936l54.272-198.656q133.12 1.024 243.712 1.024l286.72 0z'

/** 文件图标（`FileTypeIcon` 的 default 档：导出不按扩展名分色，一个中性文档图标足够） */
const FILE_PATHS = [
  'M767.54821 127.981836H257.905908c-36.452213 0-66.00325 29.551036-66.00325 66.00325v637.563764c0 36.452213 29.551036 66.00325 66.00325 66.00325h509.642302c36.452213 0 66.00325-29.551036 66.00325-66.00325V193.985086c0-36.453237-29.550013-66.00325-66.00325-66.00325z m0 670.309562c0 18.367323-14.890128 33.257451-33.257451 33.257452H289.12084c-18.367323 0-33.257451-14.890128-33.257451-33.257452V225.200018c0-18.367323 14.890128-33.257451 33.257451-33.257451h445.169919c18.367323 0 33.257451 14.890128 33.257451 33.257451v573.09138z',
  'M575.667042 351.84337c0 17.662265-14.3181 31.980365-31.980366 31.980366H351.804485c-17.662265 0-31.980365-14.3181-31.980366-31.980366 0-17.662265 14.3181-31.980365 31.980366-31.980365H543.686676c17.662265 0 31.980365 14.3181 31.980366 31.980365zM703.58748 479.764831c0 17.662265-14.3181 31.980365-31.980366 31.980366h-319.803653c-17.662265 0-31.980365-14.3181-31.980365-31.980366 0-17.662265 14.3181-31.980365 31.980365-31.980365h319.803653c17.662265 0 31.980365 14.3181 31.980366 31.980365zM703.58748 607.686293c0 17.662265-14.3181 31.980365-31.980366 31.980365h-319.803653c-17.662265 0-31.980365-14.3181-31.980365-31.980365 0-17.662265 14.3181-31.980365 31.980365-31.980366h319.803653c17.662265 0 31.980365 14.3181 31.980366 31.980366z',
]

/** 上下文压缩图标（`StatsSvg`：三根递增柱） */
const STATS_SVG_INNER =
  '<rect x="3" y="14.5" width="3.8" height="6" rx="1.9"/><rect x="9.2" y="10.5" width="3.8" height="10" rx="1.9"/><rect x="15.4" y="6.5" width="3.8" height="14" rx="1.9"/><circle cx="4.9" cy="11.6" r="1.5"/><circle cx="11.1" cy="7.6" r="1.5"/><circle cx="17.3" cy="3.6" r="1.5"/>'

/** 一个图标 svg 元素（`viewBox` 由调用方给，填充色一律 currentColor 交给 CSS） */
function svgIcon(
  className: string,
  viewBox: string,
  inner: string,
): string {
  return `<svg class="${className}" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
}

/** 折叠箭头 */
function caretIcon(className: string): string {
  return svgIcon(className, '0 0 1024 1024', `<path d="${CARET_PATH}" fill="currentColor"/>`)
}

/** 思考过程图标 */
function thinkIcon(className: string): string {
  return svgIcon(className, '0 0 1024 1024', `<path d="${THINK_PATH}" fill="currentColor"/>`)
}

/* 行模型（`message-list/rows.ts` 的移植） */

/**
 * 列表的一行。
 * - `one`：自己成行的消息（气泡 / 摘要卡 / 孤儿工具结果）。
 * - `tools`：一段连续的工具调用（≥2 次调用才成组，只有 1 次时保持单卡）。
 *   `open` = 尾部段（后面再没有可见气泡）→ 默认展开，其余默认折叠。
 */
type Row =
  | { kind: 'one'; message: Message }
  | { kind: 'tools'; messages: Message[]; open: boolean }

/**
 * 一条消息是否属于这段连续工具调用 = 带工具调用的 assistant。
 * 带引用 / 文件 / 技能 / 图片块的不并入（它们在气泡里另有可见渲染）。
 */
function isToolCallMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false
  if (!message.toolCalls || message.toolCalls.length === 0) return false
  if (messageHasAttachmentBlocks(message.content)) return false
  return true
}

/** 会话级索引（先扫一遍，渲染时只查表）。 */
interface SessionIndex {
  /** toolCallId → 工具返回消息（重复结果只认第一条，与聊天区 `toolResultsFor` 同口径） */
  resultsByCallId: Map<string, Message>
  /** 有宿主（被某个 assistant 的 `toolCalls` 引用过）的 toolCallId */
  hostedCallIds: Set<string>
}

function indexSession(messages: readonly Message[]): SessionIndex {
  const resultsByCallId = new Map<string, Message>()
  const hostedCallIds = new Set<string>()
  for (const message of messages) {
    for (const tc of message.toolCalls ?? []) {
      if (tc.id) hostedCallIds.add(tc.id)
    }
    if (
      message.role === 'tool' &&
      message.toolCallId &&
      !resultsByCallId.has(message.toolCallId)
    ) {
      resultsByCallId.set(message.toolCallId, message)
    }
  }
  return { resultsByCallId, hostedCallIds }
}

/**
 * 是否是孤儿工具结果：宿主调用不存在，或同一 id 有多条结果（只回填第一条）。
 * 聊天区渲染 null，导出必须单独成卡，否则内容就丢了。
 */
function isOrphanToolResult(message: Message, index: SessionIndex): boolean {
  const id = message.toolCallId
  if (!id || !index.hostedCallIds.has(id)) return true
  return index.resultsByCallId.get(id)?.id !== message.id
}

/**
 * 切行：连续工具调用合成一组，tool 结果不占行；孤儿工具结果单独成行。
 */
function buildRows(messages: readonly Message[], index: SessionIndex): Row[] {
  const rows: Row[] = []
  /** 正在攒的工具调用段（遇到可见内容就收口） */
  let run: Message[] = []
  const flush = () => {
    if (run.length === 0) return
    // 阈值按工具调用总数而非消息条数（一次 assistant 可并行多个）
    let calls = 0
    for (const m of run) calls += m.toolCalls?.length ?? 0
    if (calls >= 2) {
      rows.push({ kind: 'tools', messages: run, open: false }) // open 占位，文末反向扫描时定
    } else {
      // 只有一次工具调用：保持单卡，不套折叠头
      rows.push({ kind: 'one', message: run[0] })
    }
    run = []
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      // 被宿主引用过的结果已进调用卡片；只有孤儿结果才自己占行
      if (isOrphanToolResult(message, index)) {
        flush()
        rows.push({ kind: 'one', message })
      }
      continue
    }
    if (isToolCallMessage(message)) {
      // 段首宿主可带正文（显示在组头之上）；中段再遇带正文的就收口
      if (run.length > 0 && messageHasBody(message)) flush()
      run.push(message)
      continue
    }
    flush()
    rows.push({ kind: 'one', message })
  }
  flush()

  // 尾部段（open）：从后往前扫，只有可见内容才打断扫描（空壳 assistant 不算）
  let visibleAfter = false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.kind === 'tools') {
      row.open = !visibleAfter
      const lead = row.messages[0]
      if (lead && messageHasVisibleContent(lead)) visibleAfter = true
    } else if (messageHasVisibleContent(row.message)) {
      visibleAfter = true
    }
  }
  return rows
}

/* 渲染上下文与取值助手 */

interface RenderContext extends SessionIndex {
  options: ExportOptions
  renderMarkdown: MarkdownToHtml
}

/** 工具结果消息的纯文本（content 正常是 string，数组块兜底取 text / tool_result） */
function toolResultText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((c) => c.type === 'text' || c.type === 'tool_result')
    .map((c) => (c.type === 'text' ? c.text : c.content))
    .join('\n\n')
}

/** 工具参数格式化：缩进 2 的 JSON 文本；不可序列化时退回字符串 */
function formatToolArgs(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2) ?? ''
  } catch {
    return String(input)
  }
}

/**
 * 工具调用的行内摘要（移植自 DefaultMessage.getShortText）：多文件取首路径 +N，
 * 多字段优先 path，单字段直接取值，其余打 JSON。
 */
function toolShortText(input: unknown): string {
  if (input == null || typeof input !== 'object') return String(input ?? '')
  const obj = input as Record<string, unknown>
  // 多文件（read_file 的 paths）
  if (Array.isArray(obj.paths) && obj.paths.length > 0) {
    const first = String(obj.paths[0] ?? '')
    return obj.paths.length > 1 ? `${first} +${obj.paths.length - 1}` : first
  }
  const keys = Object.keys(obj)
  if (keys.length === 0) return ''
  if (keys.length === 1) return String(obj[keys[0]] ?? '')
  if (keys.includes('path')) return String(obj.path ?? '')
  try {
    return JSON.stringify(obj)
  } catch {
    return ''
  }
}

/** 文件路径末段（兼容 / 与 \） */
function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

/** 体积格式化（B/KB/MB/GB），与 FileChip 同口径 */
function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/** 12500 → 12.5k（token 量级显示） */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}

/** 消息时间（绝对时间：文档离开应用后「刚刚」没有意义） */
function messageTime(message: Message): string {
  return new Date(message.timestamp).toLocaleString(getCurrentLanguage(), {
    hour12: false,
  })
}

/** 失败标记（`⚠️ 执行失败（ID: …）`）；未失败返回空串 */
function errorMark(message: Message): string {
  if (!message.isError) return ''
  const id = message.toolCallId ? `（ID: ${escapeHtml(message.toolCallId)}）` : ''
  return ` <span class="tool-call__error">⚠️ ${escapeHtml(t('执行失败'))}${id}</span>`
}

/* 片段渲染 */

/** 思考过程折叠块（默认收起，折叠头与聊天区 .reasoning-header 同款） */
function thinkingFold(message: Message, ctx: RenderContext): string {
  if (ctx.options.omitThinking) return ''
  const text = message.reasoningContent
  if (!text || !text.trim()) return ''
  const body = ctx.renderMarkdown(text)
  if (!body.trim()) return ''
  const elapsed =
    message.reasoningElapsedMs && message.reasoningElapsedMs > 0
      ? formatDuration(message.reasoningElapsedMs)
      : ''
  return [
    '<details class="reasoning-block">',
    '<summary class="reasoning-header">',
    thinkIcon('reasoning-icon'),
    `<span>${escapeHtml(t('思考过程'))}</span>`,
    elapsed ? `<span class="reasoning-elapsed">${escapeHtml(elapsed)}</span>` : '',
    caretIcon('collapsed-icon'),
    '</summary>',
    '<div class="reasoning-text">',
    '<div class="line"></div>',
    `<div class="markdown-renderer">${body}</div>`,
    '</div>',
    '</details>',
  ].join('\n')
}

/** 引用 chip（QuoteChip 静态版：色条 + 发送方图标 + 发送方 + 摘要，hover 看全文） */
function quoteChip(quote: QuoteContent): string {
  const who = quote.role === 'user' ? t('你') : 'AI'
  const icon = svgIcon(
    'quote-chip-icon-svg',
    quote.role === 'user' ? '0 0 1107 1024' : '0 0 1024 1024',
    quote.role === 'user'
      ? USER_PATHS.map((d) => `<path d="${d}" fill="currentColor"/>`).join('')
      : `<path d="${AGENT_PATH}" fill="currentColor"/>`,
  )
  const title = [
    tpl('引用 $__sender__ 的消息', { sender: who }),
    quote.text,
    quote.messageId ? tpl('消息 ID：$__id__', { id: quote.messageId }) : '',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    `<span class="quote-chip" title="${escapeHtml(title)}">`,
    '<span class="quote-chip-bar"></span>',
    `<span class="quote-chip-icon">${icon}</span>`,
    `<span class="quote-chip-sender">${escapeHtml(who)}</span>`,
    `<span class="quote-chip-text">${escapeHtml(quote.text)}</span>`,
    '</span>',
  ].join('')
}

/** 技能卡片（SkillChip card 形态静态版：图标 + 名 + 字符数 + 描述） */
function skillCard(skill: SkillContent): string {
  const chars =
    typeof skill.content === 'string' && skill.content.length > 0
      ? tpl('$__count__ 字符', { count: skill.content.length })
      : ''
  const title = [
    tpl('引用技能：$__name__', { name: skill.name }),
    skill.description || '',
    skill.path || '',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    `<span class="skill-chip${skill.description ? ' has-desc' : ''}" title="${escapeHtml(title)}">`,
    '<span class="skill-chip-head">',
    `<span class="skill-chip-icon">${svgIcon(
      'skill-chip-icon-svg',
      '0 0 1024 1024',
      `<path d="${SKILL_PATH}" fill="currentColor"/>`,
    )}</span>`,
    `<span class="skill-chip-name">${escapeHtml(skill.name)}</span>`,
    chars ? `<span class="skill-chip-meta">${escapeHtml(chars)}</span>` : '',
    '</span>',
    skill.description
      ? `<span class="skill-chip-desc">${escapeHtml(skill.description)}</span>`
      : '',
    '</span>',
  ].join('')
}

/** 文件 chip（FileChip 静态版：图标 + 文件名 + 体积 / 文件夹） */
function fileChip(file: FileContent): string {
  const displayName = file.name || fileNameOf(file.path)
  const meta = file.isDir ? t('文件夹') : formatFileSize(file.size)
  return [
    `<span class="file-chip${file.isDir ? ' is-dir' : ''}" title="${escapeHtml(file.path)}">`,
    `<span class="file-chip-icon">${svgIcon(
      'file-chip-icon-svg',
      '0 0 1024 1024',
      (file.isDir ? [FOLDER_PATH] : FILE_PATHS)
        .map((d) => `<path d="${d}" fill="currentColor"/>`)
        .join(''),
    )}</span>`,
    `<span class="file-chip-name">${escapeHtml(displayName)}</span>`,
    meta ? `<span class="file-chip-meta">${escapeHtml(meta)}</span>` : '',
    '</span>',
  ].join('')
}

/**
 * 一次工具调用的卡片：行（状态点 + 工具名 + 摘要 + 耗时 + 箭头）+ 通用详情（参数 / 返回）。
 * 聊天区每类工具的专用展开视图不复刻；详情高度超 50vh 时内部滚动。
 */
function toolCallCard(call: ToolUseContent, result: Message | undefined): string {
  const status: 'done' | 'pending' | 'error' = !result
    ? 'pending'
    : result.isError
      ? 'error'
      : 'done'
  const short = toolShortText(call.input)
  const timing =
    result?.elapsedMs && result.elapsedMs > 1000
      ? formatDuration(result.elapsedMs)
      : ''
  const output = result ? toolResultText(result).trim() : ''
  return [
    `<details class="tool-call is-${status}">`,
    '<summary class="tool-call__row">',
    `<span class="tool-call__point ${status}"></span>`,
    `<span class="tool-call__label">${escapeHtml(call.name)}</span>`,
    short
      ? `<span class="tool-call__short" title="${escapeHtml(short)}">${escapeHtml(short)}</span>`
      : '',
    timing ? `<span class="tool-call__timing">${escapeHtml(timing)}</span>` : '',
    caretIcon('tool-call__caret'),
    '</summary>',
    '<div class="tool-call__view">',
    `<div class="tool-call__field">${escapeHtml(t('工具调用参数'))}</div>`,
    `<pre class="tool-call__code">${escapeHtml(formatToolArgs(call.input))}</pre>`,
    result
      ? [
        `<div class="tool-call__field">${escapeHtml(t('工具返回'))}${errorMark(result)}</div>`,
        output ? `<pre class="tool-call__code">${escapeHtml(output)}</pre>` : '',
      ].join('\n')
      : `<div class="tool-call__field">${escapeHtml(t('暂无详情'))}</div>`,
    '</div>',
    '</details>',
  ].join('\n')
}

/** 孤儿工具结果卡片：没有调用参数，只输出返回内容 */
function orphanResultCard(message: Message): string {
  const output = toolResultText(message).trim()
  const firstLine = output.split('\n')[0]?.slice(0, 120) ?? ''
  return [
    `<details class="tool-call${message.isError ? ' is-error' : ' is-orphan'}">`,
    '<summary class="tool-call__row">',
    `<span class="tool-call__point${message.isError ? ' error' : ''}"></span>`,
    `<span class="tool-call__label">${escapeHtml(t('工具返回'))}</span>`,
    firstLine
      ? `<span class="tool-call__short" title="${escapeHtml(output)}">${escapeHtml(firstLine)}</span>`
      : '',
    caretIcon('tool-call__caret'),
    '</summary>',
    '<div class="tool-call__view">',
    `<div class="tool-call__field">${escapeHtml(t('工具返回'))}${errorMark(message)}</div>`,
    output ? `<pre class="tool-call__code">${escapeHtml(output)}</pre>` : '',
    '</div>',
    '</details>',
  ].join('\n')
}

/** 工具组折叠头最多预览几个工具名，与聊天区同值 */
const TOOL_PREVIEW_MAX = 3

/**
 * 一段连续工具调用 → 一个折叠组。折叠头只说调了几次（加工具名预览），不显示成败状态点。
 */
function toolGroup(members: Message[], open: boolean, ctx: RenderContext): string {
  const names: string[] = []
  const seen = new Set<string>()
  let calls = 0
  for (const member of members) {
    for (const call of member.toolCalls ?? []) {
      calls++
      if (!call.name || seen.has(call.name)) continue
      seen.add(call.name)
      if (names.length < TOOL_PREVIEW_MAX) names.push(call.name)
    }
  }
  const more = seen.size - names.length
  const preview = names.length
    ? `<span class="tool-group__tools" title="${escapeHtml([...seen].join(', '))}">${escapeHtml(
      names.join(' · '),
    )}${more > 0 ? ` +${more}` : ''}</span>`
    : ''
  const cards: string[] = []
  members.forEach((member, index) => {
    // 段首宿主的思考在它自己的气泡里，组内只补中段成员的
    if (index > 0) {
      const fold = thinkingFold(member, ctx)
      if (fold) cards.push(fold)
    }
    for (const call of member.toolCalls ?? []) {
      const result = call.id ? ctx.resultsByCallId.get(call.id) : undefined
      cards.push(toolCallCard(call, result))
    }
  })
  return [
    `<details class="tool-group"${open ? ' open' : ''}>`,
    '<summary class="tool-group__head">',
    `<span class="tool-group__label">${escapeHtml(
      tpl('$__count__ 次工具调用', { count: calls }),
    )}</span>`,
    preview,
    caretIcon('tool-group__caret'),
    '</summary>',
    `<div class="tool-group__body">${cards.join('\n')}</div>`,
    '</details>',
  ].join('\n')
}

/**
 * 一条消息 → 气泡（message-bubble 静态版）：引用 → 技能 → 正文 → 文件。
 * 用户正文不渲染 Markdown（与聊天区一致）；图片不导出，没有可见内容的消息不产气泡。
 */
function messageBubble(message: Message, ctx: RenderContext): string {
  const isUser = message.role === 'user'
  if (!messageHasVisibleContent(message)) return ''

  const quotes = getQuoteBlocks(message.content)
  const skills = getSkillBlocks(message.content)
  const files = getFileBlocks(message.content)
  const body = messageBodyText(message.content)
  if (
    !body &&
    quotes.length === 0 &&
    skills.length === 0 &&
    files.length === 0
  ) {
    // 剩下的可见内容只有图片（不导出）→ 不留空壳气泡
    return ''
  }

  const inner: string[] = []
  if (quotes.length > 0) {
    inner.push(
      `<div class="message-quotes">${quotes.map(quoteChip).join('\n')}</div>`,
    )
  }
  if (skills.length > 0) {
    inner.push(
      `<div class="message-skills">${skills.map(skillCard).join('\n')}</div>`,
    )
  }
  if (body) {
    inner.push(
      isUser
        ? `<div class="message-content">${escapeHtml(body)}</div>`
        : `<div class="message-content"><div class="markdown-renderer">${ctx.renderMarkdown(body)}</div></div>`,
    )
  }
  if (files.length > 0) {
    inner.push(
      `<div class="message-files">${files.map(fileChip).join('\n')}</div>`,
    )
  }
  inner.push(
    `<div class="message-time">${escapeHtml(messageTime(message))}</div>`,
  )

  const thinking = isUser ? '' : thinkingFold(message, ctx)

  return [
    `<div class="message-bubble ${isUser ? 'user' : 'assistant'}">`,
    '<div class="message-body">',
    thinking,
    '<div class="message-content-wrapper">',
    inner.join('\n'),
    '</div>',
    '</div>',
    '</div>',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 反馈消息：居中卡片（与聊天区 .message-feedback 同款） */
function feedbackCard(message: Message, ctx: RenderContext): string {
  const body = messageBodyText(message.content)
  if (!body) return ''
  return [
    '<div class="message-feedback">',
    '<div class="feedback-content"><div class="markdown-renderer">',
    ctx.renderMarkdown(body),
    '</div></div>',
    '</div>',
  ].join('\n')
}

/** 上下文压缩摘要（role:'summary'）：紧凑卡片，点开看全文 */
function summaryCard(message: Message, ctx: RenderContext): string {
  const body = messageBodyText(message.content)
  const mode = message.uiData?.compressMode
  const parts: string[] = []
  if (mode === 'raw') parts.push(t('正文压缩'))
  else if (mode === 'ai') parts.push(t('AI 摘要'))
  const tokens = message.uiData?.contextTokens
  if (typeof tokens === 'number' && tokens > 0) {
    parts.push(tpl('压缩后约 $__n__ tokens', { n: formatTokens(tokens) }))
  }
  parts.push(messageTime(message))

  return [
    '<div class="message-compress-summary">',
    '<details class="compress-summary-card">',
    '<summary class="compress-summary-head" title="' +
    escapeHtml(t('点击查看压缩后的摘要')) +
    '">',
    svgIcon('compress-summary-icon', '0 0 24 24', STATS_SVG_INNER),
    '<span class="compress-summary-main">',
    `<span class="compress-summary-title">${escapeHtml(t('上下文已压缩'))}</span>`,
    `<span class="compress-summary-meta">${escapeHtml(parts.join(' · '))}</span>`,
    '</span>',
    caretIcon('compress-summary-expand'),
    '</summary>',
    `<div class="compress-summary-body"><div class="markdown-renderer">${ctx.renderMarkdown(
      body || t('（无内容）'),
    )}</div></div>`,
    '</details>',
    '</div>',
  ].join('\n')
}

/** 一行 → HTML（气泡 / 工具组 / 摘要卡 / 孤儿结果卡） */
function renderRow(row: Row, ctx: RenderContext): string {
  const { options } = ctx
  if (row.kind === 'tools') {
    const lead = row.messages[0]
    // 段首宿主的正文（若有）显示在组头之上、不随折叠隐藏 —— 与聊天区 ToolCallGroup 一致
    const leadBubble = lead ? messageBubble(lead, ctx) : ''
    if (options.omitToolCalls) return leadBubble
    return [leadBubble, toolGroup(row.messages, row.open, ctx)]
      .filter(Boolean)
      .join('\n')
  }

  const message = row.message
  if (message.role === 'tool') {
    // 选项过滤后没内容的消息整条不写（不留空壳）
    return options.omitToolCalls ? '' : orphanResultCard(message)
  }
  if (message.role === 'summary') return summaryCard(message, ctx)
  if (message.role === 'feedback') return feedbackCard(message, ctx)

  const bubble = messageBubble(message, ctx)
  // 工具调用挂在 assistant 消息上时，卡片跟在气泡之后（与聊天区 message-bubble 的渲染顺序一致）
  const cards =
    message.role === 'assistant' && !options.omitToolCalls
      ? (message.toolCalls ?? [])
        .map((call) =>
          toolCallCard(
            call,
            call.id ? ctx.resultsByCallId.get(call.id) : undefined,
          ),
        )
        .join('\n')
      : ''
  return [bubble, cards].filter(Boolean).join('\n')
}

/* 内嵌样式（单文件、无外部资源；随系统深浅色切换） */

const EXPORT_STYLE = `
:root {
  color-scheme: light dark;
  /* 字号令牌：与 ui/styles/theme.scss 的「中」档一致 */
  --font-size-base: 14px;
  --font-size-md: 13px;
  --font-size-sm: 12px;
  --font-size-xs: 11px;
  --font-size-2xs: 10px;
  /* 颜色令牌：与 ui/styles/theme.scss 的亮色档一致 */
  --bg-primary: #fff;
  --bg-secondary: #f7f7f8;
  --text-primary: #1a1a1a;
  --text-secondary: #666;
  --text-tertiary: #767676;
  --border-color: #e5e5e5;
  --border-color-light: rgba(108, 108, 108, 0.134);
  --hover-bg: #f0f0f0;
  --accent-color: #4f46e5;
  --assistant-bubble-bg: #f1f1f3;
  --btn-bg-primary: #4f46e5;
  --primary-fg: #ffffff;
  --inline-code-bg: #e8e8ed;
  --inline-code-color: #642dd1;
  --blockquote-bg: #f8f9fa;
  --table-header-bg: #efeff5;
  --table-item-bg: #ffffff;
  --code-bg: #292c33;
  --code-fg: #abb2bf;
  --color-success: #0fcd55;
  --color-error: #cf222e;
  --accent-warn: #f59e0b;
  --mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace;
  /* 滚动条滑块：与应用 theme.scss 的 --scrollbar-thumb 同源，但这里用半透明（衬在任何底色上都成立） */
  --scrollbar-thumb: rgba(0, 0, 0, 0.18);
  --scrollbar-thumb-hover: rgba(0, 0, 0, 0.34);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #1e1e2e;
    --bg-secondary: #181825;
    --text-primary: #cdd6f4;
    --text-secondary: #a6adc8;
    --text-tertiary: #858b9e;
    --border-color: #2c2c30;
    --border-color-light: rgba(255, 255, 255, 0.08);
    --hover-bg: #313244;
    --accent-color: #6f67ea;
    --assistant-bubble-bg: rgba(49, 50, 68, 0.58);
    --btn-bg-primary: #454091;
    --inline-code-bg: #45475a;
    --inline-code-color: #cba6f7;
    --blockquote-bg: #181825;
    --table-header-bg: #181825;
    --table-item-bg: #383948;
    --color-success: #14b74f;
    --color-error: #f35b5e;
    --accent-warn: #f9e2af;
    --scrollbar-thumb: rgba(255, 255, 255, 0.16);
    --scrollbar-thumb-hover: rgba(255, 255, 255, 0.32);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  /* 页面本身不滚动：文档头固定、只有消息区滚（见 .chat-export / .chat-messages） */
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
  font: var(--font-size-base)/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  -webkit-text-size-adjust: 100%;
  /* 打印 / 存 PDF 时保留气泡底色（否则浏览器一律刷白，气泡左右之分就看不出来了） */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ==================== 滚动条（细 / 圆角 / 半透明，hover 加深） ==================== */
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  /* 透明边框 + padding-box：视觉 4px，热区 10px */
  border: 3px solid transparent;
  border-radius: 999px;
  background: var(--scrollbar-thumb);
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
  background-clip: padding-box;
}
*::-webkit-scrollbar-corner { background: transparent; }
/* Firefox 不支持 ::-webkit-scrollbar，走标准属性；Chromium 上不能设 scrollbar-width（会令 webkit 伪元素失效） */
@supports not selector(::-webkit-scrollbar) {
  html { scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin; }
}

/* ==================== 整页骨架：文档头固定 + 消息区独立滚动 ==================== */
.chat-export {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh; /* 移动端地址栏收放时更准 */
  max-width: 960px;
  margin: 0 auto;
}

/* ==================== 文档头（会话标题 + 元信息，不随消息滚动） ==================== */
.export-header {
  flex: none;
  padding: 22px 24px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
}
.export-title { margin: 0 0 10px; font-size: 24px; line-height: 1.3; font-weight: 600; }
.export-meta { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0; font-size: var(--font-size-sm); color: var(--text-tertiary); }
.export-meta .meta-item { display: flex; gap: 6px; }
.export-meta dt { font-weight: 600; }
.export-meta dd { margin: 0; }

/* ==================== 消息区（复刻 message-list 的气泡） ====================
   整页**唯一**的滚动容器：文档头钉在顶上，气泡在这里滚。 */
.chat-messages {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable; /* 滚动条出现 / 消失时内容不横跳 */
  padding: 14px 0 72px;
}
.message-bubble { display: flex; gap: 12px; padding: 10px 20px; }
.message-body { display: flex; flex-direction: column; max-width: 90%; min-width: 0; position: relative; }
.message-content-wrapper { width: fit-content; max-width: 100%; margin-left: 8px; }
.message-bubble.user { flex-direction: row-reverse; }
.message-bubble.user .message-body { align-items: flex-end; }
.message-bubble.user .message-body .message-content {
  padding: 8px 12px;
  width: fit-content;
  margin-left: auto;
  background: var(--btn-bg-primary);
  color: var(--primary-fg);
  border-radius: 16px 4px 16px 16px;
  word-break: break-word;
}
.message-bubble.assistant .message-body { max-width: 90%; }
.message-bubble.assistant .message-body .message-content {
  background: var(--assistant-bubble-bg);
  color: var(--text-primary);
  border-radius: 4px 16px 16px 16px;
}
.message-content { padding: 10px 14px; font-size: var(--font-size-base); line-height: 1.6; white-space: pre-wrap; }
.message-time { margin-top: 4px; padding: 0 4px; font-size: var(--font-size-xs); color: var(--text-tertiary); }
.message-bubble.user .message-time { text-align: right; }

/* 文件 / 引用 / 技能（气泡内的附件区，排布与聊天区一致）
   ⚠️ 没有 .message-images —— 图片**不导出**（base64 内嵌会让文档体积爆炸，见 messageBubble 注释）。 */
.message-quotes { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-bottom: 6px; margin-left: auto; width: fit-content; max-width: 100%; }
.message-skills { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-bottom: 6px; margin-left: auto; width: fit-content; max-width: 100%; }
.message-files { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; justify-content: flex-end; }

/* 引用 chip（shared/QuoteChip） */
.quote-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 2.2em;
  padding: 0 8px; border: 1px solid var(--border-color); border-radius: 8px;
  background: var(--bg-secondary); color: var(--text-secondary);
  font-size: var(--font-size-xs); line-height: 1.6; overflow: hidden;
}
.quote-chip-bar { flex: none; width: 2px; height: 1.1em; border-radius: 1px; background: var(--accent-color); }
.quote-chip-icon { display: inline-flex; align-items: center; flex: none; color: var(--accent-color); }
.quote-chip-icon-svg { width: 13px; height: 13px; display: block; }
.quote-chip-sender { flex: none; color: var(--text-primary); font-weight: 500; }
.quote-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 文件 chip（shared/FileChip） */
.file-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 260px; min-height: 2.2em;
  padding: 0 8px; border: 1px solid var(--border-color); border-radius: 8px;
  background: var(--bg-primary); color: var(--text-secondary);
  font-size: var(--font-size-xs); line-height: 1;
}
.file-chip-icon { display: inline-flex; align-items: center; flex: none; color: var(--accent-color); }
.file-chip-icon-svg { width: 14px; height: 14px; display: block; }
.file-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-weight: 500; }
.file-chip-meta { flex: none; color: var(--text-tertiary); }

/* 技能卡片（shared/SkillChip 的 card 形态） */
.skill-chip {
  display: block; width: 400px; max-width: 100%; border: 1px solid var(--border-color);
  border-radius: 10px; background: var(--bg-primary); color: var(--text-secondary);
  font-size: var(--font-size-sm); line-height: 1; overflow: hidden;
}
.skill-chip-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 8px; }
.skill-chip.has-desc .skill-chip-head { border-bottom: 1px solid var(--border-color-light); }
.skill-chip-icon { display: inline-flex; align-items: center; flex: none; color: var(--accent-color); }
.skill-chip-icon-svg { width: 14px; height: 14px; display: block; }
.skill-chip-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-weight: 500; }
.skill-chip-meta { flex: none; color: var(--text-tertiary); }
.skill-chip-desc {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  overflow: hidden; max-height: calc(3 * 1.5em);
  margin-top: 3px; padding: 0 8px 7px;
  color: var(--text-secondary); font-size: var(--font-size-xs); line-height: 1.5; white-space: normal;
}

/* ==================== 思考过程（复刻 .reasoning-block / .reasoning-header） ==================== */
.reasoning-block { margin: 0 0 4px; font-size: var(--font-size-md); width: fit-content; max-width: 100%; }
.reasoning-header {
  display: flex; align-items: center; gap: 4px; width: fit-content;
  padding: 2px 6px; margin: 0 0 4px -6px; border-radius: 6px;
  font-weight: 500; color: var(--accent-color); font-size: var(--font-size-sm);
  cursor: pointer; user-select: none; list-style: none;
}
.reasoning-header::-webkit-details-marker { display: none; }
.reasoning-header:hover { background: var(--hover-bg); }
.reasoning-icon { width: 14px; height: 14px; flex: none; fill: var(--accent-color); }
.reasoning-elapsed { margin-left: 2px; font-weight: 400; font-size: var(--font-size-xs); color: var(--text-tertiary); }
.collapsed-icon { width: 14px; height: 14px; flex: none; fill: var(--accent-color); opacity: 0.6; transform: rotate(-90deg); transition: transform 0.2s ease; }
details[open] > .reasoning-header .collapsed-icon { opacity: 1; transform: rotate(0deg); }
.reasoning-text { display: flex; color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5; word-break: break-word; }
.reasoning-text > .line { flex: none; width: 2px; margin: 6px 8px 6px 0; border-radius: 2px; background: var(--text-secondary); opacity: 0.4; }
.reasoning-text .markdown-renderer { flex: 1; min-width: 0; }
.reasoning-text .markdown-renderer p,
.reasoning-text .markdown-renderer h1, .reasoning-text .markdown-renderer h2,
.reasoning-text .markdown-renderer h3, .reasoning-text .markdown-renderer h4,
.reasoning-text .markdown-renderer h5, .reasoning-text .markdown-renderer h6,
.reasoning-text .markdown-renderer li { opacity: 0.6; }

/* ==================== 工具调用：单卡 ==================== */
.tool-call { margin: 2px 0 2px 28px; max-width: 90%; }
.tool-call__row {
  display: inline-flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%;
  padding: 3px 10px; border-radius: 6px; font-size: var(--font-size-sm);
  color: var(--text-secondary); cursor: pointer; user-select: none; list-style: none;
}
.tool-call__row::-webkit-details-marker { display: none; }
.tool-call__row:hover { background: var(--hover-bg); }
.tool-call__point { flex: none; width: 8px; height: 8px; margin-right: 2px; border-radius: 50%; background: var(--color-success); }
.tool-call__point.error { border-radius: 20%; background: var(--color-error); }
.tool-call__point.pending { background: var(--accent-warn); }
.tool-call__label { flex: none; color: var(--text-secondary); font-size: var(--font-size-xs); }
.tool-call__short { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent-color); font-weight: 500; font-size: var(--font-size-xs); }
.tool-call__timing { flex: none; color: var(--text-tertiary); font-size: var(--font-size-xs); }
.tool-call__caret { flex: none; width: 12px; height: 12px; fill: var(--text-tertiary); transition: transform 0.2s ease; }
details[open] > .tool-call__row .tool-call__caret { transform: rotate(180deg); }
/* 工具调用的展开视图：参数 + 返回，超 50vh 内部滚动 */
.tool-call__view {
  margin: 4px 0 8px; padding: 8px 12px; border-left: 1px solid var(--border-color); border-radius: 0 8px 8px 0;
  background: var(--hover-bg);
  max-height: 50vh; overflow: auto;
}
.tool-call__field { margin: 8px 0 4px; font-size: var(--font-size-xs); font-weight: 600; color: var(--text-tertiary); }
.tool-call__field:first-child { margin-top: 0; }
.tool-call__error { color: var(--color-error); font-weight: 600; }
.tool-call__code {
  margin: 0 0 8px; padding: 8px 10px; border-radius: 6px;
  background: var(--code-bg); color: var(--code-fg);
  font-family: var(--mono); font-size: var(--font-size-sm); line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.tool-call__code:last-child { margin-bottom: 0; }

/* ==================== 工具调用：折叠组（复刻 .tool-group） ==================== */
.tool-group { margin: 2px 0 2px 28px; max-width: 93%; }
.tool-group__head {
  display: inline-flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%;
  padding: 4px 10px; border-radius: 8px; cursor: pointer; user-select: none; list-style: none;
  color: var(--text-secondary); font-size: var(--font-size-sm);
}
.tool-group__head::-webkit-details-marker { display: none; }
.tool-group__head:hover { background: var(--hover-bg); }
.tool-group__label { white-space: nowrap; }
.tool-group__tools {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px;
  padding: 1px 6px; border-radius: 5px; background: var(--hover-bg);
  color: var(--text-tertiary); font-family: var(--mono); font-size: var(--font-size-2xs);
}
.tool-group__caret { flex: none; width: 12px; height: 12px; fill: var(--text-tertiary); transition: transform 0.2s ease; }
details[open] > .tool-group__head .tool-group__caret { transform: rotate(180deg); }
.tool-group__body { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; padding-left: 10px; border-left: 1px solid var(--border-color); }
/* 组内卡片去掉左外边距：由 .tool-group 统一给，否则与组头错位 */
.tool-group__body > .tool-call { margin-left: 0; }
.tool-group__body .reasoning-block { margin-bottom: 2px; }

/* ==================== 反馈消息 / 上下文压缩摘要 ==================== */
.message-feedback { display: flex; padding: 8px 20px; }
.feedback-content {
  max-width: 90%; width: fit-content; padding: 10px 16px;
  background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 10px;
  color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.6;
}
.message-compress-summary { display: flex; padding: 8px 20px; }
.compress-summary-card {
  display: block; max-width: 90%;
  border: 1px dashed var(--accent-color); border-radius: 10px;
  background: color-mix(in srgb, var(--accent-color) 6%, transparent);
  color: var(--text-secondary); font-size: var(--font-size-sm);
}
.compress-summary-head { display: flex; align-items: center; gap: 10px; padding: 8px 14px; cursor: pointer; user-select: none; list-style: none; }
.compress-summary-head::-webkit-details-marker { display: none; }
.compress-summary-head:hover { background: color-mix(in srgb, var(--accent-color) 12%, transparent); border-radius: 10px; }
.compress-summary-icon { flex: none; width: 16px; height: 16px; fill: var(--accent-color); }
.compress-summary-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.compress-summary-title { color: var(--text-primary); font-weight: 500; }
.compress-summary-meta { color: var(--text-tertiary); font-size: var(--font-size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compress-summary-expand { flex: none; width: 12px; height: 12px; fill: var(--text-tertiary); transform: rotate(-90deg); transition: transform 0.15s ease; }
details[open] > .compress-summary-head .compress-summary-expand { transform: rotate(0deg); }
.compress-summary-body { max-height: 50vh; overflow: auto; padding: 0 14px 12px; }
.compress-summary-body .markdown-renderer { font-size: var(--font-size-sm); }

/* ==================== Markdown 正文（复刻 markdown-renderer.scss） ==================== */
.markdown-renderer { color: inherit; font-size: var(--font-size-md); line-height: 1.7; white-space: normal; word-break: break-word; }
.markdown-renderer p { margin: 0 0 2px; }
.markdown-renderer p:last-child { margin-bottom: 0; }
.markdown-renderer h1, .markdown-renderer h2, .markdown-renderer h3, .markdown-renderer h4, .markdown-renderer h5, .markdown-renderer h6 { margin: 16px 0 8px; font-weight: 600; line-height: 1.35; }
.markdown-renderer h1:first-child, .markdown-renderer h2:first-child, .markdown-renderer h3:first-child { margin-top: 0; }
.markdown-renderer h1 { font-size: 1.35em; padding-bottom: 6px; border-bottom: 1px solid var(--border-color); }
.markdown-renderer h2 { font-size: 1.2em; }
.markdown-renderer h3 { font-size: 1.1em; }
.markdown-renderer h4, .markdown-renderer h5, .markdown-renderer h6 { font-size: 1.05em; }
.markdown-renderer ul, .markdown-renderer ol { margin: 3px 0; padding-left: 20px; }
.markdown-renderer li { margin: 3px 0; }
.markdown-renderer ul { list-style: disc; }
.markdown-renderer ol { list-style: decimal; }
.markdown-renderer a { color: var(--accent-color); text-decoration: none; border-bottom: 1px solid transparent; }
.markdown-renderer a:hover { border-bottom-color: var(--accent-color); }
.markdown-renderer strong { font-weight: 600; }
.markdown-renderer em { font-style: italic; }
.markdown-renderer del { color: var(--text-secondary); }
.markdown-renderer blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid var(--accent-color); border-radius: 0 6px 6px 0; background: var(--blockquote-bg); color: var(--text-secondary); font-style: italic; }
.markdown-renderer hr { margin: 16px 0; border: 0; border-top: 1px solid var(--border-color); }
.markdown-renderer img { max-width: 100%; margin: 8px 0; border-radius: 8px; }
.markdown-renderer code {
  padding: 1px 6px; border-radius: 4px; background: var(--inline-code-bg); color: var(--inline-code-color);
  font-family: var(--mono); font-size: 0.9em; word-break: break-word;
}
.markdown-renderer pre {
  margin: 10px 0; padding: 12px 14px; border-radius: 8px; background: var(--code-bg); color: var(--code-fg);
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--mono); font-size: var(--font-size-sm); line-height: 1.6;
}
.markdown-renderer pre code { padding: 0; background: none; color: inherit; font-size: inherit; }
.table-wrapper { margin: 10px 0; overflow-x: auto; border: 1px solid var(--border-color); border-radius: 6px; }
.table-wrapper table { width: 100%; border-collapse: collapse; font-size: var(--font-size-md); }
.table-wrapper th, .table-wrapper td { padding: 8px 12px; border-bottom: 1px solid var(--border-color); text-align: left; }
.table-wrapper th { background: var(--table-header-bg); color: var(--text-primary); font-weight: 600; white-space: nowrap; }
.table-wrapper td { background: var(--table-item-bg); color: var(--text-primary); }
.table-wrapper tr:last-child td { border-bottom: none; }

/* ==================== 打印 / 存 PDF ==================== */
/* 打印：折叠内容一律展开，高度上限与滚动一并放开 */
@media print {
  /* 回到普通文档流：固定头的 100vh 布局不能拿去打印（否则只会印出第一屏） */
  html, body { height: auto; }
  body { overflow: visible; }
  .chat-export { display: block; height: auto; }
  .chat-messages { display: block; overflow: visible; padding: 0; }
  .export-header { padding: 0 0 14px; }
  details:not([open]) > *:not(summary),
  details::details-content { display: block !important; content-visibility: visible !important; }
  .tool-call__view, .compress-summary-body { max-height: none !important; overflow: visible !important; }
  .collapsed-icon, .tool-call__caret, .tool-group__caret, .compress-summary-expand { display: none; }
  .message-bubble, .tool-group, .tool-call, .message-compress-summary { break-inside: avoid; }
}
`.trim()

/* 文档组装 */

/**
 * 会话 → 独立完整 HTML 文档。
 * @param renderMarkdown 正文 Markdown → HTML 片段
 */
export function sessionToHtml(
  session: Session,
  renderMarkdown: MarkdownToHtml,
  options: ExportOptions = DEFAULT_OPTIONS,
): string {
  const index = indexSession(session.messages)
  const ctx: RenderContext = {
    options,
    renderMarkdown,
    ...index,
  }

  const body = buildRows(session.messages, index)
    .map((row) => renderRow(row, ctx))
    .filter(Boolean)
    .join('\n')

  const meta: Array<[string, string]> = [
    [
      t('导出时间'),
      new Date().toLocaleString(getCurrentLanguage(), { hour12: false }),
    ],
    [t('模型'), session.modelId || t('未知')],
  ]
  if (session.agentId) {
    const agent = agentRepo.load().agents.find((a) => a.id === session.agentId)
    if (agent) meta.push(['Agent', agent.name])
  }
  meta.push([t('消息数'), String(session.messages.length)])

  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(getCurrentLanguage())}">`,
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="generator" content="Virlen" />',
    `<title>${escapeHtml(session.title)}</title>`,
    `<style>${EXPORT_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main class="chat-export">',
    '<header class="export-header">',
    `<h1 class="export-title">${escapeHtml(session.title)}</h1>`,
    '<dl class="export-meta">',
    ...meta.map(
      ([k, v]) =>
        `<div class="meta-item"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
    ),
    '</dl>',
    '</header>',
    '<div class="chat-messages">',
    body,
    '</div>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * 创建正文 Markdown → HTML 转换器：复用应用的 react-markdown 渲染链。
 * 只在真导出时动态加载；不可用时退化为转义后的 <pre>。
 */
export async function createMarkdownHtmlRenderer(): Promise<MarkdownToHtml> {
  try {
    const [server, markdown, gfm] = await Promise.all([
      import('react-dom/server'),
      import('react-markdown'),
      import('remark-gfm'),
    ])
    const ReactMarkdown = markdown.default
    const remarkGfm = gfm.default

    return (src: string) =>
      server.renderToStaticMarkup(
        // 注：react-markdown 的 props 类型较严，只用到最基础的几个字段
        createElement(
          ReactMarkdown as any,
          {
            remarkPlugins: [remarkGfm],
            components: {
              // 外链新窗口打开
              a: (props: any) =>
                createElement(
                  'a',
                  { href: props.href, target: '_blank', rel: 'noopener noreferrer' },
                  props.children,
                ),
              // 表格套一层滚动容器（与聊天区同款），窄屏横向滚动而不撑破气泡
              // node（AST）不能往 DOM 上传，否则会渲染成 node="[object Object]"
              table: ({ node, children, ...rest }: any) =>
                createElement(
                  'div',
                  { className: 'table-wrapper' },
                  createElement('table', rest, children),
                ),
            },
          } as any,
          src,
        ),
      )
  } catch (e) {
    console.warn('[export] Markdown 渲染器不可用，正文退化为纯文本', e)
    return (src: string) => `<pre class="tool-call__code">${escapeHtml(src)}</pre>`
  }
}

/**
 * 导出会话到 HTML 文件；取消返回 null。
 */
export async function exportSessionToFile(
  sessionId: string,
  options: ExportOptions = DEFAULT_OPTIONS,
): Promise<string | null> {
  // 分页加载下必须先确保完整历史在内存，否则只导出已加载的尾部
  await sessionStore.ensureAllMessagesLoaded(sessionId)
  const session = sessionStore.getSession(sessionId)
  if (!session) return null

  const renderMarkdown = await createMarkdownHtmlRenderer()
  const html = sessionToHtml(session, renderMarkdown, options)

  try {
    // 动态导入 Tauri API（非 Tauri 环境降级）
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')

    // 安全的文件名
    const safeName =
      session.title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || t('对话')

    const filePath = await save({
      title: t('导出会话为 HTML'),
      defaultPath: `${safeName}.html`,
      filters: [
        { name: 'HTML', extensions: ['html'] },
        { name: t('所有文件'), extensions: ['*'] },
      ],
    })

    if (!filePath) return null // 用户取消

    await writeTextFile(filePath, html)
    return filePath
  } catch (e) {
    // 非 Tauri 环境：降级为浏览器下载
    console.warn('Tauri API 不可用，使用浏览器下载方式', e)
    downloadAsFile(html, session.title)
    return null
  }
}

/** 浏览器降级：Blob 下载。 */
function downloadAsFile(content: string, title: string): void {
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[<>:"/\\|?*]/g, '_')}.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
