import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { invoke } from '@tauri-apps/api/core'
import * as xtermModule from '@xterm/xterm'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import {
  buildFinishedSegments,
  buildLiveSegments,
  followBottomIfPinned,
  TerminalBlock,
  TerminalStatus,
  TerminalView,
} from '@/ui/pages/chat/components/tool-call/TerminalBlock'
import ExecuteScriptMessage from '@/ui/pages/chat/components/tool-call/ExecuteScriptMessage'
import {
  PendingCrWriter,
  splitTrailingCr,
  XtermTerminalBlock,
} from '@/ui/pages/chat/components/tool-call/XtermTerminal'

/**
 * CodeBlock 依赖 Monaco（jsdom 里无法渲染编辑器），这里换成结构等价的最小替身：
 * 本用例只验证「脚本正文 + 文件名被正确传给 CodeBlock」，不测 Monaco 本身。
 */
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children, fileName }: any) => (
    <div className="code-block-wrapper">
      <span className="code-file-name">{fileName}</span>
      <pre className="code-block-body">{children}</pre>
    </div>
  ),
}))

/**
 * xterm 在 jsdom 里没有量度/画布，`term.open()` 没有意义；
 * 需要「真实挂载」（跑 effect）的用例用最小替身。
 * 静态渲染用例（renderToStaticMarkup）本就不会跑 effect，不受影响。
 *
 * 替身实例会登记进 __instances：右键菜单 / Ctrl+C 智能复制的用例靠它
 * 驱动选区（hasSelection/getSelection）与断言 paste / selectAll 等调用。
 */
