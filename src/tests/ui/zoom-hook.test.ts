/**
 * applyWebviewZoom 与快捷键的接线：设置值 → webview 原生缩放。
 *
 * 这里把 Tauri 判定与 webviewWindow 都桩掉，只为守住五件事：
 *  ① 递给 setZoom 的是**归一化后**的倍率（不是滑杆的原始字符串 / 越界值）；
 *  ② setZoom 失败被吞掉（缩放是外观项，不该把调用方带崩），**且不修改「已生效」倍率**
 *    （原生子视图靠它把 CSS 像素换算成逻辑像素，见 `applied-zoom.ts`）；
 *  ③ 非 Tauri（浏览器 dev / 测试环境）直接跳过，不去碰 api；
 *  ④ Ctrl/Cmd + = / - / 0 真的改变设置（且事件被吃掉），并由 reaction 落到 setZoom。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const { setZoom, isTauriAvailable } = vi.hoisted(() => ({
  setZoom: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  isTauriAvailable: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setZoom }),
}))
vi.mock('@/services/rust-engine', () => ({ isTauriAvailable }))

import { applyWebviewZoom, useZoom } from '@/ui/hooks/useZoom'
import { appliedZoomFactor, setAppliedZoomFactor } from '@/ui/hooks/applied-zoom'
import { settingsState } from '@/ui/store/settingStore'

beforeEach(() => {
  setZoom.mockReset()
  setZoom.mockImplementation(() => Promise.resolve())
  isTauriAvailable.mockReturnValue(true)
  settingsState.value.zoomFactor = 1
  setAppliedZoomFactor(1)
})

it('把设置值归一化后交给 setZoom', async () => {
  await applyWebviewZoom(1.25)
  expect(setZoom).toHaveBeenCalledWith(1.25)
  // 落地之后才改「已生效」倍率（原生视图的 CSS → DIP 换算读它）
  expect(appliedZoomFactor()).toBe(1.25)
})

it('越界 / 字符串 / 脏值都先归一化', async () => {
  await applyWebviewZoom(5)
  expect(setZoom).toHaveBeenLastCalledWith(2)

  await applyWebviewZoom('0.8')
  expect(setZoom).toHaveBeenLastCalledWith(0.8)

  await applyWebviewZoom(NaN)
  expect(setZoom).toHaveBeenLastCalledWith(1)
})

it('setZoom 失败只告警，不抛给调用方', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  setZoom.mockImplementation(() => Promise.reject(new Error('ACL denied')))

  await expect(applyWebviewZoom(1.5)).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalled()
  // 没落地就不能改：否则原生视图会按一个「页面并没缩放」的倍率去摆位置
  expect(appliedZoomFactor()).toBe(1)

  warn.mockRestore()
})

it('非 Tauri 环境直接跳过（那里没有可缩放的 webview）', async () => {
  isTauriAvailable.mockReturnValue(false)
  await applyWebviewZoom(1.5)
  expect(setZoom).not.toHaveBeenCalled()
  // 没有 webview 可缩放，口径仍要跟上（单测 / 浏览器预览读同一份值）
  expect(appliedZoomFactor()).toBe(1.5)
})

// ==================== 快捷键（窗口级监听） ====================

function HookHost(): null {
  useZoom()
  return null
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function mountHook() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(HookHost)))
}

/** 派发一次键盘事件，返回它（用于查 defaultPrevented） */
function press(init: KeyboardEventInit): KeyboardEvent {
  // 真实键盘事件是 cancelable 的；不传这一项，preventDefault() 什么也不做，
  // defaultPrevented 永远是 false（这条断言就白写了）
  const e = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    window.dispatchEvent(e)
  })
  return e
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

it('Ctrl/Cmd + = 放大、- 缩小、0 复位：改的是设置，并落成 webview 缩放', () => {
  mountHook()

  press({ key: '=', ctrlKey: true })
  expect(settingsState.value.zoomFactor).toBe(1.1)
  expect(setZoom).toHaveBeenLastCalledWith(1.1)

  press({ key: '-', ctrlKey: true })
  expect(settingsState.value.zoomFactor).toBe(1)

  press({ key: '=', ctrlKey: true })
  press({ key: '=', ctrlKey: true })
  expect(settingsState.value.zoomFactor).toBe(1.2)

  // 缩到很大以后仍然一条键回得去（不靠鼠标）
  press({ key: '0', ctrlKey: true })
  expect(settingsState.value.zoomFactor).toBe(1)
  expect(setZoom).toHaveBeenLastCalledWith(1)
})

it('缩放键被吃掉（不再冒到 xterm / 浏览器默认），上限按不住就夹紧', () => {
  mountHook()

  const e = press({ key: '-', ctrlKey: true })
  expect(e.defaultPrevented).toBe(true)

  // 连按到下限后不再变小，也不会溢出成负值
  for (let i = 0; i < 10; i++) press({ key: '-', ctrlKey: true })
  expect(settingsState.value.zoomFactor).toBe(0.5)
})

it('普通按键不插手（不 preventDefault、不改设置）', () => {
  mountHook()

  const e = press({ key: '=' })
  expect(e.defaultPrevented).toBe(false)
  expect(settingsState.value.zoomFactor).toBe(1)

  const p = press({ key: 'p', ctrlKey: true })
  expect(p.defaultPrevented).toBe(false)
})

