/**
 * 弹窗键盘操作 —— 授权确认（AuthorizationModal）与 AI 选择（UserChoiceModal）
 *
 * 需求：两个弹窗都要能「只用键盘走完」——
 *   Enter = 确定、Esc = 取消、Tab / Shift+Tab 切换项、↑ ↓ ← → 切换项。
 *
 * 这里钉的是**焦点流转**（谁拿到焦点、Enter 落到哪个动作）。它完全由
 * `document.activeElement` 驱动，`renderToStaticMarkup` 那类纯渲染断言覆盖不到，
 * 所以单独用真实挂载 + 派发 keydown 来测。
 *
 * 一个 jsdom 的固有边界：**jsdom 不会实现「Enter 激活聚焦按钮」这条浏览器默认动作**，
 * 所以「焦点在按钮上 + Enter」的用例都用 `el.click()` 显式补上那一下默认动作，
 * 以此验证「Virlen 侧不重复触发」（见两处 double-fire 用例）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** 真实 MarkdownRenderer 静态引入 monaco（jsdom 无 CSS.escape），导入即崩 —— 换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="mock-md">{content}</div>
  ),
}))

import AuthorizationModal from '@/ui/pages/chat/components/modals/authorization'
import UserChoiceModal from '@/ui/pages/chat/components/modals/user-choice'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
})

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  mounted.push({ root, host })
}

const activeEl = (): HTMLElement | null => document.activeElement as HTMLElement
/** 当前焦点元素的文案（弹窗容器上是整段文字，因此按钮 / 选项用例只断言相等） */
const activeText = (): string => activeEl()?.textContent?.trim() ?? ''
/** 当前焦点项的「名字」——选项取 .choice-label（否则会把勾选符号 ● 也算进去） */
const activeLabel = (): string =>
  activeEl()?.querySelector('.choice-label')?.textContent?.trim() ??
  activeText()
const activeClass = (): string => activeEl()?.className ?? ''

/** 把焦点直接放到某个元素上（模拟「点了一下这块区域」） */
async function focusOn(selector: string) {
  const el = document.querySelector(selector) as HTMLElement
  await act(async () => el.focus())
  return el
}

/** 从当前焦点元素派发按键 —— 真实键盘就是这样冒泡到 React 根容器的 */
async function press(key: string, init: KeyboardEventInit = {}) {
  const target = activeEl() ?? document.body
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  await act(async () => {
    target.dispatchEvent(ev)
  })
  return ev
}

/** 模拟浏览器的默认动作：焦点在按钮上时 Enter / 空格 → click */
async function nativeActivate(el: HTMLElement | null) {
  if (!el) throw new Error('没有拿到待激活的元素')
  await act(async () => el.click())
}

// ==================== 授权确认弹窗 ====================

async function renderAuth(overrides: Record<string, any> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const onShelve = vi.fn()
  await render(
    <AuthorizationModal
      visible
      permName="terminal.normal.execute"
      title="命令执行"
      desc="npm install"
      onConfirm={onConfirm}
      onCancel={onCancel}
      onShelve={onShelve}
      {...overrides}
    />,
  )
  return { onConfirm, onCancel, onShelve }
}

