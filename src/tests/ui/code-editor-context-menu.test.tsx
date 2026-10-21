/**
 * CodeEditor 的右键菜单（剪切 / 复制 / 粘贴 / 全选）。
 *
 * 背景：自绘窗口全局 preventDefault 了浏览器原生 contextmenu，而 Monaco 精简入口
 * （`editor.api.js`）一个 contrib 都不带 —— `contrib/contextmenu` 不是「没引」，是根本没有，
 * 所以右键此前「什么都不发生」（与 Ctrl+F 查找框同一类坑，见 code-editor-find.test.ts）。
 *
 * 这里守四件事：
 *   1. 右键能弹出这四项（文案 / 顺序），且拦掉原生菜单；
 *   2. 禁用态矩阵：无选区 → 剪切 / 复制灰；只读 → 剪切 / 粘贴灰；空文档 → 全选灰；
 *   3. 动作真的落到编辑器上：剪切**先写剪贴板再删**（写不进去就不删）、粘贴替换选区、全选选全文；
 *   4. 「全选 → 紧接着复制」这条连招：菜单不关，且「复制」随着选区变化从灰变亮。
 *
 * jsdom 里没有真 Monaco：`@monaco-editor/react` 换成会调 `onMount(替身)` 的桩，
 * 编辑器替身只实现本组件真正碰到的成员。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const { copyTextMock, readClipboardTextMock, toastMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn(),
  readClipboardTextMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('@/utils/clipboard', () => ({
  copyText: copyTextMock,
  readClipboardText: readClipboardTextMock,
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: toastMock,
  useToast: (): unknown => ({ Toast: (): null => null, showToast: toastMock }),
}))
/** monaco 在 jsdom 里导入即崩（缺 CSS.escape）：编辑器本体整个换掉 */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } },
  virlenDarkTheme: {},
}))
/** 模块顶层直接引的那份 contrib 也要挡（它不经过 setupMonaco） */
vi.mock('monaco-editor/editor/contrib/find/browser/findController.js', () => ({}))

const state = vi.hoisted(() => ({ editor: null as unknown }))

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  /** 编辑器替身：真 Monaco 在 jsdom 里起不来，这里只负责按时回调 onMount（组件在那里挂右键监听） */
  const Editor = (props: { onMount?: (editor: unknown) => void }) => {
    const ref = React.useRef<HTMLDivElement | null>(null)
    React.useEffect(() => {
      const editor = state.editor as { getDomNode: () => HTMLElement | null } | null
      if (!editor) return
      editor.getDomNode = () => ref.current
      props.onMount?.(editor)
      // 只在挂载时接一次（真组件也是 onMount 一次）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return React.createElement('div', { ref, className: 'mono-dom' })
  }
  return { default: Editor, Editor, loader: { config: (): void => {} } }
})

import CodeEditor from '@/ui/components/code-editor/CodeEditor'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const RANGE = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }
const FULL_RANGE = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 3,
  endColumn: 1,
}
const CURSOR = { lineNumber: 2, column: 3 }

type FakeEditor = ReturnType<typeof makeEditor>

