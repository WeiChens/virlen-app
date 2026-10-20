/**
 * 启动屏（`src/boot/splash.ts`）的行为契约。
 *
 * 这块代码在最早期跑（i18n / store 都还没就绪），所以它的**容错**比功能更重要：
 * 节点缺失不许抛、进度越界不许溢出、失败态必须给得出重试入口、失败时标题栏必须还在
 * （否则窗口关不掉）。DOM 结构按 `index.html` 里的 `#boot-cover` 复刻 —— 那边的 id
 * 是它唯一的接口。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { bootSplash } from '@/boot/splash'
import { accentTokens, DEFAULT_ACCENT } from '@/ui/theme/accentPalette'

/** 与 index.html 里的启动屏结构一致（改结构 = 改这里，否则契约就失效了） */
function mountSplash(): void {
  document.body.innerHTML = `
    <div id="boot-cover">
      <div id="boot-titlebar">
        <div class="boot-titlebar__title"><img src="/logo.png" alt="" /><span>Virlen</span></div>
        <div class="boot-titlebar__controls">
          <button id="boot-min" type="button"></button>
          <button id="boot-max" type="button"></button>
          <button id="boot-close" type="button"></button>
        </div>
      </div>
      <div id="boot-splash">
        <img class="boot-splash__logo" src="/logo.png" alt="" />
        <div class="boot-splash__track"><div id="boot-splash-bar"></div></div>
        <p id="boot-splash-text"></p>
        <div id="boot-splash-error" hidden>
          <p id="boot-splash-error-text"></p>
          <button id="boot-splash-retry" type="button"></button>
        </div>
      </div>
    </div>`
}

const bar = () => document.getElementById('boot-splash-bar') as HTMLElement
const text = () => document.getElementById('boot-splash-text') as HTMLElement
const splash = () => document.getElementById('boot-splash') as HTMLElement
const cover = () => document.getElementById('boot-cover') as HTMLElement
const titlebar = () => document.getElementById('boot-titlebar') as HTMLElement
const errorBox = () => document.getElementById('boot-splash-error') as HTMLElement
const errorText = () => document.getElementById('boot-splash-error-text') as HTMLElement
const retry = () => document.getElementById('boot-splash-retry') as HTMLButtonElement
const control = (id: string) => document.getElementById(id) as HTMLButtonElement

