import './style.scss'
import { Component, ReactNode, useState } from 'react'
import { t } from '@/ui/i18n'
import {
  getToolCallMessage,
  IToolCallMessage,
  ToolMessageProps,
} from './IToolCallMessage'
import { Message, ToolUseContent } from '@/types'
import { ToolCallGroup } from './tool-call-group'
import { extractReactNodeText } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import ContextMenu, {
  useContextMenu,
} from '@/ui/components/shared/ContextMenu'
import { fileMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import { primaryPathOf } from './primary-path'
export { ToolCallGroup }

/**
 * 展开视图渲染错误兜底。
 * 单条工具消息渲染异常时只展示错误占位，避免异常冒泡导致整棵组件树崩溃白屏。
 */
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
 * 把 getExpandView 放到子组件里执行，再套上 ExpandErrorBoundary：
 * 若直接在 ToolCallMessage 自身的渲染流程中调用 getExpandView 并抛出异常，
 * 异常会从 ToolCallMessage 的 render 中冒泡出去，无法被子级错误边界捕获。
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
}

export function ToolCallMessage({ message, result }: Props) {
  const type = message.name
  const [expand, setExpand] = useState(false)
  /** 卡片右键菜单：只针对「本工具操作的那个路径」 */
  const menu = useContextMenu<string>()
  /** 主路径（取不到就不开菜单 —— 宁可不响应，也不要打开一个打不开的路径） */
  const primaryPath = primaryPathOf(message.input)
  /**
   * 当前会话工作目录。工具入参里的路径可能是**相对**的（LLM 常写 `src/a.ts`），
   * 而 openPath / revealItemInDir 只认绝对路径，故将 workspace 交给 fileMenuItems 补齐。
   * 取值与 TerminalBlock / securityService.getWorkspace 一致。
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
        onClick={() => setExpand(!expand)}
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
