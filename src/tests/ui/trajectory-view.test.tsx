/**
 * 轨迹视图接线用例：真实挂载 `TrajectoryView`，验证「消息 → 轮/步/行 → 表 / 概览 / 检查器」
 * 这条链端到端是通的（纯投影规则的用例在 `domain/trajectory.test.ts`）。
 *
 * jsdom 里的两个坑（与 `message-list-tool-group.test.tsx` 同一套处理）：
 * 1. 没有布局 → `clientHeight / offsetHeight` 恒为 0，虚拟列表渲染区间为空（什么都不显示）；
 * 2. 没有 ResizeObserver → 虚拟库收不到尺寸变化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Message } from '@/types'

// monaco 在 jsdom 里跑不起来（缺 CSS.escape）：替换成结构等价的最小替身
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: { rules: [] as unknown[] },
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  toMonacoLang: (): string | undefined => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ children }: any) => <pre>{children}</pre>,
}))

/**
 * 用量账本替身：默认空（jsdom 里没有 Tauri，真 repo 会兜底成空），
 * 需要时由单个用例填空 —— 否则统计条 / 请求页这两块没法验证。
 */
const ledgerMock = vi.hoisted(() => ({
  all: null as unknown,
  chat: null as unknown,
  records: [] as unknown[],
}))

vi.mock('@/infrastructure/statsRepo', () => {
  const emptyBucket = {
    key: '',
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCalls: 0,
  }
  const EMPTY_STATS = {
    buckets: [] as never[],
    totals: emptyBucket,
    firstTs: null as number | null,
    lastTs: null as number | null,
  }
  return {
    statsRepo: {
      stats: async (query: { kind?: string }) => {
        // legacy（历史回填）在用例里恒为空：归入对话请求的逻辑单独在 hook 里管
        if (query.kind === 'chat_round') return ledgerMock.chat ?? EMPTY_STATS
        if (query.kind === 'legacy') return EMPTY_STATS
        return ledgerMock.all ?? EMPTY_STATS
      },
      records: async () => ({ records: ledgerMock.records, total: ledgerMock.records.length }),
      clear: async () => 0,
    },
  }
})

import { TrajectoryView } from '@/ui/pages/chat/components/trajectory/trajectory-view'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.cb(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 700,
  width: 900,
  height: 700,
  toJSON: () => ({}),
} as DOMRect
Element.prototype.getBoundingClientRect = () => RECT
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => 700,
})
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 900,
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 900,
})
// 轨迹表滚动容器给一个「高视口」，让全部行都进入渲染窗口（否则断言会跟着缓冲常量碎）
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains('trajectory-table__scroll') ? 4000 : 700
  },
})
// jsdom 没实现 scrollTo（虚拟库 scrollToIndex 会用到）
function noopScrollTo(): void {}
Element.prototype.scrollTo = noopScrollTo as unknown as typeof Element.prototype.scrollTo

const T0 = 1_700_000_000_000

