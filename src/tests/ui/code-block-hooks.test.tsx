/**
 * CodeBlock 的 hook 数量必须恒定（线上 React error #300 回归）
 *
 * 线上埋点 `error.react.boundary` 报的是
 *   `Minified React error #300`（Rendered fewer hooks than expected.
 *     This may be caused by an accidental early return statement.）
 * 组件栈形如 `... at code (<anonymous>) at pre (<anonymous>) at ...`，
 * 即 react-markdown 的 `code` 覆盖组件（对象字面量属性名会被 JS 推断为函数名 "code"）
 * 里的 CodeBlock —— 也就是 `observer(CodeBlock)`。
 *
 * 成因：`useAutoCenter()` 曾经写在「行内代码」那条提前 return **之后**，
 * 而行内 / 块状两条渲染路径共用同一个 fiber：
 *   ① 流式回复会做「前缀冻结」：把内容切成 [已定稿前缀][正在增长的尾部]，
 *      尾部只是内容的**后缀**，所以它的首块会因为分界点前移而**换人**（见 splitStablePrefix）；
 *   ② 于是同一个 `pre > code` 位置，先渲染「带语言的围栏」（块状路径 → 有 useAutoCenter），
 *      下一帧换成「无语言、单行内容的围栏」（命中行内提前 return → 少一个 hook）→ React 抛 #300。
 *
 * 本文件守两条：
 *   ① 触发条件确实存在：用真实的 splitStablePrefix 断言「尾部换人」；
 *   ② CodeBlock 在同一位置来回切换块状/行内时 hook 数量不变（不抛 #300 / #310）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import CodeBlock from '@/ui/pages/chat/components/message/code-block'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import { splitStablePrefix } from '@/ui/pages/chat/components/message/streamMarkdown'

// Monaco 在 jsdom 里跑不起来（缺 CSS.escape 等浏览器 API）：只关心 hook 数量，不测着色
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code }: any) => <pre className="mock-code-preview">{code}</pre>,
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 前缀必须 ≥ MIN_STABLE_PREFIX(320)，否则 splitStablePrefix 不切分 */
const PREFIX = '这是一段已经定稿的正文，用来把前缀推过 320 字符阈值。'.repeat(20)

/** 尾部首块 = 带语言的围栏（块状路径） */
const CONTENT_1 = `${PREFIX}\n\n\`\`\`ts\nconst a = 1\n\`\`\``
/** 追加一个「无语言、单行」的围栏后，分界点前移 → 尾部首块换成它（行内路径） */
const CONTENT_2 = `${CONTENT_1}\n\n\`\`\`\nnpm install\n\`\`\``

describe('CodeBlock：行内 / 块状切换不改变 hook 数量', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let errors: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
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
  })

  it('触发条件：前缀冻结会让尾部首块从「带语言围栏」换成「无语言单行围栏」', () => {
    const [, tail1] = splitStablePrefix(CONTENT_1)
    const [, tail2] = splitStablePrefix(CONTENT_2)

    expect(tail1).toBe('```ts\nconst a = 1\n```')
    expect(tail2).toBe('```\nnpm install\n```')
  })

  it('尾部换人（带语言围栏 → 无语言单行围栏）时，不抛 React #300', async () => {
    const [, tail1] = splitStablePrefix(CONTENT_1)
    const [, tail2] = splitStablePrefix(CONTENT_2)

    await act(async () => root.render(<MarkdownRenderer content={tail1} />))
    // 带语言围栏 → 块状路径（Monaco / wrapper）
    expect(container.querySelector('.code-block-wrapper')).toBeTruthy()

    // 同一个 `pre > code` 位置换成无语言单行围栏 → 行内提前 return
    // 修复前：这里从 4 个 hook 掉到 3 个 → React #300
    await act(async () => root.render(<MarkdownRenderer content={tail2} />))
    expect(container.querySelector('.inline-code')).toBeTruthy()

    expect(errors).toEqual([])
  })

  it('同一位置 块状 → 行内 → 块状 往返，hook 数量始终一致', async () => {
    const view = (children: string) => (
      <div className="host">
        <CodeBlock inlineCode>{children}</CodeBlock>
      </div>
    )

    // 有换行、无语言 → 块状路径
    await act(async () => root.render(view('npm install\nnpm run build')))
    expect(container.querySelector('.code-block-wrapper')).toBeTruthy()

    // 同一 fiber 变成无换行 → 行内路径（少一个 hook 就抛 #300）
    await act(async () => root.render(view('npm install')))
    expect(container.querySelector('.inline-code')).toBeTruthy()

    // 再变回块状（多一个 hook 就抛 #310）
    await act(async () => root.render(view('npm install\nnpm run build')))
    expect(container.querySelector('.code-block-wrapper')).toBeTruthy()

    expect(errors).toEqual([])
  })
})
