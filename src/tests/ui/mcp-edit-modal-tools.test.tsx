/**
 * mcp-edit-modal · 工具选择的清单来源。
 *
 * 守三条行为（后端语义由 `cargo test -p virlen-core mcp` 守）：
 *  ① 编辑一台**已经连上**的服务器：打开弹窗就有工具清单（Rust 的 `allTools`，不受白名单裁剪），
 *     勾选按已保存的白名单回填，**不必**重新连一次；
 *  ② 被排除过的工具也必须列出来（否则一旦取消勾选就再也勾不回来）；
 *  ③ 新增服务器没有清单：保存被挡，点「获取工具列表」才现取。
 *
 * 环境走**模拟 Tauri**（`invoke` 在 `src/tests/setup.ts` 里 mock）：`mcpRepo` / `mcpStore` 都用真的，
 * 只有 IPC 是假的 —— 换 mock 仓储会绕开 `available` 与刷新链路。
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
import { showToast } from '@/ui/components/shared/Toast'
import type {
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
} from '@/domain/mcp'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function tool(rawName: string): McpToolInfo {
  return { name: rawName, rawName, description: `${rawName} 的描述`, inputSchema: {} }
}

/** 已保存的配置：白名单只留 `a_tool`（c_tool 是新增的、还没进白名单） */
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
  enabledTools: ['a_tool'],
  injectInstructions: true,
}

const ALL_TOOLS = [tool('a_tool'), tool('c_tool')]

function status(): McpServerStatus {
  return {
    id: 'srv1',
    name: 'blender',
    transport: 'stdio',
    state: 'ready',
    toolCount: 1,
    // 模型可见的那一份（已按白名单裁过）
    tools: [tool('a_tool')],
    // 服务器提供的完整清单（编辑弹窗的候选）
    allTools: ALL_TOOLS,
    reconnectCount: 0,
  }
}

let upserts: McpServerConfig[]
let probes: McpServerConfig[]

async function installInvoke() {
  const core = await import('@tauri-apps/api/core')
  vi.mocked(core.invoke).mockImplementation((async (cmd: string, args?: any) => {
    if (cmd === 'cmd_mcp_list') {
      return { configs: [CONFIG], statuses: [status()], conflicts: [], epoch: 1 } as const
    }
    if (cmd === 'cmd_mcp_upsert') {
      upserts.push(args.config as McpServerConfig)
      return { ok: true, id: (args.config as McpServerConfig).id }
    }
    if (cmd === 'cmd_mcp_test') {
      probes.push(args.config as McpServerConfig)
      return { ok: true, toolCount: 2, tools: ALL_TOOLS }
    }
    throw new Error(`未预期的命令：${cmd}`)
  }) as never)
}

async function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<McpSettings />))
  // 首次拉取在 useEffect 里（异步）：再 flush 一轮，否则列表还是空的
  await act(async () => {})
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

const pickerItems = () =>
  Array.from(document.querySelectorAll<HTMLLIElement>('.mcp-tool-picker li'))

const checkedNames = () =>
  Array.from(document.querySelectorAll<HTMLLIElement>('.mcp-tool-picker li'))
    .filter((li) => li.querySelector<HTMLInputElement>('input')!.checked)
    .map((li) => li.querySelector('code')!.textContent)

const footerButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.modal-footer button')).find(
    (button) => button.textContent?.includes(label),
  )!

const footerHint = () => document.querySelector('.mcp-footer-hint')?.textContent ?? ''

beforeEach(async () => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  document.body.innerHTML = ''
  upserts = []
  probes = []
  await installInvoke()
  vi.mocked(showToast).mockClear()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

it('编辑已连接的服务器：清单直接回填（含被白名单排除的工具），保存不必重连', async () => {
  const { host, unmount } = await render()

  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('.mcp-row-actions .icon-btn[aria-label="编辑服务器"]')!
      .click()
  })

  // 一打开就有清单：两个工具都在（c_tool 是被白名单排除的那个）
  expect(pickerItems().length).toBe(2)
  expect(checkedNames()).toEqual(['a_tool'])
  // 有清单就不该再要求「先获取」
  expect(footerHint()).toBe('')
  expect(footerButton('保存').disabled).toBe(false)

  await act(async () => footerButton('保存').click())

  expect(probes).toHaveLength(0)
  expect(upserts).toHaveLength(1)
  // 白名单按勾选写回（顺序跟服务器清单走，不是旧数组顺序）
  expect(upserts[0].enabledTools).toEqual(['a_tool'])
  await unmount()
})

it('新增服务器：没有清单时保存被挡，点「获取工具列表」才现取', async () => {
  const { host, unmount } = await render()

  await act(async () => {
    host.querySelector<HTMLButtonElement>('.mcp-header-actions .btn-primary')!.click()
  })

  await type(document.querySelector<HTMLInputElement>('#mcp-name')!, 'fs')
  await type(document.querySelector<HTMLInputElement>('#mcp-command')!, 'npx')

  expect(pickerItems()).toHaveLength(0)
  expect(footerHint()).toContain('先获取工具列表才能保存')
  expect(footerButton('保存').disabled).toBe(true)

  await act(async () => footerButton('获取工具列表').click())

  // 探测请求**不带**旧白名单（否则 Rust 会按它裁剪清单）
  expect(probes[0].enabledTools).toBeUndefined()
  expect(pickerItems().length).toBe(2)
  // 新增服务器默认全选
  expect(checkedNames()).toEqual(['a_tool', 'c_tool'])

  await act(async () => footerButton('保存').click())
  expect(upserts).toHaveLength(1)
  // 全选 = 不限制（undefined），不是空数组
  expect(upserts[0].enabledTools).toBeUndefined()
  await unmount()
})
