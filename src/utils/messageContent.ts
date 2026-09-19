/**
 * messageContent — 用户消息 content 的组装与解析
 *
 * 输入框里的附件有两种形态：
 *   - 图片：base64 dataURL（本轮请求需要真实图片内容）
 *   - 文件：仅绝对路径（不拷贝文件内容，交由 AI 用工具按需读取）
 *
 * 这里把「文本 + 图片 + 文件」统一成 MessageContent，供发送链路复用；
 * 反向解析（从 content 里取回文件块）供消息气泡渲染 chip 使用。
 */
import {
  fileBlockToText,
  type FileContent,
  type MessageContent,
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

/**
 * 组装用户消息 content
 *
 * 文本规则与原有图片链路保持一致：
 *   - 有文本 → 原样发送
 *   - 无文本但有图片 → 补一句「分析这张/这N张图片」
 *   - 无文本但有文件 → 补一句「看看这些文件」
 */
export function buildUserContent(
  text: string,
  images: ImageInput[] = [],
  files: FileInput[] = [],
): MessageContent {
  const blocks: Exclude<MessageContent, string> = []

  if (text) {
    blocks.push({ type: 'text', text })
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

/** 文件附件块的模型可读文本（与各 Provider 序列化保持一致，供日志/摘要使用） */
export function fileBlocksToText(files: FileContent[]): string {
  return files.map(fileBlockToText).join('\n')
}
