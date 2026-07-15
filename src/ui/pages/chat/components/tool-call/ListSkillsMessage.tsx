/**
 * ListSkillsMessage — list_skills 工具调用的消息展示组件
 *
 * 一行显示：技能数量（如果有 result 内容则提取）
 * 展开显示：完整的技能列表文本
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class ListSkillsMessage implements IToolCallMessage {
  getToolName(): string {
    return 'list_skills'
  }

  getToolLabel(_type: string): string {
    return t('技能')
  }

  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const content = props.message?.content as string | undefined
      if (content) {
        // 尝试提取技能数量，格式: "已启用技能 (N 个)"
        const match = content.match(/已启用技能\s*\((\d+)\s*个\)/)
        if (match) {
          const count = match[1]
          return (
            <span>
              {tpl('$__count__ 个技能', { count })}
            </span>
          )
        }
        // 如果内容以 0 个技能结尾
        if (content.includes('没有启用的技能') || content.includes('0 个')) {
          return <span style={{ color: '#999' }}>{t('暂无技能')}</span>
        }
      }
      return t('查看技能列表')
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.content) {
      return (
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            margin: 0,
            fontSize: 'var(--font-size-sm)',
            lineHeight: 1.6,
          }}>
          {props.message.content as string}
        </pre>
      )
    }
    return null
  }

  diyWrapper(): boolean {
    return false
  }
}

export default ListSkillsMessage
