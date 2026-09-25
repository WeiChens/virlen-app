import { t, tpl, getCurrentLanguage } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/**
 * 失败文案：优先按结构化 `uiData.errorKind` 用界面语言重建（D2 的失败侧）；
 * 旧消息 / 无结构化信息 → 回退 `content`（模型侧固定英文原文，不做语言猜测）。
 *
 * 目前只有一种失败：非法时区（TS 侧预校验抛 `ToolError`，Rust 侧 `Tz::from_str` 失败，
 * 两侧文案同形，见 `infrastructure/tools/system/get-current-time.ts`）。
 */
function formatErrorBody(props: ToolMessageProps): string {
  const ui = props.message?.uiData as
    | { errorKind?: string; timezone?: string }
    | undefined
  if (ui?.errorKind === 'invalid_timezone') {
    return tpl('无效的时区: $__tz__', { tz: ui.timezone ?? '' })
  }
  return (props.message?.content as string) || ''
}

/**
 * 结果正文：优先用结构化 `uiData`（时间戳 + 时区）按当前 UI 语言本地化；
 * 旧数据（无 uiData）回退到 `message.content`（模型侧固定英文）。
 *
 * 这样「模型看到的时间格式」恒定，而「界面显示的时间格式」跟随 UI 语言。
 */
function formatTimeBody(props: ToolMessageProps): string {
  const ui = props.message?.uiData as
    | { timestamp?: number; timezone?: string }
    | undefined
  if (ui && typeof ui.timestamp === 'number') {
    return new Date(ui.timestamp).toLocaleString(getCurrentLanguage(), {
      timeZone: ui.timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'long',
    })
  }
  return (props.message?.content as string) || ''
}

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
      const body = props.message?.isError
        ? formatErrorBody(props)
        : formatTimeBody(props)
      const tzInfo = timezone ? tpl('（时区：$__tz__）', { tz: timezone }) : ''
      return tzInfo + body
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{formatErrorBody(props)}</div>
    }
    try {
      const body = formatTimeBody(props)
      if (!body) {
        return <div>{t('获取失败')}</div>
      }
      return <div>{body}</div>
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return false
  }
}

export default GetCurrentTimeMessage
