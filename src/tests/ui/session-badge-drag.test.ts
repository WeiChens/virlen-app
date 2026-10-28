// @vitest-environment jsdom
/**
 * `sidebar/session-badge-drag.ts` —— 拖侧栏会话项上的「右侧栏标签数」徽标 = 把那批标签搬走。
 *
 * 五条被钉住的：
 * 1. **两个落点**：右键内的会话行 → 搬去那个会话；标签栏 → 搬进当前会话；
 * 2. **自己的会话行不算落点**（搬给自己没意义）：不高亮、不回调；
 * 3. **没越过阈值就还是一次点击**（点徽标 = 打开那个会话的面板）：不造浮层、不回调；
 * 4. **浮层挂在 body 上**（`.is-tab-ghost`，与拖标签共用），压住落点时淡下去；
 * 5. **拖完那次 click 要吞掉**（`badgeDragJustEnded()`），窗口失焦则收尾成取消。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  badgeDragJustEnded,
  startSessionBadgeDrag,
  type BadgeDropTarget,
} from '@/ui/pages/chat/components/sidebar/session-badge-drag'
import {
  highlightDropArea,
  highlightSessionDrop,
  registerDropArea,
  registerSessionDropList,
  SESSION_ROW_ATTR,
} from '@/ui/pages/chat/components/sidebar/session-drop'

const SELF = 'sess-self'
const OTHER = 'sess-other'

const disposers: (() => void)[] = []

/** jsdom 没有布局引擎：矩形一律手给 */
function fakeRect(left: number, width: number, top = 0, height = 800): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/** 造一行会话（`.session-item[data-session-row]`） */
function sessionRow(sessionId: string, top: number, height = 24): HTMLElement {
  const element = document.createElement('div')
  element.className = 'session-item'
  element.setAttribute(SESSION_ROW_ATTR, sessionId)
  element.getBoundingClientRect = () => fakeRect(0, 200, top, height)
  return element
}

/** 会话列表 + 标签栏 + 聊天区一起登记好（都是落点） */
function mountTargets(row: HTMLElement) {
  const list = document.createElement('div')
  list.className = 'session-list'
  list.appendChild(row)
  list.getBoundingClientRect = () => fakeRect(0, 200)
  document.body.appendChild(list)
  disposers.push(registerSessionDropList(() => list))

  const strip = document.createElement('div')
  strip.className = 'side-panel-tabs'
  strip.getBoundingClientRect = () => fakeRect(0, 300, 400, 36)
  document.body.appendChild(strip)
  disposers.push(registerDropArea('tabbar', () => strip))

  const chat = document.createElement('div')
  chat.className = 'chat-main'
  chat.getBoundingClientRect = () => fakeRect(300, 900, 0, 800)
  document.body.appendChild(chat)
  disposers.push(registerDropArea('chat-main', () => chat))
  return { list, strip, chat }
}

/** 造一个徽标（按钮本体），返回它与被给到的 rect */
function badge(): HTMLElement {
  const el = document.createElement('button')
  el.className = 'session-panel-badge'
  el.getBoundingClientRect = () => fakeRect(180, 20, 0, 16)
  document.body.appendChild(el)
  return el
}

/** 按下徽标（`startSessionBadgeDrag` 只需要 button / currentTarget / clientX / clientY） */
function press(el: HTMLElement, onDrop: (t: BadgeDropTarget) => void, from = SELF, x = 185, y = 8) {
  startSessionBadgeDrag(
    { button: 0, currentTarget: el, clientX: x, clientY: y } as unknown as ReactMouseEvent,
    { fromSessionId: from, onDrop },
  )
}

const ghost = () => document.querySelector<HTMLElement>('.is-tab-ghost')
const move = (x: number, y: number) =>
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }))
const up = () => document.dispatchEvent(new MouseEvent('mouseup'))

