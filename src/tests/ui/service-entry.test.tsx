/**
 * ServiceEntry — 聊天页标题栏「后台服务」入口 + 面板（P2）
 *
 * 覆盖这些容易出错的地方：
 * 1. **入口只在「有服务」时出现**（已选会话 = 本会话；新对话页 = 全部会话，P4），徽标 = **运行中**
 *    数量（已结束的不算）—— 口径错了，用户会以为还有东西在跑（或反过来，以为都停了）；
 * 2. **默认停在「运行中」页**，两页条数直接挂在页签上（另一页有没有东西一眼可见）；
 * 3. **终止 = 直接调 Rust（不弹二次确认）**，杀完立刻对账：行落到「已结束」、徽标归零 ——
 *    少了这次对账会出现「点了没反应」的假象（下次轮询 1s 之后才变）；
 * 4. **「已结束」页没有终止按钮**（幂等语义留给 AI 的 kill 工具），并如实显示退出码；
 * 5. **新对话页的全局视图**（`sessionId=null`）：跨会话列表 + 每行标归属，终止 / 终端弹窗必须带
 *    **行自己的**会话 id —— 带错就是「在另一个会话上杀服务」，不是界面问题而是行为错误。
 *
 * 数据层（Rust 注册表 / 命令 / 会话隔离）由 `cargo test -p virlen-core native_tools::service` 守；
 * 这里只验界面行为，因此直接 mock 数据入口。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ServiceEntry from '@/ui/pages/chat/components/service/ServiceEntry'
import {
  killBackgroundService,
  listAllBackgroundServices,
  listBackgroundServices,
  readServiceConsole,
  type BackgroundServiceInfo,
} from '@/infrastructure/backgroundService'
import { showToast } from '@/ui/components/shared/Toast'

vi.mock('@/infrastructure/backgroundService', () => ({
  listBackgroundServices: vi.fn(),
  listAllBackgroundServices: vi.fn(),
  killBackgroundService: vi.fn(),
  readServiceConsole: vi.fn(),
  writeServiceConsole: vi.fn(),
  resizeServiceConsole: vi.fn(),
}))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))

/** xterm 在 jsdom 里没有量度 / 画布（`term.open()` 没有意义）—— 这里用最小替身，
 *  只为让终端弹窗能挂载（终端本体自己的行为在 `service-terminal.test.tsx` 里验）。 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { baseY: 0, viewportY: 0 } }
    options: any
    constructor(options?: any) {
      this.options = { fontSize: 13, ...(options ?? {}) }
    }
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    dispose() {}
    focus() {}
    hasSelection() {
      return false
    }
    getSelection() {
      return ''
    }
    clearSelection() {}
    selectAll() {}
    paste() {}
    onData() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 一条服务快照（只写关心的字段，其余给合理默认） */
function svc(over: Partial<BackgroundServiceInfo>): BackgroundServiceInfo {
  return {
    id: 'svc_1',
    name: 'dev',
    cmd: 'npm run dev',
    status: 'running',
    returnCode: null,
    killed: false,
    pid: 1234,
    startedAt: Date.now() - 70_000,
    uptimeMs: 70_000,
    uptime: '1m10s',
    sandbox: 'write_isolation',
    unreadChars: 0,
    terminal: true,
    interactive: true,
    ...over,
  }
}

let root: ReturnType<typeof createRoot> | null = null

function mount(sessionId: string | null = 's1') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<ServiceEntry sessionId={sessionId} />))
}

