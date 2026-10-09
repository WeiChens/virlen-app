/**
 * ServiceTerminal — 后台服务的终端弹窗（P3）
 *
 * 覆盖这些容易出错的地方：
 * 1. **增量续接**：每帧只把新增部分交给 xterm（不是整段重写）—— 写错就是每 350ms 让终端闪一次；
 * 2. **`reset` 整段重放**：环形窗口丢掉客户端持有的开头后，必须清屏重放，否则 ANSI 流会从半截接起；
 * 3. **输入开关**：只有 `interactive`（跑在伪控制台里 + 仍在运行）才把键击送出去 ——
 *    已结束 / 管道模式下敲键盘必须静默无效；
 * 4. **提示文案**：不能输入时要说清是「服务已结束」还是「管道模式」，并如实提示输出被截断；
 * 5. **关停**：Esc / ✕ 关闭；服务被摘出注册表（读回 null）后停止轮询并提示；
 * 6. **尺寸上报**：首帧（控制台状态还没回来）也必须把尺寸问出去 ——「还不知道」不等于「不能输入」；
 *    状态明确为「不能输入」后即停止上报（不能白刷 IPC，也不能让伪控制台停在默认尺寸）。
 *
 * xterm 在 jsdom 里没有量度 / 画布（`term.open()` 没有意义），用最小替身：
 * 记录 `write` / `reset` 调用、捕获 `onData` 回调供用例「敲键盘」。
 * 数据层（Rust 注册表 / 命令 / 会话隔离 / 控制台关停）由
 * `cargo test -p virlen-core native_tools::service` 守；这里只验界面行为。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as xtermModule from '@xterm/xterm'

import ServiceTerminal from '@/ui/pages/chat/components/service/ServiceTerminal'
import {
  readServiceConsole,
  resizeServiceConsole,
  writeServiceConsole,
  type BackgroundServiceInfo,
  type ServiceConsoleChunk,
} from '@/infrastructure/backgroundService'

vi.mock('@/infrastructure/backgroundService', () => ({
  listBackgroundServices: vi.fn(),
  killBackgroundService: vi.fn(),
  readServiceConsole: vi.fn(),
  writeServiceConsole: vi.fn(),
  resizeServiceConsole: vi.fn(),
}))

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

/** 一帧控制台应答（只写关心的字段，其余给合理默认） */
function chunk(over: Partial<ServiceConsoleChunk>): ServiceConsoleChunk {
  return {
    text: '',
    reset: false,
    next: 0,
    headDropped: false,
    running: true,
    terminal: true,
    interactive: true,
    ...over,
  }
}

function svc(over: Partial<BackgroundServiceInfo> = {}): BackgroundServiceInfo {
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
let onClose: ReturnType<typeof vi.fn<() => void>>
let onKill: ReturnType<typeof vi.fn<(service: BackgroundServiceInfo) => void>>

function mount(service: BackgroundServiceInfo | undefined = svc()) {
  onClose = vi.fn<() => void>()
  onKill = vi.fn<(service: BackgroundServiceInfo) => void>()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ServiceTerminal
        sessionId="s1"
        serviceId="svc_1"
        service={service}
        killing={false}
        onKill={onKill}
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

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? ''
}

/** 终端替身收到的所有写入（拼起来 = 屏幕上该有的内容） */
function written(): string {
  return xterm.__instances
    .flatMap((t: any) => t.write.mock.calls.map((c: any[]) => String(c[0])))
    .join('')
}

beforeEach(() => {
  // jsdom 没有布局：`clientWidth / clientHeight` 恒为 0，而 `XtermTerminal::syncSize` 对未布局的容器
  // 直接返回（不上报尺寸）→ 「首帧也要上报尺寸」这条根本走不到。给元素一个固定的伪尺寸（只影响本文件）。
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
  vi.mocked(readServiceConsole).mockReset()
  vi.mocked(writeServiceConsole).mockReset()
  vi.mocked(resizeServiceConsole).mockReset()
  vi.mocked(writeServiceConsole).mockResolvedValue(true)
  vi.mocked(resizeServiceConsole).mockResolvedValue(true)
  xterm.__clear()
})

afterEach(() => {
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).clientHeight
  if (root) act(() => root!.unmount())
  root = null
})

