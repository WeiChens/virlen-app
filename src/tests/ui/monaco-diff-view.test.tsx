/**
 * MonacoDiffView —— git 差异弹窗的 Monaco 正文：守**我们交下去的契约**。
 *
 * Monaco 自己的行为（真虚拟化、两栏同步滚动、差异算法跑在 worker 里）在 jsdom 里验不了 ——
 * 它按容器尺寸排版，这里既没有布局也没有 worker。所以本用例只守这条边界：
 * - 两侧全文**按原样**交给 Monaco（切文件只 setValue，不重建 DOM）；
 * - 语言由文件名推（认不出的扩展名退化成纯文本，不瞎猜）；
 * - 只读 / 不折行 / 不折叠未改动行 / 两栏恒等宽（分栏拖拽关掉）/ 不回退箭头 / **右键菜单自绘**；
 * - 打开 **和换文件** 都落到第一处改动（改动落在文件后半段时，不定位看起来就等于「没高亮」）；
 * - 两个列头（原文件 / 新文件 + Ln 区间）在，布局是「两等宽列 + 一行列头 + 编辑器填满剩余高度」；
 * - **单栏形态**（新增 / 删除 / 未跟踪，`singleSide`）：只画那一栏的列头（横跨两列）+ 单栏只读编辑器，
 *   整份内容由一条整行装饰按「全删除（`line-delete`）/ 全新增（`line-insert`）」着色，换侧要重画；
 * - **右键菜单**：复制读开菜单那一刻的选区快照、全选只作用于右键那一栏且保持菜单打开、
 *   单栏形态的标签不写栏名（只有一栏，写栏名会让人以为还有另一栏）。
 *
 * 真实观感（切文件是否更快、两栏滚动是否跟手、配色与聊天里的 diff 是否像一套）需要人工确认。
 */
import { readFileSync } from 'node:fs'
import { compileString } from 'sass'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { DiffEditorProps, EditorProps } from '@monaco-editor/react'

// monaco 在 jsdom 里导入即崩（缺 CSS.escape）；本用例也不看词法着色
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))
// 剪贴板 / Toast 会真的调 Tauri：右键菜单的两条副作用路径换成替身
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): unknown => ({ Toast: (): null => null, showToast: vi.fn() }),
}))

/** 抓住最近一次渲染交给 Monaco 的 props（真编辑器在 jsdom 里起不来） */
const state = vi.hoisted(() => ({
  props: null as DiffEditorProps | null,
  editorProps: null as EditorProps | null,
}))
vi.mock('@monaco-editor/react', () => {
  const Stub = () => <div className="mono-stub" />
  return {
    default: Stub,
    loader: { config: () => {} },
    DiffEditor: (props: DiffEditorProps) => {
      state.props = props
      return <div className="diff-editor-stub" />
    },
    Editor: (props: EditorProps) => {
      state.editorProps = props
      return <div className="editor-stub" />
    },
  }
})

import type { ComponentProps } from 'react'
import {
  MonacoDiffView,
  monacoDiffHeight,
} from '@/ui/pages/chat/components/message/MonacoDiffView'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'

/**
 * 上面几处断言用的选项形状（只取本用例碰到的键，避免把 Monaco 的整个类型搬进来）。
 * 用宽松类型而不是 `IDiffEditorConstructionOptions`：单栏那份选项里「对比」专属键应当是 undefined，
 * 拿严格类型断言反而绕。
 */
type MonacoNsOptions = {
  readOnly?: boolean
  originalEditable?: boolean
  wordWrap?: string
  diffWordWrap?: string
  enableSplitViewResizing?: boolean
  useInlineViewWhenSpaceIsLimited?: boolean
  renderSideBySide?: boolean
  hideUnchangedRegions?: { enabled?: boolean }
  ignoreTrimWhitespace?: boolean
  renderMarginRevertIcon?: boolean
  renderGutterMenu?: boolean
  lineDecorationsWidth?: number
  minimap?: { enabled?: boolean }
  renderOverviewRuler?: boolean
  contextmenu?: boolean
  automaticLayout?: boolean
  fontSize?: number
  lineHeight?: number
  fontFamily?: string
  lineNumbers?: (line: number) => string
}

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** Monaco 的 Range 是类实例，这里只当不透明值比对 */
const FULL_RANGE = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 9,
  endColumn: 1,
}
const OLD_TEXT = 'aaa\nbbb\n'
const NEW_TEXT = 'yyy\n'

