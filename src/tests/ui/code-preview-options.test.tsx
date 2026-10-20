/**
 * CodePreview → Monaco 的选项契约：滚动归谁、高度怎么算。
 *
 * 2026-10 重构后：纵向滚动由 **Monaco 内置滚动条**承担（`maxContentHeight` 夹紧时
 * `scrollbar.vertical: 'auto'`），外层（聊天代码块）不再套 `overflow: auto` ——
 * 外层滚动那版会把 Ctrl+F 的查找框一起滚出视野。没超上限时高度仍等于内容高度、不开滚动条。
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

it('未超上限时纵向滚动条藏形（差 1px 也不冒幽灵条），且不吃掉外层的滚轮', async () => {
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

/**
 * 超过上限 → 高度钉上限 + 内置滚动条；不超过 → 与内容等高、不出现滚动条。
 *
 * 这是「外层自定义滚动条」退场的契约：滚动必须发生在 Monaco 里，`find-widget` 才不会被滚走。
 */
it('超过 maxContentHeight：高度钉在上限、内置纵向滚动条打开', async () => {
  const estimate = codePreviewHeight(80, 16)
  await act(async () =>
    root.render(
      <CodePreview
        code={CODE}
        language="typescript"
        height={estimate}
        fitContent
        maxContentHeight={300}
      />,
    ),
  )
  expect(state.props?.height).toBe(300)
  expect((state.props?.options as PreviewOptions).scrollbar?.vertical).toBe('auto')
})

it('未超 maxContentHeight：高度 = 内容高度，滚动条保持藏形', async () => {
  const estimate = codePreviewHeight(2, 16)
  await act(async () =>
    root.render(
      <CodePreview
        code={CODE}
        language="typescript"
        height={estimate}
        fitContent
        maxContentHeight={400}
      />,
    ),
  )
  expect(state.props?.height).toBe(estimate)
  expect((state.props?.options as PreviewOptions).scrollbar?.vertical).toBe('hidden')
})

it('编辑器后来报的内容高度超过上限：一样钉在上限并放出自带滚动条', async () => {
  const estimate = codePreviewHeight(2, 16)
  await act(async () =>
    root.render(
      <CodePreview
        code={CODE}
        language="typescript"
        height={estimate}
        fitContent
        maxContentHeight={300}
      />,
    ),
  )
  const fake = makeFakeEditor(estimate)
  await act(async () => {
    state.props?.onMount?.(fake.editor as never, {} as never)
  })
  await act(async () => fake.setContentHeight(900))
  expect(state.props?.height).toBe(300)
  expect((state.props?.options as PreviewOptions).scrollbar?.vertical).toBe('auto')
})
