/**
 * 一段**连续**的工具调用合成一行（行模型见 `message-list/rows.ts`）。
 *
 * 折叠态只说一件事：调了几次（外加工具名预览）；展开后是各自仍可再展开的卡片（卡片的折叠态由
 * `ToolCallMessage` 自己管，本组件只把「按住滚动偏移」透传下去）。
 * **段首宿主的正文**若有，显示在组头之**上**、不随折叠隐藏（它是看得见的边界，分段规则见 `rows.ts::buildRows`）。
 * 头部**不显示**成功/失败的状态点。
 *
 * ⚠️ 段首宿主交给**真的 `MessageBubble`** 渲染（只传 `omitToolCalls`：卡片由本组渲染）：
 * 成员消息进了组就不会再走列表的气泡分支，若这里手搓一份精简气泡，段首那条的
 * **思考过程折叠块**（`.reasoning-block`）、底部操作栏、右键菜单就会一起丢掉
 * —— 而「有正文的宿主」是允许进组的（见 `rows.ts::isToolCallMessage`），于是
 * 「正文输出的思考过程」被连带藏掉，与设置项「隐藏工具调用的思考过程」的语义不符。
 * 走真气泡 = 这些外围能力全部同源，不给第二个渲染口径。
 *
 * ⚠️ **运行中的组（pending）恒展开、不可折叠**：工具还在跑时折起来用户就看不到进展了；
 * 跑完（done / error）后恢复成「按 `open` 折叠」。
 * ⚠️ **尾部段**（后面再没有可见气泡的那组，`rows.ts::buildRows` 的 `tail`）**默认展开**：
 * 这段工具调用还没被正文收尾（agent 还在干活 / 刚跑完还没答话），折起来同样看不到进展。
 * 该默认值由列表层**算进 `open`**（用户点过则以用户的选择为准），本组件不重复判定。
 *
 * ⚠️ `open` 由父层**预先算好**并以布尔值传入：组件是 `memo` 的，若把折叠态留在内部读（或传一个每次渲染
 * 都换引用的 map），切换折叠会被 `memo` 挡掉（点了没反应）。同理，「成员消息」必须由父层按**成员身份**
 * 缓存后传进来（`useVirtualList.membersFor`），而不是传「全量 messages + 下标」或者父层 map 出来的新数组
 * —— 前者每次 setMessages 都换引用，后者每次渲染都换，两条都会把 `memo` 直接击穿。
 *
 * ⚠️ 点组头会改**这一行的高度** → 先请列表按住滚动偏移（`useRowToggleHold`）：贴底状态下库的跟底
 * 补偿会把阅读位置甩到组内容后面（与气泡的「显示更多 / 收起」同一类问题）。
 */
import { memo, useMemo } from 'react'
import type { Message } from '@/types'
import { t } from '@/ui/i18n'
import { useRowToggleHold } from '@/ui/hooks/useRowToggleHold'
import { ToolCallMessage } from '../tool-call'
import { toolGroupView } from './message-list/rows'
import { EMPTY_TOOL_RESULTS } from './message-list/constants'
import MessageBubble, { type MessageBubbleHandlers } from './message-bubble'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import './tool-call-group.scss'

interface Props extends MessageBubbleHandlers {
  /** 组行 key（折叠态就按它记账） */
  groupKey: string
  /**
   * 组内成员消息（带工具调用的 assistant，按时间顺序）。
   * ⚠️ 由列表层按行 key 缓存后传入（`useVirtualList.groupRowFor`）：成员没变就是同一个数组引用。
   * 不能改成「全量 messages + 下标」—— 那样每次 setMessages 都会换引用，memo 必然失效。
   */
  members: Message[]
  /**
   * 与 `members` 一一对应：该成员每条 toolCall 的结果消息（按 toolCalls 顺序）。
   * ⚠️ 同样必须由列表层缓存后传入：换「传函数」「每次渲染新建数组」都会击穿 memo
   * （函数跟着 messages 换引用）。
   */
  results: (Message | undefined)[][]
  /** 是否展开（列表层算好的：用户的表态 ?? 尾部段的默认展开，见 `rows.ts` 的 `tail`） */
  open: boolean
  /** 切换展开 / 收起（传 key 而非闭包，保证引用稳定以命中 memo） */
  onToggle: (key: string) => void
  /** 行内展开 / 收起会改这一行的高度 → 请列表按住滚动偏移（见 `useRowToggleHold`） */
  onHoldScrollOffset?: () => void
}

