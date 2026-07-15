/**
 * message-bubble — 消息气泡
 * 区分 user/assistant/tool 角色，渲染 Markdown、图片、tool calls、底部操作栏（复制/时间/编辑）
 */
import { t } from '@/ui/i18n'
import { type Message } from '@/types'
import CopySvg from '@/ui/components/icons/CopySvg'
import EditSvg from '@/ui/components/icons/EditSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import MarkdownRenderer from './markdown-renderer'
import './message-bubble.scss'
import { showToast } from '@/ui/components/shared/Toast'
import { timeFormat } from '@/utils/time'
import { useRef, useState } from 'react'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import ThinkSvg from '@/ui/components/icons/ThinkSvg'
import { ToolCallMessage, ToolCallGroup } from '../tool-call'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { settingsState } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import { showImagePreview } from '@/ui/components/shared/ImagePreview'
import QuickInputSvg from '@/ui/components/icons/QuickInputSvg'
import { Observer } from 'mobx-react-lite'

interface Props {
  message: Message
  onEdit?: (message: string) => void
  onDelete?: (messageId: string) => void
  allMessages: Message[]
}

export default function MessageBubble({
  message,
  onEdit,
  onDelete,
  allMessages,
}: Props) {
  const mkdRef = useRef(null as HTMLDivElement)

  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'
  const isAssistant = message.role === 'assistant'
  if (isTool) return null

  function getContent(renderer = true): string {
    if (typeof message.content === 'string') {
      if (isAssistant && !renderer) {
        return (mkdRef.current?.innerText || message.content).trim()
      }
      return message.content.trim()
    }
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
      .trim()
  }

  function hasImages(): boolean {
    if (typeof message.content === 'string') return false
    return message.content.some((block) => block.type === 'image_url')
  }

  function getImages(): string[] {
    if (typeof message.content === 'string') return []
    return message.content
      .filter((block) => block.type === 'image_url')
      .map((block) => ('image_url' in block ? block.image_url.url : ''))
  }

  function handleCopy() {
    const content = getContent(false)
    navigator.clipboard
      ?.writeText(content)
      .then(() => {
        showToast(t('已复制到剪贴板'))
      })
      .catch(() => {
        const textarea = document.createElement('textarea')
        textarea.value = content
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      })
  }

  // assistant 只有 tool_calls 没有文本内容时，显示为紧凑的 tool-call 卡片
  const showAsToolCall =
    isAssistant && message.toolCalls?.length && !getContent()
  // tool 消息内容只是纯结果文本，用简洁方式展示
  const showContent = getContent()

  // 是否显示底部操作栏（streaming 中和纯 toolcall/无内容不显示）
  const showActions = !message.streaming && !showAsToolCall && !isTool

  const [showReasoning, setShowReasoning] = useState(false)
  const isReasoningTime =
    message.streaming && message.reasoningContent && !message.content
  const hideToolCallThink = settingsState.value.hideToolCallThink

  const hideMessageBubble =
    isAssistant &&
    message.toolCalls &&
    message.toolCalls.length > 0 &&
    !showContent &&
    hideToolCallThink
  return (
    <>
      {!hideMessageBubble && (
        <div
          className={`message-bubble ${isUser ? 'user' : isTool ? 'tool' : 'assistant'} ${showAsToolCall ? 'toolcall-only' : ''}`}>
          <div className="message-body">
            {(isAssistant || isUser) && (
              <>
                {message.reasoningContent && (
                  <div className={`reasoning-block`}>
                    {showContent && (
                      <div
                        className="reasoning-header"
                        onClick={() => {
                          if (isReasoningTime) return
                          setShowReasoning((v) => !v)
                        }}>
                        <ThinkSvg className="reasoning-icon"></ThinkSvg>
                        <span>
                          {showContent
                            ? t('思考过程')
                            : message.streaming
                              ? t('思考中...')
                              : t('思考过程')}
                        </span>
                        {!isReasoningTime && (
                          <CollapsedSvg
                            className={`collapsed-icon ${showReasoning ? 'collapsed' : ''}`}
                          />
                        )}
                      </div>
                    )}
                    {(showReasoning ||
                      isReasoningTime ||
                      (!showContent &&
                        (!settingsState.value.hideToolCallThink ||
                          !message.toolCalls?.length))) && (
                      <div className={`reasoning-text`}>
                        <div
                          className={`line ${isReasoningTime ? 'reasoning' : ''}`}></div>
                        <MarkdownRenderer
                          content={message.reasoningContent}
                          isUser={false}
                          streaming={message.streaming}
                        />
                      </div>
                    )}
                  </div>
                )}
                <div className="message-content-wrapper">
                  {showContent && (
                    <div className="message-content" ref={mkdRef}>
                      <MarkdownRenderer
                        content={showContent}
                        isUser={isUser}
                        streaming={message.streaming}
                      />
                    </div>
                  )}
                  {hasImages() && (
                    <div className="message-images">
                      {getImages().map((url, i) => (
                        <img
                          key={i}
                          src={url}
                          alt={`image-${i}`}
                          className="message-image"
                          onClick={() =>
                            showImagePreview({
                              src: url,
                              previewSrcList: getImages(),
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                  {showActions && (
                    <div className="message-actions">
                      <span className="action-time">
                        {timeFormat(message.timestamp)}
                      </span>
                      <Observer>
                        {() => {
                          function handleSaveToQuickInput() {
                            const text = getContent(false)
                            if (!text) return
                            const templates =
                              settingsState.value.quickInputTemplates
                            settingsState.setValue('quickInputTemplates', [
                              ...templates,
                              { id: v4(), text },
                            ])
                            showToast(t('已保存到快捷方式'))
                          }
                          return (
                            <>
                              {isUser &&
                                !showContent.includes('\n') &&
                                showContent.length <= 50 &&
                                !settingsState.value.quickInputTemplates.some(
                                  (t) => t.text === showContent,
                                ) && (
                                  <button
                                    className="action-btn"
                                    onClick={handleSaveToQuickInput}
                                    title={t('保存到快捷方式')}>
                                    <QuickInputSvg />
                                  </button>
                                )}
                            </>
                          )
                        }}
                      </Observer>
                      <button
                        className="action-btn"
                        onClick={handleCopy}
                        title={t('复制')}>
                        <CopySvg />
                      </button>
                      <button
                        className="action-btn"
                        title={t('编辑')}
                        onClick={() => {
                          onEdit(getContent(false))
                        }}>
                        <EditSvg />
                      </button>
                      {!isTool && (
                        <button
                          className="action-btn action-delete"
                          title={t('删除')}
                          onClick={async () => {
                            const confirmed = await MessageBox.warn(
                              t('删除消息'),
                              t('确认删除该消息及后续所有消息？'),
                            )
                            if (confirmed) {
                              onDelete?.(message.id)
                            }
                          }}>
                          <DeleteSvg />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallGroup
          toolCalls={message.toolCalls}
          allMessages={allMessages}
          showContent={!!showContent}>
          <div className="message-tool-calls">
            {message.toolCalls.map((tc) => (
              <ToolCallMessage
                key={tc.id}
                message={tc}
                allMessages={allMessages}
              />
            ))}
          </div>
        </ToolCallGroup>
      )}
    </>
  )
}