vi.mock('@xterm/xterm', () => {
  const instances: any[] = []
  return {
    Terminal: class {
      cols = 80
      rows = 24
      /**
       * 缓冲状态替身：滚轮链断用例靠 `baseY` 区分「有回滚缓冲」（终端自己吃掉滚轮）
       * 与「一屏装得下」（放行给消息列表）。
       */
      buffer = { active: { baseY: 0, viewportY: 0 } }
      hasSelection = vi.fn(() => false)
      getSelection = vi.fn(() => '')
      clearSelection = vi.fn()
      selectAll = vi.fn()
      paste = vi.fn()
      focus = vi.fn()
      attachCustomKeyEventHandler = vi.fn()
      constructor() {
        instances.push(this)
      }
      loadAddon() {}
      open() {}
      write() {}
      reset() {}
      dispose() {}
      onData() {
        return { dispose() {} }
      }
    },
    __instances: instances,
  }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/**
 * execute_command / execute_script 终端块的字段显示：
 *  - 命令失败（CmdError，无 uiData）不能被当成绿色成功输出
 *  - 运行态/完成态共用同一套片段渲染，避免结束瞬间文字跳变
 *  - 自动跟随必须落在「真正的滚动容器」(.code-pre-warpper) 上
 */

describe('buildLiveSegments（运行态）', () => {
  it('空输入 → 空片段', () => {
    expect(buildLiveSegments(null as any)).toEqual([])
    expect(buildLiveSegments('')).toEqual([])
  })

  // 注：processTerminalOutput 自身会移除尾部空行
  it('保留 \\r 覆盖语义，整体作为单个 live 片段', () => {
    expect(buildLiveSegments('10%\r50%\r100%\n')).toEqual([
      { kind: 'live', text: '100%' },
    ])
  })

  it('stderr 标记原样保留，不做分色（边界无法从拼接文本可靠还原）', () => {
    expect(buildLiveSegments('out\n[stderr] err\n')).toEqual([
      { kind: 'live', text: 'out\n[stderr] err' },
    ])
  })
})

describe('buildFinishedSegments（完成态）', () => {
  it('正常结束：用结构化 stdout/stderr，不再回落 content', () => {
    expect(
      buildFinishedSegments(
        { stdout: 'a\n', stderr: 'warn\n', exitCode: 0 },
        '退出码: 0\na\n[标准错误]\nwarn\n',
        false,
      ),
    ).toEqual([
      { kind: 'stdout', text: 'a' },
      { kind: 'stderr', text: 'warn' },
    ])
  })

  it('无输出：不产生空白的输出行（原实现会多一个空行）', () => {
    expect(
      buildFinishedSegments(
        { stdout: '', stderr: '', exitCode: 0 },
        '退出码: 0',
        false,
      ),
    ).toEqual([])
  })

  it('CmdError（退出码 >= 2，无 uiData）：content 整体按失败报告渲染（红）', () => {
    expect(
      buildFinishedSegments(undefined, '退出码: 2\na\n[标准错误]\nboom\n', true),
    ).toEqual([{ kind: 'stderr', text: '退出码: 2\na\n[标准错误]\nboom' }])
  })

  it('保留首行缩进（不再 trim），退出码 1 的结果照常渲染', () => {
    expect(
      buildFinishedSegments({ stdout: '  indented\n', exitCode: 1 }, 'x', false),
    ).toEqual([{ kind: 'stdout', text: '  indented' }])
  })

  it('只有 exitCode、没有流字段时回落 content，避免整段输出丢失', () => {
    expect(buildFinishedSegments({ exitCode: 0 }, 'some output', false)).toEqual([
      { kind: 'stdout', text: 'some output' },
    ])
  })
})

describe('followBottomIfPinned（运行中自动跟随）', () => {
  const fakeEl = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({
    scrollHeight,
    scrollTop,
    clientHeight,
  })

  it('已在底部 → 跟随到最底部', () => {
    const el = fakeEl(1000, 760, 240)
    expect(followBottomIfPinned(el)).toBe(true)
    expect(el.scrollTop).toBe(1000)
  })

  it('阈值内（39px）仍跟随', () => {
    const el = fakeEl(1000, 721, 240)
    expect(followBottomIfPinned(el)).toBe(true)
    expect(el.scrollTop).toBe(1000)
  })

  it('用户往上翻过 → 不打扰，滚动位置不动', () => {
    const el = fakeEl(1000, 100, 240)
    expect(followBottomIfPinned(el)).toBe(false)
    expect(el.scrollTop).toBe(100)
  })

  it('内容不足一屏（无滚动条）→ 视为贴底，赋值为最大值也无害', () => {
    const el = fakeEl(120, 0, 240)
    expect(followBottomIfPinned(el)).toBe(true)
  })
})

describe('TerminalBlock 渲染', () => {
  it('片段之间补 \\n，stdout/stderr 分别带类名，失败徽标为红色', () => {
    const html = renderToStaticMarkup(
      <TerminalBlock
        title="Terminal"
        cmd="ls"
        segments={[
          { kind: 'stdout', text: 'a' },
          { kind: 'stderr', text: 'w' },
        ]}
        status={<TerminalStatus exitCode={2} />}
      />,
    )
    expect(html).toContain('terminal-stdout">a</code>')
    expect(html).toContain('terminal-stderr">\nw</code>')
    expect(html).toContain('terminal-status error')
  })

  it('成功徽标为中性色，无输出片段时不渲染空 code', () => {
    const html = renderToStaticMarkup(
      <TerminalBlock
        title="Terminal"
        cmd="ls"
        segments={[]}
        status={<TerminalStatus exitCode={0} />}
      />,
    )
    expect(html).toContain('class="terminal-status"')
    expect(html).not.toContain('terminal-stdout')
  })

  it('滚动容器是 .code-pre-warpper（跟随逻辑必须作用在它上面）', () => {
    const html = renderToStaticMarkup(
      <TerminalBlock title="Terminal" segments={[]} followBottom />,
    )
    expect(html).toContain('<div class="code-pre-warpper">')
    // pre 只是内层展示元素，不是滚动容器
    expect(html).toContain('<pre class="code-pre">')
  })

  it('killing 时终止按钮禁用并显示「终止中」', () => {
    const html = renderToStaticMarkup(
      <TerminalBlock title="Terminal" segments={[]} onKill={() => {}} killing />,
    )
    expect(html).toContain('disabled')
    expect(html).toContain('终止中')
  })
})

describe('TerminalView（运行态与完成态共用同一组件 / 同一 DOM 形状）', () => {
  const finishedMessage = {
    id: 'm1',
    role: 'tool',
    content: '退出码: 0\nok',
    toolCallId: 't1',
    uiData: { stdout: 'ok\n', stderr: '', exitCode: 0 },
    timestamp: 0,
  } as any

  it('运行中：结构完整、无状态徽标（kill 需 store 注册后才出现）', () => {
    const html = renderToStaticMarkup(
      <TerminalView toolCallId="t1" title="Terminal" cmd="ls" />,
    )
    expect(html).toContain('class="tool-cmd-running"')
    expect(html).toContain('class="execute-command-wrapper"')
    expect(html).toContain('class="code-pre-warpper"')
    expect(html).not.toContain('terminal-status')
  })

  it('完成后：DOM 结构不变（React 才能复用节点、保住滚动位置）并显示退出码', () => {
    const html = renderToStaticMarkup(
      <TerminalView
        toolCallId="t1"
        title="Terminal"
        cmd="ls"
        message={finishedMessage}
      />,
    )
    expect(html).toContain('class="tool-cmd-running"')
    expect(html).toContain('class="execute-command-wrapper"')
    expect(html).toContain('class="code-pre-warpper"')
    expect(html).toContain('terminal-status')
    expect(html).toContain('退出码: 0')
    expect(html).toContain('terminal-stdout">ok</code>')
  })
})

/**
 * 自动跟随的落点回归测试。
 *
 * jsdom 不做布局，所以用访问器拦截 scrollTop 的赋值，直接验证「写到了哪个元素」：
 * 曾经的实现对 .code-pre（overflow:hidden、无高度约束，scrollHeight ===
 * clientHeight）调用 scroll()，对不可滚动元素是空操作 → 运行中的终端永远停在
 * 输出顶部。这里保证跟随只作用在 .code-pre-warpper 上。
 */
function mockScrollBox(
  el: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
) {
  const record = { assigned: null as number | null, reads: 0 }
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => {
      record.reads++
      return scrollTop
    },
    set: (v: number) => {
      record.assigned = v
    },
  })
  return record
}

