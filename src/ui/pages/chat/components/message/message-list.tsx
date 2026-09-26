/**
 * chat-message-list — 聊天消息列表组件（虚拟滚动版）
 *
 * 从 chat-view 分离，管理消息列表的渲染、滚动行为、暂停/错误提示。
 *
 * 使用 @tanstack/react-virtual 做「动态高度」虚拟滚动：
 *  - DOM 恒定：仅渲染视口附近的若干条消息，向上翻阅上万条也不会累积 DOM。
 *  - 滚动锚定：向上从 SQLite 回补更早历史（前插）时保持视口不跳动。
 *  - 贴底跟随：位于底部时，新消息 / 流式增长自动跟随；用户上滑后不打扰。
 *
 * 拆分说明：全部状态 / 副作用 / 事件已抽到 `./message-list/*`
 *（use-message-list 编排 + use-virtual-list / use-scroll-controller / use-jump-controller），
 * 本文件只负责把控制器返回的渲染模型拼成 JSX，并保持既有对外 API 不变。
 */
import { useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import MessageBubble from './message-bubble'
import { useChatMessageList } from './message-list/use-message-list'
import { AnchorDots } from './message-list/anchor-dots'
import {
  ErrorBanner,
  JumpLoadingIndicator,
  LoadMoreHint,
  PausedRunBanner,
  ScrollToBottomButton,
} from './message-list/overlays'
import './message-list.scss'
import type { ChatMessageListProps } from './message-list/types'

export type { MessageJumpTarget, ChatMessageListProps } from './message-list/types'

function ChatMessageList(props: ChatMessageListProps) {
  const { messages, onQuoteJump } = props
  const m = useChatMessageList(props)

  // 锚点点击：scrollToMessage 是异步的，这里显式 void 掉返回值
  const handleAnchorJump = useCallback(
    (id: string) => {
      void m.scrollToMessage(id)
    },
    [m.scrollToMessage],
  )

  return (
    <>
      {/* 错误提示 */}
      {m.error && <ErrorBanner error={m.error} onClose={m.closeError} />}

      {/* 消息列表（虚拟滚动：仅渲染视口附近的若干条） */}
      <div
        className="chat-messages-container"
        style={{
          opacity: m.hide ? 0 : 1,
        }}
        ref={m.containerRef}>
        <div
          className="vm-list"
          style={{
            height: m.rowVirtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}>
          {/* 加载更多提示（点击可手动回补更早历史） */}
          {m.hasMoreInDb && (
            <LoadMoreHint
              loading={m.isLoadingOlder}
              onClick={() => {
                if (!m.isLoadingOlder) void m.loadOlder()
              }}
            />
          )}

          {m.virtualItems.map((vi) => {
            const msg = messages[vi.index]
            if (!msg) return null
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={m.rowVirtualizer.measureElement}
                className={`message-item-wrap${msg.id === m.highlightMsgId ? ' highlighted' : ''}`}
                data-msg-id={msg.role === 'user' ? msg.id : undefined}
                style={{
                  position: 'absolute',
                  top: vi.start,
                  left: 0,
                  width: '100%',
                }}>
                <MessageBubble
                  onEdit={m.handleEditBubble}
                  onDelete={m.handleDeleteBubble}
                  onTransferSummary={m.handleTransferSummary}
                  onQuote={m.handleQuoteBubble}
                  onQuoteJump={onQuoteJump}
                  message={msg}
                  toolResults={m.toolResultsFor(msg)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* 用户消息锚点列表 — 覆盖整个会话的全量 user 消息，可视区内滚动查找 */}
      {m.anchorUsers.length > 1 && (
        <div className="msg-anchor-list">
          <AnchorDots
            users={m.anchorUsers}
            activeId={m.activeUserMsgId}
            loadingId={m.jumpLoadingId}
            onJump={handleAnchorJump}
          />
        </div>
      )}

      {/* 锚点定位中：点击的锚点在回补历史（需等待时显示） */}
      {m.jumpLoadingId && <JumpLoadingIndicator />}

      {/* 滚动到底部按钮 */}
      {m.showScrollToBottomBtn && (
        <ScrollToBottomButton onClick={m.handleScrollToBottom} />
      )}

      {/* 工具调用暂停提示 */}
      {m.isCurrentPaused && (
        <PausedRunBanner
          onResume={m.handleResume}
          onCancel={m.handleCancelPaused}
        />
      )}
    </>
  )
}

export default observer(ChatMessageList)
