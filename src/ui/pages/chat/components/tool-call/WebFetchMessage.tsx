import { t, tpl } from '@/ui/i18n'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { openUrl } from '@tauri-apps/plugin-opener'
class WebFetchMessage implements IToolCallMessage {
  getToolName(): string {
    return 'web_fetch'
  }
  getToolLabel(): string {
    return t('网络请求')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      const { url, method = 'GET' } = props.useContent.input as any
      return `${method} ${url}`
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      const body = props.useContent.input.body
      if (!body)
        return (
          <div
            onClick={async () => {
              const flag = await MessageBox.propt(
                t('外部浏览器打开'),
                tpl('是否打开网站 $__url__?', {
                  url: props.useContent.input.url,
                }),
              )
              if (!flag) return
              openUrl(props.useContent.input.url)
            }}
            style={{
              textDecoration: 'underline',
              color: 'var(--accent-color)',
              cursor: 'pointer',
              wordBreak: 'break-all',
            }}>
            {props.useContent.input.url}
          </div>
        )
      return (
        <div>
          <div
            style={{
              color: '#5b5eff',
              fontWeight: '500',
              marginBottom: '8px',
            }}>
            {t('请求体')}
          </div>
          <pre className="body-content">
            {typeof body === 'string' ? body : JSON.stringify(body, null, 2)}
          </pre>
        </div>
      )
    } catch {
      return <div>{t('解析异常')}</div>
    }
    // return (
    //   <div
    //     style={{
    //       maxHeight: '400px',
    //       maxWidth: 'clamp(10%,70%,360px)',
    //       overflowY: 'auto',
    //     }}>
    //     <div
    //       dangerouslySetInnerHTML={{
    //         __html: props.message?.content || '',
    //       }}></div>
    //   </div>
    // )
  }
  diyWrapper(): boolean {
    return false
  }
}

export default WebFetchMessage
