/**
 * BackgroundServiceMessage — 后台服务四个工具卡片的**展示层**回归。
 *
 * 这一层最容易出错的四件事：
 * 1. **输出交给 xterm，不预先去色**：`uiData.stdout/stderr` 是原始 VT 流（带 `\r` 覆盖与 ANSI），
 *    卡片必须原样喂给终端；一旦谁又拿 `processTerminalOutput` 处理一遍，颜色与进度条就没了；
 * 2. **stderr 边界**：两个流在后端分开收，交织顺序已丢 —— 回放时用一行亮红标记交代边界；
 * 3. **只读**：卡片是「工具返回那一刻」的回放（`running=false`）—— 不上报尺寸、键击不出去；
 * 4. **动作**：「打开终端」只上报 `{serviceId,name}`（会话 id 归宿主补），
 *    「复制」给的是**纯文本**（能贴进别处），全屏是原位 + portal 两份终端。
 *
 * xterm 在 jsdom 里没有量度 / 画布（`term.open()` 没有意义），用最小替身：
 * 记录 `write` / `reset` 调用，与 `service-terminal.test.tsx` 同一套替身口径。
 * 数据层（Rust 注册表 / 输出窗口 / 会话隔离）由 `cargo test -p virlen-core native_tools::service` 守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as xtermModule from '@xterm/xterm'

import BackgroundServiceMessage from '@/ui/pages/chat/components/tool-call/BackgroundServiceMessage'
import commentEvent from '@/events/commentEvent'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import { invoke } from '@tauri-apps/api/core'
import type { Message, ToolUseContent } from '@/types'

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
vi.mock('@/utils/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => true) }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const xterm = xtermModule as any
const ANSI_READY = '\x1b[32mready\x1b[0m in 300ms\n'
/** stderr 段的分隔标记（亮红 + 按界面语言重建的 [标准错误]） */
const STDERR_MARK = '\x1b[91m[标准错误]\x1b[0m'

let root: ReturnType<typeof createRoot> | null = null

/** 挂一块卡片：直接调 `getExpandView`（与 `ToolCallMessage` 的调用口径一致） */
function mount(
  toolName: string,
  ui: Record<string, any> | undefined,
  opts: {
    input?: Record<string, any>
    expand?: boolean
    toolCallId?: string
  } = {},
) {
  const card = new BackgroundServiceMessage()
  const useContent = {
    type: 'tool_use',
    id: opts.toolCallId ?? 'tc_1',
    name: toolName,
    input: opts.input ?? {},
  } as ToolUseContent
  const node = card.getExpandView({
    useContent,
    message: (ui ? { uiData: ui } : undefined) as unknown as Message,
    expand: opts.expand ?? true,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<>{node}</>))
}

/** 终端替身收到的所有写入（拼起来 = 屏幕上该有的内容） */
function written(): string {
  return xterm.__instances
    .flatMap((t: any) => t.write.mock.calls.map((c: any[]) => String(c[0])))
    .join('')
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? ''
}