const MESSAGES: Message[] = [
  {
    id: 'u1',
    role: 'user',
    content: '帮我读一下 a.ts',
    timestamp: T0,
  },
  {
    id: 'a1',
    role: 'assistant',
    content: '我先看看',
    timestamp: T0 + 100,
    reasoningContent: '这是一个文件读取任务',
    reasoningElapsedMs: 800,
    usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    toolCalls: [
      { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
    ],
  },
  {
    id: 't1',
    role: 'tool',
    content: 'export const a = 1',
    toolCallId: 'c1',
    timestamp: T0 + 600,
    elapsedMs: 200,
  },
  {
    id: 'u2',
    role: 'user',
    content: '谢谢',
    timestamp: T0 + 5000,
  },
]

let root: Root | null = null
let container: HTMLDivElement | null = null

/** 假 2D 上下文：只记「调用过哪些绘制 API」（几何口径由 `tests/domain/trajectory-paint.test.ts` 守） */
function fakeContext(): { calls: string[] } & Record<string, unknown> {
  const calls: string[] = []
  const record = (name: string) => (): void => {
    calls.push(name)
  }
  return {
    calls,
    beginPath: record('beginPath'),
    roundRect: record('roundRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    clearRect: record('clearRect'),
    setTransform: record('setTransform'),
    fill: record('fill'),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
  }
}

let ctx: { calls: string[] } & Record<string, unknown>
const originalGetContext = HTMLCanvasElement.prototype.getContext

beforeEach(() => {
  ctx = fakeContext()
  HTMLCanvasElement.prototype.getContext = (() =>
    ctx) as unknown as HTMLCanvasElement['getContext']
})

/** 在概览条上按一下（pointerdown + pointerup，不移动 = 点击） */
function press(el: Element, x: number, y: number): void {
  for (const type of ['pointerdown', 'pointerup']) {
    act(() => {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      )
    })
  }
}

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(element)
  })
  return container
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    systemPrompt: '你是助手',
    messages: MESSAGES,
    hasMoreOlder: false,
    onLoadOlder: (): void => undefined,
    onJumpToMessage: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  ledgerMock.all = null
  ledgerMock.chat = null
  ledgerMock.records = []
})

/** 等 hook 的 400ms 防抖把账本数据装进来 */
async function flushUsage(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
  })
}

/** 账本聚合桶 */
function bucket(patch: Record<string, number> = {}) {
  return {
    key: '',
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCalls: 0,
    ...patch,
  }
}

/** 一条账本明细（chat_round） */
function usageRecord(patch: Record<string, unknown> = {}) {
  return {
    id: 1,
    ts: T0 + 5000,
    sessionId: 's1',
    sessionTitle: '会话',
    messageId: 'a1',
    model: 'gpt-4o',
    providerType: 'openai',
    providerConfigId: 'p1',
    kind: 'chat_round',
    round: 1,
    promptTokens: 120,
    completionTokens: 30,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    estimated: false,
    durationMs: 4200,
    traceId: 'tr-1',
    ...patch,
  }
}

