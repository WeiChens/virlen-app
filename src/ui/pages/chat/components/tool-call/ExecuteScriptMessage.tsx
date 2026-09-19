import { useState } from 'react'
import { t } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { TerminalView } from './TerminalBlock'
import { Message } from '@/types'
import CodeBlock from '../message/code-block'

function shortPath(path: string): string {
  const workspace =
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace
  return path ? toShortPath(path, workspace) : ''
}

/**
 * execute_script 展开视图：顶部「终端 / 文件」切换，默认终端。
 *
 * tabs 放在 TerminalView **外面**，终端块（TerminalBlock）自身结构不变。
 *
 * 切到「文件」时终端直接卸载（而非用 display:none 隐藏，也不用给 TerminalView
 * 加 props）：终端输出本来就存在 toolOutputStore 里，切回来重新挂载即可完整还原，
 * 且重新挂载会重新触发贴底，不会停在跑了一半的某一行。
 */
function ScriptExpandView({
  toolCallId,
  command,
  filePath,
  fileContent,
  message,
  expand,
}: {
  toolCallId: string
  command?: string
  filePath?: string
  fileContent: string
  message?: Message
  /** 用户是否展开了本条工具消息（驱动终端块的「打开即居中」） */
  expand?: boolean
}) {
  const [tab, setTab] = useState<'terminal' | 'file'>('terminal')
  const fileLabel = filePath ? shortPath(filePath) : ''

  return (
    <div className="script-view">
      <div className="script-tabs">
        {(['terminal', 'file'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}>
            {key === 'terminal' ? t('终端') : t('文件')}
          </button>
        ))}
      </div>
      {tab === 'terminal' ? (
        <TerminalView
          toolCallId={toolCallId}
          title={t('脚本')}
          cmd={command}
          fileLabel={fileLabel}
          message={message}
          expand={expand}
        />
      ) : fileContent ? (
        // 脚本正文直接取工具入参 file_content —— 即真正写入磁盘并执行的那份内容
        // （脚本默认执行完即删，重新读盘会拿不到）。
        <div className="script-file">
          <CodeBlock fileName={fileLabel} maxHeight={400} showLineNumbers>
            {fileContent}
          </CodeBlock>
        </div>
      ) : (
        <div className="script-file-empty">{t('暂无文件内容')}</div>
      )}
    </div>
  )
}

class ExecuteScriptMessage implements IToolCallMessage {
  getToolName(): string {
    return 'execute_script'
  }
  getToolLabel(): string {
    return t('执行脚本')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { command, tips, file_path } = props.useContent.input
      return (
        <span className="execute-command-short">
          {tips && <span className="execute-command-tips">{tips}</span>}
          <span style={{ color: 'var(--accent-color)', fontWeight: 500 }}>
            {command || file_path || getUrlFileName(file_path || '', null)}
          </span>
        </span>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      const { command, file_path, file_content } =
        props.useContent.input
      const message = props.message
      // 运行中：不展开也渲染实时终端；完成后折叠则不渲染
      if (message && !props.expand) return null
      return (
        <ScriptExpandView
          toolCallId={props.useContent.id}
          command={command as string | undefined}
          filePath={file_path as string | undefined}
          fileContent={(file_content as string) ?? ''}
          message={message}
          expand={props.expand}
        />
      )
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return true
  }
}

export default ExecuteScriptMessage
