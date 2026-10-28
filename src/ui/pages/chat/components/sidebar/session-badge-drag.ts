/**
 * 拖着左侧栏会话项上的「右侧栏标签数」徽标 = 把这个会话**开着的那批标签**搬走。
 *
 * 落点（判定都在 `session-drop.ts`，那里同时管「隐形行不接」这些坑）：
 * - 右侧面板的**标签栏** / 整个**聊天区**（`dropAreaHitAt`）→ 搬进**当前**会话；
 * - **另一个会话行**（`sessionDropHitAt`）→ 搬进那个会话；自己的会话行不算（「搬给自己」没意义）。
 *
 * 为什么聊天区也算：标签栏只有 36px 高，逼用户把徒标拖进一条细缝没道理；
 * 而右侧栏的标签本来就属于「这个对话」，指针落在聊天区里就是那个意思。
 *
 * 为什么和拖标签一样用鼠标事件 + body 上的浮层：
 * 1. `dragDropEnabled: true`（拖文件进输入框要真实路径，见 §11.8）时页面收不到 HTML5 drag / drop；
 * 2. 徽标在侧栏里，而侧栏的分组会裁内容（`overflow: hidden`）、标签栏更是 `overflow-y: hidden` ——
 *    浮层只有 `position: fixed`（`.is-tab-ghost`，与拖标签共用一套样式）才能跟着指针一路走。
 *
 * 提示：只有落点那一行 / 标签栏会亮（`.tab-drop-target` / `.is-drop-target`），不会再给
 * 所有会话行描虚线圈。
 */
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  dropAreaHitAt,
  highlightDropArea,
  highlightSessionDrop,
  sessionDropHitAt,
} from './session-drop'

/** 超过这个位移才算拖动（否则还是一次点击：点徽标 = 打开那个会话的面板） */
const DRAG_THRESHOLD = 4
/** 拖完松手那一次 click 是拖动的尾巴：这段时间内吞掉（自己会过期，不残留） */
const CLICK_AFTER_DRAG_MS = 400

/** 松手时落在哪 */
export type BadgeDropTarget =
  /** 另一个会话行上 */
  | { kind: 'session'; sessionId: string }
  /** 右侧面板的标签栏 / 聊天区：都是「搬进当前会话」 */
  | { kind: 'current' }

export interface BadgeDragOptions {
  /** 这个徽标属于哪个会话（要搬走的就是它的标签） */
  fromSessionId: string
  /** 落在某个落点上（没落在任何地方 = 取消，不回调） */
  onDrop: (target: BadgeDropTarget) => void
}

/** 上一次「拖徽标」结束的时刻：紧跟其后的那次 click 要吞掉 */
let dragEndedAt = 0

/**
 * 紧跟拖徽标之后的那次 click 要不要吞掉。
 *
 * 与面板那边拖标签的 `suppressClickRef` 同一套思路（时钟窗口而不是永久标志）：
 * 松手时指针不在徽标上时 `click` 根本不会来，永久标志会把下一次正常点击吃掉。
 */
export function badgeDragJustEnded(): boolean {
  return performance.now() - dragEndedAt < CLICK_AFTER_DRAG_MS
}

/**
 * 在徽标上按下：越过阈值就开始拖，松手按落点回调一次。
 *
 * 做成普通函数（不是 hook）而不是在侧栏里展开：侧栏每次渲染都会传新闭包，
 * 这里只在本次拖动期间用它，没有「旧闭包」问题。
 */
export function startSessionBadgeDrag(
  event: ReactMouseEvent,
  options: BadgeDragOptions,
): void {
  if (event.button !== 0) return
  const from = options.fromSessionId
  const source = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startY = event.clientY
  /** 跟着指针走的浮层；未越过阈值时是 null（= 还只是一次点击） */
  let ghost: HTMLElement | null = null
  /** 抓握点（指针相对徽标左上角）：抓哪儿就一直抓哪儿 */
  let grabX = 0
  let grabY = 0
  /** 指针此刻压在哪个落点上（`null` = 松手就取消） */
  let target: BadgeDropTarget | null = null

  const place = (clientX: number, clientY: number) => {
    if (!ghost) return
    ghost.style.transform = `translate3d(${Math.round(clientX - grabX)}px, ${Math.round(
      clientY - grabY,
    )}px, 0)`
  }

  const onMove = (move: MouseEvent) => {
    if (!ghost) {
      const passed =
        Math.abs(move.clientX - startX) >= DRAG_THRESHOLD ||
        Math.abs(move.clientY - startY) >= DRAG_THRESHOLD
      if (!passed) return
      const rect = source.getBoundingClientRect()
      ghost = source.cloneNode(true) as HTMLElement
      // 与拖标签共用浮层样式（fixed / 不吃事件 / 高层级），见 `side-panel/style.scss`
      ghost.classList.add('is-tab-ghost')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.setAttribute('inert', '')
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      document.body.appendChild(ghost)
      grabX = startX - rect.left
      grabY = startY - rect.top
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    }
    place(move.clientX, move.clientY)
    // 落点：会话行（自己的不算）优先，其次「大片落点」：标签栏（精确）与聊天区（离得够大）
    const hit = sessionDropHitAt(move.clientX, move.clientY)
    const rowSessionId = hit && hit.sessionId !== from ? hit.sessionId : null
    const overTabbar =
      !rowSessionId && dropAreaHitAt('tabbar', move.clientX, move.clientY)
    const overChat =
      !rowSessionId &&
      !overTabbar &&
      dropAreaHitAt('chat-main', move.clientX, move.clientY)
    target = rowSessionId
      ? { kind: 'session', sessionId: rowSessionId }
      : overTabbar || overChat
        ? { kind: 'current' }
        : null
    highlightSessionDrop(rowSessionId ? hit!.row : null)
    highlightDropArea('tabbar', overTabbar)
    highlightDropArea('chat-main', overChat)
    // 浮层压住落点时淡下去，别把「松手就落这儿」的高亮整个盖住（与拖标签同一口径）
    ghost.classList.toggle('is-over-session', !!target)
  }

  const finish = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    window.removeEventListener('blur', onCancel)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    highlightSessionDrop(null)
    highlightDropArea('tabbar', false)
    highlightDropArea('chat-main', false)
    ghost?.remove()
    ghost = null
  }

  const onUp = () => {
    const dragged = !!ghost
    const dropped = dragged ? target : null
    finish()
    if (!dragged) return
    // 这次 click 是拖动的尾巴（点徽标会切到那个会话的面板），吞掉
    dragEndedAt = performance.now()
    if (dropped) options.onDrop(dropped)
  }

  /**
   * 窗口失焦（Alt+Tab / 弹窗抢焦点）时 `mouseup` 可能永远不来：收尾成**取消**。
   * 不收的话浮层会一直黏在屏幕上（它挂在 body 上，不归任何 React 树管）。
   */
  const onCancel = () => {
    target = null
    onUp()
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  window.addEventListener('blur', onCancel)
}
