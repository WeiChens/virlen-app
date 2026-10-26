/**
 * 设置「代码」页：代码显示 + 外部编辑器（原独立菜单已并入）。
 *
 * 三条口径：
 *  ① 侧栏只剩「代码」一个菜单 —— 「外部编辑器」不再是独立页（`SettingsPage` 里没有 'editor'）；
 *  ② 外部编辑器那段真的渲染在代码页里，选预设就写进默认编辑器；
 *  ③ 代码显示自己的段（主题 / 字体与排版 / 预览）原样还在，没被搬家打散。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Monaco 在 jsdom 里起不来（缺 CSS.escape），本用例只看页面结构与交互
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: () => <div className="stub-preview" />,
}))
// 选中预设会 showToast：页面上没有 Toast 宿主，桩掉免得往 stderr 打「请先使用 useToast 挂载」
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))

import CodeDisplaySettings from '@/ui/pages/Settings/code-display-settings'
import { settingsState } from '@/ui/store'
import { EDITOR_PRESETS } from '@/domain/editor'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = process.cwd()

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  settingsState.value.editorOpenConfigs = []
  settingsState.value.editorOpenDefaultId = ''
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<CodeDisplaySettings />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  settingsState.value.editorOpenConfigs = []
  settingsState.value.editorOpenDefaultId = ''
})

/** 编辑器卡片（预设与自定义入口都是 `.template-main` 按钮） */
function card(label: string): HTMLButtonElement {
  const found = [
    ...host.querySelectorAll<HTMLButtonElement>(
      '.editor-settings .template-main',
    ),
  ].find((b) => b.textContent?.includes(label))
  if (!found) throw new Error(`找不到编辑器卡片：${label}`)
  return found
}

it('侧栏只剩「代码」：外部编辑器不再是独立菜单', () => {
  const view = readFileSync(
    resolve(ROOT, 'src/ui/pages/Settings/settings-view.tsx'),
    'utf8',
  )
  expect(view).not.toContain(`page === 'editor'`)
  expect(view).not.toContain(`t('外部编辑器')`)
  expect(view).toContain(`t('代码')`)
  expect(view).toContain('CodeDisplaySettings')

  const page = readFileSync(
    resolve(ROOT, 'src/ui/pages/Settings/code-display-settings.tsx'),
    'utf8',
  )
  expect(page).toContain(`t('外部编辑器')`)
  expect(page).toContain('<EditorSettings />')

  const dict = JSON.parse(
    readFileSync(resolve(ROOT, 'src/ui/i18n/lang/en-US.json'), 'utf8'),
  ) as Record<string, string>
  expect(dict['代码']).toBe('Code')
})

it('外部编辑器与代码显示同在一页：预设卡片 + 自定义入口都在', () => {
  expect(host.textContent).toContain('代码显示')
  expect(host.textContent).toContain('外部编辑器')
  const labels = [...host.querySelectorAll('.editor-settings .template-label')].map(
    (n) => n.textContent,
  )
  for (const preset of EDITOR_PRESETS) expect(labels).toContain(preset.name)
  expect(labels).toContain('自定义')
})

it('点预设卡片 = 选中为默认编辑器（写进同一份设置）', () => {
  act(() => card('VS Code').click())

  const config = settingsState.value.editorOpenConfigs.find(
    (c) => c.name === 'VS Code',
  )
  expect(config).toBeTruthy()
  expect(settingsState.value.editorOpenDefaultId).toBe(config!.id)
})

it('代码显示那几段没被搬家影响：主题 / 字体与排版 / 预览还在', () => {
  expect(host.textContent).toContain('字体与排版')
  expect(host.textContent).toContain('预览')
  expect(host.querySelectorAll('.cd-theme').length).toBeGreaterThan(0)
  expect(host.querySelector('.cd-reset')?.textContent).toBe('恢复默认')
})
