/**
 * 工具调用组组件的接线冒烟用例（与 `tool-group-rows.test.ts` 同源）。
 *
 * 为什么必须挂真实组件：「组折叠着没有」「展开后组内是几张卡片」「运行中的组会不会被折」
 * 都是 DOM 里才可观测的行为 —— 纯函数层只能钉住「折叠态该显示什么文案」（`toolGroupView`）
 * 与「哪些消息合成一行」（`buildRows`）。
 *
 * 这里把 `ToolCallMessage` 换成最小替身：本用例只验证「组的折叠结构」，
 * 不测单张卡片各自的渲染（那是 `tool-call-*.test.tsx` 的职责）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Message, ToolUseContent } from '@/types'

vi.mock('@/ui/pages/chat/components/tool-call', () => ({
  ToolCallMessage: ({ message }: { message: ToolUseContent }) => (
    <div className="tool-card" data-tool-name={message.name} />
  ),
}))

// 组内正文走 MarkdownRenderer（会连带拉起 code-block / monaco）——本用例只验证「正文渲染在卡片之前」，
// 换成最小替身即可
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="md-body">{content}</div>
  ),
}))

import ToolCallGroup from '@/ui/pages/chat/components/message/tool-call-group'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const tc = (id: string, name: string): ToolUseContent => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})

const assistant = (
  id: string,
  toolCalls: ToolUseContent[],
  content = '',
): Message => ({
  id,
  role: 'assistant',
  content,
  toolCalls,
  timestamp: 0,
})

// m1 带正文（宿主过渡说明）：展开时应排在它的卡片之前
const m1 = assistant('a1', [tc('t1', 'read_file'), tc('t2', 'grep')], '先看这里。')
const m2 = assistant('a2', [tc('t3', 'write_file')])

/** 每个工具调用都配上结果 → 组状态 done（跑完了，可折叠） */
const resultsDone = (m: Message): (Message | undefined)[] =>
  (m.toolCalls ?? []).map(
    (c): Message => ({ id: `r-${c.id}`, role: 'tool', content: '', timestamp: 0 }),
  )

/** 结果都还没回来 → 组状态 pending（运行中，恒展开） */
const resultsPending = (m: Message): (Message | undefined)[] =>
  (m.toolCalls ?? []).map((): Message | undefined => undefined)

let container: HTMLDivElement | null = null
let root: Root | null = null

function Harness({
  resultsOf,
}: {
  resultsOf: (m: Message) => (Message | undefined)[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <ToolCallGroup
      groupKey="tools:a1"
      messages={[m1, m2]}
      messageIndexes={[0, 1]}
      toolResultsFor={resultsOf}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    />
  )
}

function mount(
  resultsOf: (m: Message) => (Message | undefined)[] = resultsDone,
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Harness resultsOf={resultsOf} />)
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function head(): HTMLButtonElement {
  const el = container?.querySelector<HTMLButtonElement>('.tool-group__head')
  if (!el) throw new Error('工具组的组头没渲染出来')
  return el
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

describe('工具调用组：跑完默认折叠，点头展开', () => {
  it('跑完的组：默认折叠，组内卡片不在 DOM，头部无状态点', () => {
    mount(resultsDone)
    expect(container!.querySelectorAll('.tool-group').length).toBe(1)
    const h = head()
    expect(h.textContent).toContain('3 次工具调用')
    // 工具名预览（去重、按出现顺序）
    expect(h.textContent).toContain('read_file')
    expect(h.textContent).toContain('grep')
    // 头部不再显示成功/失败的状态点
    expect(container!.querySelector('.tool-group__point')).toBeNull()
    // 折叠态组内卡片**不在 DOM**（不是 CSS 藏起来）
    expect(container!.querySelector('.tool-group__body')).toBeNull()
    expect(container!.querySelector('.tool-card')).toBeNull()
    // 但段首正文恒显示（不随折叠隐藏）—— 复用普通 assistant 消息的容器
    expect(
      container!.querySelector('.message-bubble.assistant .message-content')
        ?.textContent,
    ).toContain('先看这里。')
    expect(h.getAttribute('aria-expanded')).toBe('false')
  })

  it('单击组头展开后是全部卡片；再点收回', () => {
    mount(resultsDone)
    click(head())
    const cards = container!.querySelectorAll('.tool-group__body .tool-card')
    expect(cards.length).toBe(3)
    expect([...cards].map((c) => c.getAttribute('data-tool-name'))).toEqual([
      'read_file',
      'grep',
      'write_file',
    ])
    // 段首正文恒显示在组头之上（不随折叠隐藏）
    expect(
      container!.querySelector('.message-bubble.assistant .message-content')
        ?.textContent,
    ).toContain('先看这里。')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    // 收回：折叠可逆
    click(head())
    expect(container!.querySelector('.tool-group__body')).toBeNull()
  })

  it('运行中的组（pending）：即使 open=false 也恒展开，点组头也折不起来', () => {
    mount(resultsPending)
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(container!.querySelector('.tool-group__body')).not.toBeNull()
    expect(container!.querySelectorAll('.tool-card').length).toBe(3)
    // 运行中不允许折叠：点组头后仍是展开
    click(head())
    expect(container!.querySelector('.tool-group__body')).not.toBeNull()
  })
})
