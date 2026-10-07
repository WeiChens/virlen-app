/**
 * 「设置 → 通用 → 主题色」的界面行为。
 *
 * 界面这一层只负责"把用户点的色写进设置"（写样式由 hooks/useAccentColor.ts 监听设置完成，
 * 见 accent-color-contract.test.ts）。所以这里守的是三件事：
 *  ① 色板真的绑到了设置项上（点一下 = `settingsState.value.accentColor` 变），
 *     而不是只换了个高亮状态；
 *  ② 输入框展示的是**当前生效色**（点色板后它得跟着走，否则用户看到的是上一次的色）；
 *  ③ 「恢复默认」写空串并置灰 —— 空串 = 回落到 theme.scss 的内置靛蓝（不是写死一个 hex）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// 页面本身不碰 Tauri（只有「可视化预览」按钮会 openUrl），桩掉免得 import 阶段就报错
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

import GeneralSettings from '@/ui/pages/Settings/general-settings'
import { settingsState } from '@/ui/store'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '@/ui/theme/accentPalette'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  settingsState.value.accentColor = ''
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
  document.getElementById('virlen-accent-color')?.remove()
})

function swatches(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.accent-swatch')]
}

function hexInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.accent-hex')!
}

function resetButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.accent-reset')!
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('通用页渲染出整块色板（每颗按钮都带自己的色值，不是装饰）', () => {
  expect(swatches().length).toBe(ACCENT_PRESETS.length)
  for (const [i, preset] of ACCENT_PRESETS.entries()) {
    expect(swatches()[i].title).toBeTruthy()
    // 默认档（空串）下高亮的是内置酭蓝那一颗，其余都是未选中
    const expected = preset.color === DEFAULT_ACCENT ? 'true' : 'false'
    expect(swatches()[i].getAttribute('aria-pressed')).toBe(expected)
  }
})

it('点色板 = 写进设置，并把选中态挪过去', () => {
  const blue = ACCENT_PRESETS[1]
  click(swatches()[1])
  expect(settingsState.value.accentColor).toBe(blue.color)
  expect(swatches()[1].getAttribute('aria-pressed')).toBe('true')
  expect(swatches()[0].getAttribute('aria-pressed')).toBe('false')
  // 输入框展示的是当前生效色
  expect(hexInput().value).toBe(blue.color)
})

it('默认档（空串）时高亮内置靛蓝、输入框显示内置色、恢复默认置灰', () => {
  expect(hexInput().value).toBe(DEFAULT_ACCENT)
  expect(swatches()[0].getAttribute('aria-pressed')).toBe('true')
  expect(resetButton().disabled).toBe(true)
})

it('「恢复默认」写空串（回落内置靛蓝）而不是写死一个 hex', () => {
  click(swatches()[2])
  expect(settingsState.value.accentColor).toBe(ACCENT_PRESETS[2].color)
  expect(resetButton().disabled).toBe(false)

  click(resetButton())
  expect(settingsState.value.accentColor).toBe('')
  expect(resetButton().disabled).toBe(true)
  expect(hexInput().value).toBe(DEFAULT_ACCENT)
})

it('取色器与输入框都在（任意色那条路有入口，不是只有预设）', () => {
  expect(container.querySelector<HTMLInputElement>('.accent-native')!.type).toBe('color')
  expect(hexInput().value).toBe(DEFAULT_ACCENT)
})

it('这一行用堆叠布局，且只留标题：色板整整 470px，挤在 label 右侧会把中文标签压成一列字', () => {
  const row = container.querySelector('.setting-row.is-stacked')
  expect(row).not.toBeNull()
  expect(row!.querySelector('.accent-field')).not.toBeNull()
  // 标签只有「主题色」；实现细节（亮/暗各取一档、派生规则）不面向用户
  expect(row!.querySelector('.setting-label .label-text')!.textContent).toBe('主题色')
  expect(row!.querySelector('.setting-label .label-desc')).toBeNull()
})