/** 一个够用的编辑器替身：本组件真的会碰的成员就这几个 */
function makeEditor(text: string) {
  const model = {
    getFullModelRange: () => FULL_RANGE,
    getValue: () => text,
    getValueInRange: vi.fn(() => ''),
  }
  const decorations = { set: vi.fn(), clear: vi.fn() }
  const createDecorationsCollection = vi.fn(() => decorations)
  const editor = {
    getModel: () => model,
    // ⚠️ 关返回类型必须写出来：本项目 `strictNullChecks: false`，`() => null` 的返回类型会被推成
    // any（TS7011，`noImplicitAny` 报错）；写成「选区 | null」才能被后面的用例改成有选区那个替身。
    getSelection: (): { isEmpty: () => boolean } | null => null,
    setSelection: vi.fn(),
    focus: vi.fn(),
    updateOptions: vi.fn(),
    createDecorationsCollection,
    getDomNode: (): null => null,
  }
  return { editor, model, decorations, createDecorationsCollection }
}

/** 两栏差异编辑器的替身：两栏各给一个替身（右键菜单要按栏分辨） */
function makeDiffEditor() {
  const original = makeEditor(OLD_TEXT)
  const modified = makeEditor(NEW_TEXT)
  const revealFirstDiff = vi.fn()
  const editor = {
    revealFirstDiff,
    getOriginalEditor: () => original.editor,
    getModifiedEditor: () => modified.editor,
    getDomNode: (): null => null,
  }
  return { editor, revealFirstDiff, original, modified }
}

let root: ReturnType<typeof createRoot> | null = null

type ViewProps = ComponentProps<typeof MonacoDiffView>

/**
 * 换 props 重渲染（保持 `mount` 那棵树的形状）。
 * ⚠️ 别在根上直接 render `<MonacoDiffView />`：`mount` 外面包了一层 `<div onContextMenu>`，
 * 少了这层就是「根的子节点类型变了」→ React 卸载整棵树再重建，而这几条用例验的恰恰是
 * 「同一份编辑器实例只 `setValue`、不重建」（写错就会拿到假的结果）。
 */
let rerender: ((props: ViewProps, onOuter?: () => void) => Promise<void>) | null =
  null

async function mount(
  oldText: string,
  newText: string,
  fileName: string,
  singleSide?: 'old' | 'new',
  onOuterContextMenu?: () => void,
  extra: Partial<ViewProps> = {},
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  rerender = async (props, onOuter = onOuterContextMenu) => {
    await act(async () => {
      root!.render(
        <div onContextMenu={onOuter}>
          <MonacoDiffView {...props} />
        </div>,
      )
    })
  }
  await rerender({ oldText, newText, fileName, singleSide, ...extra })
  return host
}

/** 单栏编辑器由库在挂载完成后回调，这里就模拟那一刻 */
function mountSingleEditor(text: string) {
  const fake = makeEditor(text)
  act(() => state.editorProps!.onMount!(fake.editor as never, {} as never))
  return fake
}

/** 两栏差异编辑器同理 */
function mountDiffEditor() {
  const fake = makeDiffEditor()
  act(() => state.props!.onMount!(fake.editor as never, {} as never))
  return fake
}

const menuLabels = () =>
  Array.from(document.querySelectorAll('.context-menu-item')).map(
    (el) => el.textContent,
  )
const menuButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))

async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      }),
    )
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  state.props = null
  state.editorProps = null
  rerender = null
  vi.mocked(copyText).mockClear()
  vi.mocked(showToast).mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

it('两侧全文按原样交给 Monaco，语言由文件名推（认不出就是纯文本）', async () => {
  const host = await mount('a\nb\n', 'a\nc\n', 'src/a.ts')

  expect(host.querySelector('.diff-editor-stub')).not.toBeNull()
  expect(state.props?.original).toBe('a\nb\n')
  expect(state.props?.modified).toBe('a\nc\n')
  expect(state.props?.language).toBe('typescript')
  expect(state.props?.theme).toBe('virlen-dark')
  // 两侧 model 随这个组件一起销毁（切文件只 setValue，不重建）
  expect(state.props?.keepCurrentOriginalModel).toBe(false)
  expect(state.props?.keepCurrentModifiedModel).toBe(false)

  // 没有扩展名 / 认不出的扩展名：不能瞎猜一个语言
  act(() => root!.unmount())
  document.body.innerHTML = ''
  await mount('x\n', 'y\n', 'LICENSE')
  expect(state.props?.language).toBe('plaintext')
})

