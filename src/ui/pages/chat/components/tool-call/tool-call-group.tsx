import { useState, useEffect } from 'react'
import { ToolUseContent, Message } from '@/types'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import { t, tpl } from '@/ui/i18n'

interface Props {
  toolCalls: ToolUseContent[]
  /** 与 toolCalls 一一对应的工具结果消息（未完成处为 undefined） */
  toolResults?: (Message | undefined)[]
  /** 该条 assistant 消息是否有正文内容 */
  showContent: boolean
  children: React.ReactNode
}

export function ToolCallGroup({
  toolCalls,
  toolResults,
  showContent,
  children,
}: Props) {
  const canCollapse = toolCalls.length > 1
  const [collapsed, setCollapsed] = useState(canCollapse ? !showContent : false)

  // 当 AI 开始输出正文时自动展开
  useEffect(() => {
    if (showContent && canCollapse) {
      setCollapsed(false)
    }
  }, [showContent, canCollapse])

  if (!canCollapse) {
    return children
  }
  // 统计完成数（toolResults 与 toolCalls 按索引对齐）
  const total = toolCalls.length
  const completed = toolCalls.reduce(
    (n, _tc, i) => n + (toolResults?.[i] ? 1 : 0),
    0,
  )
  const hasError = !!toolResults?.some((r) => r?.isError)
  const hasPending = completed < total

  // 摘要文本
  let summary = tpl('调用 $__total__ 个工具', { total })
  if (!showContent && hasPending) {
    summary += ` (${completed}/${total})`
  }
  if (hasError) {
    summary += ' ⚠️'
  }

  return (
    <div
      className={`tool-call-group ${collapsed ? 'collapsed' : ''} ${!canCollapse ? 'no-collapse' : ''}`}>
      <div
        className="tool-call-group-header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? t('展开工具调用') : t('折叠工具调用')}>
        <CollapsedSvg
          className={`tool-call-group-arrow ${collapsed ? '' : 'expanded'}`}
        />
        <span className="tool-call-group-summary">{summary}</span>
        {hasPending && (
          <span className="tool-call-group-badge">{t('执行中...')}</span>
        )}
      </div>
      {!collapsed && <div className="tool-call-group-body">{children}</div>}
    </div>
  )
}
