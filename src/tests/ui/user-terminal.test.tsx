/**
 * UserTerminal — 用户自己的交互终端（右侧面板里的一个标签）。
 *
 * 五条被钉住的：
 * 1. **默认脱壳但不挂徽标**：用户终端本来就不进沙盒，「沙盒已关闭」常驻就是噪声（2026-10-24 去掉了）；
 * 2. **增量续接**：每帧只把新增部分交给 xterm，`reset` 那帧整段重放；
 * 3. **输入跟着运行状态走**：跑着才把键击送出去，结束后敲键盘必须静默无效；
 * 4. **结束后如实报退出码**（`exitCode` 为 null 时不编一个）；
 * 5. **终端被外面关掉**（读回 null）→ 提示一句并停止轮询（保留最后一屏）。
 *
 * xterm 在 jsdom 里没有画布（`term.open()` 没有意义），用与 `service-terminal.test.tsx`
 * 同一份最小替身；数据层（ConPTY / 注册表 / 会话隔离）由
 * `cargo test -p virlen-core user_shell` 守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as xtermModule from '@xterm/xterm'

import UserTerminal from '@/ui/pages/chat/components/terminal/UserTerminal'
import {
  readUserTerminal,
  resizeUserTerminal,
  writeUserTerminal,
  type UserTerminalChunk,
} from '@/infrastructure/terminal'
import * as terminalModule from '@/infrastructure/terminal'

vi.mock('@/infrastructure/terminal', () => {
  const handlers: Array<(frame: any) => void> = []
  return {
    startUserTerminal: vi.fn(),
    // 终端类型列表：这个用例集不起终端，但模块形状要跟真实的一致
    listUserTerminalShells: vi.fn(async () => []),
    readUserTerminal: vi.fn(),
    writeUserTerminal: vi.fn(),
    resizeUserTerminal: vi.fn(),
    killUserTerminal: vi.fn(),
    onUserTerminalOutput: vi.fn(async (handler: (frame: any) => void) => {
      handlers.push(handler)
      return () => {}
    }),
    /** 模拟 Rust 侧推一帧（`terminal:output`） */
    __emitOutput(frame: any) {
      handlers.forEach((h) => h(frame))
    },
    __clearHandlers() {
      handlers.length = 0
    },
  }
})

vi.mock('@xterm/xterm', () => {
  const instances: any[] = []
  let dataHandlers: Array<(d: string) => void> = []
  return {
    Terminal: class {
      cols = 80
      rows = 24
      buffer = { active: { baseY: 0, viewportY: 0 } }
      options: any
      write = vi.fn()
      reset = vi.fn()
      dispose = vi.fn()
      focus = vi.fn()
      constructor(options?: any) {
        this.options = { fontSize: 13, ...(options ?? {}) }
        instances.push(this)
      }
      loadAddon() {}
      open() {}
      onData(cb: (d: string) => void) {
        dataHandlers.push(cb)
        return { dispose() {} }
      }
      attachCustomKeyEventHandler() {}
      hasSelection() {
        return false
      }
      getSelection() {
        return ''
      }
      clearSelection() {}
      selectAll() {}
      paste() {}
    },
    __instances: instances,
    /** 模拟用户敲键盘（xterm 把键击交给 `onData` 回调） */
    __type(data: string) {
      dataHandlers.forEach((cb) => cb(data))
    },
    __clear() {
      instances.length = 0
      dataHandlers = []
    },
  }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const xterm = xtermModule as any
/** 推送侧的替身（`__emitOutput` 模拟 Rust 发来的一帧） */
const terminal = terminalModule as any

/** 推一帧（缺省字段给合理值） */
function push(over: Record<string, unknown>) {
  act(() =>
    terminal.__emitOutput({
      sessionId: 's1',
      id: 'term_3',
      from: 0,
      next: 0,
      text: '',
      reset: false,
      running: true,
      ...over,
    }),
  )
}

/** 一帧读取应答（只写关心的字段，其余给合理默认） */
function chunk(over: Partial<UserTerminalChunk>): UserTerminalChunk {
  return {
    text: '',
    reset: false,
    next: 0,
    headDropped: false,
    running: true,
    interactive: true,
    exitCode: null,
    killed: false,
    ...over,
  }
}

let root: ReturnType<typeof createRoot> | null = null
let onClose: ReturnType<typeof vi.fn<() => void>>

function mount(over: { active?: boolean } = {}) {
  onClose = vi.fn<() => void>()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <UserTerminal
        sessionId="s1"
        termId="term_3"
        shell="powershell"
        active={over.active ?? true}
        onClose={onClose}
      />,
    ),
  )
}

