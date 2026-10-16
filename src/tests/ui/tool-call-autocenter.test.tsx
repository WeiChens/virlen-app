import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import EditFileMessage from '@/ui/pages/chat/components/tool-call/EditFileMessage'
import { AUTO_CENTER_DELAY_MS } from '@/ui/hooks/useAutoCenter'

/**
 * edit_file 展开视图的「打开即居中」回归。
 *
 * 为什么单独守一条：
 *   - 曾经 `useAutoCenter()` 被写在 EditFileMessage 的**类方法** `renderExpandView` 里（且有早退分支），
 *     属于条件调用 hook。实测会让 React 内部记账错乱（console.error 打出
 *     `Internal React error: Expected static flag was missing`）并重复触发 effect；
 *   - 正确做法是 hook 只在**组件顶层**无条件调用（现在是 `MonacoDiffView` / `CodeBlock` 的 `autoCenter`），
 *     由「用户展开」这一步驱动。
 * 因此这里同时断言：① 不出现任何 React 内部报错；② 每次展开只居中一次。
 */

// Monaco 在 jsdom 里跑不起来（缺 CSS.escape 等浏览器 API）：本用例只关心「何时居中」，
// 词法着色 / 差异计算不在此测 —— 差异正文（`MonacoDiffView`）那两条路都换成替身。
// ⚠️ 换成真组件的话，`@monaco-editor/react` 的 loader 会去加载 monaco（走 CDN）→ 控制台报错，
// 而本用例恰好断言「控制台没有 React 内部报错」。
vi.mock('@monaco-editor/react', () => {
  const Stub = () => <div className="mono-stub" />
  return {
    default: Stub,
    Editor: Stub,
    DiffEditor: Stub,
    loader: { config: () => {} },
  }
})

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

/**
 * 等「打开即居中」落地：hook 里有一次 [`AUTO_CENTER_DELAY_MS`] 的延迟（等布局稳定 —— 展开瞬间
 * 量到的高度是过渡中的，就是那个「展开后自己往上跳一下」的抖动在修的东西），所以断言前必须让
 * 那个定时器真的跑完。曾经这里在 `act()` 之后同步断言「已经居中」，实现改成延迟后就必然假红
 * （CI 三个平台一起红就是这么来的）。
 */
async function flushAutoCenter(expected?: number) {
  await act(async () => {
    // 先让 hook 里那段延迟到点（+ 余量：慢机器上定时器会被拖后）
    await new Promise((resolve) => setTimeout(resolve, AUTO_CENTER_DELAY_MS + 60))
    // 期望「确实居中了几次」时再轮询一小会儿，别把慢机器拖成假红；
    // 不传 expected = 只证明「到点了也没人再来滚」（钉「收起后不许再跳」）
    const deadline = Date.now() + 1000
    while (
      expected != null &&
      scrollCalls.length < expected &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  })
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

  it('每次展开居中一次，且不触发 React 内部报错', async () => {
    act(() => root.render(<Harness expand={false} />))
    expect(scrollCalls.length).toBe(0) // 折叠时不挂载 → 不居中

    act(() => root.render(<Harness expand={true} />))
    await flushAutoCenter(1)
    expect(scrollCalls.length).toBe(1)

    act(() => root.render(<Harness expand={false} />))
    await flushAutoCenter()
    expect(scrollCalls.length).toBe(1) // 收起不居中

    act(() => root.render(<Harness expand={true} />))
    await flushAutoCenter(2)
    expect(scrollCalls.length).toBe(2) // 再次展开 → 再居中一次

    // hook 被条件调用会让 React 打出内部错误（见文件头注释）
    expect(errors).toEqual([])
  })

  it('展开后立刻收起 → 延迟窗口里的那次居中作废（不许自己跳一下）', async () => {
    act(() => root.render(<Harness expand={true} />))
    // 延迟还没到就折起来：用户看到的是「刚点开又收起」，此时再滚一下纯属捣乱
    act(() => root.render(<Harness expand={false} />))
    await flushAutoCenter()
    expect(scrollCalls.length).toBe(0)
    expect(errors).toEqual([])
  })
})
