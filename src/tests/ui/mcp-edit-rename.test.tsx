/**
 * MCP 服务器改名 → Agent 白名单迁移的**接线**（`mcp-edit-modal` 的保存路径）
 *
 * 逻辑本身在 `domain/mcp/rename.ts`（有自己的单测）、写回在 `services/mcp.ts`；
 * 这里只钉那条最容易漏的接缝：**改名保存后真的把迁移跑了一遍**，而且：
 *  1. 名字没变时一条都不动（每次保存都扫一遍全量 Agent 等于白刷 updatedAt）；
 *  2. 保存失败（upsert 抛错）时**不迁移** —— 服务器没改成，白名单先跑了就是半套状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Agent } from '@/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const OLD = 'mcp__blender-mcp__look'
const NEW = 'mcp__blender__look'
const STORAGE_KEY = 'virlen-store'

vi.mock('@/infrastructure/mcp/repo', () => ({
  mcpRepo: {
    isAvailable: () => true,
    upsert: vi.fn(async (config: { id: string }) => ({ ok: true, id: config.id })),
    test: vi.fn(async () => ({
      ok: true,
      toolCount: 1,
      tools: [{ name: NEW, rawName: 'look', description: '', inputSchema: {} }],
    })),
  },
}))

function seedAgent(allowTools: string[]): Agent {
  return {
    id: 'agent-1',
    name: 'agent-1',
    description: '',
    personality: '',
    identity: '',
    defaultWorkspace: '',
    projectRulesFile: 'AGENTS.md',
    defaultModel: { providerConfigId: '', modelId: '' },
    allowTools,
    skills: [],
    defaultParams: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.resetModules()
  vi.clearAllMocks()
})

/** 重置模块图 → 按当前 localStorage 重新造 store（agentStore 是模块级单例） */
async function setup(allowTools: string[], overrides?: { failUpsert?: boolean }) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ agents: [seedAgent(allowTools)] }),
  )
  vi.resetModules()

  const repo = await import('@/infrastructure/mcp/repo')
  vi.mocked(repo.mcpRepo.upsert).mockImplementation((async (config: {
    id: string
  }) => {
    if (overrides?.failUpsert) throw new Error('写配置失败')
    return { ok: true, id: config.id }
  }) as never)

  const [{ default: McpEditModal }, { agentStore }, { createMcpServerDraft }] =
    await Promise.all([
      import('@/ui/pages/Settings/mcp-edit-modal'),
      import('@/ui/store/agentStore'),
      import('@/domain/mcp'),
    ])

  const config = { ...createMcpServerDraft('stdio'), id: 'srv-1', name: 'blender-mcp', command: 'uvx' }

  await act(async () => {
    root.render(
      <McpEditModal
        visible
        initialConfig={config}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
  })
  return { agentStore, config }
}

const el = <T extends Element>(sel: string) => container.querySelector<T>(sel)!

/** 受控输入：必须走原生 setter + input 事件 */
function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 「保存」按钮（modal footer 里的主按钮） */
function buttonByText(text: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === text,
  )!
}

/** 改名前必须先测通（保存门禁：没读到工具列表不给存） */
async function probeAndSave(name: string) {
  await act(async () => buttonByText('测试连接').click())
  await act(async () => setInputValue(el<HTMLInputElement>('#mcp-name'), name))
  await act(async () => buttonByText('保存').click())
}

describe('mcp-edit-modal · 改名迁移', () => {
  it('改名保存 → 白名单里的旧公开名换成新名', async () => {
    const { agentStore } = await setup([OLD, 'read_file'])

    await probeAndSave('blender')

    expect(agentStore.getAgent('agent-1')!.allowTools).toEqual([NEW, 'read_file'])
  })

  it('名字没变 → 一条都不动（不白刷 updatedAt）', async () => {
    const { agentStore } = await setup([OLD])
    const before = agentStore.getAgent('agent-1')!

    await probeAndSave('blender-mcp')

    expect(agentStore.getAgent('agent-1')).toBe(before)
  })

  it('保存失败 → 不迁移（服务器没改成，白名单也不能先跑）', async () => {
    const { agentStore } = await setup([OLD], { failUpsert: true })
    const before = agentStore.getAgent('agent-1')!

    await probeAndSave('blender')

    expect(agentStore.getAgent('agent-1')).toBe(before)
  })
})
