/**
 * 「设置 → 通用 → 界面缩放」的界面行为。
 *
 * 缩放真正生效在 `ui/hooks/useZoom.ts`（监听设置 → 调 webview setZoom），
 * 所以这一层守的是三件事：
 *  ① 滑杆的取值范围 / 步长直接取领域常量（不在这里另写一套 min-max-step）；
 *  ② 拖动只改草稿，**松手才落库** —— 否则一次拖动就是几十次 settings.change 埋点与写表；
 *  ③ 「恢复默认」写回 100% 并随即置灰（100% 时没有可恢复的东西）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// 页面本身不碰 Tauri（只有「可视化预览」会 openUrl），桩掉免得 import 阶段就报错
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

import GeneralSettings from '@/ui/pages/Settings/general-settings'
import { settingsState } from '@/ui/store'
import { DEFAULT_ZOOM, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@/domain/zoom'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  settingsState.value.zoomFactor = DEFAULT_ZOOM
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
})

function zoomRange(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.zoom-range')!
}

function zoomValue(): HTMLElement {
  return container.querySelector<HTMLElement>('.zoom-value')!
}

function resetButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.zoom-reset')!
}

/** 改滑杆值并派发 input（React 的 onChange 监听的是 input） */
function dragTo(value: number) {
  const el = zoomRange()
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 松手（提交点） */
function release() {
  act(() => {
    zoomRange().dispatchEvent(new Event('pointerup', { bubbles: true }))
  })
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('滑杆的范围与步长直接用领域常量，默认 100%', () => {
  const el = zoomRange()
  expect(el.type).toBe('range')
  expect(el.min).toBe(String(ZOOM_MIN))
  expect(el.max).toBe(String(ZOOM_MAX))
  expect(el.step).toBe(String(ZOOM_STEP))
  expect(el.value).toBe('1')
  expect(zoomValue().textContent).toBe('100%')
  // 100% 时无可恢复；按钮上的 tooltip 是「缩太大也能一键回来」的发现入口
  expect(resetButton().disabled).toBe(true)
  expect(resetButton().title).toContain('Ctrl/Cmd')
})

it('拖动只改草稿：百分比跟着走、松手才写进设置', () => {
  dragTo(1.25)
  expect(zoomValue().textContent).toBe('125%')
  // 还没松手 → 设置没动（不产生埋点 / 写表 / 一次 webview 缩放）
  expect(settingsState.value.zoomFactor).toBe(DEFAULT_ZOOM)

  release()
  expect(settingsState.value.zoomFactor).toBe(1.25)
  expect(resetButton().disabled).toBe(false)
})

it('「恢复默认」写回 100%，且随即置灰', () => {
  dragTo(1.5)
  release()
  expect(settingsState.value.zoomFactor).toBe(1.5)

  click(resetButton())
  expect(settingsState.value.zoomFactor).toBe(DEFAULT_ZOOM)
  expect(zoomRange().value).toBe('1')
  expect(zoomValue().textContent).toBe('100%')
  expect(resetButton().disabled).toBe(true)
})
