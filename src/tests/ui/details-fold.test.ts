/**
 * details-fold（markdown `<details>` 的开合过渡）用例。
 *
 * 守四件事：
 * 1. **接管得当**：点 summary 时先 `preventDefault`（不让 UA 立刻开合），再把高度从当前值插值到目标值；
 * 2. **动画期间保持展开**：收起过程要能把内容留在树上，结束时才落到 `open = false`；
 * 3. **不误伤**：summary 里的链接 / 按钮不接管，`prefers-reduced-motion` 时整段不接管，
 *    没有 WAAPI 的极老 WebView 直接落终态；
 * 4. **连点可打断**：上一段动画先 cancel（裁剪类跟着摘掉），不会两段动画抢同一个 height。
 *
 * happy-dom 不做布局：`getBoundingClientRect` 与 `animate` 都按需替换成可断言的替身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachDetailsFold,
  foldDetails,
  FOLD_MS,
} from '@/ui/pages/chat/components/message/details-fold'

/** 假高度：展开 200 / 收起 40（只为能算出插值端点，不追求真实） */
const OPEN_H = 200
const CLOSED_H = 40

interface AnimCall {
  frames: { height: string }[]
  options: { duration?: number; easing?: string }
}

/** 造一个 markdown 里的折叠块（默认收起） */
function makeDetails(html = '<summary>答案与解析</summary><p>正文</p>') {
  const root = document.createElement('div')
  root.className = 'markdown-renderer'
  root.innerHTML = `<details>${html}</details>`
  const details = root.querySelector('details')!
  details.getBoundingClientRect = (() => ({ height: details.open ? OPEN_H : CLOSED_H })) as never
  return { root, details }
}

/** 把 WAAPI 换成可断言的替身：记录关键帧，finish / cancel 由用例手动触发 */
function stubAnimate() {
  const calls: AnimCall[] = []
  let latest: { onfinish?: () => void; oncancel?: () => void } = {}
  let cancels = 0
  const animate = ((frames: AnimCall['frames'], options: AnimCall['options']) => {
    const anim = {
      onfinish: undefined as (() => void) | undefined,
      oncancel: undefined as (() => void) | undefined,
      cancel: () => {
        cancels += 1
        anim.oncancel?.()
      },
    }
    calls.push({ frames, options })
    latest = anim
    return anim
  }) as never
  return {
    animate,
    calls,
    cancels: () => cancels,
    finish: () => latest.onfinish?.(),
  }
}

