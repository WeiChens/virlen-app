/**
 * GitErrorModal — Git 操作失败的**持久**错误弹窗。
 *
 * 守的是三条「换成 toast 就会丢掉的东西」：
 * 1. **原文照抄**：多行 stderr（`fatal:` + `hint:`）必须完整显示，不能被压成一句「操作失败」；
 * 2. **可复制**：复制的内容带动作名（只有一段 stderr，别人不知道是哪一步失败的）；
 * 3. **只能由用户关**：它是弹窗（不是自动消失的提示），关掉之前内容一直在。
 *
 * 动作为什么不用 toast：git 的下一步常常就写在 `hint:` 行里，几秒读不完 —— 这是本组件存在的理由。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import GitErrorModal from '@/ui/pages/chat/components/git/GitErrorModal'

const copyText = vi.fn((_text: string) => Promise.resolve(true))
vi.mock('@/utils/clipboard', () => ({
  copyText: (text: string) => copyText(text),
}))

const showToast = vi.fn()
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: (text: string) => showToast(text),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const STDERR = [
  'error: Your local changes to the following files would be overwritten by merge:',
  '\ta.txt',
  'hint: commit your changes or stash them before you merge.',
].join('\n')

let root: ReturnType<typeof createRoot> | null = null
let closed = 0

function mount(text = STDERR) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(<GitErrorModal op="pull" text={text} onClose={() => (closed += 1)} />),
  )
}

beforeEach(() => {
  closed = 0
  copyText.mockClear()
  showToast.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('原文完整显示（多行 stderr 一行都不少）', () => {
  mount()
  const pre = document.querySelector('.git-error-body pre')
  expect(pre?.textContent).toBe(STDERR)
  // 动作名也要在：单看一段 stderr，「哪一步失败的」是缺失的一半信息
  expect(document.querySelector('.git-error-op')?.textContent).toBe('操作：pull')
  expect(document.querySelector('.modal-header')?.textContent).toContain('操作失败')
})

it('「复制错误信息」把动作名与原文一起复制', async () => {
  mount()
  const copy = [...document.querySelectorAll('.modal-footer button')].find(
    (el) => el.textContent === '复制错误信息',
  ) as HTMLElement
  expect(copy).toBeTruthy()
  await act(async () => {
    copy.click()
  })
  expect(copyText).toHaveBeenCalledWith(`pull\n${STDERR}`)
  expect(showToast).toHaveBeenCalledWith('已复制错误信息')
})

it('「关闭」把控制权交回调用方（内容不会自己消失）', async () => {
  mount()
  const close = [...document.querySelectorAll('.modal-footer button')].find(
    (el) => el.textContent === '关闭',
  ) as HTMLElement
  await act(async () => {
    close.click()
  })
  expect(closed).toBe(1)
})