afterEach(() => {
  highlightSessionDrop(null)
  highlightDropArea('tabbar', false)
  highlightDropArea('chat-main', false)
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

describe('徽标拖到另一个会话行', () => {
  it('命中行 → 行亮 + 浮层淡下去；松手只回调一次（目标会话）', () => {
    const row = sessionRow(OTHER, 0)
    mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(100, 10)
    expect(ghost()).not.toBeNull()
    expect(ghost()!.classList.contains('is-over-session')).toBe(true)
    expect(row.classList.contains('tab-drop-target')).toBe(true)

    up()
    expect(drops).toEqual([{ kind: 'session', sessionId: OTHER }])
    // 浮层收掉、高亮清掉；尾巴 click 要吞
    expect(ghost()).toBeNull()
    expect(row.classList.contains('tab-drop-target')).toBe(false)
    expect(badgeDragJustEnded()).toBe(true)
  })

  it('自己的会话行不算落点：不高亮、松手不回调', () => {
    const row = sessionRow(SELF, 0)
    mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(100, 10)
    expect(ghost()).not.toBeNull()
    expect(row.classList.contains('tab-drop-target')).toBe(false)
    expect(ghost()!.classList.contains('is-over-session')).toBe(false)

    up()
    expect(drops).toEqual([])
  })
})

describe('徽标拖到标签栏 / 聊天区', () => {
  it('命中标签栏 → 整条栏亮；松手回调 `current`（= 当前会话）', () => {
    const row = sessionRow(OTHER, 0)
    const { strip } = mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(150, 410)
    expect(strip.classList.contains('is-drop-target')).toBe(true)
    expect(row.classList.contains('tab-drop-target')).toBe(false)

    up()
    expect(drops).toEqual([{ kind: 'current' }])
    expect(strip.classList.contains('is-drop-target')).toBe(false)
  })

  /** 标签栏只有 36px 高，逼用户去命中一条细缝没道理：整个聊天区都算「搬进当前对话」 */
  it('命中聊天区 → 整个聊天区亮；松手同样回调 `current`', () => {
    const row = sessionRow(OTHER, 0)
    const { strip, chat } = mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(600, 300)
    expect(chat.classList.contains('is-drop-target')).toBe(true)
    expect(strip.classList.contains('is-drop-target')).toBe(false)

    up()
    expect(drops).toEqual([{ kind: 'current' }])
    expect(chat.classList.contains('is-drop-target')).toBe(false)
  })

  it('拖出全部落点 → 提示全收，松手什么都不上报', () => {
    const row = sessionRow(OTHER, 0)
    const { strip, chat } = mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(150, 410)
    expect(strip.classList.contains('is-drop-target')).toBe(true)
    move(600, 900)
    expect(strip.classList.contains('is-drop-target')).toBe(false)
    expect(chat.classList.contains('is-drop-target')).toBe(false)

    up()
    expect(drops).toEqual([])
  })
})

describe('点击 / 取消', () => {
  it('没越过阈值：还是一次点击（不造浮层、不回调）', () => {
    // ⚠️ 不断言 `badgeDragJustEnded() === false`：那个 400ms 窗口是模块级的，
    // 上一个用例刚拖过（同一模块实例），这里的值取决于用例子间隔了多久
    const row = sessionRow(OTHER, 0)
    mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(186, 9) // 1px
    up()
    expect(ghost()).toBeNull()
    expect(drops).toEqual([])
  })

  it('拖动中窗口失焦：浮层收掉、不回调（mouseup 可能永远不来）', () => {
    const row = sessionRow(OTHER, 0)
    const { strip } = mountTargets(row)
    const drops: BadgeDropTarget[] = []
    const el = badge()

    press(el, (t) => drops.push(t))
    move(150, 410)
    expect(ghost()).not.toBeNull()

    window.dispatchEvent(new Event('blur'))
    expect(ghost()).toBeNull()
    expect(strip.classList.contains('is-drop-target')).toBe(false)
    expect(drops).toEqual([])
  })
})