it('选项契约：只读、不折行、不折叠未改动行、两栏恒等宽、不回退箭头、右键菜单自绘', async () => {
  await mount('a\n', 'b\n', 'a.txt')

  const o = state.props!.options as MonacoNsOptions
  expect(o.readOnly).toBe(true)
  expect(o.originalEditable).toBe(false)
  expect(o.wordWrap).toBe('off')
  expect(o.diffWordWrap).toBe('off')
  // 分栏可拖 = 上面的列头与下面的两栏会错位；窄窗口自动切内联 = 与「左右对比」对不上
  expect(o.enableSplitViewResizing).toBe(false)
  expect(o.useInlineViewWhenSpaceIsLimited).toBe(false)
  expect(o.renderSideBySide).toBe(true)
  // 实测反馈：不要用 … 省略相同的部分
  expect(o.hideUnchangedRegions?.enabled).toBe(false)
  // 行尾空格也算差异（旧视图逐字符比、git 也照实显示）
  expect(o.ignoreTrimWhitespace).toBe(false)
  expect(o.renderMarginRevertIcon).toBe(false)
  expect(o.renderGutterMenu).toBe(false)
  // ⚠️ 行装饰车道必须容得下 diff 的 +/- 标记（`.codicon-diff-insert` / `.codicon-diff-remove`）：
  // Monaco 把它的字号钉成 11px、字形推进宽度 = 1em = 11px（墨迹 9.64px、左边界 0），而车道的右边界
  // **就是**正文左边界（`contentLeft = decorationsLeft + lineDecorationsWidth`）—— 车道窄了，标记的
  // 右半边就被画在它之后的正文层盖掉（实测：单栏预览那档的 6px 只看得见左边的 6/9.64，像「只显示一半」）。
  expect(o.lineDecorationsWidth).toBeGreaterThanOrEqual(11)
  expect(o.minimap?.enabled).toBe(false)
  expect(o.renderOverviewRuler).toBe(false)
  // ⚠️ 必须关掉 Monaco 自带的右键菜单：英文、与项目皮肤不搭，而且它会 stopPropagation，
  // 让 React 这边的 onContextMenu 收不到（我们的「复制 / 全选」就开不出来了）
  expect(o.contextmenu).toBe(false)
  // 弹窗里的高度由布局决定，编辑器得自己跟着容器尺寸走
  expect(o.automaticLayout).toBe(true)
  // 行高与字号同一个倍率（1.55，与 .diff-side-by-side 的 --diff-line-height 一致）
  expect(o.lineHeight).toBe(Math.round((o.fontSize ?? 12) * 1.55))
  expect(String(o.fontFamily)).toContain('JetBrains Mono')
})

it('打开 / 换文件都落到第一处改动（改动在文件后半段时，不定位看起来就等于「没高亮」）', async () => {
  await mount('a\n', 'b\n', 'a.txt')
  const { revealFirstDiff } = mountDiffEditor()
  expect(revealFirstDiff).toHaveBeenCalledTimes(1)

  // 换文件：库走 setValue 不重建编辑器，所以得靠记住的实例再定位一次
  await rerender!({ oldText: 'a2\n', newText: 'b2\n', fileName: 'a.txt' })
  expect(revealFirstDiff).toHaveBeenCalledTimes(2)
})