async function mountTerminal(toolCallId: string) {
  toolOutputStore.register(toolCallId, {
    toolName: 'execute_command',
    output: '',
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<TerminalView toolCallId={toolCallId} title="Terminal" cmd="ls" />)
  })
  return { host, root }
}

describe('运行中自动跟随的落点', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('已贴底：写入 .code-pre-warpper，而不是内层 .code-pre', async () => {
    const { host, root } = await mountTerminal('t-scroll')
    const wrapper = host.querySelector('.code-pre-warpper') as HTMLElement
    const pre = host.querySelector('.code-pre') as HTMLElement
    expect(wrapper).toBeTruthy()
    expect(pre).toBeTruthy()

    // wrapper 是可滚动盒子：内容 1000 / 视口 240，当前 760 → 已贴底
    const wrapperRecord = mockScrollBox(wrapper, 1000, 240, 760)
    // pre 自身不可滚动：scrollHeight === clientHeight
    const preRecord = mockScrollBox(pre, 1000, 1000, 0)

    await act(async () => {
      toolOutputStore.append('t-scroll', 'hello\n')
      toolOutputStore.flush('t-scroll')
    })

    expect(wrapperRecord.reads).toBeGreaterThan(0)
    expect(wrapperRecord.assigned).toBe(1000)
    expect(preRecord.assigned).toBeNull()

    await act(async () => root.unmount())
    toolOutputStore.remove('t-scroll')
  })

  it('用户已往上翻：不打扰，不做任何写入', async () => {
    const { host, root } = await mountTerminal('t-scroll2')
    const wrapper = host.querySelector('.code-pre-warpper') as HTMLElement
    const wrapperRecord = mockScrollBox(wrapper, 1000, 240, 100)

    await act(async () => {
      toolOutputStore.append('t-scroll2', 'more\n')
      toolOutputStore.flush('t-scroll2')
    })

    expect(wrapperRecord.reads).toBeGreaterThan(0)
    expect(wrapperRecord.assigned).toBeNull()

    await act(async () => root.unmount())
    toolOutputStore.remove('t-scroll2')
  })
})

/**
 * execute_script 展开视图：顶部「终端 / 文件」tabs，默认终端。
 * 关键点：tabs 在 TerminalView 外面，终端块结构不变；脚本正文走 CodeBlock。
 */
describe('execute_script 展开视图：终端 / 文件 tabs', () => {
  const SCRIPT = ['console.log(1)', 'console.log(2)'].join('\n')

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  async function mountScriptView() {
    toolOutputStore.register('t-script', {
      toolName: 'execute_script',
      output: '',
    })
    const node = new ExecuteScriptMessage().getExpandView({
      useContent: {
        id: 't-script',
        name: 'execute_script',
        input: {
          file_path: 'temp/run.js',
          file_content: SCRIPT,
          command: 'node temp/run.js',
        },
      },
      // 结果消息未到（运行中）→ 不展开也会渲染实时终端
      message: undefined,
      expand: true,
    } as any)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(node as any)
    })
    return { host, root }
  }

  const tabTexts = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('.script-tabs button')).map(
      (b) => b.textContent,
    )

  it('头部有「终端 / 文件」两个 tab，默认显示终端', async () => {
    const { host, root } = await mountScriptView()

    expect(tabTexts(host)).toEqual(['终端', '文件'])
    expect(host.querySelector('.execute-command-wrapper')).toBeTruthy()
    expect(host.querySelector('.script-file')).toBeNull()

    await act(async () => root.unmount())
    toolOutputStore.remove('t-script')
  })

  it('切到「文件」：用 CodeBlock 渲染脚本正文（带文件名），终端块卸载', async () => {
    const { host, root } = await mountScriptView()

    const buttons = host.querySelectorAll('.script-tabs button')
    await act(async () => {
      ;(buttons[1] as HTMLButtonElement).click()
    })

    expect(host.querySelector('.script-file')).toBeTruthy()
    expect(host.querySelector('.code-block-wrapper')).toBeTruthy()
    expect(host.querySelector('.code-file-name')?.textContent).toBe(
      'temp/run.js',
    )
    expect(host.querySelector('.code-block-body')?.textContent).toBe(SCRIPT)
    // 终端块不再挂载
    expect(host.querySelector('.execute-command-wrapper')).toBeNull()

    // 切回终端
    await act(async () => {
      ;(buttons[0] as HTMLButtonElement).click()
    })
    expect(host.querySelector('.execute-command-wrapper')).toBeTruthy()
    expect(host.querySelector('.script-file')).toBeNull()

    await act(async () => root.unmount())
    toolOutputStore.remove('t-script')
  })

  it('无 file_content 时显示占位文案，不渲染 CodeBlock', async () => {
    toolOutputStore.register('t-script', {
      toolName: 'execute_script',
      output: '',
    })
    const node = new ExecuteScriptMessage().getExpandView({
      useContent: {
        id: 't-script',
        name: 'execute_script',
        input: { file_path: 'temp/run.js', command: 'node temp/run.js' },
      },
      message: undefined,
      expand: true,
    } as any)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(node as any)
    })
    await act(async () => {
      ;(
        host.querySelectorAll('.script-tabs button')[1] as HTMLButtonElement
      ).click()
    })

    expect(host.querySelector('.script-file-empty')?.textContent).toBe(
      '暂无文件内容',
    )
    expect(host.querySelector('.code-block-wrapper')).toBeNull()

    await act(async () => root.unmount())
    toolOutputStore.remove('t-script')
  })
})