it('运行中：首帧整段写入，下一帧只接增量；键击直达服务的伪控制台', async () => {
  vi.mocked(readServiceConsole)
    .mockResolvedValueOnce(chunk({ text: 'booting\n', next: 8 }))
    .mockResolvedValue(chunk({ text: 'ready on 3000\n', next: 22 }))

  mount()
  await flush()
  expect(readServiceConsole).toHaveBeenCalledWith('s1', 'svc_1', 0)
  expect(written()).toBe('booting\n')

  // 第二帧：只把新增那段交给 xterm（整段重写会让终端每帧闪一次）
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400))
  })
  expect(written()).toBe('booting\nready on 3000\n')
  expect(readServiceConsole).toHaveBeenLastCalledWith('s1', 'svc_1', 8)

  // 键击：xterm 的 onData → transport.write → 服务的控制台命令
  act(() => xterm.__type('y'))
  expect(writeServiceConsole).toHaveBeenCalledWith('s1', 'svc_1', 'y')
  // 头部：状态徽标 / 名称 / 命令行 / 元信息
  expect(text('.service-console-name')).toBe('dev')
  expect(text('.service-console-cmd')).toBe('$ npm run dev')
  expect(text('.service-console-meta')).toContain('服务 ID：svc_1')
})

it('首帧（控制台状态还没回来）也要把尺寸报出去：伪控制台不能停在默认尺寸', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(chunk({}))
  mount()

  // 终端实例创建（useLayoutEffect）发生在第一次轮询应答**之前**（那时 `info === null`）。
  // 「还不知道能不能输入」不等于「不能输入」：必须把尺寸问出去 —— 否则这次上报会被后续的
  // 「尺寸没变不重复上报」+「上报成功就不重试」两道保护彻底吃掉，服务的伪控制台就一直停在
  // 创建时的默认 240×50（折行位置与用户看到的终端不一致，全屏程序更明显）。
  expect(resizeServiceConsole).toHaveBeenCalledTimes(1)
  expect(resizeServiceConsole).toHaveBeenCalledWith('s1', 'svc_1', 80, 24)

  // 状态到位（运行中）后尺寸没变 → 不重复上报（ResizeObserver 反复回调不该白刷 ConPTY 重绘）
  await flush()
  expect(resizeServiceConsole).toHaveBeenCalledTimes(1)
})

it('管道模式：首帧问一次探测，知道不能输入之后不再上报', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(
    chunk({ terminal: false, interactive: false }),
  )
  mount()
  // 首帧的探测（Rust 真环境下回 false，`XtermTerminal` 会短重试几次后放弃）
  expect(resizeServiceConsole).toHaveBeenCalledTimes(1)

  await flush()
  // 已经知道没有可调的控制台 → 开关收敛，不再重复问
  expect(resizeServiceConsole).toHaveBeenCalledTimes(1)
})

it('reset 帧：清屏后整段重放（环形丢过头时不能半截接 ANSI 流）', async () => {
  vi.mocked(readServiceConsole)
    .mockResolvedValueOnce(chunk({ text: 'old\n', next: 4 }))
    .mockResolvedValue(
      chunk({ text: 'rewritten\n', next: 10, reset: true, headDropped: true }),
    )

  mount()
  await flush()
  const term = xterm.__instances[0]
  expect(written()).toBe('old\n')

  await act(async () => {
    await new Promise((r) => setTimeout(r, 400))
  })
  expect(term.reset).toHaveBeenCalled()
  expect(written()).toBe('old\nrewritten\n')
  // 窗口开头被环形丢弃 → 如实提示「更早的输出已被截断」
  expect(text('.service-console-foot')).toContain('更早的输出已被截断')
})

it('已结束：只读回放（提示 + 键击不送出去 + 没有终止按钮）', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(
    chunk({ text: 'exited\n', next: 7, running: false, interactive: false }),
  )

  mount(svc({ status: 'exited', killed: true, returnCode: 1 }))
  await flush()

  expect(written()).toBe('exited\n')
  expect(text('.service-console-foot')).toContain('服务已结束，只能查看输出')
  expect(document.querySelector('.service-console-kill')).toBeNull()

  act(() => xterm.__type('x'))
  expect(writeServiceConsole).not.toHaveBeenCalled()
})

it('管道模式（没有伪控制台）：如实说明不能输入', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(
    chunk({ terminal: false, interactive: false }),
  )

  mount(svc({ terminal: false, interactive: false }))
  await flush()
  expect(text('.service-console-foot')).toContain('管道模式下，无法输入')
})

it('服务被摘出注册表（读回 null）：提示 + 停止轮询', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(null)

  mount()
  await flush()
  expect(text('.service-console-foot')).toContain('该服务已不在列表中')
  const callsAfterGone = vi.mocked(readServiceConsole).mock.calls.length

  await act(async () => {
    await new Promise((r) => setTimeout(r, 600))
  })
  // 已经不在表里：不再白刷 IPC（重试也是空）
  expect(vi.mocked(readServiceConsole).mock.calls.length).toBe(callsAfterGone)
  expect(onClose).not.toHaveBeenCalled()
})

it('Esc 与 ✕ 都能关闭弹窗', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(chunk({}))
  mount()
  await flush()

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(onClose).toHaveBeenCalledTimes(1)

  act(() => {
    ;(document.querySelector('.service-console-close') as HTMLButtonElement).click()
  })
  expect(onClose).toHaveBeenCalledTimes(2)
})