it('单栏形态：只画那一栏的列头（横跨两列）+ 单栏编辑器，整份内容按全删除 / 全新增着色', async () => {
  // 删除（只有旧侧有内容）
  const host = await mount(OLD_TEXT, '', 'src/a.ts', 'old')

  expect(host.querySelector('.diff-editor-stub')).toBeNull()
  expect(host.querySelector('.editor-stub')).not.toBeNull()
  expect(state.editorProps?.value).toBe(OLD_TEXT)
  expect(state.editorProps?.language).toBe('typescript')
  expect(state.editorProps?.theme).toBe('virlen-dark')

  // 单栏的选项里没有「对比」专属的那几个开关（那份只有一栏内容）
  const so = state.editorProps!.options as MonacoNsOptions
  expect(so.readOnly).toBe(true)
  expect(so.contextmenu).toBe(false)
  expect(so.renderSideBySide).toBeUndefined()
  expect(so.originalEditable).toBeUndefined()

  const heads = [...host.querySelectorAll('.diff-col-header')]
  expect(heads).toHaveLength(1)
  expect(heads[0].className).toContain('diff-col-header--old')
  expect(heads[0].className).toContain('diff-col-header--single')
  expect(heads[0].textContent).toContain('原文件')
  expect(heads[0].textContent).toContain('Ln 1–3')
  expect(host.querySelector('.diff-col-header--new')).toBeNull()

  // 整份内容按「全删除」着色：直接用 Monaco 差异编辑器自己那两条类名（配色同源）
  const removed = mountSingleEditor(OLD_TEXT)
  expect(removed.createDecorationsCollection).toHaveBeenCalledWith([
    {
      range: FULL_RANGE,
      options: {
        isWholeLine: true,
        className: 'line-delete',
        marginClassName: 'gutter-delete',
      },
    },
  ])

  // 换成新增（同一份编辑器实例不重建）：列头 → 新文件，底色 → 全新增
  await rerender!({
    oldText: '',
    newText: NEW_TEXT,
    fileName: 'src/a.ts',
    singleSide: 'new',
  })
  expect(state.editorProps?.value).toBe(NEW_TEXT)
  const head = host.querySelector('.diff-col-header')
  expect(head?.className).toContain('diff-col-header--new')
  expect(head?.textContent).toContain('新文件')
  expect(head?.textContent).toContain('Ln 1–2')
  expect(removed.decorations.set).toHaveBeenCalledWith([
    {
      range: FULL_RANGE,
      options: {
        isWholeLine: true,
        className: 'line-insert',
        marginClassName: 'gutter-insert',
      },
    },
  ])
})

it('右键菜单（单栏）：复制读开菜单那一刻的选区，「全选」把整份选上且不写栏名', async () => {
  const host = await mount('', NEW_TEXT, 'src/a.ts', 'new')
  const fake = mountSingleEditor(NEW_TEXT)

  // 无选区：只提示先选，不碰剪贴板
  await rightClick(host.querySelector('.git-mono-diff')!)
  expect(menuLabels()).toEqual(['复制', '全选'])
  await act(async () => menuButtons()[0].click())
  expect(showToast).toHaveBeenCalledWith('请先选择要复制的内容')
  expect(copyText).not.toHaveBeenCalled()

  // 「全选」：选中整个模型 + 菜单保持打开（紧接着就能复制）；快照取整份文本
  await rightClick(host.querySelector('.git-mono-diff')!)
  await act(async () => menuButtons()[1].click())
  expect(fake.editor.setSelection).toHaveBeenCalledWith(FULL_RANGE)
  expect(fake.editor.focus).toHaveBeenCalled()
  expect(document.querySelector('.context-menu')).toBeTruthy()
  await act(async () => menuButtons()[0].click())
  expect(copyText).toHaveBeenCalledWith(NEW_TEXT)
})

it('右键菜单（两栏）：按落点分辨是哪一栏（列头也算），复制读快照，且不冒泡到外层', async () => {
  const outer = vi.fn()
  const host = await mount(OLD_TEXT, NEW_TEXT, 'a.txt', undefined, outer)
  const diff = mountDiffEditor()

  // 右栏有选区：复制拿到选区文本；开菜单后选区丢了也不影响（快照）
  diff.modified.model.getValueInRange = vi.fn(() => 'PICKED')
  diff.modified.editor.getSelection = vi.fn(() => ({ isEmpty: () => false }))
  await rightClick(host.querySelector('.diff-col-header--new')!)
  expect(menuLabels()).toEqual(['复制', '全选新文件'])
  expect(outer).not.toHaveBeenCalled()
  diff.modified.editor.getSelection = vi.fn(() => null)
  await act(async () => menuButtons()[0].click())
  expect(copyText).toHaveBeenCalledWith('PICKED')

  // 全选右栏：只选那一栏的整个模型（左栏一动没动）
  await rightClick(host.querySelector('.diff-col-header--new')!)
  await act(async () => menuButtons()[1].click())
  expect(diff.modified.editor.setSelection).toHaveBeenCalledWith(FULL_RANGE)
  expect(diff.original.editor.setSelection).not.toHaveBeenCalled()

  // 落点不在任何一栏（两栏之外的 padding / 根节点）→ 兜底「原文件」
  await rightClick(host.querySelector('.git-mono-diff')!)
  expect(menuLabels()).toEqual(['复制', '全选原文件'])
})