function ToolCallGroup({
  groupKey,
  members,
  results,
  open,
  onToggle,
  onHoldScrollOffset,
  onEdit,
  onDelete,
  onTransferSummary,
  onQuote,
  onQuoteJump,
}: Props) {
  // 结果按成员下标随身带；`toolGroupView` 仍按「成员 → 结果数组」取值，与折叠头口径一致
  const view = useMemo(() => {
    const byMember = new Map<Message, readonly (Message | undefined)[]>()
    members.forEach((msg, i) => byMember.set(msg, results[i] ?? EMPTY_TOOL_RESULTS))
    return toolGroupView(
      members,
      (msg) => byMember.get(msg) ?? EMPTY_TOOL_RESULTS,
    )
  }, [members, results])
  // 段首宿主（带工具调用的 assistant，可能带正文）交给真气泡渲染：正文 / 思考过程块 / 操作栏 /
  // 右键菜单一次性拿全，与列表里的普通消息同源（卡片由本组渲染，故传 omitToolCalls）
  const lead = members[0]
  // 运行中的组恒展开：工具还在跑时折起来，用户就看不到进展了
  const expanded = open || view.status === 'pending'
  const bodyId = `${groupKey}__body`
  // 组头就是「要保持可见」的锚点：收起后组内容一下矮掉（可能整屏），视口很可能已不在这一行上
  const { anchorRef: headRef, beforeToggle } = useRowToggleHold<HTMLButtonElement>(
    expanded,
    onHoldScrollOffset,
  )
  return (
    <>
      {lead && (
        <MessageBubble
          message={lead}
          omitToolCalls
          onEdit={onEdit}
          onDelete={onDelete}
          onTransferSummary={onTransferSummary}
          onQuote={onQuote}
          onQuoteJump={onQuoteJump}
          onHoldScrollOffset={onHoldScrollOffset}
        />
      )}
      <div className={`tool-group${expanded ? ' is-open' : ''}`}>
        <button
          type="button"
          ref={headRef}
          className={`tool-group__head is-${view.status}`}
          onClick={() => {
            // 运行中的组恒展开：点它不会改高度（折不起来），别白按住一窗偏移
            if (!expanded) beforeToggle(true)
            else if (view.status !== 'pending') beforeToggle(false)
            onToggle(groupKey)
          }}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          title={expanded ? t('收起工具调用') : t('展开工具调用')}>
          <span className="tool-group__label">{view.label}</span>
          {view.tools.length > 0 && (
            <span className="tool-group__tools" title={view.tools.join(', ')}>
              {view.tools.join(' · ')}
              {view.moreTools > 0 ? ` +${view.moreTools}` : ''}
            </span>
          )}
          <CollapsedSvg
            className={`tool-group__caret${expanded ? ' is-open' : ''}`}
          />
        </button>
        {expanded && (
          <div className="tool-group__body" id={bodyId}>
            {members.map((message, k) => {
              const toolCalls = message.toolCalls ?? []
              const memberResults = results[k] ?? EMPTY_TOOL_RESULTS
              return (
                <div className="tool-group__member" key={message.id}>
                  {toolCalls.map((tc, i) => (
                    <ToolCallMessage
                      key={tc.id}
                      message={tc}
                      result={memberResults[i]}
                      onHoldScrollOffset={onHoldScrollOffset}
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
