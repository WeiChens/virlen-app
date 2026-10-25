/**
 * 模型服务的术语显示名。
 *
 * 库里存的始终是协议名（openai / anthropic / gemini），这些值要发给服务商、也会落盘，
 * 只在显示时换成用户看得懂的说法。
 */
import { t } from '@/ui/i18n'

const PROTOCOL_LABELS: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
}

/** 接口协议名；未知协议原样返回 */
export function protocolLabel(type: string): string {
  const label = PROTOCOL_LABELS[type]
  return label ? t(label) : type
}
