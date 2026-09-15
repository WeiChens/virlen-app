import { useEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import commentEvent from '@/events/commentEvent'
import { getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import {
  ToolOutput,
  toolOutputStore,
} from '@/infrastructure/tools/output-store'
import { processTerminalOutput } from '@/infrastructure/tools/execute/common'

function shortPath(path: string): string {
  const workspace =
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace
  return path ? toShortPath(path, workspace) : ''
}

function RunningOutput({
  toolCallId,
  cmd,
  filePath,
  tips,
}: {
  toolCallId: string
  cmd: string
  filePath?: string
  tips?: string
}) {
  const [liveOutput, setLiveOutput] = useState<string>(null)
  const [entry, setEntry] = useState<ToolOutput | null>(
    toolOutputStore.get(toolCallId),
  )
  const scrollRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    // 立即读取一次已有输出
    const existing = toolOutputStore.get(toolCallId)
    if (existing) {
      setLiveOutput(existing.output)
    }
    const unsub = toolOutputStore.subscribe((id, out) => {
      if (id === toolCallId) {
        setLiveOutput(out.output)
      }
    })
    return unsub
  }, [toolCallId])

  useEffect(() => {
    if (entry) return
    const timer = setInterval(() => {
      const newEntry = toolOutputStore.get(toolCallId)
      if (newEntry) {
        setEntry(newEntry)
      }
    }, 500)
    return () => {
      clearInterval(timer)
    }
  }, [entry])

  useEffect(() => {
    if (entry) {
      commentEvent.emit('requestScrollToBottom')
      if (!scrollRef.current) return
      const bottom =
        scrollRef.current.scrollHeight -
        (scrollRef.current.scrollTop + scrollRef.current.clientHeight)
      if (bottom < 40) {
        scrollRef.current.scroll({
          top: scrollRef.current.scrollHeight,
          behavior: 'instant',
        })
      }
    }
  }, [liveOutput, entry])

  if (!entry) return null
  const output = processTerminalOutput(liveOutput)

  return (
    <div className="tool-cmd-running">
      <div className="execute-command-wrapper">
        <div className="header">
          <span className="title">Script</span>
          {tips && <span className="execute-command-header-tips">{tips}</span>}
          {entry.kill && (
            <button
              className="tool-cmd-kill-btn"
              onClick={() => {
                entry.kill?.()
              }}
              title={t('终止执行')}>
              ■ {t('终止')}
            </button>
          )}
        </div>
        <div className="code-pre-warpper">
          <pre className="code-pre" ref={scrollRef}>
            {filePath && (
              <>
                <code style={{ userSelect: 'none' }}>📄 </code>
                <code>{shortPath(filePath) + '\n'}</code>
              </>
            )}
            <code style={{ userSelect: 'none' }}>$ </code>
            <code>{cmd + '\n'}</code>
            <code>{output}</code>
          </pre>
        </div>
      </div>
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
      const command = props.useContent.input.command
      const filePath = props.useContent.input.file_path as string | undefined
      const tips = props.useContent.input.tips as string | undefined
      const body = props.message?.content as string
      if (!props.message) {
        return (
          <RunningOutput
            toolCallId={props.useContent.id}
            cmd={command}
            filePath={filePath}
            tips={tips}
          />
        )
      }
      if (!props.expand) {
        return null
      }
      const output = {
        stdout: props.message.uiData?.stdout || body,
        stderr: props.message.uiData?.stderr || '',
      }
      return (
        <div className="execute-command-wrapper">
          <div className="header">
            <span className="title">Script</span>
            {tips && <span className="execute-command-header-tips">{tips}</span>}
          </div>
          <div className="code-pre-warpper">
            <pre className="code-pre">
              {filePath && (
                <>
                  <code style={{ userSelect: 'none' }}>📄 </code>
                  <code>{shortPath(filePath) + '\n'}</code>
                </>
              )}
              <code style={{ userSelect: 'none' }}>$ </code>
              <code>{command + '\n'}</code>
              <code
                style={{
                  color: '#22c122',
                }}>
                {processTerminalOutput(output.stdout?.trim()) + '\n'}
              </code>
              <code
                style={{
                  color: '#d82222',
                }}>
                {processTerminalOutput(output.stderr?.trim())}
              </code>
              {props.message.uiData?.note && (
                <code style={{ color: '#e5c07b' }}>
                  {'\n' + props.message.uiData.note}
                </code>
              )}
            </pre>
          </div>
        </div>
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
