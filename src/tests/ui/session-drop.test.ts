// @vitest-environment jsdom
/**
 * `sidebar/session-drop.ts` —— 「把右侧栏的标签拖到会话项上」的落点判定与提示。
 *
 * 六条被钉住的：
 * 1. **按 rect 命中**（不靠 `elementFromPoint`：被拖的那一份永远压在指针底下，那样只会命中它自己）；
 * 2. **看不见的行不接**：折叠分组里的行 rect 仍在（`0fr` + `overflow:hidden` 只是裁掉），
 *    `inert` 祖先或 `checkVisibility() === false` 的行一律跳过 —— 否则「拖到 A 却进了 B」；
 * 3. **行间缝隙吸附到最近一行**（超过 `ROW_SNAP` 不吸），零像素误差不算落点；
 * 4. **滚出列表可视区的段不算**，0 高 / 列表外 / 没登记 → `null`；
 * 5. **只高亮落点那一行**（不再给所有行描虚线）；标签栏也有自己的落点（`registerTabStrip`）；
 * 6. **注销后不再命中**（侧栏卸载不能把落点留着）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dropAreaHitAt,
  highlightDropArea,
  highlightSessionDrop,
  registerDropArea,
  registerSessionDropList,
  sessionDropHitAt,
  SESSION_ROW_ATTR,
} from '@/ui/pages/chat/components/sidebar/session-drop'

const disposers: (() => void)[] = []

/** 造一行会话（jsdom 量不到布局，rect 只能手给） */
function row(sessionId: string, top: number, height = 24): HTMLElement {
  const element = document.createElement('div')
  element.className = 'session-item'
  element.setAttribute(SESSION_ROW_ATTR, sessionId)
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top,
      right: 200,
      bottom: top + height,
      width: 200,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  return element
}