/** `getCurrentWindow()` 的最小子集（splash 不 import Tauri，所以这里传假对象） */
function fakeWindow() {
  return {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('启动屏 · 文案与进度', () => {
  it('setText 写进 #boot-splash-text', () => {
    mountSplash()
    bootSplash.setText('正在启动…')
    expect(text().textContent).toBe('正在启动…')
  })

  it('进度按 8%–92% 区间映射（头尾都留余量）', () => {
    mountSplash()
    bootSplash.setProgress(0)
    expect(bar().style.width).toBe('8%')
    bootSplash.setProgress(0.5)
    expect(bar().style.width).toBe('50%')
    bootSplash.setProgress(1)
    expect(bar().style.width).toBe('92%')
  })

  it('越界 / 脏值一律夹紧，不溢出也不回退', () => {
    mountSplash()
    bootSplash.setProgress(-3)
    expect(bar().style.width).toBe('8%')
    // step 数超过估算值时 completed/total > 1 → 停在 92%，而不是超过容器
    bootSplash.setProgress(2.4)
    expect(bar().style.width).toBe('92%')
    bootSplash.setProgress(Number.NaN)
    expect(bar().style.width).toBe('8%')
  })
})

describe('启动屏 · 收尾', () => {
  it('done 补满进度、打上 data-leaving，并在过渡结束后移除整块（含标题栏）', () => {
    mountSplash()
    bootSplash.done()
    expect(bar().style.width).toBe('100%')
    expect(cover().dataset.leaving).toBe('true')
    expect(bootSplash.isPresent()).toBe(true)

    cover().dispatchEvent(new Event('transitionend'))
    expect(bootSplash.isPresent()).toBe(false)
    expect(document.getElementById('boot-titlebar')).toBeNull()
  })

  it('过渡被系统禁用（没有 transitionend）也能靠兜底定时器移除', () => {
    vi.useFakeTimers()
    mountSplash()
    bootSplash.done()
    expect(bootSplash.isPresent()).toBe(true)
    vi.advanceTimersByTime(400)
    expect(bootSplash.isPresent()).toBe(false)
  })

  it('done 幂等：重复调用不会重复挂监听 / 报错', () => {
    mountSplash()
    bootSplash.done()
    expect(() => bootSplash.done()).not.toThrow()
    cover().dispatchEvent(new Event('transitionend'))
    expect(bootSplash.isPresent()).toBe(false)
  })
})

describe('启动屏 · 失败态', () => {
  it('展示总述 + 具体错误，并把重试按钮接上整页重载', () => {
    mountSplash()

    bootSplash.fail(new Error('prompt texts not hydrated'), {
      message: '启动没有完成，请重试；若反复失败请重启应用。',
      retry: '重试',
    })

    expect(splash().dataset.failed).toBe('true')
    expect(errorBox().hidden).toBe(false)
    expect(errorText().textContent).toContain('启动没有完成')
    expect(errorText().textContent).toContain('prompt texts not hydrated')
    expect(retry().textContent).toBe('重试')
    // 点击后走整页 reload（jsdom 的 location 不可重定义，所以只验证处理器已挂上）
    expect(typeof retry().onclick).toBe('function')
  })

  it('失败不动标题栏：窗口仍然能关、能挪', () => {
    mountSplash()
    bootSplash.fail(new Error('boom'), { message: '启动没有完成', retry: '重试' })
    const win = fakeWindow()
    bootSplash.bindWindowControls(win)
    control('boot-close').click()
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('没有 detail（非 Error 且为空）时只显示总述，不留下 undefined', () => {
    mountSplash()
    bootSplash.fail(undefined, { message: '启动没有完成', retry: '重试' })
    expect(errorText().textContent).toBe('启动没有完成')
  })
})

describe('启动屏 · 标题栏窗口按钮', () => {
  it('三枚按钮各调对应的窗口方法', () => {
    mountSplash()
    const win = fakeWindow()
    bootSplash.bindWindowControls(win)

    control('boot-min').click()
    control('boot-max').click()
    control('boot-close').click()

    expect(win.minimize).toHaveBeenCalledTimes(1)
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('重复绑定不叠加监听（一次点击只触发一次）', () => {
    mountSplash()
    const win = fakeWindow()
    bootSplash.bindWindowControls(win)
    bootSplash.bindWindowControls(win)
    control('boot-min').click()
    expect(win.minimize).toHaveBeenCalledTimes(1)
  })

  it('标题栏不在（极简 DOM）时 bind 不抛错', () => {
    mountSplash()
    document.getElementById('boot-min')?.remove()
    document.getElementById('boot-max')?.remove()
    document.getElementById('boot-close')?.remove()
    expect(() => bootSplash.bindWindowControls(fakeWindow())).not.toThrow()
    expect(titlebar()).not.toBeNull()
  })
})

describe('启动屏 · 主题色', () => {
  afterEach(() => {
    const root = document.documentElement
    root.style.removeProperty('--boot-accent')
    root.style.removeProperty('--boot-bar')
    root.style.removeProperty('--boot-bar-fg')
    root.removeAttribute('data-boot-theme')
  })

  it('把主题色与深浅档落成 CSS 变量（令牌值来自唯一源 accentTokens）', () => {
    bootSplash.applyAppearance('#9333ea', 'dark')
    const root = document.documentElement
    const tokens = accentTokens('#9333ea', 'dark')
    expect(root.getAttribute('data-boot-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--boot-accent')).toBe(tokens['--primary'])
    expect(root.style.getPropertyValue('--boot-bar')).toBe(tokens['--primary-bar'])
    expect(root.style.getPropertyValue('--boot-bar-fg')).toBe(tokens['--primary-bar-fg'])
  })

  it('深色档的标题栏比亮色档暗（不把品牌原色直接当暗色标题栏）', () => {
    bootSplash.applyAppearance('#4f46e5', 'light')
    const light = document.documentElement.style.getPropertyValue('--boot-bar')
    bootSplash.applyAppearance('#4f46e5', 'dark')
    const dark = document.documentElement.style.getPropertyValue('--boot-bar')
    expect(light).toBe('#4f46e5')
    expect(dark).not.toBe(light)
  })

  it('空串 / 脏色回落到内置默认色', () => {
    bootSplash.applyAppearance('', 'light')
    expect(document.documentElement.style.getPropertyValue('--boot-accent')).toBe(
      accentTokens(DEFAULT_ACCENT, 'light')['--primary'],
    )
    bootSplash.applyAppearance('rgba(1,2,3,.5)', 'light')
    expect(document.documentElement.style.getPropertyValue('--boot-accent')).toBe(
      accentTokens(DEFAULT_ACCENT, 'light')['--primary'],
    )
  })

  it('启动屏已移除也照设不误（变量在 :root 上，不需要节点）', () => {
    expect(bootSplash.isPresent()).toBe(false)
    expect(() => bootSplash.applyAppearance('#15803d', 'light')).not.toThrow()
    expect(document.documentElement.getAttribute('data-boot-theme')).toBe('light')
  })
})

describe('启动屏 · 容错', () => {
  it('页面里没有启动屏时全部 no-op，且不抛错', () => {
    expect(bootSplash.isPresent()).toBe(false)
    expect(() => {
      bootSplash.setText('x')
      bootSplash.setProgress(0.5)
      bootSplash.done()
      bootSplash.fail(new Error('x'), { message: 'm', retry: 'r' })
      bootSplash.bindWindowControls(fakeWindow())
    }).not.toThrow()
  })
})