/**
 * 终端块内置「全屏」动作。
 * 与 CodeBlock 同构：靠 createPortal + position:fixed 铺满窗口内容区，
 * 原位终端照常保留（否则消息条目变矮会触发虚拟列表重测量 / 滚动跳动）。
 */
describe('TerminalBlock 全屏', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  async function mountTerminalBlock() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <TerminalBlock
          title="Terminal"
          cmd="ls"
          segments={[{ kind: 'stdout', text: 'ok' }]}
        />,
      )
    })
    return { host, root }
  }

  const fullscreenBtn = (host: HTMLElement) =>
    host.querySelector('.terminal-fullscreen-btn') as HTMLButtonElement
  const layer = () =>
    document.querySelector('.terminal-fullscreen-layer') as HTMLElement | null

  it('header 带内置全屏按钮、不再显示 tips，默认不渲染浮层', async () => {
    const { host, root } = await mountTerminalBlock()

    expect(fullscreenBtn(host)).toBeTruthy()
    // header 里的 tips 已移除
    expect(host.querySelector('.execute-command-header-tips')).toBeNull()
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })

  it('点击后把 .is-fullscreen 终端挂到 body，原位终端照常保留', async () => {
    const { host, root } = await mountTerminalBlock()

    await act(async () => fullscreenBtn(host).click())

    const el = layer()
    expect(el).toBeTruthy()
    // 必须挂在 body 下（不受消息条目祖先的 transform/overflow 影响才能铺满）
    expect(el!.parentElement).toBe(document.body)
    // 浮层里是「铺满」形态，且输出照常渲染
    expect(
      el!.querySelector('.execute-command-wrapper.is-fullscreen'),
    ).toBeTruthy()
    expect(el!.querySelector('.code-pre-warpper')).toBeTruthy()
    // 原位终端仍在（没有被搬走），且不是全屏形态
    expect(host.querySelector('.execute-command-wrapper')).toBeTruthy()
    expect(
      host.querySelector('.execute-command-wrapper.is-fullscreen'),
    ).toBeNull()

    await act(async () => root.unmount())
  })

  it('再点一次退出，Esc 也能退出', async () => {
    const { host, root } = await mountTerminalBlock()

    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeTruthy()
    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeNull()

    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeTruthy()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })
})

/**
 * PTY 终端块（xterm 路径）的结构回归，Step 2 ③（命名按键条）/ ⑤（全屏）。
 * 外观已对齐桌面上那份 xterm-demo：顶部窗口栏（红黄绿点 + 标签）+ 底部状态栏。
 *
 * 只做静态渲染断言（不触发 xterm 的 useLayoutEffect —— jsdom 没有真正的画布/量度），
 * 验证 DOM 结构齐备；xterm 的实际渲染与全屏滚动交给真机手动验收。
 */
