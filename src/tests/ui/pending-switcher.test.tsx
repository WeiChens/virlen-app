/**
 * 待应答交互**并发**时的展示与切换 —— 挂真实 `useToolUI`（`tool-ui.tsx`）。
 *
 * 守三条用户可见的承诺：
 *  1. 并发时**不再互相覆盖**：一次只展示一个弹窗，其余挂在切换条上（计数 + 未读点）；
 *  2. 切换条可切（先去答别的，再切回来），**切回来草稿还在**（勾选的选项没被清空）；
 *  3. 应答 / 另一端应答后出队，自动轮到同位置的下一项；只剩一项时切换条消失（不占视野）。
 *
 * 纯函数状态机由 `pending-interactions.test.ts` 单独守；这里只钉「接线 + DOM 里看得见的行为」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** 真实 MarkdownRenderer 静态引入 monaco（jsdom 无 CSS.escape），导入即崩 —— 换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="mock-md">{content}</div>
  ),
}))
/** 窗口闪烁提醒与本用例无关；jsdom 里也没有 Tauri 窗口 */
vi.mock('@/utils/windowAttention', () => ({
  requestAttentionIfUnfocused: async (): Promise<void> => {},
}))

import toolInteractEvent from '@/events/toolInteractEvent'
import { useToolUI } from '@/ui/pages/chat/components/tool-ui'
import UserChoiceModal from '@/ui/pages/chat/components/modals/user-choice'
import {
  clearAllChoiceDrafts,
  type ChoiceDraft,
} from '@/ui/pages/chat/components/modals/choice-drafts'

/** 草稿缓存是模块级单例：用例之间必须隔离 */
beforeEach(() => {
  clearAllChoiceDrafts()
})

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const { toolUI } = useToolUI()
  return <>{toolUI}</>
}

let host: HTMLElement | null = null
let root: Root | null = null

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Harness />)
  })
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  host?.remove()
  host = null
})

function showChoice(id: string, question: string, toolCallId = `tc-${id}`): void {
  act(() => {
    toolInteractEvent.emit('showChoice', {
      interactionId: id,
      sessionId: 's1',
      toolCallId,
      question,
      options: ['继续', '停下'],
      multi: false,
    })
  })
}

function showAuthorization(id: string, title: string): void {
  act(() => {
    toolInteractEvent.emit('showAuthorization', {
      interactionId: id,
      sessionId: 's1',
      toolCallId: `tc-${id}`,
      permName: 'terminal.normal.execute',
      title,
    })
  })
}

function click(selector: string, index = 0): void {
  const el = document.querySelectorAll(selector)[index] as HTMLElement | undefined
  if (!el) throw new Error(`找不到元素：${selector}[${index}]`)
  act(() => {
    el.click()
  })
}

const chips = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.pending-switcher__item'))

async function pressAlt(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }),
    )
  })
}

