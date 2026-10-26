/**
 * 设置 · 浏览器 · HTML 预览：两个脚本权限开关的行为。
 *
 * 从预览面板搬到这里的原因（实测反馈）：之前每打开一个 HTML 都要重勾一次；
 * 而这两个值是「用户对哪类页面可信」的长期判断，属于全局设置。
 *
 * 三条要守的：
 * 1. 默认全关；
 * 2. 「允许外部资源」依赖「允许运行脚本」—— 脚本都不跑时它没有意义（disabled + 说明）；
 * 3. 关掉脚本时把外部资源一并归零，不留一个「勾着但无效」的选项。
 */
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import PreviewSecurity from '@/ui/pages/Settings/security-preview'
import { settingsState } from '@/ui/store'

let root: ReturnType<typeof createRoot> | null = null

// React 19 的 `act()` 要求显式声明这是测试环境（否则每个 await act 都打一行警告）
beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<PreviewSecurity />)
  })
}

const toggles = () =>
  [...document.querySelectorAll<HTMLInputElement>('.setting-row input[type="checkbox"]')]

beforeEach(() => {
  document.body.innerHTML = ''
  settingsState.value.htmlPreviewAllowScripts = false
  settingsState.value.htmlPreviewAllowRemote = false
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('默认全关，且「允许外部资源」在脚本关着时不可点', async () => {
  await mount()

  const [scripts, remote] = toggles()
  expect(scripts.checked).toBe(false)
  expect(remote.checked).toBe(false)
  expect(remote.disabled).toBe(true)
  expect(document.body.textContent).toContain('需先开启「允许运行脚本」')
})

it('开启「允许运行脚本」写入设置，并让外部资源可点', async () => {
  await mount()

  await act(async () => toggles()[0].click())
  expect(settingsState.value.htmlPreviewAllowScripts).toBe(true)
  expect(toggles()[1].disabled).toBe(false)
})

it('关掉「允许运行脚本」时，「允许外部资源」一并归零', async () => {
  await mount()

  await act(async () => toggles()[0].click())
  await act(async () => toggles()[1].click())
  expect(settingsState.value.htmlPreviewAllowRemote).toBe(true)

  await act(async () => toggles()[0].click())
  expect(settingsState.value.htmlPreviewAllowScripts).toBe(false)
  expect(settingsState.value.htmlPreviewAllowRemote).toBe(false)
  expect(toggles()[1].disabled).toBe(true)
})