/** 一个已结束 / 运行中的服务（字段与 Rust `service/common.rs::base_ui` 对齐） */
function serviceUi(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'svc_1',
    name: 'dev',
    cmd: 'npm run dev',
    status: 'running',
    returnCode: null,
    killed: false,
    pid: 1234,
    startedAt: 1_700_000_000_000,
    uptimeMs: 70_000,
    uptime: '1m10s',
    sandbox: 'write_isolation',
    terminal: true,
    interactive: true,
    stdout: '',
    stderr: '',
    truncated: false,
    ...over,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(copyText).mockReset()
  vi.mocked(copyText).mockResolvedValue(true)
  vi.mocked(showToast).mockClear()
  vi.mocked(invoke).mockClear()
  xterm.__clear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

it('运行中的服务：状态 / 名称 / 命令 / 元信息齐全，输出原样交给终端（不去色）', () => {
  mount(
    'start_background_service',
    serviceUi({ stdout: ANSI_READY }),
    { input: { name: 'dev', cmd: 'npm run dev' } },
  )

  const titlebar = text('.xterm-titlebar')
  expect(titlebar).toContain('运行中')
  expect(titlebar).toContain('dev')
  // 深色终端 chrome 上的徽标变体（浅色那套描边会发白）
  expect(document.querySelector('.service-status')!.className).toContain(
    'is-on-dark',
  )
  expect(text('.pty-cmd-line')).toContain('npm run dev')
  const meta = text('.pty-meta-line')
  expect(meta).toContain('服务 ID：svc_1')
  expect(meta).toContain('进程 1234')
  expect(meta).toContain('已运行 1m10s')
  // 原始流：ANSI 一个字都不许提前剥掉 —— 剥了 xterm 就没颜色可画
  expect(written()).toBe(ANSI_READY)
  // 只读回放：非运行态不显示光标（与命令终端同一个判定，挂在终端主体 wrapper 上）
  expect(
    document.querySelector('.pty-terminal-body-wrapper')!.className,
  ).toContain('is-finished')
  // 已结束 / 回放态不再问伪控制台尺寸（问了也只会拿到 false + 8 次重试）
  expect(invoke).not.toHaveBeenCalled()
})

it('stderr 段用一行亮红标记交代边界，两个流都原样回放', () => {
  mount(
    'get_background_service',
    serviceUi({
      status: 'exited',
      killed: false,
      returnCode: 1,
      stdout: 'out line\n',
      stderr: 'boom\n',
    }),
    { input: { id: 'svc_1' } },
  )

  const stream = written()
  expect(stream).toBe(`out line\n${STDERR_MARK}\r\nboom\n`)
  // 退出码进元信息行（与终端里的退出码分开看：一个说「怎么死的」，一个说「死了」）
  expect(text('.pty-meta-line')).toContain('退出码 1')
})

it('没有任何输出：「暂无输出」+ 终端零写入（别把纯黑屏当成渲染坏了）', () => {
  mount('get_background_service', serviceUi({ stdout: '', stderr: '' }), {
    input: { id: 'svc_1' },
  })
  expect(text('.pty-hint')).toContain('暂无输出')
  expect(written()).toBe('')
})

it('「打开终端」只上报 serviceId + name（会话 id 由宿主按当前会话补）', () => {
  const received: Array<{ serviceId: string; name: string }> = []
  const off = commentEvent.on('openServiceTerminal', (input) =>
    received.push(input),
  )
  mount('start_background_service', serviceUi(), { input: {} })

  const open = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.terminal-header-actions button'),
  ).find((b) => b.textContent?.includes('打开终端'))!
  act(() => open.click())

  expect(received).toEqual([{ serviceId: 'svc_1', name: 'dev' }])
  off()
})

it('「复制」给的是纯文本（去掉 ANSI 与 \\r 覆盖），失败才提示', async () => {
  mount(
    'start_background_service',
    serviceUi({ stdout: `${ANSI_READY}progress 10%\rprogress 90%\n` }),
    { input: {} },
  )

  const copy = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.terminal-header-actions button'),
  ).find((b) => b.textContent?.includes('复制'))!
  await act(async () => copy.click())

  // 终端里看得见什么，剪贴板就是什么：颜色码不进正文，\r 覆盖只留最后一次
  // （`processTerminalOutput` 会移除尾部空行 —— 末尾没有换行才正常）
  expect(vi.mocked(copyText).mock.calls[0][0]).toBe(
    'ready in 300ms\nprogress 90%',
  )
  expect(showToast).not.toHaveBeenCalled()

  vi.mocked(copyText).mockResolvedValue(false)
  await act(async () => copy.click())
  expect(showToast).toHaveBeenCalledWith('复制失败')
})