describe('AuthorizationModal 授权弹窗 · 键盘', () => {
  it('打开即把焦点放到「允许执行」——浏览器里直接 Enter 就是确定', async () => {
    const { onConfirm } = await renderAuth()
    expect(activeText()).toBe('允许执行')

    // jsdom 不实现「Enter 激活按钮」，手动补上那一下默认动作
    await nativeActivate(activeEl())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('焦点不在按钮上（点了正文 → 落在弹窗容器）时，Enter 仍然 = 允许执行', async () => {
    const { onConfirm } = await renderAuth()
    await focusOn('.modal-content')
    await press('Enter')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('↑ / ← 在「暂存 → 拒绝 → 允许执行」之间循环，且拦掉默认（否则 ↑↓ 会滚正文）', async () => {
    await renderAuth()
    expect(activeText()).toBe('允许执行')

    await press('ArrowUp') // 允许执行 → 拒绝
    expect(activeText()).toBe('拒绝')
    await press('ArrowUp') // 拒绝 → 暂存
    expect(activeText()).toBe('暂存')

    const ev = await press('ArrowUp') // 暂存 → 环回 允许执行
    expect(activeText()).toBe('允许执行')
    expect(ev.defaultPrevented).toBe(true)

    await press('ArrowDown') // 允许执行 → 环回 暂存
    expect(activeText()).toBe('暂存')
    await press('ArrowRight') // 暂存 → 拒绝
    expect(activeText()).toBe('拒绝')
    await press('ArrowLeft') // 拒绝 → 暂存
    expect(activeText()).toBe('暂存')
  })

  it('焦点停在按钮上时 Enter 交给浏览器原生（Virlen 侧不重复触发确认）', async () => {
    const { onConfirm } = await renderAuth()
    await press('ArrowUp') // 焦点移到「拒绝」
    expect(activeText()).toBe('拒绝')
    await press('Enter')
    // 原生语义是「点这个按钮」→ 拒绝；这里只断言没有误触发「允许执行」
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Esc = 拒绝（取消）', async () => {
    const { onCancel, onConfirm } = await renderAuth()
    await press('Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Tab 只在自己弹窗内循环（共享 Modal 的焦点圈定依然生效）', async () => {
    await renderAuth()
    // 标题栏 ✕ + 三个动作都在圈定范围内，一路 Tab 不会掉到 document.body
    for (let i = 0; i < 8; i++) await press('Tab')
    expect(activeEl()).not.toBe(document.body)
    expect(document.querySelector('.modal-content')?.contains(activeEl())).toBe(
      true,
    )
  })

  it('点过弹窗内非聚焦区域（焦点掉到 body）后键盘也不失效', async () => {
    const { onConfirm } = await renderAuth()
    await act(async () => (document.activeElement as HTMLElement)?.blur())
    expect(document.activeElement).toBe(document.body)
    await press('Enter') // 模态弹窗是最上层：Enter 仍然归它
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

// ==================== AI 选择弹窗 ====================

async function renderChoice(overrides: Record<string, any> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const onShelve = vi.fn()
  await render(
    <UserChoiceModal
      visible
      sessionId=""
      question="选哪个？"
      options={['A', 'B']}
      multi={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onShelve={onShelve}
      {...overrides}
    />,
  )
  return { onConfirm, onCancel, onShelve }
}

const optionState = (): boolean[] =>
  Array.from(document.querySelectorAll('.choice-option')).map(
    (el) => el.getAttribute('aria-checked') === 'true',
  )

describe('UserChoiceModal 选择弹窗 · 键盘', () => {
  it('一项未选时 Enter 被忽略：不回调、不挪焦点、也不偷偷选中', async () => {
    const { onConfirm } = await renderChoice()
    expect(activeClass()).toContain('user-choice-modal')

    await press('Enter')
    expect(onConfirm).not.toHaveBeenCalled()
    expect(activeClass()).toContain('user-choice-modal') // 焦点原地不动
    expect(optionState()).toEqual([false, false])
  })

  it('Tab / Shift+Tab 在「选项 → 暂存 → 自定义 → 取消 → 确认」之间循环（跑不出弹窗）', async () => {
    await renderChoice()
    await press('ArrowDown') // 容器 → A
    await press(' ') // 选中 A → 「确认」变为可用
    await focusOn('.user-choice-modal') // 焦点回到弹窗容器，从头开始数

    const seq: string[] = []
    for (let i = 0; i < 6; i++) {
      await press('Tab')
      seq.push(activeLabel())
    }
    expect(seq).toEqual(['A', 'B', '暂存', '自定义', '取消', '确认'])

    await press('Tab') // 确认 → 环回第一个选项
    expect(activeLabel()).toBe('A')

    await press('Tab', { shiftKey: true }) // 第一个选项 → 环回确认
    expect(activeLabel()).toBe('确认')

    // 焦点始终在弹窗内（本弹窗此前没有任何焦点圈定）
    expect(
      document.querySelector('.user-choice-modal')?.contains(activeEl()),
    ).toBe(true)
  })

  it('一项未选时跳过 disabled 的「确认」（禁用项不该能聚焦）', async () => {
    await renderChoice()
    // 只有 5 项可聚焦，因此容器上按 ↑ 落到末尾的「取消」而不是「确认」
    await press('ArrowUp')
    expect(activeText()).toBe('取消')
    await press('Tab') // 取消 之后没有可聚焦项 → 直接环回第一个选项
    expect(activeText()).toBe('A')
  })

  it('↑ / ↓ / ← / → 与 Tab 等价（含环回）', async () => {
    await renderChoice()
    await press('ArrowDown') // 容器 → A
    expect(activeText()).toBe('A')
    await press('ArrowDown')
    expect(activeText()).toBe('B')
    await press('ArrowRight')
    expect(activeText()).toBe('暂存')
    await press('ArrowUp')
    expect(activeText()).toBe('B')
    await press('ArrowLeft')
    expect(activeText()).toBe('A')
    await press('ArrowUp') // 末尾可聚焦项是「取消」→ 环回它
    expect(activeText()).toBe('取消')
  })

  it('点遮罩空白处（焦点落在遮罩上）后，方向键 / 空格 / Enter 仍然可用', async () => {
    const { onConfirm } = await renderChoice()
    await focusOn('.user-choice-backdrop')
    await press('ArrowDown')
    expect(activeText()).toBe('A')
    await press(' ') // 选中
    expect(optionState()).toEqual([true, false])
    await press('Enter') // 有选中项 → 提交
    expect(onConfirm).toHaveBeenCalledWith({ selected: ['A'], customReply: '' })
  })

  it('空格 = 选中 / 取消选中（单选互斥）；Enter 在选项上不切换选中', async () => {
    const { onConfirm } = await renderChoice()
    await press('ArrowDown') // → A
    await press('Enter') // 未选 → 忽略
    expect(optionState()).toEqual([false, false])

    await press(' ')
    expect(optionState()).toEqual([true, false])

    await press('ArrowDown') // → B
    await press(' ')
    expect(optionState()).toEqual([false, true]) // 单选互斥

    await press(' ') // 再按一次 = 取消选中
    expect(optionState()).toEqual([false, false])
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('选项上 Enter：有选中项就提交（不必先移到「确认」）', async () => {
    const { onConfirm } = await renderChoice()
    await press('ArrowDown') // → A
    await press(' ') // 选中
    await press('Enter') // 焦点还在选项上，直接提交
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ selected: ['A'], customReply: '' })
  })

  it('多选：空格逐项勾选，Enter 提交（不必先移到「确认」）', async () => {
    const { onConfirm } = await renderChoice({ multi: true })
    await press('ArrowDown') // → A
    await press(' ')
    await press('ArrowDown') // → B
    await press(' ')
    expect(optionState()).toEqual([true, true])

    await press('Enter')
    expect(onConfirm).toHaveBeenCalledWith({
      selected: ['A', 'B'],
      customReply: '',
    })
  })

  it('焦点在「确认」按钮上时交给浏览器原生（Virlen 侧不重复触发）', async () => {
    const { onConfirm } = await renderChoice()
    await press('ArrowDown') // → A
    await press(' ') // 选中 → 「确认」可用
    for (let i = 0; i < 5; i++) await press('Tab') // A→B→暂存→自定义→取消→确认
    expect(activeLabel()).toContain('确认')

    await press('Enter')
    expect(onConfirm).not.toHaveBeenCalled() // 原生 click 才该触发
    await nativeActivate(activeEl())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('焦点不在按钮上（选项 / 弹窗空白）时 Enter = 提交，且只回调一次', async () => {
    const { onConfirm } = await renderChoice()
    await press('ArrowDown') // → A
    await press(' ') // 选中 A
    await focusOn('.user-choice-modal') // 焦点移出选项（如点了弹窗空白处）
    await press('Enter')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ selected: ['A'], customReply: '' })
  })

  it('Ctrl / Cmd + Enter 任意位置直接提交', async () => {
    const { onConfirm } = await renderChoice()
    await press('ArrowDown') // → A
    await press(' ') // 选中 A
    await press('Enter', { ctrlKey: true })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('输入法选字中（isComposing）的 Enter 不提交', async () => {
    const { onConfirm } = await renderChoice()
    await press('ArrowDown') // → A
    await press(' ') // 选中 A
    await press('Enter', { isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(optionState()).toEqual([true, false])
  })

  it('Esc = 取消', async () => {
    const { onCancel, onConfirm } = await renderChoice()
    await press('Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