describe('XtermTerminalBlock（PTY）结构与操作区', () => {
  const render = (running: boolean) =>
    renderToStaticMarkup(
      <XtermTerminalBlock
        title="Terminal"
        cmd="npm login"
        stream=""
        running={running}
        toolCallId="t-pty"
      />,
    )

  // ⚠️ 按键条目前**只保留 Ctrl+D（EOF）**：桌面端可直接在终端里键击/粘贴输入
  //    （xterm 的 onData 直送伪控制台），按键条只是给触屏 / 无键盘场景补一个「结束输入」入口。
  //    Enter 归回车键 / Ctrl+C 归「终止」按钮，其余（Tab/↑/↓）已移除 —— 若日后恢复那批按钮，
  //    请同步补回断言。
  it('运行中：含按键条（Ctrl+D）、接管按钮、全屏按钮与终端容器', () => {
    const html = render(true)
    expect(html).toContain('is-pty')
    expect(html).toContain('pty-key-bar')
    expect(html).toContain('pty-hold-btn')
    expect(html).toContain('接管')
    expect(html).toContain('Ctrl+D')
    expect(html).toContain('发送 Ctrl+D（EOF）')
    expect(html).toContain('terminal-fullscreen-btn')
    expect(html).toContain('pty-terminal-body')
  })

  it('完成态：不渲染按键条与接管按钮，但仍保留全屏按钮', () => {
    const html = render(false)
    expect(html).not.toContain('pty-key-bar')
    expect(html).not.toContain('pty-hold-btn')
    expect(html).toContain('terminal-fullscreen-btn')
    expect(html).toContain('pty-terminal-body')
  })

  // 曾经 `note` 只在 `<pre>` 版 TerminalBlock 里渲染，PTY 路径把它静默丢了（终端里看不到脚本执行的说明）。
  it('完成态：输出末尾的附加说明（note）会被渲染', () => {
    const html = renderToStaticMarkup(
      <XtermTerminalBlock
        title="Terminal"
        cmd="npm run build"
        stream=""
        running={false}
        toolCallId="t-pty-note"
        note="脚本已删除"
      />,
    )
    expect(html).toContain('pty-hint')
    expect(html).toContain('脚本已删除')
  })

  it('demo 风格外框：顶部窗口栏（红黄绿点）+ 右上操作区；底部状态栏已移除', () => {
    const html = render(true)
    expect(html).toContain('xterm-titlebar')
    expect(html).toContain('terminal-header-actions')
    expect(html).toContain('xterm-dot--red')
    expect(html).toContain('xterm-dot--yellow')
    expect(html).toContain('xterm-dot--green')
    // 标签页（.xterm-tab）已移除：标题改由 `$ cmd` 行 / 右上操作区承载，这里不再断言
    // 底部状态栏已移除：终端尺寸徽标改到右上角（有尺寸时才渲染）
    expect(html).not.toContain('xterm-statusbar')
  })

  it('命令行前显示当前工作目录（pty-cmd-line 内、`$ cmd` 之前）', () => {
    const html = renderToStaticMarkup(
      <XtermTerminalBlock
        title="Terminal"
        cwd="E:/code/virlen/virlen-app"
        cmd="npm init"
        stream=""
        running
        toolCallId="t-pty-cwd"
      />,
    )
    expect(html).toContain('class="pty-cwd"')
    expect(html).toContain('E:/code/virlen/virlen-app')
    // `$` 提示符单独成 span（CSS 置 user-select:none，复制命令时不带上它）
    expect(html).toContain('class="pty-prompt"')
    // cwd 必须排在 `$ cmd` 之前
    expect(html.indexOf('E:/code/virlen/virlen-app')).toBeLessThan(
      html.indexOf('npm init'),
    )
  })

  it('无 cwd 时不渲染提示符目录（退回 `$ cmd`）', () => {
    expect(render(true)).not.toContain('pty-cwd')
  })

  it('完成态加 is-finished 类（用于隐藏终端光标）；运行态不加', () => {
    expect(render(true)).not.toContain('is-finished')
    expect(render(false)).toContain('is-finished')
  })
})

/** 拿到最新挂载的 Terminal 替身（右键菜单用例驱动选区 / 断言 paste 调用） */
function lastXtermInstance(): any {
  const list = (xtermModule as any).__instances as any[]
  return list[list.length - 1]
}

/**
 * PTY 终端的右键菜单（复制/粘贴/全选）与 Ctrl+C 智能复制。
 *
 * 背景：键盘输入会经 xterm onData 直送伪控制台 —— Ctrl+C 被转成 \x03 中断命令，
 * 浏览器原生复制又被 xterm 的 preventDefault 吞掉，终端里根本没法复制。
 * 补丁语义：有选区时 Ctrl+C 复制（不再发 \x03）；右键弹自定义菜单。
 */