describe('TrajectoryView', () => {
  it('把消息摊成「会话开始 + 第 1 轮 + 第 2 轮」的记录表', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const text = el.textContent ?? ''
    expect(text).toContain('会话开始')
    expect(text).toContain('第 1 轮')
    expect(text).toContain('第 2 轮')
    expect(text).toContain('第 1 步')
    // 行号连续，且系统提示词占 #1
    expect(el.querySelector('.trajectory-record .col-index')?.textContent).toBe('#1')
    expect(text).toContain('系统提示词 · ')
    // 工具行显示工具名 + 参数
    expect(text).toContain('read_file')
    expect(text).toContain('{"path":"a.ts"}')
    // 助手行的 token 与思考耗时
    expect(text).toContain('120')
    expect(text).toContain('30')
    expect(text).toContain('800ms')
    // 工具耗时 200ms
    expect(text).toContain('200ms')
  })

  it('点击记录行打开检查器，并可在检查器里跳回对话', () => {
    const onJumpToMessage = vi.fn()
    const el = render(<TrajectoryView {...baseProps({ onJumpToMessage })} />)
    const rows = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-record')]
    const toolRow = rows.find((row) => row.textContent?.includes('read_file'))
    expect(toolRow).toBeDefined()
    act(() => {
      toolRow!.click()
    })
    expect(el.querySelector('.trajectory-inspector')).not.toBeNull()
    // 工具行有「参数 / 结果」两个专属页
    const tabs = [...el.querySelectorAll('.trajectory-tab')].map((tab) => tab.textContent)
    expect(tabs).toContain('参数')
    expect(tabs).toContain('结果')

    const jump = el.querySelector<HTMLButtonElement>('.trajectory-jump')
    expect(jump).not.toBeNull()
    act(() => {
      jump!.click()
    })
    // 工具行跳回的是宿主 assistant 的消息 id
    expect(onJumpToMessage).toHaveBeenCalledWith('a1')
  })

  it('收起一轮之后，该轮的记录行从表里消失（轮头保留）', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const firstTurn = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-turn')].find(
      (row) => row.textContent?.includes('第 1 轮'),
    )
    expect(firstTurn).toBeDefined()
    const before = el.querySelectorAll('.trajectory-record').length
    act(() => {
      firstTurn!.click()
    })
    const after = el.querySelectorAll('.trajectory-record').length
    expect(after).toBeLessThan(before)
    // 轮头还在，并显示折叠摘要
    expect(el.textContent).toContain('组 · ')
  })

  it('「调用」开关收起所有工具行', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    expect(
      [...el.querySelectorAll('.trajectory-record')].some((row) =>
        row.textContent?.includes('read_file'),
      ),
    ).toBe(true)
    const toggle = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-toggle')].find(
      (button) => button.textContent?.includes('调用'),
    )
    act(() => {
      toggle!.click()
    })
    expect(
      [...el.querySelectorAll('.trajectory-record')].some((row) =>
        row.textContent?.includes('read_file'),
      ),
    ).toBe(false)
  })

  it('搜索命中的行带 is-match，非命中不标', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const input = el.querySelector<HTMLInputElement>('.trajectory-toolbar__search input')
    expect(input).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(input, 'read_file')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const matches = [...el.querySelectorAll('.trajectory-record.is-match')]
    // 命中两行：工具行（工具名 + 参数）与助手行（工具名预览）
    expect(matches).toHaveLength(2)
    expect(matches.some((row) => row.textContent?.includes('read_file'))).toBe(true)
    expect(
      matches.some((row) => !row.textContent?.includes('read_file')),
    ).toBe(true)
  })

  it('概览条：canvas 真的被驱动去画，点一根能定位到对应记录', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    expect(el.querySelector('.trajectory-timeline__canvas')).not.toBeNull()
    // jsdom 里 `clientWidth` 是 0，能画出条子就说明「模型 → 指令 → canvas」这条链是通的
    expect(ctx.calls).toContain('fillRect')

    const rows = el.querySelectorAll('.trajectory-record')
    // 等宽模式下第 N 根条就在 [(N-1)/总数, N/总数) 里；取最后一根（第 2 轮的用户消息，输入泳道）
    const x = ((rows.length - 0.5) / rows.length) * 900
    press(el.querySelector('.trajectory-timeline__viewport')!, x, 5)
    expect(el.querySelector('.trajectory-record.is-selected')?.textContent).toContain(
      '谢谢',
    )
    expect(el.querySelector('.trajectory-inspector')).not.toBeNull()
  })

  it('概览条：滚轮放大后内容层变宽（放大后才出横向滚动条），双击回到 1×', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const spacer = el.querySelector<HTMLElement>('.trajectory-timeline__spacer')
    const scroll = el.querySelector<HTMLElement>('.trajectory-timeline__scroll')
    const viewport = el.querySelector<HTMLElement>('.trajectory-timeline__viewport')
    expect(spacer).not.toBeNull()
    expect(scroll).not.toBeNull()
    // 1× = 整段会话铺满视口：内容不溢出，视口不会出滚动条
    expect(spacer!.style.width).toBe('100%')

    act(() => {
      scroll!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
      )
    })
    expect(parseFloat(spacer!.style.width)).toBeGreaterThan(100)

    act(() => {
      viewport!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(spacer!.style.width).toBe('100%')
  })

  it('概览条：悬停在条子上时把它的摘要当作提示（条子不再是 DOM 节点）', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const viewport = el.querySelector<HTMLElement>('.trajectory-timeline__viewport')!
    const rows = el.querySelectorAll('.trajectory-record')
    const x = ((rows.length - 0.5) / rows.length) * 900
    act(() => {
      viewport.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 5 }),
      )
    })
    expect(viewport.title).toContain('谢谢')
    act(() => {
      // 移到条子之外（落点落在第一根之前）：悬停高亮与提示都该退回默认
      viewport.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: -20,
          clientY: 5,
        }),
      )
    })
    expect(viewport.title).toContain('滚轮缩放')
  })

  it('概览条：拖出一段区间只提亮那个时间段的行', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const viewport = el.querySelector<HTMLElement>('.trajectory-timeline__viewport')!
    const rows = el.querySelectorAll('.trajectory-record')
    const at = (index: number) => ((index + 0.5) / rows.length) * 900
    act(() => {
      viewport.dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          clientX: at(0),
          clientY: 5,
        }),
      )
    })
    act(() => {
      viewport.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: at(1),
          clientY: 5,
        }),
      )
    })
    act(() => {
      viewport.dispatchEvent(
        new MouseEvent('pointerup', {
          bubbles: true,
          clientX: at(1),
          clientY: 5,
        }),
      )
    })
    const dimmed = [...el.querySelectorAll('.trajectory-record.is-dimmed')]
    expect(dimmed.length).toBeGreaterThan(0)
    expect(dimmed.length).toBeLessThan(rows.length)
  })

  it('回补更早历史后，选中的记录仍指向同一条（按 key 而不是行号）', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const target = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-record')].find(
      (row) => row.textContent?.includes('谢谢'),
    )
    expect(target).toBeDefined()
    act(() => {
      target!.click()
    })
    expect(el.querySelector('.trajectory-record.is-selected')?.textContent).toContain(
      '谢谢',
    )

    // 模拟向上回补：历史前插后所有记录行号都会变（#5 → #8）
    const older: Message[] = [
      { id: 'u0', role: 'user', content: '更早的问题', timestamp: T0 - 10_000 },
      {
        id: 'a0',
        role: 'assistant',
        content: '更早的回答',
        timestamp: T0 - 9_000,
      },
    ]
    act(() => {
      root!.render(
        <TrajectoryView {...baseProps({ messages: [...older, ...MESSAGES] })} />,
      )
    })

    const selected = el.querySelector('.trajectory-record.is-selected')
    expect(selected?.textContent).toContain('谢谢')
    // 行号确实变了（选中行不再是 #5）
    expect(selected?.querySelector('.col-index')?.textContent).not.toBe('#5')
  })

  it('检查器：按住分隔条拖动才改宽度，松手后不再跟着鼠标跑', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    act(() => {
      el.querySelector<HTMLButtonElement>('.trajectory-record')!.click()
    })
    const aside = el.querySelector<HTMLElement>('.trajectory-inspector')!
    const handle = el.querySelector<HTMLElement>('.trajectory-inspector__resizer')!
    const widthOf = (): number =>
      parseFloat(aside.style.getPropertyValue('--trajectory-inspector-width'))
    const before = widthOf()

    act(() => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 900 }),
      )
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 800 }))
    })
    // 分隔条在面板左缘：向左拖 100px = 变宽 100px
    expect(widthOf()).toBe(before + 100)

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 800 }))
    })
    // 松手后再动鼠标不该继续改宽度（pointerdown 上 preventDefault 会抑制兼容 mousemove，
    // 之前挂在 window 上的 mousemove 监听就变成了「松手后跟着鼠标跑」）
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
    })
    expect(widthOf()).toBe(before + 100)
    localStorage.removeItem('virlen.trajectory.inspectorWidth')
  })

  it('没有消息时显示空状态，不渲染表格', () => {
    const el = render(<TrajectoryView {...baseProps({ messages: [] })} />)
    expect(el.textContent).toContain('这段会话还没有可显示的记录')
    expect(el.querySelector('.trajectory-table')).toBeNull()
  })

  it('请求统计：账本为空时只报「已加载的记录」，并说清口径', async () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    await flushUsage()
    const bar = el.querySelector('.trajectory-stats__bar')
    expect(bar).not.toBeNull()
    expect(bar!.textContent).toContain('请求统计')
    // 窗口口径：MESSAGES 里只有一条回复行
    expect(bar!.textContent).toContain('对话 1 次')
    expect(bar!.textContent).toContain('仅已加载')

    act(() => {
      el.querySelector<HTMLButtonElement>('.trajectory-stats__bar')!.click()
    })
    expect(el.textContent).toContain('账本不可用')
    expect(el.textContent).toContain('已加载的记录')
    expect(el.querySelectorAll('.trajectory-stats__metric').length).toBeGreaterThan(0)
  })

  it('请求统计：账本给出会话全量合计（对话请求 / 其它调用 / 缓存命中率）', async () => {
    const totals = bucket({
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 600,
      cacheWriteTokens: 100,
      totalTokens: 1900,
      calls: 3,
      estimatedCalls: 1,
    })
    ledgerMock.all = { buckets: [], totals, firstTs: T0, lastTs: T0 + 5000 }
    ledgerMock.chat = {
      buckets: [],
      totals: bucket({ calls: 2, promptTokens: 1000, completionTokens: 200 }),
      firstTs: T0,
      lastTs: T0 + 5000,
    }
    const el = render(<TrajectoryView {...baseProps()} />)
    await flushUsage()
    expect(el.textContent).toContain('会话全量')
    expect(el.textContent).toContain('对话 2 次')
    // 600 / (1000 + 600 + 100) = 35%
    expect(el.textContent).toContain('缓存 35%')

    act(() => {
      el.querySelector<HTMLButtonElement>('.trajectory-stats__bar')!.click()
    })
    expect(el.textContent).toContain('其它调用')
    expect(el.textContent).toContain('估算用量')
    // 3 次调用、2 次对话请求 → 其它调用 1
    const metrics = [...el.querySelectorAll('.trajectory-stats__metric')]
    const other = metrics.find((m) => m.textContent?.startsWith('其它调用'))
    expect(other?.textContent).toContain('1')
  })

  it('账本流水落到回复行：实测耗时替掉反推值，并标记模型', async () => {
    ledgerMock.all = {
      buckets: [],
      totals: bucket({ calls: 1, promptTokens: 120, completionTokens: 30, totalTokens: 150 }),
      firstTs: T0,
      lastTs: T0 + 5000,
    }
    ledgerMock.chat = {
      buckets: [],
      totals: bucket({ calls: 1 }),
      firstTs: T0,
      lastTs: T0 + 5000,
    }
    ledgerMock.records = [usageRecord()]
    const el = render(<TrajectoryView {...baseProps()} />)
    await flushUsage()

    const assistantRow = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-record')].find(
      (row) => row.textContent?.includes('我先看看'),
    )
    expect(assistantRow).toBeDefined()
    // 账本实测 4.2s（反推值是 300ms，两者不会同时出现）
    expect(assistantRow!.querySelector('.col-time')?.textContent).toBe('4.2s')
    expect(assistantRow!.querySelector('.trajectory-record__model')?.textContent).toBe('gpt-4o')

    act(() => {
      assistantRow!.click()
    })
    const requestTab = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-tab')].find(
      (tab) => tab.textContent === '请求',
    )
    expect(requestTab).toBeDefined()
    act(() => {
      requestTab!.click()
    })
    const inspector = el.querySelector('.trajectory-inspector')
    expect(inspector?.textContent).toContain('gpt-4o')
    expect(inspector?.textContent).toContain('openai')
    // 30 tok / 4.2s ≈ 7 tok/s
    expect(inspector?.textContent).toContain('7 tok/s')
    expect(inspector?.textContent).toContain('#1')
  })

  it('没有账本时回复行的耗时仍是反推值，并加 ≈ 标记', () => {
    const el = render(<TrajectoryView {...baseProps()} />)
    const assistantRow = [...el.querySelectorAll<HTMLButtonElement>('.trajectory-record')].find(
      (row) => row.textContent?.includes('我先看看'),
    )
    // 工具结束于 T0+600、自带 200ms → 开始于 T0+400 → 反推 300ms
    expect(assistantRow!.querySelector('.col-time')?.textContent).toBe('≈300ms')
    expect(assistantRow!.querySelector('.trajectory-record__model')).toBeNull()
  })
})
