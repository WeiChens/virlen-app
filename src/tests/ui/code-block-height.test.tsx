/**
 * 代码块容器高度（调用方那一侧）：`MonacoCodeView` 必须把
 * `codePreviewHeight(行数, 行高)` 原样交给 `CodePreview`。
 *
 * 为什么是条等式而不是「差不多就行」：Monaco 的内容高度 = `行数 × 行高 + 上下 padding`
 *（0.56 `linesLayout.js::getLinesTotalHeight`）。没超过代码区上限时高度就等于内容高度、
 * 且不开滚动条，所以容器矮 1px 就把最后一行裁掉（没有滚动条可拖）；高出来那一截是多余底色。
 *
 * 曾经那版估算 `max(行高 + 16, 5 + (行数 + 1) × 行高)` 只是**在默认字号下**凑巧对上
 *（行高 20 → 比内容高 1px）：字号 / 行高一改就翻成负数（字号 11 + 行高 1.2 → 行高 13 → 矮 6px），
 * 于是「不需要滚动的高度，滚轮也能推开一点」。本用例守的就是这个回归。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// Monaco 在 jsdom 里起不来（按容器尺寸排版，还没有 canvas 度量）：只抓 CodeBlock 交下去的 props
const state = vi.hoisted(() => ({ props: null as Record<string, any> | null }))
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: (props: Record<string, any>) => {
    state.props = props
    return <pre className="mock-code-preview">{props.code}</pre>
  },
}))
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
  copyImageToClipboard: vi.fn(() => Promise.resolve(true)),
  saveImageAs: vi.fn(() => Promise.resolve('')),
  defaultImageName: vi.fn(() => 'image-1'),
  imageMimeOf: vi.fn(() => 'image/png'),
  imageExtOf: vi.fn(() => 'png'),
  readImageBytes: vi.fn(() => Promise.resolve(new Uint8Array())),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): Record<string, unknown> => ({ Toast: (): null => null, showToast: vi.fn() }),
}))
vi.mock('@/services/editor-service', () => ({
  editorService: {
    isEnabled: vi.fn(() => false),
    getSelectedConfig: vi.fn(() => undefined),
    getSelectedCommand: vi.fn(() => ''),
    openFile: vi.fn(() => Promise.resolve({ ok: true })),
    openWithConfig: vi.fn(() => Promise.resolve({ ok: true })),
  },
}))

import CodeBlock from '@/ui/pages/chat/components/message/code-block'
import {
  DEFAULT_CODE_DISPLAY_SETTINGS,
  codeLineHeightPx,
  codePreviewHeight,
} from '@/domain/code-display'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const LINE = 'const a = 1'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function mount(code: string, fontSize?: number): Promise<void> {
  await act(async () =>
    root.render(
      <CodeBlock className="language-ts" fontSize={fontSize}>
        {code}
      </CodeBlock>,
    ),
  )
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

it('高度 = 行数 × 行高 + 上下 padding（不多 1px、也不少 1px）', async () => {
  const fontSize = 16
  await mount(Array.from({ length: 7 }, () => LINE).join('\n'), fontSize)

  const lh = codeLineHeightPx(fontSize, DEFAULT_CODE_DISPLAY_SETTINGS.codeLineHeight)
  expect(state.props?.height).toBe(codePreviewHeight(7, lh))
})

it('末尾换行按三种行尾剥（只剥 `\n` 会让 CRLF 文件剩一个裸 `\r` → Monaco 多算一行）', async () => {
  const lh = codeLineHeightPx(
    DEFAULT_CODE_DISPLAY_SETTINGS.codeFontSize,
    DEFAULT_CODE_DISPLAY_SETTINGS.codeLineHeight,
  )
  // Windows 文件（read_file 原样给 CRLF）：末尾 `\r\n` 必须整个剥掉
  await mount(`${LINE}\r\n${LINE}\r\n${LINE}\r\n`)
  const code = state.props?.code as string
  expect(code.endsWith('\r')).toBe(false)
  expect(code.endsWith('\n')).toBe(false)
  expect(code.split('\n').length).toBe(3)
  expect(state.props?.height).toBe(codePreviewHeight(3, lh))

  // 老 Mac 行尾（孤立 `\r`）同理：剥掉那个 `\r`，行数与我们算的一致
  await mount(`${LINE}\r${LINE}\r`)
  expect((state.props?.code as string).endsWith('\r')).toBe(false)
})

it('高度交给编辑器自己报（首帧只给估算）——行数口径不同时不再多出一条可滚范围', async () => {
  await mount(LINE)
  expect(state.props?.fitContent).toBe(true)
})

it('末尾换行不算一行；单行代码也按 1 行算（不能退化成固定高度）', async () => {
  const lh = codeLineHeightPx(
    DEFAULT_CODE_DISPLAY_SETTINGS.codeFontSize,
    DEFAULT_CODE_DISPLAY_SETTINGS.codeLineHeight,
  )

  // 代码块会把末尾那一个换行去掉（`String(children).replace(/(\r\n|\r|\n)$/, '')`），Monaco 的模型同样只有 3 行
  await mount(`${LINE}\n${LINE}\n${LINE}\n`)
  expect(state.props?.height).toBe(codePreviewHeight(3, lh))

  await mount(LINE)
  expect(state.props?.height).toBe(codePreviewHeight(1, lh))
})

/**
 * `maxHeight` 只限「代码区」，且必须**换成像素上限**交给 CodePreview：
 * 纵向滚动从此在 Monaco 内部（带库自带滚动条），外层 wrapper 不再 `overflow: auto`——
 * 外层滚动那版会把 Ctrl+F 的查找框一起滚出视野。
 */
it('maxHeight 换算成代码区像素上限交给 CodePreview（px 原样、vh 按视口）', async () => {
  await act(async () =>
    root.render(
      <CodeBlock className="language-ts" maxHeight={450}>
        {LINE}
      </CodeBlock>,
    ),
  )
  expect(state.props?.maxContentHeight).toBe(450)
  // 外层不再自己滚：wrapper 上不该再有 max-height / overflow
  const wrapper = container.querySelector('.code-block-wrapper') as HTMLElement
  expect(wrapper.style.maxHeight).toBe('')
  expect(wrapper.style.overflow).toBe('')

  await act(async () =>
    root.render(
      <CodeBlock className="language-ts" maxHeight="55vh">
        {LINE}
      </CodeBlock>,
    ),
  )
  // jsdom 的 innerHeight = 768 → 55vh；把 '55vh' 原样递给 Monaco 它是认不出来的
  expect(state.props?.maxContentHeight).toBeCloseTo(window.innerHeight * 0.55, 5)
})

it('不传 maxHeight 时不夹紧（内容多高块就多高）', async () => {
  await mount(LINE)
  expect(state.props?.maxContentHeight).toBeUndefined()
})