it('聊天里那几个 props：文件头 + 动作按钮、autoHeight、行号映射、列头说明', async () => {
  const onClick = vi.fn()
  const host = await mount(OLD_TEXT, NEW_TEXT, 'src/a.ts', undefined, undefined, {
    autoHeight: true,
    showHeader: true,
    actions: [{ title: '打开文件', onClick }],
    lineNumbers: {
      old: (line) => String(line + 249),
      new: (line) => (line === 2 ? '' : String(line + 249)),
    },
    colHeaderNote: { old: 'Ln 250–252', new: null },
  })

  // 文件头（与 DOM 版同一套 .diff-header）：文件名 + 动作按钮
  expect(host.querySelector('.diff-header-name')?.textContent).toBe('src/a.ts')
  const btn = host.querySelector<HTMLButtonElement>('.diff-action-btn')!
  expect(btn.title).toBe('打开文件')
  await act(async () => btn.click())
  expect(onClick).toHaveBeenCalledTimes(1)

  // 高度：类名 + 纯函数（内联 CSS 自定义变量不在 jsdom 里断言）
  const rootEl = host.querySelector('.git-mono-diff')!
  expect(rootEl.className).toContain('is-autoheight')
  expect(rootEl.className).toContain('has-header')
  expect(monacoDiffHeight(3, 12)).toBe(3 * Math.round(12 * 1.55) + 12)

  // 列头说明：给了就用它，给 null 就不显示（多处编辑合并后行号不连续）
  const heads = [...host.querySelectorAll('.diff-col-header')]
  expect(heads[0].querySelector('.diff-col-range')?.textContent).toBe('Ln 250–252')
  expect(heads[1].querySelector('.diff-col-range')?.textContent).toBe('')

  // 行号映射：两栏各装一份（差异编辑器的两栏各有自己的行号）
  const diff = mountDiffEditor()
  // 取 vi 记录的最后一回调用（不用 `.at(-1)`：`lib` 是 ES2020，没有 `Array.prototype.at`）
  const lastOptions = (editor: { updateOptions: { mock: { calls: unknown[][] } } }) => {
    const calls = editor.updateOptions.mock.calls
    return calls[calls.length - 1]?.[0] as { lineNumbers: (line: number) => string }
  }
  const firstCall = (): ((line: number) => string) => lastOptions(diff.original.editor).lineNumbers
  const newCall = lastOptions(diff.modified.editor)
  expect(firstCall()(3)).toBe('252')
  // 占位行 / 另一侧没有的行给空串（不编号）
  expect(newCall.lineNumbers(2)).toBe('')

  // ⚠️ 喂给 Monaco 的必须是**同一个函数**（身份一变它就重排行号栏），但内容跟着最新那份 prop 走
  const stableBefore = firstCall()
  await rerender!({
    oldText: OLD_TEXT,
    newText: NEW_TEXT,
    fileName: 'src/a.ts',
    lineNumbers: { old: (line) => String(line), new: (line) => String(line) },
  })
  // 换了一份映射对象之后，Monaco 手上还是那个函数（没为它再塞一个进去）……
  expect(firstCall()).toBe(stableBefore)
  // ……而它读到的已经是最新那份（闭包里走 ref）
  expect(stableBefore(3)).toBe('3')

  // 单栏形态也吃同一份映射（那份走构造选项，不是 updateOptions）
  act(() => root!.unmount())
  document.body.innerHTML = ''
  await mount(OLD_TEXT, '', 'src/a.ts', 'old', undefined, {
    lineNumbers: { old: (line) => String(line + 99) },
  })
  const so = state.editorProps!.options as MonacoNsOptions
  expect(so.lineNumbers?.(1)).toBe('100')
})

it('两个列头（原文件 / 新文件 + Ln 区间）都在，行数按 Monaco 的行号口径算', async () => {
  const host = await mount('a\nb\n', 'x\n', 'a.txt')

  const heads = [...host.querySelectorAll('.diff-col-header')]
  expect(heads).toHaveLength(2)
  expect(heads[0].className).toContain('diff-col-header--old')
  expect(heads[0].textContent).toContain('原文件')
  // 末尾那个换行也算一行（与 Monaco 里的行号对得上）
  expect(heads[0].textContent).toContain('Ln 1–3')
  expect(heads[1].className).toContain('diff-col-header--new')
  expect(heads[1].textContent).toContain('新文件')
  expect(heads[1].textContent).toContain('Ln 1–2')
})