function clickOn(el: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

/** happy-dom 的 matchMedia 可 stub：用它模拟「用户要求减少动效」 */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('attachDetailsFold — 展开', () => {
  it('点 summary：先 preventDefault，再按「收起高度 → 展开高度」插值', () => {
    const { root, details } = makeDetails()
    const anim = stubAnimate()
    details.animate = anim.animate
    attachDetailsFold(root)

    const event = clickOn(details.querySelector('summary')!)

    expect(event.defaultPrevented).toBe(true)
    expect(anim.calls).toHaveLength(1)
    expect(anim.calls[0].frames).toEqual([
      { height: `${CLOSED_H}px` },
      { height: `${OPEN_H}px` },
    ])
    expect(anim.calls[0].options.duration).toBe(FOLD_MS)
    expect(details.classList.contains('is-folding')).toBe(true)

    anim.finish()
    expect(details.open).toBe(true)
    // 裁剪类必须摘掉：留着会把之后溢出的内容一直裁掉
    expect(details.classList.contains('is-folding')).toBe(false)
  })
})

describe('attachDetailsFold — 收起', () => {
  it('点已展开的 summary：高度 展开 → 收起', () => {
    const { root, details } = makeDetails()
    details.open = true
    const anim = stubAnimate()
    details.animate = anim.animate
    attachDetailsFold(root)

    clickOn(details.querySelector('summary')!)

    expect(anim.calls[0].frames).toEqual([
      { height: `${OPEN_H}px` },
      { height: `${CLOSED_H}px` },
    ])

    anim.finish()
    expect(details.open).toBe(false)
    expect(details.classList.contains('is-folding')).toBe(false)
  })
})

describe('foldDetails — 收起过程保持展开', () => {
  it('动画期间 open 仍为 true，结束时才落到 false', () => {
    const { details } = makeDetails()
    details.open = true
    const anim = stubAnimate()
    details.animate = anim.animate

    foldDetails(details, false)

    // 关键：UA 在 open=false 时会立刻隐藏内容，那一刻就看不到收起过程了
    expect(details.open).toBe(true)
    expect(details.classList.contains('is-folding')).toBe(true)

    anim.finish()
    expect(details.open).toBe(false)
  })
})

describe('attachDetailsFold — 不误伤', () => {
  it('summary 里的链接不被接管（否则链接点不动）', () => {
    const { root, details } = makeDetails('<summary><a href="#x">跳转</a></summary><p>正文</p>')
    const anim = stubAnimate()
    details.animate = anim.animate
    attachDetailsFold(root)

    const event = clickOn(details.querySelector('a')!)

    expect(event.defaultPrevented).toBe(false)
    expect(anim.calls).toHaveLength(0)
  })

  it('prefers-reduced-motion 时不接管，交给浏览器瞬时开合', () => {
    stubReducedMotion(true)
    const { root, details } = makeDetails()
    const anim = stubAnimate()
    details.animate = anim.animate
    attachDetailsFold(root)

    const event = clickOn(details.querySelector('summary')!)

    expect(event.defaultPrevented).toBe(false)
    expect(anim.calls).toHaveLength(0)
  })

  it('点正文不触发开合', () => {
    const { root, details } = makeDetails()
    const anim = stubAnimate()
    details.animate = anim.animate
    attachDetailsFold(root)

    const event = clickOn(details.querySelector('p')!)

    expect(event.defaultPrevented).toBe(false)
    expect(anim.calls).toHaveLength(0)
  })

  it('卸载后不再接管', () => {
    const { root, details } = makeDetails()
    const anim = stubAnimate()
    details.animate = anim.animate
    const off = attachDetailsFold(root)
    off()

    const event = clickOn(details.querySelector('summary')!)

    expect(event.defaultPrevented).toBe(false)
    expect(anim.calls).toHaveLength(0)
  })
})

describe('foldDetails — 边界', () => {
  it('没有 WAAPI（极老 WebView）时直接落到终态', () => {
    const { details } = makeDetails()
    // happy-dom 自带一个 `animate` 空壳：显式抹掉才能等价于老 WebView
    ;(details as unknown as { animate?: unknown }).animate = undefined

    foldDetails(details, true)

    expect(details.open).toBe(true)
    expect(details.classList.contains('is-folding')).toBe(false)
  })

  it('空折叠块（展开 / 收起同高）不做动画', () => {
    const { details } = makeDetails('<summary>只有标题</summary>')
    details.getBoundingClientRect = (() => ({ height: 30 })) as never
    const anim = stubAnimate()
    details.animate = anim.animate

    foldDetails(details, true)

    expect(anim.calls).toHaveLength(0)
    expect(details.open).toBe(true)
  })

  it('连点：先 cancel 上一段动画（裁剪类跟着摘掉），再从当前高度重新起步', () => {
    const { details } = makeDetails()
    const anim = stubAnimate()
    details.animate = anim.animate

    foldDetails(details, true) // 展开中
    expect(details.classList.contains('is-folding')).toBe(true)

    foldDetails(details, false) // 半路改收起
    expect(anim.cancels()).toBe(1)
    expect(details.classList.contains('is-folding')).toBe(true) // 新一局又加回来了
    expect(anim.calls).toHaveLength(2)
    // 起点是「当前」高度（展开态 200），不是上一段动画的终点
    expect(anim.calls[1].frames).toEqual([
      { height: `${OPEN_H}px` },
      { height: `${CLOSED_H}px` },
    ])

    anim.finish()
    expect(details.open).toBe(false)
  })
})
