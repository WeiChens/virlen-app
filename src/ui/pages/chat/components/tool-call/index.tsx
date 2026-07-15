import './style.scss'
import { useState } from 'react'
import { getToolCallMessage } from './IToolCallMessage'
import { Message, ToolUseContent } from '@/types'
import { ToolCallGroup } from './tool-call-group'
export { ToolCallGroup }

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}

interface Props {
  message: ToolUseContent
  allMessages: Message[]
}

export function ToolCallMessage({ message, allMessages }: Props) {
  const result = allMessages.find(
    (msg) => msg.role == 'tool' && msg.toolCallId === message.id,
  )
  const type = message.name
  const [expand, setExpand] = useState(false)
  const toolCallMessage = getToolCallMessage(type)
  const p = {
    message: result,
    useContent: message,
    expand,
  }
  const isError = result?.isError
  return (
    <>
      <div
        onClick={() => setExpand(!expand)}
        className={`tool-call-message ${isError ? 'tool-call-error' : ''} ${!result ? 'tool-call-pending' : ''}`}>
        <span
          className={`tool-call-point ${isError ? 'error' : ''} ${!result ? 'pending' : ''}`}></span>
        <span className="tool-call-label">
          {toolCallMessage.getToolLabel(type)}
        </span>
        <span className="tool-call-short-text">
          {toolCallMessage.getShortText(p)}
        </span>
        {result?.elapsedMs != null && result.elapsedMs > 1000 && (
          <span className="tool-call-timing">
            {formatElapsed(result.elapsedMs)}
          </span>
        )}
      </div>
      {toolCallMessage.diyWrapper() ? (
        toolCallMessage.getExpandView(p)
      ) : (
        <>
          {expand && (
            <div className="tool-call-expand-view">
              {toolCallMessage.getExpandView(p)}
            </div>
          )}
        </>
      )}
    </>
  )
}