describe('待应答交互并发：不再互相覆盖 + 切换条', () => {
  it('跨类并发：先到的继续展示，后到的挂上切换条（带计数与未读点）', async () => {
    await mount()
    showChoice('a', '用哪个方案？')
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    // 只有一个待处理 → 切换条不出现（纯噪音）
    expect(document.querySelector('.pending-switcher')).toBeNull()

    showAuthorization('b', '执行终端命令')
    // 提问弹窗**没有被覆盖**（改造前授权弹窗会直接盖在它上面，而它既没法答、也看不见）
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    expect(document.querySelector('.authorization')).toBeNull()
    // 切换条标出「还有几个、分别是什么」
    expect(document.querySelector('.pending-switcher')?.textContent ?? '').toContain(
      '2 个待处理',
    )
    const list = chips()
    expect(list.length).toBe(2)
    expect(list[0].className).toContain('is-active')
    expect(list[0].textContent ?? '').toContain('提问')
    expect(list[1].className).toContain('is-unread')
    expect(list[1].textContent ?? '').toContain('授权')
    expect(list[1].textContent ?? '').toContain('执行终端命令')
  })

  it('切换：点一下切到授权、再点切回提问（切过之后未读点消失）', async () => {
    await mount()
    showChoice('a', '用哪个方案？')
    showAuthorization('b', '执行终端命令')

    click('.pending-switcher__item', 1)
    expect(document.querySelector('.authorization')).not.toBeNull()
    expect(document.querySelector('.user-choice-modal')).toBeNull()
    expect(chips()[1].className).not.toContain('is-unread')

    click('.pending-switcher__item', 0)
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    expect(document.querySelector('.authorization')).toBeNull()
  })

  it('Alt + ←/→ 也能切换（焦点不在输入框时）', async () => {
    await mount()
    showChoice('a', '问题 A')
    showAuthorization('b', '授权 B')

    await pressAlt('ArrowRight')
    expect(document.querySelector('.authorization')).not.toBeNull()
    await pressAlt('ArrowLeft')
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
  })

  it('切走再切回来：表单里的草稿还在（勾选的选项不被清空）', async () => {
    await mount()
    showChoice('a', '用哪个方案？')
    showAuthorization('b', '执行终端命令')

    click('.choice-option', 0)
    expect(document.querySelector('.choice-option.selected')).not.toBeNull()

    // 切去授权 → 提问弹窗收起（组件实例还在，草稿不丢）
    click('.pending-switcher__item', 1)
    expect(document.querySelector('.user-choice-modal')).toBeNull()

    // 切回来：勾选仍在
    click('.pending-switcher__item', 0)
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    expect(document.querySelector('.choice-option.selected')).not.toBeNull()
  })

  it('应答后出队：自动轮到同位置的下一项，只剩一项时切换条消失', async () => {
    await mount()
    showChoice('a', '用哪个方案？')
    showAuthorization('b', '执行终端命令')

    click('.choice-option', 0)
    click('.choice-footer .btn-confirm')
    expect(document.querySelector('.user-choice-modal')).toBeNull()
    // 轮到了授权（同位置的下一个）
    expect(document.querySelector('.authorization')).not.toBeNull()
    expect(document.querySelector('.pending-switcher')).toBeNull()
  })

  it('另一个应答端（手机）应答 → 桌面上的弹窗与切换条一起收掉', async () => {
    await mount()
    showChoice('a', '问题 A')
    showAuthorization('b', '授权 B')
    expect(document.querySelector('.pending-switcher')).not.toBeNull()

    act(() => {
      toolInteractEvent.emit('interactionSettled', 'b', 'allow')
    })
    expect(document.querySelector('.pending-switcher')).toBeNull()
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
  })
})

/**
 * 暂存（shelve）→ 恢复：用户填过的草稿必须带回来。
 *
 * 「暂存」把 run 存成暂停快照，之后点「继续」时引擎从快照恢复、**重新执行同一个 tool call**
 *（同一个 toolCallId、新的 interactionId）→ 会再弹一次同一个问题。不做外部草稿缓存的话，
 * 用户回来看到的是一张空表单，等于白填一遍。
 */
