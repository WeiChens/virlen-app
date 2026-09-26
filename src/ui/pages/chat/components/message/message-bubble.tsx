/**
 * message-bubble — 消息气泡
 * 区分 user/assistant/tool 角色，渲染 Markdown、图片、tool calls、底部操作栏（复制/时间/编辑）
 */
import { t, tpl } from '@/ui/i18n'
import { type Message } from '@/types'
import CopySvg from '@/ui/components/icons/CopySvg'
import EditSvg from '@/ui/components/icons/EditSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import MarkdownRenderer from './markdown-renderer'
import './message-bubble.scss'
import { showToast } from '@/ui/components/shared/Toast'
import { timeFormat, formatDuration } from '@/utils/time'
import { memo, useRef, useState } from 'react'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import ThinkSvg from '@/ui/components/icons/ThinkSvg'
import { ToolCallMessage, ToolCallGroup } from '../tool-call'
import { changeBrief } from '../todo/brief'
import SummaryMessage from './summary-message'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { settingsState } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import { showImagePreview } from '@/ui/components/shared/ImagePreview'
import FileChip from '@/ui/components/shared/FileChip'
import SkillChip from '@/ui/components/shared/SkillChip'
import QuickInputSvg from '@/ui/components/icons/QuickInputSvg'
import { Observer } from 'mobx-react-lite'
import { openPath } from '@tauri-apps/plugin-opener'
import { getFileBlocks, getQuoteBlocks, getSkillBlocks } from '@/utils/messageContent'
import QuoteSvg from '@/ui/components/icons/QuoteSvg'
import QuoteChip from '@/ui/components/shared/QuoteChip'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import {
  fileMenuItems,
  imageMenuItems,
  textMenuItems,
} from '@/ui/components/shared/ContextMenu/menus'

interface Props {
  message: Message
  onEdit?: (message: string) => void
  onDelete?: (messageId: string) => void
  /**
   * 右键「上下文压缩摘要」→「转移到新对话」：以当前会话为模板新建会话，
   * 把该摘要作为新会话的首条消息并切换过去。不传则不展示该项。
   */
  onTransferSummary?: (messageId: string) => void
  /**
   * 引用该消息（仅“有正文”的消息可引用）：把消息 id / 发送方 / 正文快照交给输入框
   *
   * 深思考 / 纯工具调用消息没有正文，不提供引用入口（气泡容器已隐藏操作栏）
   */
  onQuote?: (quote: {
    messageId: string
    role: 'user' | 'assistant'
    text: string
  }) => void
  /** 点击引用 chip：跳转定位到被引用的原消息 */
  onQuoteJump?: (messageId: string) => void
  /** 与 message.toolCalls 一一对应的工具结果（未完成处为 undefined） */
  toolResults?: (Message | undefined)[]
}

/**
 * 右键菜单指向的对象。
 *
 * 同一个气泡里有多类可右键对象（正文 / 图片 / 文件 chip / 深度思考），
 * 同一时刻只允许开一个菜单，所以用 target 区分「这次点的是什么」，
 * 菜单项在渲染时按 target 现算（见 useContextMenu 的说明）。
 */
type MenuTarget =
  | { kind: 'text' }
  | { kind: 'summary' }
  | { kind: 'reasoning' }
  | { kind: 'image'; src: string }
  | { kind: 'file'; path: string; isDir?: boolean }
  | { kind: 'skill'; path: string }