it('全屏：原位 + portal 两份终端，Esc 退出后回到一份', () => {
  mount('start_background_service', serviceUi({ stdout: ANSI_READY }), {
    input: {},
  })
  expect(document.querySelectorAll('.pty-terminal-body')).toHaveLength(1)

  act(() => {
    document.querySelector<HTMLButtonElement>('.terminal-fullscreen-btn')!.click()
  })
  expect(document.querySelector('.terminal-fullscreen-layer')).not.toBeNull()
  expect(document.querySelectorAll('.pty-terminal-body')).toHaveLength(2)

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(document.querySelector('.terminal-fullscreen-layer')).toBeNull()
  expect(document.querySelectorAll('.pty-terminal-body')).toHaveLength(1)
})

it('list：一行一个服务（已结束的给退出码），每行都能打开自己的终端', () => {
  const received: Array<{ serviceId: string; name: string }> = []
  const off = commentEvent.on('openServiceTerminal', (input) =>
    received.push(input),
  )
  mount('list_background_services', {
    mode: 'list',
    services: [
      serviceUi({ id: 'svc_1', name: 'dev' }),
      serviceUi({
        id: 'svc_2',
        name: 'build',
        status: 'exited',
        killed: true,
        returnCode: 0,
      }),
    ],
  })

  const rows = document.querySelectorAll('.service-list-row')
  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('运行中')
  expect(rows[1].textContent).toContain('已终止')
  expect(rows[1].textContent).toContain('退出码 0')

  act(() =>
    (rows[1].querySelector('.service-list-open') as HTMLButtonElement).click(),
  )
  expect(received).toEqual([{ serviceId: 'svc_2', name: 'build' }])
  off()

  // 一个服务都没有：说清「本对话」而不是画一张空表
  act(() => root!.unmount())
  root = null
  mount('list_background_services', { mode: 'list', services: [] })
  expect(text('.service-empty')).toBe('本对话暂无后台服务')
})

it('spawn 就失败（没有 id / 没有输出）：如实报错，不硬套一个空终端', () => {
  mount('start_background_service', {
    status: 'failed',
    name: 'dev',
    cmd: 'npm run dev',
    error: 'Failed to spawn shell',
    sandbox: 'write_isolation',
  })

  expect(text('.service-view')).toContain('启动失败')
  expect(text('.service-output')).toBe('Failed to spawn shell')
  expect(document.querySelector('.pty-terminal-body')).toBeNull()
})

it('工具还没返回：先摆出命令与「启动中…」，不预先造终端输出', () => {
  mount('start_background_service', undefined, {
    input: { name: 'dev', cmd: 'npm run dev' },
  })
  expect(text('.xterm-titlebar')).toContain('启动中…')
  expect(text('.pty-cmd-line')).toContain('npm run dev')
  expect(text('.pty-hint')).toContain('正在等待输出…')
  expect(written()).toBe('')
})

it('工具已返回但没有 uiData（调用级异常）：如实报错，不继续画「启动中」', () => {
  const card = new BackgroundServiceMessage()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <>
        {card.getExpandView({
          useContent: {
            type: 'tool_use',
            id: 'tc_err',
            name: 'get_background_service',
            input: { id: 'svc_1' },
          } as ToolUseContent,
          // 工具已结束（有结果消息）但结果里没有结构化 uiData
          message: { content: 'No background service with id "svc_1"' } as Message,
          expand: true,
        })}
      </>,
    ),
  )

  expect(text('.service-view')).toContain('失败')
  expect(text('.service-output')).toContain('No background service with id')
  expect(document.querySelector('.pty-terminal-body')).toBeNull()
})

it('折叠（expand=false）什么都不渲染：卡片收起时不许留一份终端在后台跑', () => {
  mount('start_background_service', serviceUi({ stdout: ANSI_READY }), {
    expand: false,
  })
  expect(document.querySelector('.pty-terminal-body')).toBeNull()
  expect(written()).toBe('')
})