/** 编辑器替身：只实现组件真正碰到的那几个成员 */
function makeEditor(
  opts: {
    text?: string
    /** 有没有选区（默认真有，选中前三字符） */
    selected?: boolean
    /** 右键落点是否落在选区内（默认落在选区外 → 组件要把光标挪过去） */
    clickInsideSelection?: boolean
  } = {},
) {
  const text = opts.text ?? 'abc'
  let selected = opts.selected ?? true
  const selection = {
    ...RANGE,
    isEmpty: () => !selected,
    containsPosition: () => opts.clickInsideSelection ?? false,
  }
  const listeners: Array<() => void> = []

  return {
    updateOptions: vi.fn(),
    addCommand: vi.fn(),
    onDidDispose: vi.fn(),
    getDomNode: (): HTMLElement | null => null,
    getTargetAtClientPoint: vi.fn(() => ({
      position: CURSOR,
      element: null,
      mouseColumn: 1,
    })),
    getSelection: () => selection,
    getSelections: () => [selection],
    getPosition: () => CURSOR,
    getModel: () => ({
      getFullModelRange: () => FULL_RANGE,
      getValueInRange: () => (selected ? text : ''),
      getValueLength: () => text.length,
    }),
    setPosition: vi.fn(),
    setSelection: vi.fn(),
    executeEdits: vi.fn(),
    pushUndoStop: vi.fn(),
    focus: vi.fn(),
    onDidChangeCursorSelection: (cb: () => void) => {
      listeners.push(cb)
      return { dispose: (): void => {} }
    },
    /** 测试用：让「选区变成非空」并像 Monaco 那样通知订阅方（「全选」之后就是这样） */
    __select: () => {
      selected = true
      for (const cb of listeners) cb()
    },
  }
}

let root: ReturnType<typeof createRoot> | null = null

async function render(props: { readOnly?: boolean } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<CodeEditor value="abc" onChange={() => {}} {...props} />)
  })
}

const items = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')]
const labels = (): (string | null)[] => items().map((el) => el.textContent)
const itemOf = (label: string): HTMLButtonElement =>
  items().find((el) => el.textContent === label)!