describe('XtermTerminal 右键菜单与 Ctrl+C 智能复制', () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>
  let clipboardReadText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    document.body.innerHTML = ''
    // jsdom 没有 navigator.clipboard，注入可断言的替身
    clipboardWriteText = vi.fn().mockResolvedValue(undefined)
    clipboardReadText = vi.fn().mockResolvedValue('')
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText, readText: clipboardReadText },
      configurable: true,
    })
    vi.mocked(invoke).mockReset()
  })

  afterEach(() => {
    // 还原：jsdom 本无 navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    })
  })

  async function mountPty(running: boolean) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <XtermTerminalBlock
          title="Terminal"
          cmd="echo hi"
          stream=""
          running={running}
          toolCallId="t-ctx-menu"
        />,
      )
    })
    return { host, root }
  }

  /** 在终端主体上模拟右键，返回弹出的菜单（挂 body 的 portal） */
  async function openMenu(host: HTMLElement) {
    const wrapper = host.querySelector(
      '.pty-terminal-body-wrapper',
    ) as HTMLElement
    await act(async () => {
      wrapper.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 100,
        }),
      )
    })
    return document.querySelector('.context-menu') as HTMLElement | null
  }

  const menuButtons = (menu: HTMLElement) =>
    Array.from(menu.querySelectorAll('button')) as HTMLButtonElement[]

  it('右键弹出菜单（挂 body、深色皮肤），含复制/粘贴/全选三项', async () => {
    const { host, root } = await mountPty(true)
    const menu = await openMenu(host)
    expect(menu).toBeTruthy()
    // 必须挂在 body 下（消息列表祖先带 transform/overflow，fixed 需脱离它们）
    expect(menu!.parentElement).toBe(document.body)
    // 共享 ContextMenu 的终端皮肤（黑底终端上不能用浅色菜单）
    expect(menu!.classList.contains('context-menu--dark')).toBe(true)
    expect(menuButtons(menu!).map((b) => b.textContent)).toEqual([
      '复制',
      '粘贴',
      '全选',
    ])
    await act(async () => root.unmount())
  })

  it('无选区时「复制」禁用；命令结束后「粘贴」禁用', async () => {
    const { host, root } = await mountPty(true)
    const menu = await openMenu(host)
    const [copyBtn, pasteBtn] = menuButtons(menu!)
    expect(copyBtn.disabled).toBe(true) // 无选区可复制
    expect(pasteBtn.disabled).toBe(false) // 运行中：伪控制台还在
    await act(async () => root.unmount())

    const finished = await mountPty(false)
    const menu2 = await openMenu(finished.host)
    const [, pasteBtn2] = menuButtons(menu2!)
    expect(pasteBtn2.disabled).toBe(true) // 已结束：会话不在，粘贴无处可去
    await act(async () => finished.root.unmount())
  })

  it('「复制」：写入选区文本并清选区，菜单关闭', async () => {
    const { host, root } = await mountPty(true)
    const term = lastXtermInstance()
    term.hasSelection.mockReturnValue(true)
    term.getSelection.mockReturnValue('copied-text')
    const menu = await openMenu(host)
    await act(async () => {
      menuButtons(menu!)[0].click()
    })
    expect(clipboardWriteText).toHaveBeenCalledWith('copied-text')
    expect(term.clearSelection).toHaveBeenCalled()
    expect(document.querySelector('.context-menu')).toBeNull()
    await act(async () => root.unmount())
  })

  it('「粘贴」：优先走原生命令读剪贴板，再经 term.paste 送入（保留 bracketed paste 通道）', async () => {
    const { host, root } = await mountPty(true)
    vi.mocked(invoke).mockResolvedValue('pasted-text')
    const menu = await openMenu(host)
    await act(async () => {
      menuButtons(menu!)[1].click()
    })
    expect(invoke).toHaveBeenCalledWith('read_clipboard_text')
    expect(lastXtermInstance().paste).toHaveBeenCalledWith('pasted-text')
    expect(document.querySelector('.context-menu')).toBeNull()
    await act(async () => root.unmount())
  })

  it('「粘贴」：原生命令读不到时退回浏览器剪贴板 API', async () => {
    const { host, root } = await mountPty(true)
    clipboardReadText.mockResolvedValue('from-browser')
    const menu = await openMenu(host)
    await act(async () => {
      menuButtons(menu!)[1].click()
    })
    expect(clipboardReadText).toHaveBeenCalled()
    expect(lastXtermInstance().paste).toHaveBeenCalledWith('from-browser')
    await act(async () => root.unmount())
  })

  it('「全选」：调用 selectAll 且菜单保持打开（随后「复制」随即可用）', async () => {
    const { host, root } = await mountPty(true)
    const menu = await openMenu(host)
    await act(async () => {
      menuButtons(menu!)[2].click()
    })
    expect(lastXtermInstance().selectAll).toHaveBeenCalled()
    expect(document.querySelector('.context-menu')).toBeTruthy()
    await act(async () => root.unmount())
  })

  it('右键顶部命令行（`$ cmd`）→ 复制菜单；复制内容不含 `$` 提示符', async () => {
    const { host, root } = await mountPty(true)
    const cmdLine = host.querySelector('.pty-cmd-line') as HTMLElement
    expect(cmdLine).toBeTruthy()
    // `$` 提示符单独成 span（不可选中）
    expect(cmdLine.querySelector('.pty-prompt')?.textContent).toBe('$')

    await act(async () => {
      cmdLine.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 100,
        }),
      )
    })
    const menu = document.querySelector('.context-menu') as HTMLElement
    expect(menu).toBeTruthy()
    expect(menuButtons(menu).map((b) => b.textContent)).toEqual(['复制'])

    // 无选区 → 复制整条命令（不含 `$`）
    await act(async () => {
      menuButtons(menu)[0].click()
    })
    expect(clipboardWriteText).toHaveBeenCalledWith('echo hi')

    await act(async () => root.unmount())
  })

  it('点菜单外 / Esc 关闭菜单', async () => {
    const { host, root } = await mountPty(true)
    await openMenu(host)
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('.context-menu')).toBeNull()

    await openMenu(host)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('.context-menu')).toBeNull()
    await act(async () => root.unmount())
  })

  it('Ctrl+C：有选区 → 拦截并复制（\x03 不再发给 PTY）；无选区 → 放行（维持中断语义）', async () => {
    const { host, root } = await mountPty(true)
    const term = lastXtermInstance()
    // 组件创建终端时注册的按键拦截器
    expect(term.attachCustomKeyEventHandler).toHaveBeenCalled()
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (
      ev: KeyboardEvent
    ) => boolean

    // 有选区：拦下 + preventDefault + 复制 + 清选区
    term.hasSelection.mockReturnValue(true)
    term.getSelection.mockReturnValue('selected')
    const ev = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      cancelable: true,
    })
    expect(handler(ev)).toBe(false)
    expect(ev.defaultPrevented).toBe(true)
    expect(clipboardWriteText).toHaveBeenCalledWith('selected')
    expect(term.clearSelection).toHaveBeenCalled()

    // 无选区：放行（xterm 会把 \x03 经 onData → pty_write 发出去中断命令）
    term.hasSelection.mockReturnValue(false)
    expect(
      handler(
        new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true }),
      ),
    ).toBe(true)

    // 非 keydown（keyup/keypress）不拦截；其他组合键也不拦
    expect(handler(new KeyboardEvent('keyup', { key: 'c', ctrlKey: true }))).toBe(
      true,
    )
    expect(
      handler(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true }),
      ),
    ).toBe(true)
    await act(async () => root.unmount())
  })
})