/** 等轮询的第一次 tick（`setTimeout(0)`）跑完 + 一次 setState 落地 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? ''
}

function written(): string {
  return xterm.__instances
    .flatMap((t: any) => t.write.mock.calls.map((c: any[]) => String(c[0])))
    .join('')
}

beforeEach(() => {
  // jsdom 没有布局：给元素固定的伪尺寸，让尺寸上报那条路径真的走一遍
  for (const [prop, value] of [
    ['clientWidth', 800],
    ['clientHeight', 400],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => value,
    })
  }
  document.body.innerHTML = ''
  vi.mocked(readUserTerminal).mockReset()
  vi.mocked(writeUserTerminal).mockReset()
  vi.mocked(resizeUserTerminal).mockReset()
  vi.mocked(writeUserTerminal).mockResolvedValue(true)
  vi.mocked(resizeUserTerminal).mockResolvedValue(true)
  xterm.__clear()
  terminal.__clearHandlers()
})

afterEach(() => {
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).clientHeight
  if (root) act(() => root!.unmount())
  root = null
})

it('运行中：头部只留名字与状态，增量续接，键击直达伪控制台', async () => {
  vi.mocked(readUserTerminal)
    .mockResolvedValueOnce(chunk({ text: 'PS E:\\repo> ', next: 12 }))
    .mockResolvedValue(chunk({ text: 'done\n', next: 17 }))

  mount()
  await flush()
  expect(readUserTerminal).toHaveBeenCalledWith('s1', 'term_3', 0)
  expect(written()).toBe('PS E:\\repo> ')

  // 头部不挂「沙盒已关闭」徽标：用户终端永远不进沙盒，常驻一枚红标只是噪声
  // （与 `SandboxBadge` 只画「在沙盒里」同一口径）
  // 头部显示**展示名**（`powershell` id → Windows PowerShell）：不同 shell 一眼能分清
  expect(text('.service-console-name')).toBe('Windows PowerShell')
  expect(document.querySelector('.terminal-sandbox-badge')).toBeNull()
  // 不再有元信息那一行（工作目录 / 进程 pid）：它只是白白吃持终端高度，
  // 工作目录已经在标签 tooltip 上 —— 这一条是用户明确要求的
  expect(document.querySelector('.service-console-meta')).toBeNull()

  // 第二帧只接增量（整段重写会让终端每帧闪一次）。实时增量走推送，轮询只负责状态 ——
  // 所以这里等一个慢轮询周期（SAFETY_MS = 1000）
  await wait(1100)
  expect(written()).toBe('PS E:\\repo> done\n')
  expect(readUserTerminal).toHaveBeenLastCalledWith('s1', 'term_3', 12)

  act(() => xterm.__type('g'))
  expect(writeUserTerminal).toHaveBeenCalledWith('s1', 'term_3', 'g')
})

it('已结束：键击不再送出，退出码如实显示（null 时不编）', async () => {
  vi.mocked(readUserTerminal).mockResolvedValue(
    chunk({ text: 'bye\n', next: 4, running: false, interactive: false, exitCode: 2 }),
  )

  mount()
  await flush()
  act(() => xterm.__type('x'))
  expect(writeUserTerminal).not.toHaveBeenCalled()
  expect(text('.service-console-foot')).toContain('退出码 2')
  expect(text('.service-console-foot')).toContain('只能查看输出')
})

it('终止退出（没有退出码）：只说「已结束」，不编一个 0', async () => {
  vi.mocked(readUserTerminal).mockResolvedValue(
    chunk({ running: false, interactive: false, exitCode: null, killed: true }),
  )

  mount()
  await flush()
  const foot = text('.service-console-foot')
  expect(foot).toContain('终端已结束，只能查看输出')
  expect(foot).not.toContain('退出码')
})

it('终端被外面关掉（读回 null）：提示一句并停止请求，保留最后一屏', async () => {
  vi.mocked(readUserTerminal)
    .mockResolvedValueOnce(chunk({ text: 'last screen\n', next: 12 }))
    .mockResolvedValue(null)

  mount()
  await flush()
  // 第二个请求来自慢轮询（1s）—— 推送只会在有新输出 / 终态时来
  await wait(1100)
  expect(text('.service-console-foot')).toContain('该终端已不在列表中')
  expect(written()).toBe('last screen\n')

  const calls = vi.mocked(readUserTerminal).mock.calls.length
  await wait(2200)
  expect(vi.mocked(readUserTerminal).mock.calls.length).toBe(calls)
})

it('推送帧（from 与游标严丝合缝）直接追加：键入回显不必等轮询', async () => {
  vi.mocked(readUserTerminal).mockResolvedValue(chunk({}))

  mount()
  await flush()
  expect(readUserTerminal).toHaveBeenCalledTimes(1)

  // 不等任何定时器：推一帧就到 xterm
  push({ from: 0, next: 5, text: 'hello' })
  expect(written()).toBe('hello')
  // 再来一帧：按偏移续接（只追加）
  push({ from: 5, next: 6, text: '!' })
  expect(written()).toBe('hello!')
  // 整个过程没有再发读请求（慢轮询还没到点）
  expect(readUserTerminal).toHaveBeenCalledTimes(1)
})

it('推送断档（from 对不上）：按当前游标补读，不按字符下标切串', async () => {
  vi.mocked(readUserTerminal)
    .mockResolvedValueOnce(chunk({ text: 'AB', next: 2 }))
    .mockResolvedValueOnce(chunk({ text: 'CD', next: 4 }))
    .mockResolvedValue(chunk({ next: 4 }))

  mount()
  await flush()
  expect(written()).toBe('AB')

  // 事件从 3 开始（本地只有 2 个字符）：中间缺了一截 → 回头读，而不是猜着切字符串
  push({ from: 3, next: 6, text: '?CD?' })
  await flush()
  expect(readUserTerminal).toHaveBeenLastCalledWith('s1', 'term_3', 2)
  expect(written()).toBe('ABCD')
})

it('重复投递（next 不超过本地游标）：直接忽略，不重复写、不补读', async () => {
  vi.mocked(readUserTerminal).mockResolvedValue(chunk({ text: 'AB', next: 2 }))

  mount()
  await flush()
  const calls = vi.mocked(readUserTerminal).mock.calls.length

  push({ from: 0, next: 2, text: 'AB' })
  await flush()
  expect(written()).toBe('AB')
  expect(vi.mocked(readUserTerminal).mock.calls.length).toBe(calls)
})

it('推送里 running=false 立刻禁掉输入：退出那一帧不必等轮询', async () => {
  vi.mocked(readUserTerminal)
    .mockResolvedValueOnce(chunk({})) // 首帧：还在跑
    .mockResolvedValue(chunk({ running: false, interactive: false, exitCode: 0 }))

  mount()
  await flush()
  act(() => xterm.__type('a'))
  expect(writeUserTerminal).toHaveBeenCalledTimes(1)

  push({ from: 0, next: 0, running: false })
  await flush() // 退出帧会顺手补一次读（拿退出码），让它落地
  act(() => xterm.__type('b'))
  expect(writeUserTerminal).toHaveBeenCalledTimes(1)
  // 退出码也跟着立刻到手，不必等 1s 的慢轮询
  expect(text('.service-console-foot')).toContain('退出码 0')
})

it('标签切走（active=false）不发任何请求，但推送仍然落屏', async () => {
  vi.mocked(readUserTerminal).mockResolvedValue(chunk({ text: 'init', next: 4 }))

  mount({ active: false })
  await wait(1200)
  expect(readUserTerminal).not.toHaveBeenCalled()

  // 切走了也在收推送：切回来不必整屏追一次（偏移与累积串一直准着）
  push({ from: 0, next: 8, text: 'initPUSH' })
  expect(written()).toBe('initPUSH')
})

it('进程一结束就关掉标签（与服务终端「终止但留条目」相反）', async () => {
  vi.mocked(readUserTerminal)
    .mockResolvedValueOnce(chunk({})) // 首帧：还在跑
    .mockResolvedValue(chunk({ running: false, interactive: false, exitCode: 0 }))

  mount()
  await flush()
  // 跑着的时候不能提前关（否则开一个终端就没了）
  expect(onClose).not.toHaveBeenCalled()

  // 用户敲了 exit：推送那一帧就够关标签，不必等慢轮询
  push({ from: 0, next: 0, running: false })
  await flush()
  expect(onClose).toHaveBeenCalledTimes(1)

  // 只关一次：后续的帧 / 轮询不再重复上报（宿主会重复 kill + 关标签）
  await wait(1100)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('头部那颗 ✕ 走宿主给的 onClose（关终端由宿主负责杀进程树）', async () => {
  vi.mocked(readUserTerminal).mockResolvedValue(chunk({}))
  mount()
  await flush()

  act(() => {
    document.querySelector<HTMLButtonElement>('.service-console-close')!.click()
  })
  expect(onClose).toHaveBeenCalledTimes(1)
})
