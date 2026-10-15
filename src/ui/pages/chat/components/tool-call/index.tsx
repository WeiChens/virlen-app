import './style.scss'
import { Component, ReactNode, useState } from 'react'
import { t } from '@/ui/i18n'
import {
  getToolCallMessage,
  IToolCallMessage,
  ToolMessageProps,
} from './IToolCallMessage'
import { Message, ToolUseContent } from '@/types'
import { extractReactNodeText } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import ContextMenu, {
  useContextMenu,
} from '@/ui/components/shared/ContextMenu'
import { fileMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import { primaryPathOf } from './primary-path'
import { useRowToggleHold } from '@/ui/hooks/useRowToggleHold'

/** 展开视图渲染错误兜底：单条工具消息渲染异常时只展示错误占位，避免异常冒泡导致整棵组件树白屏 */
class ExpandErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[ToolCallMessage] expand view render failed:', error)
  }

  render() {
    if (this.state.hasError) {
      return <div className="error">{t('内容渲染失败')}</div>
    }
    return this.props.children
  }
}

/**
 * 把 getExpandView 放到子组件里执行再套错误边界：直接在 ToolCallMessage 的 render 里调用，
 * 异常会从它自身的 render 冒泡出去，子级错误边界捕获不到。
 */
function ToolCallExpandView({
  toolCallMessage,
  props,
}: {
  toolCallMessage: IToolCallMessage
  props: ToolMessageProps
}) {
  if (toolCallMessage.diyWrapper()) {
    return toolCallMessage.getExpandView(props)
  }
  if (!props.expand) return null
  return (
    <div className="tool-call-expand-view">
      {toolCallMessage.getExpandView(props)}
    </div>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}

interface Props {
  message: ToolUseContent
  /** 该工具调用的结果消息（未完成时为 undefined） */
  result?: Message
  /**
   * 展开 / 收起会改**这一行的高度**（展开视图撑在卡片下方）→ 请列表按住滚动偏移，
   * 否则贴底状态下库的跟底补偿会把阅读位置甩到卡片末尾（见 `useRowToggleHold`）。
   */
  onHoldScrollOffset?: () => void
}

export function ToolCallMessage({ message, result, onHoldScrollOffset }: Props) {
  const type = message.name
  const [expand, setExpand] = useState(false)
  /** 卡片右键菜单：只针对「本工具操作的那个路径」 */
  const menu = useContextMenu<string>()
  /** 展开 / 收起时按住滚动偏移（卡片头是「收起后要保持可见」的锚点） */
  const { anchorRef: cardRef, beforeToggle } = useRowToggleHold<HTMLDivElement>(
    expand,
    onHoldScrollOffset,
  )
  /** 主路径（取不到就不开菜单 —— 宁可不响应，也不要打开一个打不开的路径） */
  const primaryPath = primaryPathOf(message.input)
  /**
   * 当前会话工作目录。工具入参里的路径可能是相对的（LLM 常写 `src/a.ts`），而 openPath /
   * revealItemInDir 只认绝对路径，故把 workspace 交给 fileMenuItems 补齐（取值同 securityService）。
   */
  const workspace =
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace ||
    ''
  const toolCallMessage = getToolCallMessage(type)
  const p = {
    message: result,
    useContent: message,
    expand,
  }
  const isError = result?.isError
  // getShortText 在 ToolCallMessage 自身渲染中执行，异常无法被子级错误边界捕获，故调用点兜底
  let shortText: React.ReactNode
  try {
    shortText = toolCallMessage.getShortText(p)
  } catch (err) {
    console.error('[ToolCallMessage] getShortText failed:', err)
    shortText = t('解析异常')
  }
  
  return (
    <>
      <div
        ref={cardRef}
        onClick={() => {
          beforeToggle(!expand)
          setExpand(!expand)
        }}
        onContextMenu={
          primaryPath ? (e) => menu.openAt(e, primaryPath) : undefined
        }
        className={`tool-call-message ${isError ? 'tool-call-error' : ''} ${!result ? 'tool-call-pending' : ''}`}>
        <span
          className={`tool-call-point ${isError ? 'error' : ''} ${!result ? 'pending' : ''}`}></span>
        <span className="tool-call-label">
          {toolCallMessage.getToolLabel(type)}
        </span>
        <span className="tool-call-short-text" title={extractReactNodeText(shortText)}>{shortText}</span>
        {result?.elapsedMs != null && result.elapsedMs > 1000 && (
          <span className="tool-call-timing">
            {formatElapsed(result.elapsedMs)}
          </span>
        )}
      </div>
      <ExpandErrorBoundary>
        <ToolCallExpandView toolCallMessage={toolCallMessage} props={p} />
      </ExpandErrorBoundary>
      {/* 右键菜单：打开 / 编辑器打开 / 在文件管理器中显示 / 复制路径 */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={fileMenuItems(menu.state.target, {
            workspace,
            // read_file 会下发起止行 → 编辑器打开时直接定位（与文件卡片里的动作一致）
            line: result?.uiData?.startLine,
          })}
          onClose={menu.close}
        />
      )}
    </>
  )
}