it('布局契约：两等宽列 + 一行列头，编辑器占满剩余高度，且结构上不可能溢出外层', () => {
  const css = compileString(
    readFileSync(
      'src/ui/pages/chat/components/message/MonacoDiffView.scss',
      'utf8',
    ),
  )
    .css
    // 去掉注释：dart-sass 保留 loud 注释，而注释里也会写到同样的属性文本，
    // 不剥掉就会把断言带偏（与 git-panel-style-contract 同一处理）
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // 结构规则只有一处（聊天里的 edit_file 消息与 git 弹窗共用这一份 SCSS）
  expect(css).toMatch(/\.git-mono-diff\s*\{[^}]*display:\s*grid/)
  // ⚠️ 必须是 minmax(0, 1fr)：`1fr` 的下限是 min-content，Monaco 能把列顶宽
  //（窄窗口下就变成外层的横向滚动条，→ 与 Monaco 的 ResizeObserver 互相追着闪）
  expect(css).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
  )
  expect(css).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/)
  // 单栏形态的那一个列头必须横跨两列（只占左半的话，与下面铺满的单栏正文对不上）
  expect(css).toMatch(
    /\.git-mono-diff\s*>\s*\.diff-col-header--single\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
  )
  // 编辑器必须拿到确定高度（Monaco 按容器尺寸排版）
  expect(css).toMatch(
    /\.git-mono-diff-editor\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
  )
  expect(css).toMatch(/\.git-mono-diff-editor\s*\{[^}]*min-height:\s*0/)
  // 「外层滚动条疯狂闪动」那条回路：子节点自己裁（overflow: hidden）→ 外层（.git-diff-body,
  // overflow: auto）永远看不到溢出；列头也不许把列顶宽
  expect(css).toMatch(/\.git-mono-diff\s*\{[^}]*overflow:\s*hidden/)
  expect(css).toMatch(/\.git-mono-diff-editor\s*\{[^}]*overflow:\s*hidden/)
  expect(css).toMatch(
    /\.git-mono-diff\s*>\s*\.diff-col-header\s*\{[^}]*min-width:\s*0/,
  )
  expect(css).toMatch(
    /\.git-mono-diff\s*>\s*\.diff-col-header\s*\{[^}]*overflow:\s*hidden/,
  )
  // 聊天里的外壳：宽度必须是确定值（fit-content 会与 Monaco 的 automaticLayout 互相追）
  expect(css).toMatch(/\.diff-mono-wrapper\s*\{[^}]*min-width:\s*0/)
  // 有文件头时多一行（聊天里画文件名 + 动作按钮）
  expect(css).toMatch(/\.git-mono-diff\.has-header\s*\{[^}]*grid-template-rows:[^;]*;[^}]*\}/)
  // autoHeight：高度由组件算好写在 --mono-diff-h 上，上限 --mono-diff-max-h
  expect(css).toMatch(
    /\.git-mono-diff\.is-autoheight\s*>\s*\.git-mono-diff-editor\s*\{[^}]*height:\s*var\(--mono-diff-h\)/,
  )
  // 选区颜色局部调亮（改动底色半透明 → 选区的对比度被刨掉一半；见 SCSS 里那两条 ⚠️）：
  // 必须落在本组件的容器内（带 `.git-mono-diff ` 前缀），否则会把全局的代码预览一起改掉
  expect(css).toMatch(
    /\.git-mono-diff\s+\.monaco-editor[^{]*\{[^}]*--vscode-editor-selectionBackground:\s*#505868/,
  )
  expect(css).toMatch(
    /\.git-mono-diff\s+\.monaco-editor[^{]*\{[^}]*--vscode-editor-inactiveSelectionBackground:/,
  )
})

it('git 弹窗那份只负责「高度从哪来」（高度给 100%），结构规则不重复定义', () => {
  const css = compileString(
    readFileSync('src/ui/pages/chat/components/git/style.scss', 'utf8'),
  ).css.replace(/\/\*[\s\S]*?\*\//g, '')

  expect(css).toMatch(
    /\.git-diff-body\s*>\s*\.git-mono-diff\s*\{[^}]*height:\s*100%/,
  )
})
