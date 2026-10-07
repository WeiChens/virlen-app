/**
 * messageContent — 用户消息 content 的组装与解析。
 *
 * 输入框附件四种形态：图片（base64 dataURL，本轮请求需真实内容）、文件（仅绝对路径，交 AI 用工具读）、
 * 引用（被引用消息 id + 发送方 + 正文快照）、技能（SKILL.md 全文快照）。这里把「引用 + 技能 + 文本 + 图片 + 文件」
 * 统一成 MessageContent；反向解析（取回文件 / 引用 / 技能块）供气泡渲染 chip。
 */
import {
  fileBlockToText,
  type FileContent,
  type MessageContent,
  type QuoteContent,
  type SkillContent,
} from '@/types'
import { t, tpl } from '@/ui/i18n'

/** 输入框里的图片附件（发送时只需 url） */
export interface ImageInput {
  url: string
}

/** 输入框里的文件附件（只有路径，不拷贝内容） */
export interface FileInput {
  path: string
  name?: string
  isDir?: boolean
  size?: number
}

/** 输入框里的引用附件（只有被引用消息的元数据 + 正文快照） */
export interface QuoteInput {
  /** 被引用消息的 id */
  messageId: string
  /** 被引用消息的发送方 */
  role: 'user' | 'assistant'
  /** 被引用消息的正文快照 */
  text: string
}

/** 输入框里的技能附件（技能名 + 目录 + 描述 + SKILL.md 全文快照） */
export interface SkillInput {
  /** 技能唯一标识（skillStore 的 meta.name） */
  name: string
  /** 技能源码目录绝对路径 */
  path?: string
  /** 技能描述（SKILL.md frontmatter），仅供 UI 展示 */
  description?: string
  /** SKILL.md 全文快照 */
  content: string
}

/**
 * 组装用户消息 content。
 *
 * 文本规则：有文本原样；否则按「引用 → 技能 → 图片 → 文件」补一句提示。块顺序固定
 * quote → skill → text → image → file：引用与技能是本条消息附带的上下文（放最前，模型先看背景再看指令），
 * 图片 / 文件是搬运对象（落最后）。
 */
export function buildUserContent(
  text: string,
  images: ImageInput[] = [],
  files: FileInput[] = [],
  quotes: QuoteInput[] = [],
  skills: SkillInput[] = [],
): MessageContent {
  const blocks: Exclude<MessageContent, string> = []

  // 引用块（附在最前，保持发送顺序）
  for (const q of quotes) {
    blocks.push({
      type: 'quote',
      messageId: q.messageId,
      role: q.role,
      text: q.text,
    })
  }

  // 技能块（紧随引用之后：同样是「给模型的上下文」，而不是待处理的文件）
  for (const s of skills) {
    const block: SkillContent = {
      type: 'skill',
      name: s.name,
      path: s.path,
      content: s.content,
    }
    // 描述只服务于 UI 卡片：没有就整个字段不带，避免在库里 / 请求体里堆空字段
    if (s.description) block.description = s.description
    blocks.push(block)
  }

  if (text) {
    blocks.push({ type: 'text', text })
  } else if (quotes.length > 0) {
    blocks.push({ type: 'text', text: t('请针对引用的消息回复') })
  } else if (skills.length > 0) {
    blocks.push({ type: 'text', text: t('请参考我引用的技能') })
  } else if (images.length > 0) {
    blocks.push({
      type: 'text',
      text:
        images.length > 1
          ? tpl('分析这$__num__张图片', { num: images.length })
          : t('分析这张图片'),
    })
  } else if (files.length > 0) {
    blocks.push({ type: 'text', text: t('看看这些文件') })
  }

  // 图片块（保持原有结构，Provider 需要真实图片内容）
  for (const img of images) {
    blocks.push({
      type: 'image_url',
      image_url: { url: img.url, detail: 'auto' },
    })
  }

  // 文件块（只有路径）
  for (const f of files) {
    blocks.push({
      type: 'file',
      path: f.path,
      name: f.name,
      isDir: f.isDir,
      size: f.size,
    })
  }

  return blocks
}

/**
 * 消息正文文本（文本块拼接，去首尾空白）。与气泡的 getContent() 同口径：只取 text 块，不含引用 / 技能 / 文件 / 图片。
 */
export function messageBodyText(content: MessageContent): string {
  if (typeof content === 'string') return content.trim()
  return content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('')
    .trim()
}

/**
 * 消息是否有正文（空白正文一律视为没有）。
 *
 * ⚠️ 这是「有没有正文」的**唯一判据**：消息气泡与列表行模型（工具组是否成立）都必须走本函数 ——
 * 两处判据一旦漂移，就会出现「有内容的行被丢掉」或「空行占着位置」。
 */
export function messageHasBody(message: { content: MessageContent }): boolean {
  return messageBodyText(message.content).length > 0
}

/**
 * 消息是否带有**非文本的可见内容块**（引用 / 图片 / 文件 / 技能）—— 它们在气泡里各有渲染，与正文同属「看得见的
 * 内容」。⚠️ 列表行模型（rows.ts）与气泡（hideMessageBubble / showAsToolCall）必须**同源**，否则会出现
 * 「非文本内容被一起藏掉」或「被折叠吞掉」。
 */
export function messageHasAttachmentBlocks(content: MessageContent): boolean {
  if (typeof content === 'string') return false
  return content.some(
    (b) =>
      b.type === 'image_url' ||
      b.type === 'file' ||
      b.type === 'quote' ||
      b.type === 'skill',
  )
}

/** 消息是否有「可见内容」—— 正文，或非文本可见块（引用 / 图片 / 文件 / 技能）。 */
export function messageHasVisibleContent(message: {
  content: MessageContent
}): boolean {
  return messageHasBody(message) || messageHasAttachmentBlocks(message.content)
}

/** 从 content 中取出所有文件附件块（消息气泡渲染 chip 用） */
export function getFileBlocks(content: MessageContent): FileContent[] {
  if (typeof content === 'string') return []
  return content.filter((b): b is FileContent => b.type === 'file')
}

/** 从 content 中取出所有图片 url（消息气泡渲染缩略图用） */
export function getImageUrls(content: MessageContent): string[] {
  if (typeof content === 'string') return []
  return content
    .filter((b) => b.type === 'image_url')
    .map((b) => ('image_url' in b ? b.image_url.url : ''))
}

/** 从 content 中取出所有引用块（消息气泡渲染引用条用） */
export function getQuoteBlocks(content: MessageContent): QuoteContent[] {
  if (typeof content === 'string') return []
  return content.filter((b): b is QuoteContent => b.type === 'quote')
}

/** 从 content 中取出所有技能引用块（消息气泡渲染技能 chip 用） */
export function getSkillBlocks(content: MessageContent): SkillContent[] {
  if (typeof content === 'string') return []
  return content.filter((b): b is SkillContent => b.type === 'skill')
}

/** 文件附件块的模型可读文本（与各 Provider 序列化保持一致，供日志/摘要使用） */
export function fileBlocksToText(files: FileContent[]): string {
  return files.map(fileBlockToText).join('\n')
}