/**
 * 终端内的滚轮：滚到顶/底之后不能再把消息列表一起滚走。
 *
 * 根因（xterm 6）：终端回滚是 VS Code `SmoothScrollableElement` 的 JS 实现，它的 wheel
 * 处理器只在**真的滚动成功**时才 `preventDefault + stopPropagation`
 * （`consumeMouseWheel = didScroll`）——到边界那一下什么都不做，事件继续冒泡，
 * 浏览器顺手把外层 `.chat-messages-container` 也滚了。
 *
 * 组件在外层补了一颗**冒泡阶段**监听：能收到事件本身 = xterm 没消费 = 终端已到边界 →
 * `preventDefault()`（只取消滚动链传导，不影响 xterm 的 JS 滚动）。
 * 替身用 `buffer.active.baseY` 表达「有回滚缓冲 / 一屏装得下」两种状态。
 */
describe('终端滚轮：截断滚动链（不连带滚消息列表）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  /** jsdom 各版本对 WheelEvent 支持不一；本用例只关心 preventDefault 与冒泡 */
  const wheelEvent = () => {
    const Ctor = (globalThis as any).WheelEvent as typeof WheelEvent | undefined
    return Ctor
      ? new Ctor('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
      : new MouseEvent('wheel', { bubbles: true, cancelable: true })
  }

  async function mountPty() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <XtermTerminalBlock
          title="Terminal"
          cmd="npm install"
          stream=""
          running={false}
          toolCallId="t-scroll-chain"
        />,
      )
    })
    return { host, root }
  }

  it('有回滚缓冲（baseY > 0）：到边界的那一下滚轮被拦下（不再带动消息列表）', async () => {
    const { host, root } = await mountPty()
    lastXtermInstance().buffer.active.baseY = 200

    const body = host.querySelector('.pty-terminal-body') as HTMLElement
    const ev = wheelEvent()
    body.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)

    // 监听器随终端一起销毁（卸载后同一个节点上不再拦截）
    await act(async () => root.unmount())
    const ev2 = wheelEvent()
    body.dispatchEvent(ev2)
    expect(ev2.defaultPrevented).toBe(false)
  })

  it('无回滚缓冲（baseY === 0，输出一屏装得下）：不拦，交给消息列表（避免滚轮死区）', async () => {
    const { host, root } = await mountPty()
    lastXtermInstance().buffer.active.baseY = 0

    const body = host.querySelector('.pty-terminal-body') as HTMLElement
    const ev = wheelEvent()
    body.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)

    await act(async () => root.unmount())
  })
})

