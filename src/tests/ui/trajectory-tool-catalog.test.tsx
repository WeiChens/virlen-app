/**
 * 轨迹检查器「工具」页（对齐 dsh 的 ToolCatalog）。
 *
 * 钉四件事：
 * 1. 只有系统记录才带「工具」页（其它行没有「请求表面」这层语义）；
 * 2. 目录按**会话白名单**过滤，三态口径与引擎共用一份实现（`undefined` = 全部）；
 * 3. 折叠项：收起只占一行（名称 + 一行描述），展开才出完整描述与参数 JSON；
 * 4. 读取失败要说清原因，不能静默成「没有工具」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TrajectoryInspector } from '@/ui/pages/chat/components/trajectory/trajectory-inspector'
import { setToolDefinitionsLoader, toolRegistry } from '@/domain/tools'
import type { ResolvedToolDefinition, ToolExecutor } from '@/domain/tools/types'
import type { TrajectoryRecord } from '@/domain/trajectory'

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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** 假契约（定义来自权威源，注册中心只存执行器 + label） */
function def(
  name: string,
  description: string,
  properties: Record<string, { type: string; description?: string }> = {},
): ResolvedToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required: [] },
  }
}

const DEFS: ResolvedToolDefinition[] = [
  def('read_file', 'Read the content of a file.\nSupports line ranges.', {
    path: { type: 'string', description: 'File path' },
  }),
  def('write_file', 'Write content to a file.'),
  def('present', 'Declare existing files as deliverables for the user.'),
]
const noopExecutor = (async () => '') as ToolExecutor

function systemRecord(patch: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    key: 'rec-system',
    index: 1,
    kind: 'system',
    text: '',
    durationMs: null,
    systemPrompt: '你是 Virlen 助手',
    ...patch,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(
  record: TrajectoryRecord,
  allowedTools?: readonly string[],
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TrajectoryInspector
        record={record}
        width={400}
        allowedTools={allowedTools}
        onClose={vi.fn()}
        onResizeStart={vi.fn()}
        onJumpToConversation={vi.fn()}
      />,
    )
  })
  return container
}

/** 等 hook 的 Promise 链落地（定义读取是异步的） */
async function flushCatalog(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function tab(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('.trajectory-tab')].find(
    (item) => item.textContent === label,
  )
}

beforeEach(async () => {
  setToolDefinitionsLoader(async () => DEFS)
  await toolRegistry.register('read_file', noopExecutor, '读取文件')
  await toolRegistry.register('write_file', noopExecutor, '写入文件')
  await toolRegistry.register('present', noopExecutor, '交付文件')
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  toolRegistry.clear()
})

describe('轨迹检查器「工具」页', () => {
  it('系统记录带「工具」页：列出全部工具，折叠项展开才出参数 JSON', async () => {
    const el = render(systemRecord())
    await flushCatalog()

    expect(tab(el, '系统提示词')).toBeDefined()
    const toolsTab = tab(el, '工具')
    expect(toolsTab).toBeDefined()
    act(() => {
      toolsTab!.click()
    })

    const text = el.textContent ?? ''
    expect(text).toContain('共 3 个工具')
    expect(text).toContain('read_file')
    expect(text).toContain('读取文件')
    expect(text).toContain('present')
    expect(text).toContain('Declare existing files as deliverables')

    // 收起态只有一行摘要：完整描述里的换行内容不进 summary
    const summary = el.querySelector('.trajectory-tools__summary')
    expect(summary?.textContent).not.toContain('\n')
    // 参数 JSON 在 DOM 里（details 收起也保留），展开即可见
    expect(el.querySelector('.trajectory-tools__item pre')?.textContent).toContain(
      'File path',
    )
    const item = el.querySelector<HTMLDetailsElement>('.trajectory-tools__item')
    expect(item?.open).toBe(false)
    act(() => {
      item!.open = true
    })
    expect(item?.open).toBe(true)
  })

  it('按会话白名单过滤：只出现名单里的工具', async () => {
    const el = render(systemRecord(), ['present'])
    await flushCatalog()
    act(() => {
      tab(el, '工具')!.click()
    })

    const names = [...el.querySelectorAll('.trajectory-tools__name')].map(
      (node) => node.textContent,
    )
    expect(names).toEqual(['present'])
    expect(el.textContent).toContain('共 1 个工具')
  })

  it('白名单为空数组 = 一个都不给（空态而不是全部）', async () => {
    const el = render(systemRecord(), [])
    await flushCatalog()
    act(() => {
      tab(el, '工具')!.click()
    })
    expect(el.textContent).toContain('本次对话没有可用的工具')
    expect(el.querySelector('.trajectory-tools__item')).toBeNull()
  })

  it('非系统记录没有「工具」页', async () => {
    const el = render({
      key: 'rec-tool',
      index: 2,
      kind: 'tool',
      text: 'read_file',
      durationMs: 12,
      toolName: 'read_file',
    })
    await flushCatalog()
    expect(tab(el, '工具')).toBeUndefined()
    expect(tab(el, '参数')).toBeDefined()
  })

  it('定义读取失败要说原因，不静默成「没有工具」', async () => {
    setToolDefinitionsLoader(async () => {
      throw new Error('IPC down')
    })
    toolRegistry.invalidateDefinitions()
    const el = render(systemRecord())
    await flushCatalog()
    act(() => {
      tab(el, '工具')!.click()
    })
    expect(el.textContent).toContain('读取工具定义失败')
    expect(el.textContent).toContain('IPC down')
  })
})