describe('暂存 → 恢复：草稿带回来', () => {
  it('暂存后重新提问（同 toolCallId）：勾选被预填', async () => {
    await mount()
    showChoice('a1', '用哪个方案？', 'tc-1')
    click('.choice-option', 1)
    expect(
      document.querySelector('.choice-option.selected')?.textContent,
    ).toContain('停下')

    // 暂存：这次交互出队（引擎侧留暂停快照），草稿保留
    click('.choice-footer .btn-shelve')
    expect(document.querySelector('.user-choice-modal')).toBeNull()

    // 恢复：引擎重跑同一个 tool call（同 toolCallId、新 interactionId）
    showChoice('a2', '用哪个方案？', 'tc-1')
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    expect(
      document.querySelector('.choice-option.selected')?.textContent,
    ).toContain('停下')
  })

  it('应答（确认）之后：同一个 toolCallId 再问也不带草稿 —— 那是新问题，不是暂存恢复', async () => {
    await mount()
    showChoice('a1', '用哪个方案？', 'tc-1')
    click('.choice-option', 0)
    click('.choice-footer .btn-confirm')
    expect(document.querySelector('.user-choice-modal')).toBeNull()

    showChoice('a2', '用哪个方案？', 'tc-1')
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    expect(document.querySelector('.choice-option.selected')).toBeNull()
  })

  it('取消之后：草稿一并清掉（这个问题已被放弃，引擎不会再问）', async () => {
    await mount()
    showChoice('a1', '用哪个方案？', 'tc-1')
    click('.choice-option', 0)
    click('.choice-footer .btn-cancel')

    showChoice('a2', '用哪个方案？', 'tc-1')
    expect(document.querySelector('.choice-option.selected')).toBeNull()
  })

  it('不同 toolCallId（真换了问题）：不串草稿', async () => {
    await mount()
    showChoice('a1', '用哪个方案？', 'tc-1')
    click('.choice-option', 1)
    click('.choice-footer .btn-shelve')

    showChoice('a2', '用哪个方案？', 'tc-2')
    expect(document.querySelector('.choice-option.selected')).toBeNull()
  })
})

/**
 * UserChoiceModal：草稿的预填与上报（组件边界）。
 * 集成用例只覆盖了「勾选」；这里把自定义输入 / 展开态的预填与每次改动上报一并钉住。
 */
describe('UserChoiceModal：initialDraft / onDraftChange', () => {
  const mounted: Array<{ root: Root; host: HTMLElement }> = []

  async function mountChoice(
    props: Partial<ComponentProps<typeof UserChoiceModal>> = {},
  ): Promise<void> {
    const h = document.createElement('div')
    document.body.appendChild(h)
    const r = createRoot(h)
    await act(async () => {
      r.render(
        <UserChoiceModal
          visible
          sessionId="s1"
          question="用哪个方案？"
          options={['继续', '停下']}
          multi={false}
          onConfirm={() => {}}
          onCancel={() => {}}
          {...props}
        />,
      )
    })
    mounted.push({ root: r, host: h })
  }

  afterEach(async () => {
    for (const { root: r, host: h } of mounted.splice(0)) {
      await act(async () => r.unmount())
      h.remove()
    }
  })

  it('预填：勾选项 + 自定义回复 + 展开态（展开态也要带回来，否则「草稿还在」但看不见）', async () => {
    await mountChoice({
      initialDraft: {
        selected: ['停下'],
        customReply: '我的补充',
        showCustom: true,
      },
    })
    expect(
      document.querySelector('.choice-option.selected')?.textContent,
    ).toContain('停下')
    const input = document.querySelector<HTMLInputElement>('.custom-reply-input')
    expect(input).not.toBeNull()
    expect(input!.value).toBe('我的补充')
  })

  it('上报：挂载即回写一次初始值，之后每次勾选都上报最新草稿', async () => {
    const seen: ChoiceDraft[] = []
    await mountChoice({
      initialDraft: { selected: [], customReply: '', showCustom: false },
      onDraftChange: (d) => seen.push(d),
    })
    expect(seen.length).toBeGreaterThan(0)

    click('.choice-option', 1)
    expect(seen[seen.length - 1]).toEqual({
      selected: ['停下'],
      customReply: '',
      showCustom: false,
    })
  })

  it('展开自定义并输入：两次改动都被上报', async () => {
    const seen: ChoiceDraft[] = []
    await mountChoice({ onDraftChange: (d) => seen.push(d) })

    // 点「自定义」展开输入框
    const customBtn = [...document.querySelectorAll<HTMLElement>('.btn-custom')].find(
      (el) => el.textContent?.includes('自定义'),
    )!
    act(() => customBtn.click())
    const input = document.querySelector<HTMLInputElement>('.custom-reply-input')!
    expect(input).not.toBeNull()

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, '再加一句')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(seen[seen.length - 1]).toEqual({
      selected: [],
      customReply: '再加一句',
      showCustom: true,
    })
  })
})