/** 假矩形（jsdom 没有布局引擎：left 0 / 高 800 / 宽手给） */
function fakeRect(width: number): DOMRect {
  return {
    left: 0,
    top: 0,
    right: width,
    bottom: 800,
    width,
    height: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

/** 造列表容器 + 登记（`rows` 已经挂进去） */
function mountList(rows: (HTMLElement | HTMLElement[])[]): HTMLElement {
  const list = document.createElement('div')
  list.className = 'session-list'
  for (const item of rows) {
    if (Array.isArray(item)) {
      // 分组容器（折叠的分组：`inert` + 内层 `overflow: hidden`）
      const body = document.createElement('div')
      body.className = 'session-group-body is-collapsed'
      body.setAttribute('inert', '')
      const items = document.createElement('div')
      items.className = 'session-group-items'
      for (const row of item) items.appendChild(row)
      body.appendChild(items)
      list.appendChild(body)
      continue
    }
    list.appendChild(item)
  }
  list.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  document.body.appendChild(list)
  disposers.push(registerSessionDropList(() => list))
  return list
}

afterEach(() => {
  highlightSessionDrop(null)
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

describe('sessionDropHitAt', () => {
  it('命中哪一行就报哪个会话 id', () => {
    mountList([row('sess-1', 0), row('sess-2', 24)])
    expect(sessionDropHitAt(50, 10)?.sessionId).toBe('sess-1')
    expect(sessionDropHitAt(50, 30)?.sessionId).toBe('sess-2')
  })

  it('行与行之间的空隙 / 0 高的行 / 列表外 → null', () => {
    const collapsed = row('sess-collapsed', 60, 0)
    mountList([row('sess-1', 0), collapsed])
    // 第 24～60 之间是下一个分组头之类的东西，不是会话行
    expect(sessionDropHitAt(50, 40)).toBeNull()
    expect(sessionDropHitAt(50, 70)).toBeNull()
    expect(sessionDropHitAt(500, 10)).toBeNull()
  })

  /**
   * 折叠的分组：`grid-template-rows: 0fr` + `overflow: hidden` 把内容裁掉，但行的 rect 仍在
   * （坐标还落在后面的可见行上）。不筛掉就会拖到 A 却进了 B、高亮也亮在看不见的行上。
   */
  it('折叠分组（inert）里的行不接，即使它的 rect 正好压在指针上', () => {
    const invisible = row('sess-invisible', 0)
    const visible = row('sess-visible', 0)
    mountList([[invisible], visible])
    // 两行同坐标：DOM 顺序上先撞见的是折叠分组里那一行
    expect(sessionDropHitAt(50, 10)?.sessionId).toBe('sess-visible')
  })

  it('`checkVisibility()` 说不看见（display:none / 祖先 opacity:0）的行也不接', () => {
    const invisible = row('sess-invisible', 0)
    ;(invisible as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false
    mountList([invisible, row('sess-visible', 0)])
    expect(sessionDropHitAt(50, 10)?.sessionId).toBe('sess-visible')
  })

  it('行与行之间的缝隙吸附到最近的一行，超过吸附范围才算没命中', () => {
    // 0～24 与 40～64 中间有 16px 空白（分组头 / 外边距）
    mountList([row('sess-1', 0), row('sess-2', 40)])
    // 落在空白里但离上邻只差 2px：算上邻（差一个像素就什么都不发生才像坏了）
    expect(sessionDropHitAt(50, 26)?.sessionId).toBe('sess-1')
    // 两边都超过吸附范围 → 真的没命中
    expect(sessionDropHitAt(50, 32)).toBeNull()
  })

  it('被列表滚动裁掉的那一段不接（rect 与列表可视区求交后为空）', () => {
    // 行排到列表上边界之外：rect 盖住了 y=5，但看得见的那一段在 0 上方
    mountList([row('sess-1', -30)])
    expect(sessionDropHitAt(50, 5)).toBeNull()
  })

  it('没有登记列表（侧栏没挂 / 已卸载）→ null', () => {
    expect(sessionDropHitAt(50, 10)).toBeNull()
  })
})

describe('高亮与拖动提示', () => {
  it('高亮换行时把上一条清掉；传 null 全清', () => {
    const [first, second] = [row('sess-1', 0), row('sess-2', 24)]
    mountList([first, second])

    highlightSessionDrop(first)
    expect(first.classList.contains('tab-drop-target')).toBe(true)

    highlightSessionDrop(second)
    expect(first.classList.contains('tab-drop-target')).toBe(false)
    expect(second.classList.contains('tab-drop-target')).toBe(true)

    highlightSessionDrop(null)
    expect(second.classList.contains('tab-drop-target')).toBe(false)
  })

  it('拖动中只亮落点那一行（不再给整个列表加「能放」的类）', () => {
    const list = mountList([row('sess-1', 0), row('sess-2', 24)])
    const hit = sessionDropHitAt(50, 30)
    highlightSessionDrop(hit!.row)
    expect(list.classList.contains('tab-drag-active')).toBe(false)
    expect(document.querySelectorAll('.tab-drop-target')).toHaveLength(1)
  })

  it('注销之后不再命中', () => {
    mountList([row('sess-1', 0)])
    const dispose = disposers.pop()!
    dispose()
    expect(sessionDropHitAt(50, 10)).toBeNull()
  })
})

/** 大片落点：标签栏与聊天区都能接（拖会话徒标上去 = 搬进当前会话） */
describe('大片落点（标签栏 / 聊天区）', () => {
  function mountArea(area: 'tabbar' | 'chat-main', rect: DOMRect, className: string) {
    const element = document.createElement('div')
    element.className = className
    element.getBoundingClientRect = () => rect
    document.body.appendChild(element)
    disposers.push(registerDropArea(area, () => element))
    return element
  }

  it('rect 内算命中；0 尺寸 / 未登记 / 未挂载 → 不接', () => {
    mountArea('tabbar', fakeRect(300), 'side-panel-tabs')
    expect(dropAreaHitAt('tabbar', 150, 10)).toBe(true)
    expect(dropAreaHitAt('tabbar', 400, 10)).toBe(false)
    // 没有登记的区域（聊天页没挂 / 还没登记）一律不接
    expect(dropAreaHitAt('chat-main', 150, 10)).toBe(false)

    disposers.pop()!()
    expect(dropAreaHitAt('tabbar', 150, 10)).toBe(false)
  })

  it('0 宽 / 0 高（面板收起、聊天区被挤没）不接', () => {
    mountArea('chat-main', fakeRect(0), 'chat-main')
    expect(dropAreaHitAt('chat-main', 0, 0)).toBe(false)
  })

  it('两块各自高亮，互不影响', () => {
    const strip = mountArea('tabbar', fakeRect(300), 'side-panel-tabs')
    const chat = mountArea('chat-main', fakeRect(600), 'chat-main')

    highlightDropArea('tabbar', true)
    expect(strip.classList.contains('is-drop-target')).toBe(true)
    expect(chat.classList.contains('is-drop-target')).toBe(false)

    highlightDropArea('tabbar', false)
    highlightDropArea('chat-main', true)
    expect(strip.classList.contains('is-drop-target')).toBe(false)
    expect(chat.classList.contains('is-drop-target')).toBe(true)
    highlightDropArea('chat-main', false)
  })
})

/**
 * 两端接线（编译期不会报、跑界面才看得见）：侧栏得给会话行打标并登记列表，
 * 否则「拖标签到会话项」永远命中不到；容器得走这里的三个出口，否则「能命中但没人问」；
 * 样式得有两个提示类，否则 classList 写了也不长东西。
 */
describe('两端接线（源码契约）', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

  it('侧栏：会话行打 `data-session-row`，列表容器登记落点', () => {
    const sidebar = read('src/ui/pages/chat/components/sidebar/index.tsx')
    expect(sidebar).toContain('SESSION_ROW_ATTR')
    expect(sidebar).toContain('registerSessionDropList(() => sessionListRef.current)')
    expect(sidebar).toContain('ref={sessionListRef}')
  })

  it('侧栏：折叠的分组内容是 `inert`（落点判定靠它跳过看不见的行）', () => {
    const sidebar = read('src/ui/pages/chat/components/sidebar/index.tsx')
    expect(sidebar).toContain('inert={isCollapsed}')
  })

  it('容器：拖动中间命中、写高亮，松手上报 `onTransferTab`', () => {
    const panel = read('src/ui/pages/chat/components/side-panel/index.tsx')
    expect(panel).toContain('sessionDropHitAt(')
    expect(panel).toContain('highlightSessionDrop(')
    // 标签栏也得登记成落点（拖会话徒标上来 = 搬进当前会话），并把自己的标签栏交出去
    expect(panel).toContain("registerDropArea('tabbar'")
    expect(panel).toContain('onTransferTab?.(')
  })

  it('样式：只给落点那一行高亮，不再给所有行描虚框', () => {
    const css = read('src/ui/pages/chat/components/sidebar/style.scss')
    expect(css).toMatch(/\.session-item\.tab-drop-target\s*\{/)
    // 拖动时全屏虚线圈是用户明确不要的：这条规则不许回来
    expect(css).not.toMatch(/tab-drag-active/)
  })
})
