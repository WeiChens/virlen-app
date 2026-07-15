import { useEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import commentEvent from '@/events/commentEvent'
import {
  ToolOutput,
  toolOutputStore,
} from '@/infrastructure/tools/output-store'
import { processTerminalOutput } from '@/infrastructure/tools/terminal-output'

function RunningOutput({
  toolCallId,
  cmd,
}: {
  toolCallId: string
  cmd: string
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
          <span className="title">Bash</span>
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
        <pre className="code-pre" ref={scrollRef}>
          <code style={{ userSelect: 'none' }}>$ </code>
          <code>{cmd + '\n'}</code>
          <code>{output}</code>
        </pre>
      </div>
    </div>
  )
}

class ExecuteCommandMessage implements IToolCallMessage {
  getToolName(): string {
    return 'execute_command'
  }
  getToolLabel(): string {
    return t('终端')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { command } = props.useContent.input
      return (
        <span style={{ color: 'var(--accent-color)', fontWeight: 500 }}>
          {command}
        </span>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    // 如果工具还没返回结果（仍在运行中），展示实时输出

    // 已有最终结果，展示结果

    try {
      const command = props.useContent.input.command
      const body = props.message?.content as string
      if (!props.message) {
        return <RunningOutput toolCallId={props.useContent.id} cmd={command} />
      }
      if (!props.expand) {
        return null
      }
      const output = {
        stdout: props.message.uiData?.stdout || body,
        stderr: props.message.uiData?.stderr || '',
      }
      const code = props.message.uiData?.exitCode || 0

      return (
        <div className="execute-command-wrapper">
          <div className="header">
            <span className="title">Terminal</span>
          </div>
          <pre className="code-pre">
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
          </pre>
        </div>
      )
    } catch {
      return <div>{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return true
  }
}

export default ExecuteCommandMessage