describe('splitTrailingCr（消除「删除时光标闪到行首」）', () => {
  it('末尾单个 \\r 全部挂起（ConPTY 行重绘的先导 CR）', () => {
    // 真实样本：ConPTY 先单独发一个 \r，约 10~25ms 后才发整行重绘
    expect(splitTrailingCr('\r')).toEqual(['', '\r'])
  })

  it('末尾连续多个 \\r 一起挂起', () => {
    expect(splitTrailingCr('abc\r\r')).toEqual(['abc', '\r\r'])
  })

  it('含可见内容的尾块：内容部分照旧立即写入，只挂起尾部 \\r', () => {
    expect(splitTrailingCr('progress: 10%\r')).toEqual(['progress: 10%', '\r'])
  })

  it('不以 \\r 收尾 → 原样写入、不挂起', () => {
    expect(splitTrailingCr('package name: (x) ')).toEqual([
      'package name: (x) ',
      '',
    ])
    expect(splitTrailingCr('\x1b[11;24H\x1b[?25h')).toEqual([
      '\x1b[11;24H\x1b[?25h',
      '',
    ])
  })

  it('空串 → 空挂起', () => {
    expect(splitTrailingCr('')).toEqual(['', ''])
  })

  it('先导 CR + 后续重绘合并成一次写入（不渲染中间帧）', () => {
    // 模拟两次 writeDelta：第 1 次只有 \r（挂起、不写）；第 2 次整行重绘 → 合并
    let pending = ''
    const written: string[] = []
    const delta = (d: string) => {
      const [toWrite, hold] = splitTrailingCr(pending + d)
      pending = hold
      if (toWrite) written.push(toWrite)
    }
    delta('\r')
    expect(written).toEqual([]) // 关键：没有渲染任何中间帧（否则就是闪到行首）
    delta('\x1b[25lpackage name: (dsadsa) nam\x1b[K\r\n\x1b[K\x1b[11;27H\x1b[?25h')
    expect(written).toEqual([
      '\r\x1b[25lpackage name: (dsadsa) nam\x1b[K\r\n\x1b[K\x1b[11;27H\x1b[?25h',
    ])
    expect(pending).toBe('')
  })
})

describe('PendingCrWriter（先导 CR 合并 + 兜底防抖）', () => {
  const make = (delay = 120) => {
    const out: string[] = []
    const writer = new PendingCrWriter(delay, (text) => out.push(text))
    return { writer, out }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('先导 \\r 挂起：窗口内有后续增量 → 合并成一次写入，不渲染中间帧', () => {
    const { writer, out } = make()
    writer.push('\r')
    expect(out).toEqual([]) // 关键：没有单独渲染那个 \r
    writer.push('\x1b[25lpackage name: (x) nam\x1b[11;27H\x1b[?25h')
    expect(out).toEqual([
      '\r\x1b[25lpackage name: (x) nam\x1b[11;27H\x1b[?25h',
    ])
    vi.advanceTimersByTime(1000)
    expect(out).toHaveLength(1) // 兜底已取消，不会重复写
  })

  it('兜底防抖：窗口内没有后续增量 → 到点补写挂起的 \\r', () => {
    const { writer, out } = make(120)
    writer.push('\r')
    expect(out).toEqual([])
    vi.advanceTimersByTime(119)
    expect(out).toEqual([]) // 未到点，仍不写
    vi.advanceTimersByTime(1)
    expect(out).toEqual(['\r'])
  })

  it('含可见内容的尾块：内容立即写入，仅末尾 \\r 挂起', () => {
    const { writer, out } = make()
    writer.push('progress: 10%\r')
    expect(out).toEqual(['progress: 10%']) // 内容不延迟
    vi.advanceTimersByTime(1000)
    expect(out).toEqual(['progress: 10%', '\r'])
  })

  it('不以 \\r 收尾 → 立即写入且不挂起（不引入延迟）', () => {
    const { writer, out } = make()
    writer.push('abc')
    expect(out).toEqual(['abc'])
    vi.advanceTimersByTime(1000)
    expect(out).toEqual(['abc'])
  })

  it('后到的挂起会重置兜底定时器（合并窗口顺延）', () => {
    const { writer, out } = make(120)
    writer.push('abc\r')
    expect(out).toEqual(['abc'])
    vi.advanceTimersByTime(80)
    writer.push('def\r') // 距上次挂起 80ms → 重置定时器
    expect(out).toEqual(['abc', '\rdef'])
    vi.advanceTimersByTime(80)
    expect(out).toEqual(['abc', '\rdef']) // 还没到点
    vi.advanceTimersByTime(40)
    expect(out).toEqual(['abc', '\rdef', '\r'])
  })

  it('reset 丢弃挂起并取消定时器', () => {
    const { writer, out } = make()
    writer.push('\r')
    writer.reset()
    vi.advanceTimersByTime(1000)
    expect(out).toEqual([])
  })
})
