/**
 * 轨迹投影用到的文本工具（纯函数）。
 *
 * 只做「把消息内容压成一行 / 摊成纯文本」这两件事，不含任何界面文案 ——
 * 占位文案（「仅工具调用」「无输出」）留在 UI 层，domain 不碰 i18n。
 */
import type { MessageContent } from '@/types'
import { sliceHead } from '@/utils/text'
import { RECORD_TEXT_MAX } from './types'

/** 压成单行：连续空白（含换行）折成一个空格，再按上限截断（代理对安全） */
export function singleLine(text: string, max = RECORD_TEXT_MAX): string {
  if (!text) return ''
  return sliceHead(text.replace(/\s+/g, ' ').trim(), max)
}

/**
 * 把消息内容摊成纯文本（检查器「输出」页 / 工具结果摘要用）。
 *
 * 与 `messageBodyText` 的区别：那个只取 text 块（气泡正文口径）；这里连图片 / 文件 /
 * 引用 / 技能 / 工具结果块一起摊成可读文本 —— 轨迹的「输出」要能看出这条消息里还有什么。
 */
export function contentText(content: MessageContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image_url':
        parts.push('[图片]')
        break
      case 'file':
        parts.push(`[文件] ${block.name ?? block.path}`)
        break
      case 'quote':
        parts.push(`[引用 ${block.role}] ${block.text}`)
        break
      case 'skill':
        parts.push(`[技能] ${block.name}`)
        break
      case 'tool_use':
        parts.push(`[工具] ${block.name}`)
        break
      case 'tool_result':
        parts.push(block.content)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/** 工具参数的压缩 JSON（检查器「参数」页之外的表格摘要用） */
export function argumentsBrief(input: unknown, max = 160): string {
  if (input === undefined || input === null) return ''
  try {
    return singleLine(JSON.stringify(input), max)
  } catch {
    return ''
  }
}
