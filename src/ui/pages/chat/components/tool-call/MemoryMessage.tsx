/**
 * MemoryMessage — memory_search / memory_recall / memory_write 工具调用的消息展示
 *
 * 一行：做了什么（检索词 / 目标 id / 新记忆摘要）+ 结果状态（从 `uiData` 读，按界面语言重建）
 * 展开：与下发给模型的文本完全一致的纯文本视图
 *
 * ⚠️ 记忆正文是用户内容，只在本组件里展示，不进埋点（与 Rust 侧口径一致）。
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 一行里摘要最多显示多少字符（超出截断，完整内容在展开视图） */
const SHORT_SUMMARY_CHARS = 30

class MemoryMessage implements IToolCallMessage {
  getToolName(): string {
    return 'memory_search'
  }

  getToolLabel(type: string): string {
    const labels: Record<string, string> = {
      memory_search: t('检索记忆'),
      memory_recall: t('读取记忆详情'),
      memory_write: t('写入记忆'),
    }
    return labels[type] || t('长期记忆')
  }

  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      const type = props.useContent.name
      const input = (props.useContent.input ?? {}) as any
      const ui = props.message?.uiData as any

      // 无本地存储（库打不开 / 浏览器环境）：如实说明，而不是显示「0 条结果」
      if (ui?.available === false) {
        return <span style={{ color: '#999' }}>{t('记忆功能不可用')}</span>
      }

      if (type === 'memory_search') {
        const count = ui?.count
        const parts = [tpl('检索「$__query__」', { query: input?.query ?? '' })]
        if (count === 0) parts.push(t('无匹配记忆'))
        else if (typeof count === 'number') parts.push(tpl('$__count__ 条记忆', { count }))
        return <span>{parts.join(' · ')}</span>
      }

      if (type === 'memory_recall') {
        const id = ui?.memoryId ?? input?.memory_id ?? ''
        const parts = [tpl('读取 $__id__', { id })]
        // 「有链接但读不到详情」和「本来就没有详情」是两件事，分别显示
        if (ui?.found === true && ui?.hasDetail === false) parts.push(t('该记忆没有详情'))
        return <span>{parts.join(' · ')}</span>
      }

      const summary: string = input?.summary ?? ''
      const short =
        summary.length > SHORT_SUMMARY_CHARS
          ? summary.slice(0, SHORT_SUMMARY_CHARS) + '…'
          : summary
      return <span>{tpl('保存「$__summary__」', { summary: short })}</span>
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    const content = props.message?.content as string | undefined
    if (props.message?.isError) {
      return <div className="error">{content}</div>
    }
    if (!content) return null
    return (
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          margin: 0,
          fontSize: 'var(--font-size-sm)',
          lineHeight: 1.6,
        }}>
        {content}
      </pre>
    )
  }

  diyWrapper(): boolean {
    return false
  }
}

export default MemoryMessage
