/**
 * message-role — 消息角色的展示词汇（「导入知识库」弹窗共用）。
 *
 * 一处定义：消息选择列表的行首图标与「查看详情」弹窗的角色名必须同一套口径 ——
 * 两处各写一份，加角色 / 换图标时必然只剩一处被改（同目录 session-text.ts 同理）。
 */
import type { MessageRole } from '@/types'
import { t } from '@/ui/i18n'

/** 角色图标（列表预览行 + 详情弹窗共用） */
export const ROLE_ICON: Record<string, string> = {
  user: '👤',
  assistant: '🤖',
  tool: '🔧',
  summary: '📋',
  feedback: '🔄',
}

/** 未知角色的兜底图标（`system` 及引擎将来新增的角色） */
export const DEFAULT_ROLE_ICON = '⚙️'

/** 角色显示名（中文即 i18n key）。`system` 不在 MessageRole 里，但历史数据 / 原生引擎可能带 */
const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  summary: '摘要',
  feedback: '反馈',
  system: '系统',
}

/** 角色显示名：未知角色原样返回，便于排查（而不是显示成空白） */
export function roleLabel(role: MessageRole): string {
  const key = ROLE_LABEL[role]
  return key ? t(key) : String(role)
}
