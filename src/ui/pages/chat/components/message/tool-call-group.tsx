/**
 * tool-call-group — 一段**连续**的工具调用合成一行（行模型见 `message-list/rows.ts`）。
 *
 * 折叠态只说一件事：调了几次（外加工具名预览）。展开后是**各自仍可再展开**的卡片
 *（`ToolCallMessage` 自带 `expand`，本组件不改它）。
 *
 * **段首宿主的正文**（若有）显示在组头之**上**、不随折叠隐藏 —— 它是「看得见的边界」，
 * 用户要能读到那句过渡说明（分段规则见 `rows.ts::buildRows`：中段正文会收口，段首正文被允许）。
 * 它的 DOM 复用普通 assistant 消息的容器（`.message-bubble.assistant > .message-content-wrapper
 * > .message-content`），所以看起来就是一条普通消息、左缩进与其它消息一致。
 *
 * 折叠头是桌面自有的「聚合行」：状态点 + 调了几次 + 工具名预览 + 折叠箭头
 *（**不是**移动端那张描边卡片的翻版，见 `.scss` 顶部说明）。
 *
 * ⚠️ `open` 由父层**预先算好**并以布尔值传入：组件是 `memo` 的，若把折叠态留在
 * 内部读（或传一个每次渲染都换引用的 map），切换折叠会被 `memo` 挡掉（点了没反应）。
 * 同理，「成员消息数组」由 `messages + messageIndexes` 在内层 `useMemo` 派生（而非在父层
 * `map` 一个新数组传进来）—— 否则每次父渲染都换引用，`memo` 会被直接击穿。
 */
import { memo, useMemo } from 'react'
import type { Message } from '@/types'
import { t } from '@/ui/i18n'
import { ToolCallMessage } from '../tool-call'
import { toolGroupView } from './message-list/rows'
import MarkdownRenderer from './markdown-renderer'
import { messageBodyText } from '@/utils/messageContent'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import './tool-call-group.scss'

interface Props {
  /** 组行 key（折叠态就按它记账） */
  groupKey: string
  /** 全量消息数组（按下标取成员；传全量 + 下标，让内层 useMemo 稳定以命中 memo） */
  messages: Message[]
  /** 组内成员消息下标（带工具调用的 assistant，按时间顺序） */
  messageIndexes: number[]
  /** 取某条消息 toolCalls 对应的结果数组（与列表共用 `toolResultsFor`） */
  toolResultsFor: (message: Message) => (Message | undefined)[]
  /** 是否展开（由列表层按行 key 记账） */
  open: boolean
  /** 切换展开 / 收起（传 key 而非闭包，保证引用稳定以命中 memo） */
  onToggle: (key: string) => void
}

function ToolCallGroup({
  groupKey,
  messages,
  messageIndexes,
  toolResultsFor,
  open,
  onToggle,
}: Props) {
  // 成员数组由「全量 messages + 下标」派生：滚动 / 其它组切换时两者引用都不变，
  // useMemo 便返回同一数组 → memo 生效，不会带着全部可见行一起重渲染。
  const members = useMemo(
    () =>
      messageIndexes
        .map((i) => messages[i])
        .filter((m): m is Message => !!m),
    [messageIndexes, messages],
  )
  const view = useMemo(
    () => toolGroupView(members, toolResultsFor),
    [members, toolResultsFor],
  )
  // 段首宿主的过渡正文：恒显示在组头之上（不随折叠隐藏）
  const lead = members[0] ? messageBodyText(members[0].content) : ''
  // 状态点只靠颜色表达，屏幕阅读器读不到 —— 给它一个可读的状态名
  const statusLabel =
    view.status === 'error'
      ? t('失败')
      : view.status === 'pending'
        ? t('进行中')
        : t('已完成')
  const bodyId = `${groupKey}__body`
  return (
    <>
      {lead && (
        // 复用普通 assistant 消息的容器，让它和别的消息长得一样（灰底气泡 + 一致缩进）
        <div className="message-bubble assistant">
          <div className="message-body">
            <div className="message-content-wrapper">
              <div className="message-content">
                <MarkdownRenderer content={lead} isUser={false} streaming={false} />
              </div>
            </div>
          </div>
        </div>
      )}
      <div className={`tool-group${open ? ' is-open' : ''}`}>
        <button
          type="button"
          className={`tool-group__head is-${view.status}`}
          onClick={() => onToggle(groupKey)}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          title={open ? t('收起工具调用') : t('展开工具调用')}>
          <span
            className="tool-group__point"
            role="img"
            aria-label={statusLabel}
          />
          <span className="tool-group__label">{view.label}</span>
          {view.tools.length > 0 && (
            <span className="tool-group__tools" title={view.tools.join(', ')}>
              {view.tools.join(' · ')}
              {view.moreTools > 0 ? ` +${view.moreTools}` : ''}
            </span>
          )}
          <CollapsedSvg
            className={`tool-group__caret${open ? ' is-open' : ''}`}
          />
        </button>
        {open && (
          <div className="tool-group__body" id={bodyId}>
            {members.map((message) => {
              const toolCalls = message.toolCalls ?? []
              const results = toolResultsFor(message)
              return (
                <div className="tool-group__member" key={message.id}>
                  {toolCalls.map((tc, i) => (
                    <ToolCallMessage
                      key={tc.id}
                      message={tc}
                      result={results[i]}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

export default memo(ToolCallGroup)
