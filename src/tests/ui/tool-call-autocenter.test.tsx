import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import EditFileMessage from '@/ui/pages/chat/components/tool-call/EditFileMessage'

/**
 * edit_file 展开视图的「打开即居中」回归。
 *
 * 为什么单独守一条：
 *   - 曾经 `useAutoCenter()` 被写在 EditFileMessage 的**类方法** `renderExpandView` 里（且有早退分支），
 *     属于条件调用 hook。实测会让 React 内部记账错乱（console.error 打出
 *     `Internal React error: Expected static flag was missing`）并重复触发 effect；
 *   - 正确做法是 hook 只在**组件顶层**无条件调用（现在是 SideBySideDiff / CodeBlock 的 `autoCenter`），
 *     由「用户展开」这一步驱动。
 * 因此这里同时断言：① 不出现任何 React 内部报错；② 每次展开只居中一次。
 */

// Monaco 在 jsdom 里跑不起来（缺 CSS.escape 等浏览器 API）：本用例只关心「何时居中」，
// 词法着色不在此测 —— 与 side-by-side-diff.test.tsx 同一套替身。
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: { rules: [] as unknown[] },
}))

vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  toMonacoLang: (): string | undefined => undefined,
  default: ({ children }: any) => <pre>{children}</pre>,
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const scrollCalls: unknown[] = []
const origScrollTo = (Element.prototype as any).scrollTo

const inst = new EditFileMessage()
const useContent: any = { name: 'edit_file', input: { path: 'a.ts' } }
const message: any = {
  uiData: {
    fullPath: 'C:/x/a.ts',
    edits: [
      {
        oldStartLine: 1,
        oldEndLine: 1,
        newEndLine: 1,
        oldString: 'a',
        newString: 'b',
      },
    ],
  },
  content: 'ok',
}

/** 与 tool-call/index.tsx 的 `ToolCallExpandView` 同构：在组件渲染里调 getExpandView */
function Harness({ expand }: { expand: boolean }) {
  return (
    <div className="host">
      {inst.getExpandView({ useContent, message, expand }) as any}
    </div>
  )
}

describe('edit_file 展开视图：打开即居中', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let errors: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    scrollCalls.length = 0
    // jsdom 未实现 scrollTo：替身用于计数
    ;(Element.prototype as any).scrollTo = (...args: unknown[]) =>
      scrollCalls.push(args)
    errors = []
    origConsoleError = console.error
    console.error = (...args: any[]) => {
      errors.push(args.map((a) => (a && a.message) || String(a)).join(' '))
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    console.error = origConsoleError
    act(() => root.unmount())
    container.remove()
    ;(Element.prototype as any).scrollTo = origScrollTo
  })

  it('每次展开居中一次，且不触发 React 内部报错', () => {
    act(() => root.render(<Harness expand={false} />))
    expect(scrollCalls.length).toBe(0) // 折叠时不挂载 → 不居中

    act(() => root.render(<Harness expand={true} />))
    expect(scrollCalls.length).toBe(1)

    act(() => root.render(<Harness expand={false} />))
    expect(scrollCalls.length).toBe(1) // 收起不居中

    act(() => root.render(<Harness expand={true} />))
    expect(scrollCalls.length).toBe(2) // 再次展开 → 再居中一次

    // hook 被条件调用会让 React 打出内部错误（见文件头注释）
    expect(errors).toEqual([])
  })
})