function MessageBubble({
  message,
  onEdit,
  onDelete,
  onTransferSummary,
  onQuote,
  onQuoteJump,
  toolResults,
}: Props) {
  const mkdRef = useRef<HTMLDivElement | null>(null)
  /** 深度思考文本容器（右键「全选」要选在这上面） */
  const reasoningRef = useRef<HTMLDivElement | null>(null)
  /** 右键菜单（正文 / 图片 / 文件 / 深度思考共用一套） */
  const menu = useContextMenu<MenuTarget>()

  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'
  const isAssistant = message.role === 'assistant'
  const isFeedback = message.role === 'feedback'
  const isSummary = message.role === 'summary'
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

  /** 文件附件（只存路径，点击用系统默认程序打开） */
  const files = getFileBlocks(message.content)
  /** 引用消息（本条消息引用了哪些历史消息的正文） */
  const quotes = getQuoteBlocks(message.content)
  /** 技能引用（本条消息携带了哪些技能的 SKILL.md 全文） */
  const skills = getSkillBlocks(message.content)

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

  /**
   * 「删除」的实际动作（底部操作栏按钮与右键菜单共用：二次确认 → 删本条及后续）。
   */
  async function confirmDeleteMessage() {
    const confirmed = await MessageBox.warn(
      t('删除消息'),
      t('确认删除该消息及后续所有消息？'),
    )
    if (confirmed) {
      onDelete?.(message.id)
    }
  }

  /** 深度思考正文「全选」：把选区铺满整个思考内容（随后即可「复制」） */
  function selectAllReasoning() {
    const el = reasoningRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  /**
   * 按右键对象组装菜单项。
   *
   * 正文菜单与气泡底部操作栏**同源**：引用 / 编辑 / 删除的可见条件、
   * 删除的二次确认都复用同一批逻辑，避免两个入口行为分叉。
   */
  function buildMenuItems(target: MenuTarget): ContextMenuItem[] {
    switch (target.kind) {
      case 'image':
        return imageMenuItems(target.src)
      case 'file':
        return fileMenuItems(target.path, { isDir: target.isDir })
      case 'skill':
        // 技能引用：打开 / 编辑器打开直接指向 SKILL.md（引用的就是这份说明），
        // 再补一个目录入口（isDir 菜单会自动隐掉「编辑器打开」）
        return [
          ...fileMenuItems(`${target.path}/SKILL.md`),
          {
            key: 'open-skill-dir',
            label: t('打开技能目录'),
            divider: true,
            onClick: () => {
              openPath(target.path).catch(() => showToast(t('打开失败')))
            },
          },
        ]
      case 'reasoning':
        // 选区优先，无选区则复制整段思考内容；「全选」便于两步拿到全部
        return textMenuItems(() => message.reasoningContent || '', {
          selectAll: selectAllReasoning,
        })
      case 'summary': {
        // 压缩摘要：「复制 / 转移到新对话 / 删除」三项。
        // 它不是模型产出的一条对话，没有引用 / 编辑的语义；
        // 「转移到新对话」= 把摘要拷进一个新会话当开头，方便在干净上下文里继续；
        // 删除同样是「本条及之后全部删除」（删掉 summary = 放弃这次压缩，
        // 其后的对话也一并清掉），与其它气泡的删除语义保持一致。
        const items: ContextMenuItem[] = [
          ...textMenuItems(() => getContent(false)),
        ]
        if (onTransferSummary) {
          items.push({
            key: 'transfer-to-new-chat',
            label: t('转移到新对话'),
            onClick: () => onTransferSummary(message.id),
          })
        }
        items.push({
          key: 'delete',
          label: t('删除'),
          divider: true,
          danger: true,
          onClick: confirmDeleteMessage,
        })
        return items
      }
      default: {
        const items = textMenuItems(() => getContent(false))
        if (onQuote && showContent) {
          items.push({
            key: 'quote',
            label: t('引用'),
            onClick: () =>
              onQuote({
                messageId: message.id,
                role: isUser ? 'user' : 'assistant',
                text: getContent(false),
              }),
          })
        }
        items.push({
          key: 'edit',
          label: t('编辑'),
          onClick: () => {
            onEdit?.(getContent(false))
          },
        })
        items.push({
          key: 'delete',
          label: t('删除'),
          divider: true,
          danger: true,
          onClick: confirmDeleteMessage,
        })
        return items
      }
    }
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

  // 上下文压缩产物（role='summary'）：正文可能极长，不在消息流里铺开，
  // 只渲染可点击的提示条，摘要全文放弹窗（详见 summary-message.tsx）。
  // 摘要也必须能右键：否则用户压缩错了就没办法回退 —— 删除 summary 即「放弃压缩」，
  // 本条及之后的消息一并删除（与其它气泡同一条删除路径）。
  if (isSummary) {
    return (
      <>
        <SummaryMessage
          message={message}
          onContextMenu={(e) => menu.openAt(e, { kind: 'summary' })}
        />
        {menu.state && (
          <ContextMenu
            position={menu.state.position}
            items={buildMenuItems(menu.state.target)}
            onClose={menu.close}
          />
        )}
      </>
    )
  }

  // 任务清单变更（feedback 消息）：消息流只留一行 ——
  // 清单内容统一在标题栏的「任务清单」浮层里看（用户层面任务只有一份，见 components/todo/）。
  // 注意：正文（content）里仍是全量清单文本，给模型读，右键复制/删除照旧可用。
  if (isFeedback && message.uiData?.type === 'todo') {
    return (
      <div className="message-todo-notice">
        <span className="ico">✎</span>
        <span>
          {tpl('你更新了任务清单 · $__brief__', {
            brief: changeBrief(message.uiData.changes),
          })}
        </span>
      </div>
    )
  }

  // 反馈消息：居中系统通知样式
  if (isFeedback) {
    return (
      <div className="message-feedback">
        <div className="feedback-content">
          <MarkdownRenderer
            content={getContent()}
            isUser={false}
            streaming={false}
          />
        </div>
      </div>
    )
  }

  return (
    <>
      {!hideMessageBubble && (
        <div
          className={`message-bubble ${isUser ? 'user' : isTool ? 'tool' : 'assistant'} ${showAsToolCall ? 'toolcall-only' : ''}`}>
          <div
            className="message-body"
            onContextMenu={(e) => menu.openAt(e, { kind: 'text' })}>
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
                        {message.reasoningElapsedMs !== undefined && (
                          <span className="reasoning-elapsed">
                            {formatDuration(message.reasoningElapsedMs)}
                          </span>
                        )}
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
                        <div className={`reasoning-text`} ref={reasoningRef}
                          onContextMenu={(e) =>
                            menu.openAt(e, { kind: 'reasoning' })
                          }>
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
                  {quotes.length > 0 && (
                    <div className="message-quotes">
                      {quotes.map((q) => (
                        <QuoteChip
                          key={q.messageId}
                          role={q.role}
                          text={q.text}
                          messageId={q.messageId}
                          onClick={
                            onQuoteJump
                              ? () => onQuoteJump(q.messageId)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                  {skills.length > 0 && (
                    <div className="message-skills">
                      {skills.map((s, i) => (
                        <SkillChip
                          key={`${i}-${s.name}`}
                          // 气泡里用卡片形态：header 之外还能看到技能描述（最多三行）
                          variant="card"
                          name={s.name}
                          path={s.path}
                          description={s.description}
                          chars={s.content.length}
                          onContextMenu={
                            // 没有目录就不给菜单（fileMenuItems 需要一个能用的绝对路径）
                            s.path
                              ? (e) =>
                                  menu.openAt(e, { kind: 'skill', path: s.path! })
                              : undefined
                          }
                          onClick={
                            s.path
                              ? () => {
                                  openPath(s.path!).catch(() => { })
                                }
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
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
                          onContextMenu={(e) =>
                            menu.openAt(e, { kind: 'image', src: url })
                          }
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
                  {files.length > 0 && (
                    <div className="message-files">
                      {files.map((f) => (
                        <FileChip
                          key={f.path}
                          path={f.path}
                          name={f.name}
                          isDir={f.isDir}
                          size={f.size}
                          onContextMenu={(e) =>
                            menu.openAt(e, {
                              kind: 'file',
                              path: f.path,
                              isDir: f.isDir,
                            })
                          }
                          onClick={() => {
                            openPath(f.path).catch(() => { })
                          }}
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
                          onEdit?.(getContent(false))
                        }}>
                        <EditSvg />
                      </button>
                      {!isTool && (
                        <button
                          className="action-btn action-delete"
                          title={t('删除')}
                          onClick={confirmDeleteMessage}>
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
          toolResults={toolResults}
          showContent={!!showContent}>
          <div className="message-tool-calls">
            {message.toolCalls.map((tc, i) => (
              <ToolCallMessage
                key={tc.id}
                message={tc}
                result={toolResults?.[i]}
              />
            ))}
          </div>
        </ToolCallGroup>
      )}
      {/* 右键菜单：正文 / 摘要 / 图片 / 文件 / 深度思考共用一套（同一时刻只开一个） */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={buildMenuItems(menu.state.target)}
          onClose={menu.close}
        />
      )}
    </>
  )
}

export default memo(MessageBubble)