/** 轮询的第一次 tick 是 `setTimeout(0)`：等它跑完 + 一次 setState 落地 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function click(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null
  if (!el) throw new Error(`找不到 ${selector}`)
  act(() => el.click())
}

function texts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map(
    (el) => el.textContent?.trim() ?? '',
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(listBackgroundServices).mockReset()
  vi.mocked(listAllBackgroundServices).mockReset()
  vi.mocked(killBackgroundService).mockReset()
  vi.mocked(readServiceConsole).mockReset()
  vi.mocked(readServiceConsole).mockResolvedValue({
    text: '',
    reset: false,
    next: 0,
    headDropped: false,
    running: true,
    terminal: true,
    interactive: true,
  })
  vi.mocked(showToast).mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

it('本会话没有服务时，入口整个不渲染', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([])
  mount()
  await flush()
  expect(document.querySelector('.service-entry')).toBeNull()
})

it('徽标 = 运行中数量；默认停在「运行中」，两页条数挂在页签上', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([
    svc({ id: 'svc_1', name: 'dev-a' }),
    svc({ id: 'svc_2', name: 'dev-b', status: 'exited', returnCode: 0, uptime: '20s' }),
    svc({ id: 'svc_3', name: 'dev-c', pid: 99, status: 'exited', killed: true }),
  ])
  mount()
  await flush()

  // 徽标只数运行中的：3 条里只有 svc_1 在跑
  expect(document.querySelector('.service-badge')?.textContent).toBe('1')

  click('.service-entry-btn')
  expect(texts('.service-tab')).toEqual(['运行中1', '已结束2'])
  expect(document.querySelector('.service-tab.active')?.textContent).toContain('运行中')

  // 运行中页：只有 svc_1 一行，带终止按钮与运行时长
  expect(texts('.service-row-name')).toEqual(['dev-a'])
  expect(document.querySelector('.service-kill-btn')).not.toBeNull()
  expect(document.querySelector('.service-row-meta')?.textContent).toContain('已运行 1m10s')
})

it('「已结束」页：没有终止按钮，如实显示退出码 / 被终止', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([
    svc({ id: 'svc_1', name: 'dev-a' }),
    svc({ id: 'svc_2', name: 'dev-b', status: 'exited', returnCode: 0, uptime: '20s' }),
    svc({ id: 'svc_3', name: 'dev-c', pid: 99, status: 'exited', killed: true }),
  ])
  mount()
  await flush()
  click('.service-entry-btn')
  click('.service-tab:nth-child(2)')

  expect(texts('.service-row-name')).toEqual(['dev-b', 'dev-c'])
  // 幂等语义留给 AI 的 kill 工具：已结束的行不给按钮
  expect(document.querySelector('.service-kill-btn')).toBeNull()
  const metas = texts('.service-row-meta')
  expect(metas[0]).toContain('退出码 0')
  expect(document.querySelectorAll('.service-status.is-killed').length).toBe(1)
  // 已结束的条目为什么还在表里 —— 面板要说清楚
  expect(document.querySelector('.service-foot')?.textContent).toContain(
    '已结束的服务仍可被 AI 读取输出',
  )
})

it('终止：直接调 Rust（无二次确认），杀完立刻对账 —— 行落到「已结束」、徽标归零', async () => {
  const dead = svc({ status: 'exited', killed: true, uptime: '3s' })
  vi.mocked(listBackgroundServices)
    .mockResolvedValueOnce([svc({})])
    .mockResolvedValue([dead])
  vi.mocked(killBackgroundService).mockResolvedValue(dead)

  mount()
  await flush()
  click('.service-entry-btn')
  click('.service-kill-btn')
  await flush()

  expect(killBackgroundService).toHaveBeenCalledWith('s1', 'svc_1')
  expect(showToast).toHaveBeenCalledWith('已终止 dev')
  // 运行中归零 → 徽标消失；当前页就地变成空态（不把用户甩到另一页）
  expect(document.querySelector('.service-badge')).toBeNull()
  expect(document.querySelector('.service-tab.active')?.textContent).toContain('运行中')
  expect(document.querySelector('.service-panel-empty')?.textContent).toContain(
    '暂无运行中的后台服务',
  )
  expect(texts('.service-tab')).toEqual(['运行中0', '已结束1'])
})

it('终止时服务已不在表里（AI 抢先 kill 掉了）→ 如实提示，不谎报成功', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([svc({})])
  vi.mocked(killBackgroundService).mockResolvedValue(null)

  mount()
  await flush()
  click('.service-entry-btn')
  click('.service-kill-btn')
  await flush()

  expect(showToast).toHaveBeenCalledWith('该服务已不在列表中')
})

it('点行打开终端弹窗；行内「终止」按钮不会顺手把弹窗也打开', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([svc({})])
  vi.mocked(killBackgroundService).mockResolvedValue(
    svc({ status: 'exited', killed: true, uptime: '3s' }),
  )

  mount()
  await flush()
  click('.service-entry-btn')
  click('.service-row')
  await flush()

  // 弹窗挂到 body 上（createPortal），并从偏移 0 开始拉服务的控制台输出
  expect(document.querySelector('.service-console-panel')).not.toBeNull()
  expect(readServiceConsole).toHaveBeenCalledWith('s1', 'svc_1', 0)
  // 打开弹窗时浮层顺手收起来（不然它挡在弹窗后面）
  expect(document.querySelector('.service-popover')).toBeNull()

  act(() => {
    ;(document.querySelector('.service-console-close') as HTMLButtonElement).click()
  })
  expect(document.querySelector('.service-console-panel')).toBeNull()

  // 行内终止：只有 kill，不打开弹窗
  click('.service-entry-btn')
  click('.service-kill-btn')
  await flush()
  expect(killBackgroundService).toHaveBeenCalledWith('s1', 'svc_1')
  expect(document.querySelector('.service-console-panel')).toBeNull()
})

// ==================== 新对话页的全局视图（P4） ====================

it('全局视图：跨会话列出 + 每行标归属 + 终止用行自己的会话 id', async () => {
  vi.mocked(listAllBackgroundServices).mockResolvedValue([
    svc({ id: 'svc_9', name: 'other-dev', sessionId: 's2' }),
  ])
  vi.mocked(killBackgroundService).mockResolvedValue(
    svc({
      id: 'svc_9',
      name: 'other-dev',
      sessionId: 's2',
      status: 'exited',
      killed: true,
      uptime: '3s',
    }),
  )

  mount(null)
  await flush()

  // 全局查询走另一条命令；本会话那条一次都不能碰（新对话页根本没有「当前会话」）
  expect(listAllBackgroundServices).toHaveBeenCalled()
  expect(listBackgroundServices).not.toHaveBeenCalled()
  expect(document.querySelector('.service-badge')?.textContent).toBe('1')

  click('.service-entry-btn')
  expect(document.querySelector('.service-scope')?.textContent?.trim()).toBe(
    '全部会话',
  )
  // 归属：测试环境的 sessionStore 里没有 s2（取不到标题）→ 退回 id，仍说清了「这条是谁的」
  expect(
    document.querySelector('.service-row-session')?.textContent?.trim(),
  ).toBe('会话：s2')

  click('.service-kill-btn')
  await flush()
  expect(killBackgroundService).toHaveBeenCalledWith('s2', 'svc_9')
  expect(showToast).toHaveBeenCalledWith('已终止 other-dev')
})

it('全局视图：终端弹窗用行所属会话的 id 轮询，弹窗里也标归属', async () => {
  vi.mocked(listAllBackgroundServices).mockResolvedValue([
    svc({ id: 'svc_9', name: 'other-dev', sessionId: 's2' }),
  ])
  mount(null)
  await flush()
  click('.service-entry-btn')
  click('.service-row')
  await flush()

  expect(readServiceConsole).toHaveBeenCalledWith('s2', 'svc_9', 0)
  expect(
    document.querySelector('.service-console-session')?.textContent?.trim(),
  ).toBe('会话：s2')
})

it('全局视图：任何会话都没有服务时，入口整个不渲染', async () => {
  vi.mocked(listAllBackgroundServices).mockResolvedValue([])
  mount(null)
  await flush()
  expect(document.querySelector('.service-entry')).toBeNull()
})
