import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

class GetCurrentTimeMessage implements IToolCallMessage {
  getToolName(): string {
    return 'get_current_time'
  }
  getToolLabel(): string {
    return t('获取当前时间')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      const { timezone } = props.useContent.input
      const body = (props.message?.content as string) || ''
      const tzInfo = timezone ? tpl('（时区：$__tz__）', { tz: timezone }) : ''
      return tzInfo + body
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      const body = props.message?.content as string
      if (body === null) {
        return <div>{t('获取失败')}</div>
      }
      return <div>{body}</div>
    } catch {
      return <div>{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return false
  }
}

export default GetCurrentTimeMessage
