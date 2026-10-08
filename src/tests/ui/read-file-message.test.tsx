/**
 * read_file 展开视图：多文件 = 一个代码块 + 文件名下拉切换（回归）
 *
 * 背景：多文件（`uiData.files`）原先给每个文件各挂一个 CodeBlock 纵向堆叠 —— 长文件把消息
 * 拉得极长，且要读每个块的头才知道是哪个文件。现在只留一个块，文件名经 CodeBlock 的
 * `fileNameRender` 插槽换成 Select 下拉，点它切换。
 *
 * 本文件守四条：
 *   ① 多文件只渲染**一个**代码块（数量不随文件数涨）；
 *   ② 点文件名 → 下拉里是全部文件（label 短路径 / title 全路径）→ 选中后内容与语言跟着换；
 *   ③ 切换**不换 DOM 节点**（CodeBlock 不重挂载，全屏态与 Monaco 实例都保留），
 *      同时把滚动位置归零（`contentKey`）—— 内容原地替换，不归零会停在上一个文件的偏移上；
 *   ④ 折叠不挂载 / 展开挂载（`getExpandView` 的既有语义不变）。
 *
 * 下拉面板的**几何与配色**（内容撑宽 / 上限 500px / 选项不折行 / 深色皮肤）是纯 CSS + 内联样式，
 * jsdom 不加载 scss 也量不到布局，由 `read-file-style-contract.test.ts` 编译样式后断言；
 * 这里只钉住「调用方真的开了 content 策略、并给了皮肤类名」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import ReadFileMessage from '@/ui/pages/chat/components/tool-call/ReadFileMessage'
import { settingsState } from '@/ui/store'

// Monaco 在 jsdom 里跑不起来（缺 CSS.escape 等浏览器 API）：换成透传替身，
// 并带上 language —— 「语言标签跟着文件名换」这条只能从这里看
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code, language }: any) => (
    <pre className="mock-code-preview" data-lang={language ?? ''}>
      {code}
    </pre>
  ),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE = 'E:/code/demo'
const inst = new ReadFileMessage()

const FILES = [
  {
    fullPath: `${WORKSPACE}/src/a.tsx`,
    content: 'const a = 1',
    startLine: 1,
    endLine: 1,
  },
  {
    fullPath: `${WORKSPACE}/src/b.json`,
    content: '{"b": 2}',
    startLine: 5,
    endLine: 5,
  },
]

const useContent: any = {
  id: '1',
  name: 'read_file',
  input: { paths: FILES.map((f) => f.fullPath) },
}

function resultMessage(files: any[] = FILES, over: Record<string, any> = {}) {
  return {
    id: 'r1',
    role: 'tool',
    content: 'RAW_MODEL_TEXT',
    uiData: { files },
    timestamp: 0,
    ...over,
  } as any
}

/** 与 tool-call/index.tsx 的 `ToolCallExpandView` 同构：在组件渲染里调 getExpandView */
function Harness({ expand = true, files = FILES }: any) {
  return (
    <div className="host">
      {
        inst.getExpandView({
          useContent,
          message: resultMessage(files),
          expand,
        }) as any
      }
    </div>
  )
}

const preview = (host: HTMLElement) => host.querySelector('.mock-code-preview')
const switcher = (host: HTMLElement) =>
  host.querySelector('.code-file-switcher') as HTMLElement | null

