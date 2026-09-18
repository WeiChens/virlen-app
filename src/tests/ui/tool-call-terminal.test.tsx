import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
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
import { XtermTerminalBlock } from '@/ui/pages/chat/components/tool-call/XtermTerminal'

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

  it('运行中：含命名按键条（Enter/Ctrl+C/Ctrl+D/Tab/↑/↓）、接管按钮、全屏按钮与终端容器', () => {
    const html = render(true)
    expect(html).toContain('is-pty')
    expect(html).toContain('pty-key-bar')
    expect(html).toContain('pty-hold-btn')
    expect(html).toContain('接管')
    expect(html).toContain('Enter')
    expect(html).toContain('Ctrl+C')
    expect(html).toContain('Ctrl+D')
    expect(html).toContain('Tab')
    expect(html).toContain('↑')
    expect(html).toContain('↓')
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

  it('demo 风格外框：顶部窗口栏（红黄绿点 + 标签）+ 底部状态栏', () => {
    const html = render(true)
    expect(html).toContain('xterm-titlebar')
    expect(html).toContain('xterm-dot--red')
    expect(html).toContain('xterm-dot--yellow')
    expect(html).toContain('xterm-dot--green')
    expect(html).toContain('xterm-tab__glyph')
    expect(html).toContain('xterm-statusbar')
  })

  it('底部状态栏：运行中显示「运行中」徐标，完成态不显示', () => {
    expect(render(true)).toContain('xterm-badge--running')
    expect(render(true)).toContain('运行中')
    expect(render(false)).not.toContain('xterm-badge--running')
  })
})
