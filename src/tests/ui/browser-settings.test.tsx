/**
 * 「设置 → 通用 → 内置浏览器」的两行数值设置。
 *
 * 守三件事：
 *  ① 草稿 + **失焦才落库**（每敲一个字符就写表会刷出几十条 `settings.change` 埋点）；
 *  ② 越界值按边界收敛，空 / 非数字回落当前值（不让输入框凭空变成 0）；
 *  ③ 0 是「关掉该策略」的合法值（不休眠 / 不限个数），不能被收敛逻辑吃掉。
 *
 * 策略本身（什么时候真销毁）在 `view-policy.ts`，隔离在 `browser-view-policy.test.ts`。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// 页面本身不碰 Tauri（只有「可视化预览」会 openUrl），桩掉免得 import 阶段就报错
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

import GeneralSettings from '@/ui/pages/Settings/general-settings'
import { settingsState } from '@/ui/store'
import {
  BROWSER_MAX_VIEWS_MAX,
  BROWSER_SLEEP_MAX_SEC,
} from '@/ui/pages/chat/components/side-panel/browser/view-policy'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULT_SLEEP = 20
const DEFAULT_MAX = 10

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  settingsState.value.browserSleepAfterSec = DEFAULT_SLEEP
  settingsState.value.browserMaxViews = DEFAULT_MAX
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<GeneralSettings />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  settingsState.value.browserSleepAfterSec = DEFAULT_SLEEP
  settingsState.value.browserMaxViews = DEFAULT_MAX
})

/** 按 aria-label 取输入框（两行的标签文案就是它们的 aria-label） */
function numInput(label: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blur(el: HTMLInputElement) {
  // React 的 onBlur 实际监听的是会冒泡的 focusout
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

it('两行的取值范围直接取策略常量（不在这里另写一套 min / max）', () => {
  const sleep = numInput('闲置网页休眠')
  const max = numInput('最多保留网页')
  expect(sleep.max).toBe(String(BROWSER_SLEEP_MAX_SEC))
  expect(sleep.min).toBe('0')
  expect(max.max).toBe(String(BROWSER_MAX_VIEWS_MAX))
  expect(max.min).toBe('0')
  // 初值来自设置
  expect(sleep.value).toBe(String(DEFAULT_SLEEP))
  expect(max.value).toBe(String(DEFAULT_MAX))
})

it('输入过程中不落库，失焦才写一次', () => {
  const sleep = numInput('闲置网页休眠')
  type(sleep, '30')
  // 还没失焦：设置里仍是旧值
  expect(settingsState.value.browserSleepAfterSec).toBe(DEFAULT_SLEEP)
  blur(sleep)
  expect(settingsState.value.browserSleepAfterSec).toBe(30)
})

it('越界值按边界收敛；空输入回落当前值（不凭空变成 0）', () => {
  const max = numInput('最多保留网页')

  type(max, '9999')
  blur(max)
  expect(settingsState.value.browserMaxViews).toBe(BROWSER_MAX_VIEWS_MAX)
  expect(max.value).toBe(String(BROWSER_MAX_VIEWS_MAX))

  type(max, '')
  blur(max)
  expect(settingsState.value.browserMaxViews).toBe(BROWSER_MAX_VIEWS_MAX)
  expect(max.value).toBe(String(BROWSER_MAX_VIEWS_MAX))
})

it('0 是合法值：关掉策略不能被收敛吃掉', () => {
  const sleep = numInput('闲置网页休眠')
  type(sleep, '0')
  blur(sleep)
  expect(settingsState.value.browserSleepAfterSec).toBe(0)

  const max = numInput('最多保留网页')
  type(max, '0')
  blur(max)
  expect(settingsState.value.browserMaxViews).toBe(0)
})
