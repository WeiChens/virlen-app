/**
 * mcp-settings · 给单个 MCP 工具改公开名（`toolAliases`）。
 *
 * 守四条接线（后端语义由 `cargo test -p virlen-core mcp` 与 `tests/domain/mcp-config.test.ts` 守）：
 *  ① 工具行显示的是**公开名**，改名按钮打开弹窗、预填当前名字；
 *  ② 保存 → `cmd_mcp_upsert` 带上 `toolAliases: { rawName: 新名 }`，其余字段原样；
 *  ③ 保存后**必须**调 `migrateAgentToolNames`（旧名 → 新名），否则各 Agent 白名单里留下幽灵条目；
 *  ④ 清空输入 = 恢复默认（`toolAliases` 整个键消失），非法名字当场驳回、不发请求。
 *
 * 环境走**模拟 Tauri**（`__TAURI_INTERNALS__` + mock `invoke`）：`mcpRepo` 与 `mcpStore` 都用真的，
 * 只有 IPC 是假的 —— 换成 mock 仓储就会绕开 `available` / 刷新链路，测不出「界面到底哪来的数据」。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@/services/agent-service', () => ({
  migrateAgentToolNames: vi.fn(() => 0),
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(async () => true) },
}))

import McpSettings from '@/ui/pages/Settings/mcp-settings'
import { migrateAgentToolNames } from '@/services/agent-service'
import { showToast } from '@/ui/components/shared/Toast'
import type { McpServerConfig, McpServerStatus } from '@/domain/mcp'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG: McpServerConfig = {
  id: 'srv1',
  name: 'blender',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: [],
  env: {},
  approval: 'allow',
  toolCallTimeoutMs: 60_000,
  startupTimeoutMs: 30_000,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  injectInstructions: true,
}

function statusNamed(toolName: string): McpServerStatus {
  return {
    id: 'srv1',
    name: 'blender',
    transport: 'stdio',
    state: 'ready',
    toolCount: 1,
    tools: [{ name: toolName, rawName: 'look', description: '看场景', inputSchema: {} }],
    allTools: [{ name: toolName, rawName: 'look', description: '看场景', inputSchema: {} }],
    reconnectCount: 0,
  }
}

/** Rust 侧「当前快照」：upsert 之后换成改名生效的样子（公开名变了） */
let snapshot: { config: McpServerConfig; toolName: string }
/** 收到的 upsert 载荷 */
let upserts: McpServerConfig[]

function seed(toolAliases?: Record<string, string>) {
  snapshot = {
    config: { ...CONFIG, toolAliases },
    toolName: toolAliases?.look ?? 'look',
  }
  upserts = []
}

/** 把 `invoke` 接到假快照上（`cmd_mcp_list` / `cmd_mcp_upsert` 两条就够页面用） */
async function installInvoke() {
  const core = await import('@tauri-apps/api/core')
  vi.mocked(core.invoke).mockImplementation((async (cmd: string, args?: any) => {
    if (cmd === 'cmd_mcp_list') {
      return {
        configs: [snapshot.config],
        statuses: [statusNamed(snapshot.toolName)],
        conflicts: [] as McpServerStatus[],
        epoch: 1,
      }
    }
    if (cmd === 'cmd_mcp_upsert') {
      const next = args.config as McpServerConfig
      upserts.push(next)
      snapshot = {
        config: next,
        toolName: next.toolAliases?.look ?? 'look',
      }
      return { ok: true, id: next.id }
    }
    return undefined
  }) as never)
}

async function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<McpSettings />))
  // 首次拉取在 useEffect 里（异步）：再 flush 一轮，否则列表还是空的
  await act(async () => {})
  // 展开详情（工具清单在折叠区里）
  const expand = host.querySelector<HTMLButtonElement>('.mcp-row .expand-btn')!
  await act(async () => expand.click())
  return {
    host,
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

/** React 受控输入：走原生 setter + input 事件，否则 state 收不到 */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const renameButtonOf = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('.mcp-tool-list li .mcp-tool-head button')!

const aliasInput = () => document.querySelector<HTMLInputElement>('#mcp-tool-alias')!

/** 改名弹窗底部那颗「保存」（详情区里也有 button，故按 modal-footer 找） */
const modalSave = () => document.querySelector<HTMLButtonElement>('.modal-footer .btn-primary')!

beforeEach(async () => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  document.body.innerHTML = ''
  seed()
  await installInvoke()
  vi.mocked(migrateAgentToolNames).mockClear()
  vi.mocked(showToast).mockClear()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

it('工具行显示公开名；改名后 upsert 带 toolAliases，并迁移 Agent 白名单', async () => {
  const { host, unmount } = await render()

  // 行上显示的是公开名（模型看到的那个）
  expect(host.querySelector('.mcp-tool-list li code')?.textContent).toBe('look')

  await act(async () => renameButtonOf(host).click())
  // 预填当前公开名（改名大多是「在现有名字上改几个字」）
  expect(aliasInput().value).toBe('look')

  await type(aliasInput(), 'blender_look')
  await act(async () => modalSave().click())

  const saved = upserts[0]
  expect(saved.toolAliases).toEqual({ look: 'blender_look' })
  // 其余字段原样带回去（整条覆盖，不是局部补丁）
  expect(saved.id).toBe('srv1')
  expect(saved.name).toBe('blender')
  expect(saved.approval).toBe('allow')

  // 旧公开名 → 新公开名（用刷新后的真名字，不是前端自己猜的）
  expect(vi.mocked(migrateAgentToolNames).mock.calls[0][0]).toEqual([
    { from: 'look', to: 'blender_look' },
  ])
  await unmount()
})

it('清空输入 = 恢复默认：toolAliases 整个键消失', async () => {
  seed({ look: 'blender_look' })
  const { host, unmount } = await render()

  expect(host.querySelector('.mcp-tool-list li code')?.textContent).toBe('blender_look')
  // 改过名时要摆出服务器原名，否则用户不知道自己改的是哪一个
  expect(host.querySelector('.mcp-tool-list .mcp-tool-raw')?.textContent).toContain('look')

  await act(async () => renameButtonOf(host).click())
  expect(aliasInput().value).toBe('blender_look')

  await type(aliasInput(), '')
  await act(async () => modalSave().click())

  expect(upserts[0].toolAliases).toBeUndefined()
  expect(vi.mocked(migrateAgentToolNames).mock.calls[0][0]).toEqual([
    { from: 'blender_look', to: 'look' },
  ])
  await unmount()
})

it('非法名字当场驳回（不发请求、弹错误提示、弹窗不关）', async () => {
  const { host, unmount } = await render()

  await act(async () => renameButtonOf(host).click())
  await type(aliasInput(), 'has space')
  await act(async () => modalSave().click())

  expect(upserts).toHaveLength(0)
  expect(vi.mocked(showToast).mock.calls[0][0]).toContain('只能包含')
  expect(aliasInput()).not.toBeNull()
  await unmount()
})
