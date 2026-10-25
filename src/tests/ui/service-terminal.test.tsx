/**
 * ServiceTerminal — 后台服务的终端**面板**（右侧面板里的一个标签）
 *
 * 覆盖这些容易出错的地方：
 * 1. **输入开关**：只有 `interactive`（跑在伪控制台里 + 仍在运行）才把键击送出去 ——
 *    已结束 / 管道模式下敲键盘必须静默无效；
 * 2. **提示文案**：不能输入时要说清是「服务已结束」还是「管道模式」，并如实提示输出被截断；
 * 3. **尺寸上报**：首帧（控制台状态还没回来）也必须把尺寸问出去 ——「还不知道」不等于「不能输入」；
 *    状态明确为「不能输入」后即停止上报（不能白刷 IPC，也不能让伪控制台停在默认尺寸）。
 *
 * 增量续接 / `reset` 整段重放 / 切走停轮询那四条要真实 sleep 400~600ms，已随全量测试提速删除；
 * 取回见 `git log -- src/tests/ui/service-terminal.test.tsx`。
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
  killBackgroundService,
  listBackgroundServices,
  readServiceConsole,
  resizeServiceConsole,
  writeServiceConsole,
  type BackgroundServiceInfo,
  type ServiceConsoleChunk,
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

/** 挂一次面板；返回重渲染（改 `active` 用，同一个根不会重建终端实例） */
function mount(over: { active?: boolean; sessionLabel?: string } = {}) {
  onClose = vi.fn<() => void>()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (next: { active?: boolean } = {}) =>
    act(() =>
      root!.render(
        <ServiceTerminal
          sessionId="s1"
          serviceId="svc_1"
          name="dev"
          sessionLabel={over.sessionLabel}
          active={next.active ?? over.active ?? true}
          onClose={onClose}
        />,
      ),
    )
  render()
  return render
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
  vi.mocked(listBackgroundServices).mockReset()
  vi.mocked(listBackgroundServices).mockResolvedValue([svc()])
  vi.mocked(killBackgroundService).mockReset()
  vi.mocked(readServiceConsole).mockReset()
  vi.mocked(writeServiceConsole).mockReset()
  vi.mocked(resizeServiceConsole).mockReset()
  vi.mocked(writeServiceConsole).mockResolvedValue(true)
  vi.mocked(resizeServiceConsole).mockResolvedValue(true)
  vi.mocked(showToast).mockClear()
  xterm.__clear()
})

afterEach(() => {
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).clientHeight
  if (root) act(() => root!.unmount())
  root = null
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

it('已结束：只读回放（提示 + 键击不送出去 + 没有终止按钮）', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([
    svc({ status: 'exited', killed: true, returnCode: 1 }),
  ])
  vi.mocked(readServiceConsole).mockResolvedValue(
    chunk({ text: 'exited\n', next: 7, running: false, interactive: false }),
  )

  mount()
  await flush()

  expect(written()).toBe('exited\n')
  expect(text('.service-console-foot')).toContain('服务已结束，只能查看输出')
  expect(document.querySelector('.service-console-kill')).toBeNull()
  // 已退出的终端不再闪光标（光标判定挂在终端主体 wrapper 上，`XtermTerminal.scss` 据此中和光标）
  expect(
    document.querySelector('.pty-terminal-body-wrapper')!.className,
  ).toContain('is-finished')

  act(() => xterm.__type('x'))
  expect(writeServiceConsole).not.toHaveBeenCalled()
})

it('管道模式（没有伪控制台）：如实说明不能输入', async () => {
  vi.mocked(listBackgroundServices).mockResolvedValue([
    svc({ terminal: false, interactive: false }),
  ])
  vi.mocked(readServiceConsole).mockResolvedValue(
    chunk({ terminal: false, interactive: false }),
  )

  mount()
  await flush()
  expect(text('.service-console-foot')).toContain('当前平台不支持交互输入，只能查看输出')
})

/** 头部：身份在左（名字 + 沙盒），状态徽标与两个动作按钮靠右；✕ = 关标签 */
it('头部：状态在名字右边，右端依次是 状态 / 终止 / ✕；✕ 上报关闭', async () => {
  vi.mocked(readServiceConsole).mockResolvedValue(chunk({}))
  mount()
  await flush()

  const head = document.querySelector('.service-console-head')!
  const name = head.querySelector('.service-console-name')!
  const status = head.querySelector('.service-status')!
  // 状态在名字**右边**（左侧只留身份，状态与动作同属右端那一组）
  expect(
    name.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()

  const classes = Array.from(head.children).map((el) => el.className)
  expect(classes.slice(-3)).toEqual([
    'service-status is-on-dark is-running',
    'service-console-kill',
    'service-console-close',
  ])

  act(() => {
    ;(head.querySelector('.service-console-close') as HTMLButtonElement).click()
  })
  expect(onClose).toHaveBeenCalledTimes(1)
})

/** 头部「终止」：与面板行内那颗按钮同一套动作（直接杀 + toast + 就地刷新） */
it('头部的终止：打到标签自己的会话，并立刻对账成已结束', async () => {
  const dead = svc({ status: 'exited', killed: true, returnCode: 1 })
  vi.mocked(listBackgroundServices)
    .mockResolvedValueOnce([svc()])
    .mockResolvedValue([dead])
  vi.mocked(killBackgroundService).mockResolvedValue(dead)
  vi.mocked(readServiceConsole).mockResolvedValue(chunk({}))

  mount({ sessionLabel: '会话标题' })
  await flush()
  expect(text('.service-console-session')).toBe('对话：会话标题')

  act(() => {
    ;(document.querySelector('.service-console-kill') as HTMLButtonElement).click()
  })
  await flush()

  expect(killBackgroundService).toHaveBeenCalledWith('s1', 'svc_1')
  expect(showToast).toHaveBeenCalledWith('已终止 dev')
  // 刷新之后已经没有运行中的服务 → 头部的终止按钮消失
  expect(document.querySelector('.service-console-kill')).toBeNull()
})