describe('read_file 多文件：一个代码块 + 文件名下拉', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let errors: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    settingsState.setValue('defaultWorkspace', WORKSPACE)
    errors = []
    origConsoleError = console.error
    console.error = (...args: any[]) => {
      errors.push(args.map((a) => (a && a.message) || String(a)).join(' '))
    }
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    console.error = origConsoleError
    act(() => root.unmount())
    host.remove()
  })

  it('只渲染一个代码块，默认展示第一个文件', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    expect(host.querySelectorAll('.code-block-wrapper').length).toBe(1)
    // 文件名不再是 CodeBlock 默认那行纯文本，而是下拉：短路径为 label、全路径挂 title
    expect(host.querySelector('.code-file-name')).toBeNull()
    expect(switcher(host)?.textContent).toBe('src/a.tsx')
    expect(switcher(host)?.getAttribute('title')).toBe(FILES[0].fullPath)
    // 正文与语言都取第一个文件
    expect(preview(host)?.textContent).toBe('const a = 1')
    expect(preview(host)?.getAttribute('data-lang')).toBe('typescript')

    // 单个 code 菜单/右键链路只有一份，不该出现重复渲染
    expect(host.querySelectorAll('.code-copy-btn').length).toBe(1)
    expect(errors).toEqual([])
  })

  it('点文件名 → 列出全部文件 → 选中后正文与语言跟随切换', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const wrapperBefore = host.querySelector('.code-block-wrapper')

    await act(async () => {
      switcher(host)!.click()
    })
    const options = [...document.querySelectorAll('.custom-select__option')] as HTMLElement[]
    expect(options.map((o) => o.textContent)).toEqual(['src/a.tsx', 'src/b.json'])
    expect(options.map((o) => o.getAttribute('title'))).toEqual([
      FILES[0].fullPath,
      FILES[1].fullPath,
    ])

    await act(async () => {
      options[1].click()
    })

    // 仍只有一个代码块，且是**同一个 DOM 节点**（没换 key → CodeBlock / Monaco / 全屏态都没重建）
    expect(host.querySelectorAll('.code-block-wrapper').length).toBe(1)
    expect(host.querySelector('.code-block-wrapper')).toBe(wrapperBefore)
    expect(switcher(host)?.textContent).toBe('src/b.json')
    expect(switcher(host)?.getAttribute('title')).toBe(FILES[1].fullPath)
    expect(preview(host)?.textContent).toBe('{"b": 2}')
    expect(preview(host)?.getAttribute('data-lang')).toBe('json')
    // 下拉已收起
    expect(document.querySelectorAll('.custom-select__option').length).toBe(0)

    expect(errors).toEqual([])
  })

  it('切换文件把滚动位置归零（内容原地替换，否则停在上一个文件的偏移上）', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const wrapper = host.querySelector('.code-block-wrapper') as HTMLElement
    // jsdom 没有布局，scrollTop 恒为 0：在实例上盖一个可写值，模拟「用户已经滚下去了」
    Object.defineProperty(wrapper, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })

    await act(async () => {
      switcher(host)!.click()
    })
    const options = [...document.querySelectorAll('.custom-select__option')] as HTMLElement[]
    await act(async () => {
      options[1].click()
    })

    expect(wrapper.scrollTop).toBe(0)
    expect(errors).toEqual([])
  })

  it('下拉面板：宽度交给内容（max-content，上限 500px），并挂上深色皮肤的抓手', async () => {
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      switcher(host)!.click()
    })

    const panel = document.querySelector('.custom-select__dropdown') as HTMLElement
    expect(panel).not.toBeNull()
    // jsdom 量不到文字宽度：面板被盖成「由内容撑开」且封顶 500px 即可，
    // 「选项不折行 + 超出省略」在样式契约用例里（选项规则 + 面板上限能压住长路径）
    expect(panel.classList.contains('is-content-width')).toBe(true)
    expect(panel.style.width).toBe('max-content')
    expect(panel.style.maxWidth).toBe('500px')
    // 面板走 Portal 挂在 body 上，深色皮肤只能靠这个类名才能选中它
    expect(panel.classList.contains('code-file-panel')).toBe(true)

    await act(async () => {
      switcher(host)!.click()
    })
    expect(document.querySelector('.custom-select__dropdown')).toBeNull()
    expect(errors).toEqual([])
  })

  it('折叠时不挂载，展开时挂载', async () => {
    await act(async () => {
      root.render(<Harness expand={false} />)
    })
    expect(host.querySelector('.code-block-wrapper')).toBeNull()

    await act(async () => {
      root.render(<Harness expand={true} />)
    })
    expect(host.querySelectorAll('.code-block-wrapper').length).toBe(1)
    expect(errors).toEqual([])
  })

  it('只有一个文件时同样走下拉（uiData.files 长度为 1）', async () => {
    await act(async () => {
      root.render(<Harness files={[FILES[0]]} />)
    })
    expect(host.querySelectorAll('.code-block-wrapper').length).toBe(1)
    expect(switcher(host)?.textContent).toBe('src/a.tsx')
    expect(preview(host)?.textContent).toBe('const a = 1')
    expect(errors).toEqual([])
  })

  it('错误结果走 error 分支', () => {
    const html = renderToStaticMarkup(
      <>
        {inst.getExpandView({
          useContent,
          message: resultMessage(FILES, { isError: true, content: '读失败了' }),
          expand: true,
        }) as any}
      </>,
    )
    expect(html).toContain('class="error"')
    expect(html).toContain('读失败了')
  })
})

describe('read_file 短文本（input.paths）', () => {
  it('显示首个文件的短路径与「+N」', () => {
    const html = renderToStaticMarkup(
      <>
        {
          inst.getShortText({
            useContent,
            message: resultMessage(),
            expand: false,
          }) as any
        }
      </>,
    )
    expect(html).toContain('src/a.tsx')
    expect(html).toContain('+1')
  })
})
