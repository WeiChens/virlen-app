/**
 * messageContent — 用户消息 content 的组装与解析
 *
 * 输入框里的附件有三种形态：
 *   - 图片：base64 dataURL（本轮请求需要真实图片内容）
 *   - 文件：仅绝对路径（不拷贝文件内容，交由 AI 用工具按需读取）
 *   - 引用：被引用消息的 id + 发送方 + 正文快照（原消息可能被删除 / 压缩）
 *
 * 这里把「引用 + 文本 + 图片 + 文件」统一成 MessageContent，供发送链路复用；
 * 反向解析（从 content 里取回文件块 / 引用块）供消息气泡渲染 chip 使用。
 */
import {
  fileBlockToText,
  type FileContent,
  type MessageContent,
  type QuoteContent,
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

/**
 * 组装用户消息 content
 *
 * 文本规则与原有图片链路保持一致：
 *   - 有文本 → 原样发送
 *   - 无文本但有引用 → 补一句「请针对引用的消息回复」
 *   - 无文本但有图片 → 补一句「分析这张/这N张图片」
 *   - 无文本但有文件 → 补一句「看看这些文件」
 *
 * 块顺序固定为 quote → text → image → file：引用是「本条消息针对的对象」，
 * 放在最前，模型先看到上下文再看到指令。
 */
export function buildUserContent(
  text: string,
  images: ImageInput[] = [],
  files: FileInput[] = [],
  quotes: QuoteInput[] = [],
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

  if (text) {
    blocks.push({ type: 'text', text })
  } else if (quotes.length > 0) {
    blocks.push({ type: 'text', text: t('请针对引用的消息回复') })
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

/** 文件附件块的模型可读文本（与各 Provider 序列化保持一致，供日志/摘要使用） */
export function fileBlocksToText(files: FileContent[]): string {
  return files.map(fileBlockToText).join('\n')
}