/** 在编辑器容器上右键（组件的监听挂在它身上、捕获阶段） */
async function rightClick(target?: Element): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 30,
  })
  await act(async () => {
    ;(target ?? document.querySelector('.mono-dom')!).dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
  state.editor = null
  copyTextMock.mockReset()
  copyTextMock.mockResolvedValue(true)
  readClipboardTextMock.mockReset()
  readClipboardTextMock.mockResolvedValue('粘贴内容')
  toastMock.mockReset()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('右键弹出剪切 / 复制 / 粘贴 / 全选，并拦掉原生菜单', async () => {
  state.editor = makeEditor()
  await render()

  const event = await rightClick()

  expect(event.defaultPrevented).toBe(true)
  expect(labels()).toEqual(['剪切', '复制', '粘贴', '全选'])
})

it('右键落在选区外：光标挪到落点（粘贴 / 输入才落在右键处）', async () => {
  const editor = makeEditor()
  state.editor = editor
  await render()

  await rightClick()

  expect(editor.getTargetAtClientPoint).toHaveBeenCalled()
  expect(editor.setPosition).toHaveBeenCalledWith(CURSOR)
})

/** 查找框（Ctrl+F）里是真正的 <input>：那里右键不能把「粘贴」落到正文上 */
it('查找框里的输入控件：不弹编辑器菜单', async () => {
  state.editor = makeEditor()
  await render()

  const findWidget = document.createElement('div')
  findWidget.className = 'find-widget'
  const input = document.createElement('input')
  findWidget.appendChild(input)
  document.querySelector('.mono-dom')!.appendChild(findWidget)

  const event = await rightClick(input)

  expect(items()).toHaveLength(0)
  // 也不是我们拦的（交给查找框自己 / 窗口全局那一道）
  expect(event.defaultPrevented).toBe(false)
  expect((state.editor as FakeEditor).setPosition).not.toHaveBeenCalled()
})

it('右键落在选区内：不动光标（保住用户选中的那段）', async () => {
  const editor = makeEditor({ clickInsideSelection: true })
  state.editor = editor
  await render()

  await rightClick()

  expect(editor.setPosition).not.toHaveBeenCalled()
})

it('无选区：剪切 / 复制灰；只读：剪切 / 粘贴灰', async () => {
  state.editor = makeEditor({ selected: false })
  await render()
  await rightClick()
  expect(itemOf('剪切').disabled).toBe(true)
  expect(itemOf('复制').disabled).toBe(true)
  expect(itemOf('粘贴').disabled).toBe(false)

  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''

  state.editor = makeEditor({ selected: true })
  await render({ readOnly: true })
  await rightClick()
  expect(itemOf('剪切').disabled).toBe(true)
  expect(itemOf('粘贴').disabled).toBe(true)
  // 复制 / 全选不写内容，只读时照旧可用
  expect(itemOf('复制').disabled).toBe(false)
  expect(itemOf('全选').disabled).toBe(false)
})

it('空文档：全选灰', async () => {
  state.editor = makeEditor({ text: '', selected: false })
  await render()
  await rightClick()
  expect(itemOf('全选').disabled).toBe(true)
})

it('剪切：先把选区写进剪贴板，再删掉；落一次可撤销的编辑', async () => {
  const editor = makeEditor()
  state.editor = editor
  await render()
  await rightClick()

  await act(async () => {
    itemOf('剪切').click()
  })

  expect(copyTextMock).toHaveBeenCalledWith('abc')
  expect(editor.executeEdits).toHaveBeenCalledWith('code-editor-context-menu', [
    // 选区替身比真 Monaco 多带两个方法（isEmpty / containsPosition），比范围就够
    { range: expect.objectContaining(RANGE), text: '', forceMoveMarkers: true },
  ])
  // 前后各一个 undo 停顿：Ctrl+Z 能单独撤销这次剪切
  expect(editor.pushUndoStop).toHaveBeenCalledTimes(2)
  // 点完就关菜单
  expect(items()).toHaveLength(0)
})

it('剪切：剪贴板写不进去就什么都不删（否则文字凭空消失）', async () => {
  copyTextMock.mockResolvedValue(false)
  const editor = makeEditor()
  state.editor = editor
  await render()
  await rightClick()

  await act(async () => {
    itemOf('剪切').click()
  })

  expect(editor.executeEdits).not.toHaveBeenCalled()
  expect(toastMock).toHaveBeenCalledWith('复制失败')
})

it('粘贴：读系统剪贴板，替换当前选区', async () => {
  const editor = makeEditor()
  state.editor = editor
  await render()
  await rightClick()

  await act(async () => {
    itemOf('粘贴').click()
  })

  expect(readClipboardTextMock).toHaveBeenCalled()
  expect(editor.executeEdits).toHaveBeenCalledWith('code-editor-context-menu', [
    { range: expect.objectContaining(RANGE), text: '粘贴内容', forceMoveMarkers: true },
  ])
})

it('粘贴：剪贴板读不到文本时静默不动（不弹提示、不改内容）', async () => {
  readClipboardTextMock.mockResolvedValue('')
  const editor = makeEditor()
  state.editor = editor
  await render()
  await rightClick()

  await act(async () => {
    itemOf('粘贴').click()
  })

  expect(editor.executeEdits).not.toHaveBeenCalled()
  expect(toastMock).not.toHaveBeenCalled()
})

it('全选：选中全文、菜单不关，随后「复制」从灰变亮', async () => {
  const editor = makeEditor({ selected: false })
  state.editor = editor
  await render()
  await rightClick()
  expect(itemOf('复制').disabled).toBe(true)

  await act(async () => {
    itemOf('全选').click()
  })

  expect(editor.setSelection).toHaveBeenCalledWith(FULL_RANGE)
  // keepOpen：菜单还在，用户下一手就能点「复制」
  expect(items()).toHaveLength(4)

  // 选区变化 → 禁用态跟着刷新
  await act(async () => {
    editor.__select()
  })
  expect(itemOf('复制').disabled).toBe(false)
})

it('复制：把选中文本写进剪贴板并提示', async () => {
  state.editor = makeEditor()
  await render()
  await rightClick()

  await act(async () => {
    itemOf('复制').click()
  })

  expect(copyTextMock).toHaveBeenCalledWith('abc')
  expect(toastMock).toHaveBeenCalledWith('已复制到剪贴板')
})

/** 类型断言用：让 TS 知道替身与组件里拿到的实例形状一致 */
export type { FakeEditor }
