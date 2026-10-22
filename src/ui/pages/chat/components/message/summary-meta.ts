/**
 * 上下文压缩摘要（`role='summary'`）的文案口径 —— 消息流里的提示条（`summary-message`）与
 * 右侧详情抽屉（`summary-drawer`）共用这一份，保证两处说法一致。
 *
 * 三条：
 * 1. **正文**：正常是 string，数组块兜底取 text；
 * 2. **副标题**：压缩方式 +（仅正文压缩）压缩后上下文占用 + 时间；
 * 3. **只有 `compressMode === 'raw'` 才有「压缩后占用」**：AI 摘要消息的 `usage` 是摘要调用
 *    的消耗、不是压缩后的上下文大小，拿它当占用展示会误导 → 用 `uiData.contextTokens` 区分。
 */
import type { Message } from '@/types'
import { t, tpl } from '@/ui/i18n'
import { timeFormat } from '@/utils/time'

/** 12500 → 12.5k（与 token-ring 同一口径：整数 k 不带多余的 .0） */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}

/** summary 消息正文 → 纯文本（正常是 string，数组块兜底取 text） */
export function summaryText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('')
}

/** 压缩方式名（两种都没有时为空串：老数据 / 手工写入的 summary 没有这个字段） */
export function summaryModeLabel(message: Message): string {
  const mode = message.uiData?.compressMode
  if (mode === 'raw') return t('正文压缩')
  if (mode === 'ai') return t('AI 摘要')
  return ''
}

/** 副标题：压缩方式 +（仅正文压缩）压缩后上下文占用 + 时间 */
export function summaryMetaText(message: Message): string {
  const parts: string[] = []
  const mode = summaryModeLabel(message)
  if (mode) parts.push(mode)

  const tokens = message.uiData?.contextTokens
  if (typeof tokens === 'number' && tokens > 0) {
    parts.push(tpl('压缩后约 $__n__ tokens', { n: formatTokens(tokens) }))
  }
  parts.push(timeFormat(message.timestamp))
  return parts.join(' · ')
}
