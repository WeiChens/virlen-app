/**
 * CodePreview → Monaco 的选项契约：「不需要滚动的高度，滚轮却能推开一点」那两个来源的另一半。
 *
 * 症状有两个来源，一个在容器高度、一个在选项：
 *  1. 容器比 Monaco 的**内容高度**矮 1px → 多出 1px 可滚范围。`scrollbar.vertical: 'hidden'`
 *     只是「没有滚动条」，不是「不能滚」—— 滚轮照样能把内容推上去，而
 *     `alwaysConsumeMouseWheel: false` 只在**滚不动**时才把滚轮让给外层消息列表。
 *     容器高度由 `codePreviewHeight` 算（等式见 `code-theme-contract.test.ts`）。
 *  2. 横向滚动条默认还会把自己那 10px 加进**内容高度**
 *     （0.56 `viewLayout.js::_getContentHeight`：`linesTotalHeight + horizontalScrollbarSize`）
 *     → 「按行数算出来的等高容器」凭空多出 10px 可滚范围。
 *
 * jsdom 没有布局（Monaco 连字号都量不出来），真实滚轮行为测不到；这里只钉住我们交下去的选项。
 *
 * 用法：`CodePreview` 的 `height` 由调用方给（聊天里是 `codePreviewHeight(行数, 行高)`，
 * 用例见 `code-block-height.test.tsx`）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { EditorProps } from '@monaco-editor/react'

// monaco 在 jsdom 里导入即崩（缺 CSS.escape）；本用例也只看选项，不看词法着色
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

/** 抓住最近一次渲染交给 Monaco 的 props（真编辑器在 jsdom 里起不来） */
const state = vi.hoisted(() => ({ props: null as EditorProps | null }))
vi.mock('@monaco-editor/react', () => ({
  default: (props: EditorProps) => {
    state.props = props
    return <div className="editor-stub" />
  },
  loader: { config: (): void => {} },
}))

/**
 * 一个只满足 CodePreview 会碰的那几个成员的编辑器替身。
 * `setContentHeight` 模拟「Monaco 重算了内容尺寸」（fitContent 的测量就在那条回路上）。
 */
function makeFakeEditor(initialContentHeight: number) {
  let contentHeight = initialContentHeight
  const listeners: ((e: { contentHeightChanged: boolean }) => void)[] = []
  return {
    editor: {
      updateOptions: (): void => {},
      onDidChangeCursorSelection: (): void => {},
      onDidContentSizeChange: (
        cb: (e: { contentHeightChanged: boolean }) => void,
      ): void => {
        listeners.push(cb)
      },
      getSelection: (): null => null,
      getModel: (): null => null,
      getContentHeight: (): number => contentHeight,
      focus: (): void => {},
      setSelection: (): void => {},
    },
    setContentHeight(next: number): void {
      contentHeight = next
      listeners.forEach((cb) => cb({ contentHeightChanged: true }))
    },
  }
}

import CodePreview from '@/ui/components/code-preview/CodePreview'
import {
  CODE_PREVIEW_PADDING,
  codeLineHeightPx,
  codePreviewHeight,
} from '@/domain/code-display'

/** 只取本用例碰到的键，避免把 Monaco 的整个类型搬进来 */
type PreviewOptions = {
  padding?: { top?: number; bottom?: number }
  scrollbar?: {
    vertical?: string
    horizontal?: string
    alwaysConsumeMouseWheel?: boolean
    horizontalScrollbarSize?: number
    ignoreHorizontalScrollbarInContentHeight?: boolean
  }
}

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const CODE = 'const a = 1\nconst b = 2'
const LINE_HEIGHT = codeLineHeightPx(13)

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function mount(): Promise<PreviewOptions> {
  await act(async () =>
    root.render(
      <CodePreview
        code={CODE}
        language="typescript"
        height={codePreviewHeight(2, LINE_HEIGHT)}
      />,
    ),
  )
  return state.props!.options as PreviewOptions
}

beforeEach(() => {
  state.props = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

it('上下 padding 取共享常量（Monaco 的 padding 与容器高度必须是同一份数）', async () => {
  const o = await mount()
  expect(o.padding).toMatchObject(CODE_PREVIEW_PADDING)
  // 高度那条等式要成立，padding 就不能在组件里另写一份字面量
  expect(codePreviewHeight(2, LINE_HEIGHT)).toBe(
    2 * LINE_HEIGHT + CODE_PREVIEW_PADDING.top + CODE_PREVIEW_PADDING.bottom,
  )
})

it('横向滚动条不许把自己那 10px 加进内容高度（否则等高容器多出 10px 可滚范围）', async () => {
  const o = await mount()
  expect(o.scrollbar?.ignoreHorizontalScrollbarInContentHeight).toBe(true)
  // 它现在是浮在内容上的：底 padding 必须盖得住，否则最后一行被压住一条
  expect(o.padding?.bottom).toBeGreaterThanOrEqual(
    o.scrollbar?.horizontalScrollbarSize ?? 0,
  )
  // 横向仍要能滚（长行不折行）
  expect(o.scrollbar?.horizontal).toBe('auto')
})

it('自身没有纵向溢出时把滚轮让给外层（纵向滚动条藏形、且不吃滚轮）', async () => {
  const o = await mount()
  expect(o.scrollbar?.vertical).toBe('hidden')
  expect(o.scrollbar?.alwaysConsumeMouseWheel).toBe(false)
})

/**
 * fitContent：高度以**编辑器报的内容高度**为准（`height` 只当首帧估计）。
 *
 * 现实里的回报：一眼看过去 17 行的 CRLF 文件，我们把末尾 `\r\n` 剥成只剩一个裸 `\r`，
 * 按 `split('\n')` 只数出 16 行 → 容器矮一行 = 16px 可滚范围（实测就是这个数）。
 * 行数只能由 Monaco 说了算。
 */
it('fitContent：首帧用调用方的估算，之后跟编辑器报的内容高度走', async () => {
  const estimate = codePreviewHeight(16, 16)
  const measured = codePreviewHeight(17, 16) // Monaco：17 行（末尾裸 \r 也算换行）

  await act(async () =>
    root.render(
      <CodePreview code={CODE} language="typescript" height={estimate} fitContent />,
    ),
  )
  expect(state.props?.height).toBe(estimate)

  const fake = makeFakeEditor(estimate)
  await act(async () => {
    state.props?.onMount?.(fake.editor as never, {} as never)
  })
  expect(state.props?.height).toBe(estimate)

  // 编辑器重算内容尺寸 → 高度跟着它（多一行就多 16px，容器不再矮一行）
  await act(async () => fake.setContentHeight(measured))
  expect(state.props?.height).toBe(measured)
})

it('不传 fitContent 时高度只用调用方给的值（固定高度的预览不许自己长）', async () => {
  await act(async () =>
    root.render(<CodePreview code={CODE} language="typescript" height={220} />),
  )
  const fake = makeFakeEditor(999)
  await act(async () => {
    state.props?.onMount?.(fake.editor as never, {} as never)
  })
  await act(async () => fake.setContentHeight(999))
  expect(state.props?.height).toBe(220)
})
