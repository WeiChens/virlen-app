/**
 * 工具组头 / 工具卡片的「展开 / 收起」也是**行内改高**的开关（与气泡的「显示更多 / 收起」同一类）。
 *
 * 消息列表在贴底时有一套跟底语义（`anchorTo: 'end'` + `scrollEndThreshold`）：条目尺寸一变，
 * 库就把「高度差」补偿进 scrollTop，用户看到的就是**阅读位置被甩到内容末尾**。
 * 所以这两个开关都要：
 *  · 点击时先请列表按住滚动偏移；
 *  · 收起方向在 DOM 变矮之后把开关自身拉回视野（`block: 'nearest'`）**再重新按住**；
 *  · 展开方向只按住、不自行滚动（内容向下长，锚点原地不动）；
 *  · 点下去**不改高度**的那一下（运行中的组恒展开）不按住 —— 别白吞一窗偏移。
 *
 * jsdom 没有 `scrollIntoView`（这里替身成可断言的 fn），也没有真实排版：本用例只钉**动作与顺序**，
 * 行高变化本身由虚拟列表负责。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Message, ToolUseContent } from '@/types'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { warn: vi.fn(async () => false) },
  useMessageBox: () => ({ MessageBox: { warn: vi.fn(async () => false) } }),
}))
/** Monaco 在 jsdom 里跑不起来（缺 CSS.escape / canvas）——工具卡片会经 code-block 间接拉到它 */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: any) => <pre className="code-block-body">{children}</pre>,
}))

import ToolCallGroup from '@/ui/pages/chat/components/message/tool-call-group'
import { ToolCallMessage } from '@/ui/pages/chat/components/tool-call'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

/** jsdom 未实现 `scrollIntoView` —— 收起方向要靠它把开关拉回视野，这里补一个可断言的替身 */
const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockClear()
  ;(Element.prototype as any).scrollIntoView = scrollIntoView
})

const tc = (id: string, name: string): ToolUseContent => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})
const assistantTool = (id: string, tcs: ToolUseContent[]): Message => ({
  id,
  role: 'assistant',
  content: '',
  toolCalls: tcs,
  timestamp: 0,
})
const toolResult = (id: string, toolCallId: string): Message => ({
  id,
  role: 'tool',
  content: 'ok',
  toolCallId,
  timestamp: 0,
})

/**
 * 受控组件的宿主：点组头真的翻转 `open`（与列表层 `toggleGroup` 同口径），
 * 否则组件收到的是不变的 prop，`useRowToggleHold` 的第二拍（收起后拉回视野）永远等不到。
 */
function GroupHarness({
  results,
  onHoldScrollOffset,
  open,
}: {
  /** 与 toolCalls 一一对应的结果（缺一个 → 组是 pending） */
  results: (Message | undefined)[]
  onHoldScrollOffset?: () => void
  open: boolean
}) {
  const [isOpen, setIsOpen] = useState(open)
  const members = [assistantTool('a1', [tc('t1', 'get_current_time')])]
  return (
    <ToolCallGroup
      groupKey="g1"
      messages={members}
      messageIndexes={[0]}
      toolResultsFor={() => results}
      open={isOpen}
      onToggle={() => setIsOpen((v) => !v)}
      onHoldScrollOffset={onHoldScrollOffset}
    />
  )
}

const clickHead = (host: HTMLElement) =>
  act(async () => {
    host
      .querySelector<HTMLButtonElement>('.tool-group__head')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

describe('工具组头：展开 / 收起不改阅读位置', () => {
  it('展开：只按住偏移，不自行滚动', async () => {
    const hold = vi.fn()
    const { host, root } = await render(
      <GroupHarness
        open={false}
        results={[toolResult('r1', 't1')]}
        onHoldScrollOffset={hold}
      />,
    )
    expect(host.querySelector('.tool-group__body')).toBeNull()

    await clickHead(host)

    expect(host.querySelector('.tool-group__body')).not.toBeNull()
    expect(hold).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('收起：先按住 → 把组头拉回视野 → 再重新按住', async () => {
    const hold = vi.fn()
    const { host, root } = await render(
      <GroupHarness
        open
        results={[toolResult('r1', 't1')]}
        onHoldScrollOffset={hold}
      />,
    )
    expect(host.querySelector('.tool-group__body')).not.toBeNull()
    expect(hold).not.toHaveBeenCalled()

    await clickHead(host)

    expect(host.querySelector('.tool-group__body')).toBeNull()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(hold).toHaveBeenCalledTimes(2)
    // 顺序要紧：先按住（拦住补偿）→ 拉回视野 → 再重新按住（这一下滚动是我们自己发起的）
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      scrollIntoView.mock.invocationCallOrder[0],
    )
    expect(scrollIntoView.mock.invocationCallOrder[0]).toBeLessThan(
      hold.mock.invocationCallOrder[1],
    )

    await act(async () => root.unmount())
  })

  it('运行中的组（pending）恒展开：点组头不改高度 → 不按住偏移', async () => {
    const hold = vi.fn()
    const { host, root } = await render(
      <GroupHarness open={false} results={[]} onHoldScrollOffset={hold} />,
    )
    // 结果还没回来 → 组恒展开（折起来就看不到进展了）
    expect(host.querySelector('.tool-group__body')).not.toBeNull()

    await clickHead(host)

    expect(host.querySelector('.tool-group__body')).not.toBeNull()
    expect(hold).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})

describe('工具卡片：展开 / 收起不改阅读位置', () => {
  const card = (hold?: () => void) => (
    <ToolCallMessage
      message={tc('t1', 'get_current_time')}
      result={toolResult('r1', 't1')}
      onHoldScrollOffset={hold}
    />
  )

  it('展开只按住；收起先按住 → 拉回卡片 → 再重新按住', async () => {
    const hold = vi.fn()
    const { host, root } = await render(card(hold))
    const el = host.querySelector<HTMLDivElement>('.tool-call-message')!

    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(hold).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).not.toHaveBeenCalled()

    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(hold).toHaveBeenCalledTimes(3)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(hold.mock.invocationCallOrder[2]).toBeGreaterThan(
      scrollIntoView.mock.invocationCallOrder[0],
    )

    await act(async () => root.unmount())
  })

  it('不传 hold（单测 / 独立渲染）也能照常展开收起', async () => {
    const { host, root } = await render(card())
    const el = host.querySelector<HTMLDivElement>('.tool-call-message')!

    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.querySelector('.tool-call-expand-view')).not.toBeNull()

    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.querySelector('.tool-call-expand-view')).toBeNull()

    await act(async () => root.unmount())
  })
})
