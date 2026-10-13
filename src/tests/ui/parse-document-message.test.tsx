/**
 * ParseDocumentMessage 测试 — parse_document 工具调用的展示组件
 *
 * 覆盖：
 * - 短文本：短路径 + 「+N」/ 字符数
 * - 展开：一张卡（类型 / 大小 / 字符数 / 工作表徽标 + 正文），失败项按 errorKind 本地化
 * - 多份文档只渲染一张卡，文件名位置是下拉切换（与 read_file 的多文件同款）
 * - note / OCR / 截断 / 全文落盘行的呈现（OCR 与 note 说法重复时只留一处）
 * - 无 uiData（旧消息 / 浏览器回退路径）整段回落 content；结果未回来时占位
 * - 折叠不挂载 + 展开「打开即居中」一次
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import ParseDocumentMessage from '@/ui/pages/chat/components/tool-call/ParseDocumentMessage'
import { getCurrentLanguage } from '@/ui/i18n'
import { settingsState } from '@/ui/store'

/** Toast / 打开路径不进断言：替身化，避免 jsdom 之外的副作用 */
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => {}),
}))

const WORKSPACE = 'E:/code/demo'
const FILE = `${WORKSPACE}/报告.docx`
const zh = () => getCurrentLanguage().startsWith('zh')

const useContent: any = { id: '1', name: 'parse_document', input: { path: FILE } }
const inst = new ParseDocumentMessage()

function msg(over: Record<string, any> = {}) {
  return {
    id: 'r1',
    role: 'tool',
    content: 'RAW_MODEL_TEXT',
    timestamp: 0,
    ...over,
  } as any
}

/** 单文件成功时的 uiData（字段与 Rust `parse_document.rs::ui_data` 对齐） */
const OK_UI = {
  file: FILE,
  ok: true,
  fileType: 'docx',
  byteSize: 1536,
  charCount: 1020,
  truncated: false,
  offset: 0,
  nextOffset: null as number | null,
  sheets: [] as string[],
  sheet: null as string | null,
  note: null as string | null,
  text: '# 季度报告\n\n| 地区 | 销量 |',
}

function expand(over: Record<string, any> = {}, expanded = true) {
  return renderToStaticMarkup(
    <>
      {inst.getExpandView({
        useContent,
        message: msg(over),
        expand: expanded,
      }) as any}
    </>,
  )
}

function shortText(over: Record<string, any> = {}, input?: any) {
  return renderToStaticMarkup(
    <>
      {inst.getShortText({
        useContent: input ? { ...useContent, input } : useContent,
        message: msg(over),
        expand: false,
      }) as any}
    </>,
  )
}

describe('ParseDocumentMessage：注册信息', () => {
  it('工具名 / 标签 / 自绘卡片', () => {
    expect(inst.getToolName()).toBe('parse_document')
    expect(inst.getToolLabel('parse_document')).toBe(
      zh() ? '解析文档' : 'Parse Document',
    )
    expect(inst.diyWrapper()).toBe(true)
  })
})

describe('短文本', () => {
  beforeEach(() => settingsState.setValue('defaultWorkspace', WORKSPACE))

  it('单个文件：短路径（accent）+ 字符数', () => {
    const html = shortText({ uiData: { ...OK_UI } })
    // 展示的是短路径（工作目录内），全路径只挂在 title 上
    expect(html).toContain('>报告.docx</span>')
    expect(html).toContain(`title="${FILE}"`)
    expect(html).toContain('1020')
  })

  it('多文件：首个短路径 + 「+N」', () => {
    const html = shortText({}, { paths: [FILE, `${WORKSPACE}/b.xlsx`] })
    expect(html).toContain('报告.docx')
    expect(html).toContain('+1')
  })

  it('没有可用路径（参数错误）时退回工具名', () => {
    expect(shortText({}, {})).toContain(zh() ? '解析文档' : 'Parse Document')
  })
})

describe('展开视图：成功', () => {
  beforeEach(() => settingsState.setValue('defaultWorkspace', WORKSPACE))

  it('卡片渲染元信息 + 正文，不渲染模型侧英文原文', () => {
    const html = expand({ uiData: { ...OK_UI } })
    expect(html).toContain('doc-view')
    expect(html).toContain('报告.docx')
    expect(html).toContain('docx')
    expect(html).toContain('1.5 KB')
    expect(html).toContain('1020')
    // 正文（uiData.text）必须在；模型侧 content 不出现
    expect(html).toContain('季度报告')
    expect(html).toContain('| 地区 | 销量 |')
    expect(html).not.toContain('RAW_MODEL_TEXT')
  })

  it('工作表：指定 sheet 显示表名；未指定但有表时显示数量', () => {
    expect(expand({ uiData: { ...OK_UI, sheet: '销售' } })).toContain('销售')
    expect(expand({ uiData: { ...OK_UI, sheets: ['Sheet1', 'Sheet2'] } })).toContain(
      zh() ? '2 个工作表' : '2 worksheets',
    )
  })

  it('note（合并区域说明）原样展示', () => {
    const note = 'merged cells show a value only in the region top-left cell'
    const html = expand({ uiData: { ...OK_UI, note } })
    expect(html).toContain(note)
  })

  it('截断：给出总数与继续读取的 offset', () => {
    const html = expand({
      uiData: { ...OK_UI, truncated: true, charCount: 20272, nextOffset: 2000 },
    })
    expect(html).toContain('20272')
    expect(html).toContain('offset=2000')
    expect(html).toContain(zh() ? '内容已截断' : 'Content truncated')
  })

  it('OCR：结构化字段按界面语言重建；与 note 重复时不重复渲染 note', () => {
    const html = expand({
      uiData: {
        ...OK_UI,
        note: 'OCR_NOTE_SENTENCE',
        ocr: { available: true, images: 3, chars: 1500, total: 3 },
      },
    })
    expect(html).not.toContain('OCR_NOTE_SENTENCE')
    expect(html).toContain(zh() ? '端侧 OCR 读取了 3 张图片' : 'On-device OCR read 3 image(s)')
  })

  it('OCR 不可用：按分类重建（models）', () => {
    const html = expand({
      uiData: {
        ...OK_UI,
        ocr: { available: false, unavailableKind: 'models', unavailableReason: 'RAW_EN' },
      },
    })
    expect(html).toContain(zh() ? '端侧视觉模型未安装' : 'the on-device vision model')
    expect(html).not.toContain('RAW_EN')
  })

  it('正文为空时给占位文案', () => {
    const html = expand({ uiData: { ...OK_UI, text: '' } })
    expect(html).toContain(zh() ? '（未提取到文本）' : '(no text extracted)')
  })
})

describe('展开视图：失败', () => {
  beforeEach(() => settingsState.setValue('defaultWorkspace', WORKSPACE))

  it('unsupported：本地化格式名，不渲染模型侧英文', () => {
    const html = expand({
      isError: true,
      uiData: {
        file: `${WORKSPACE}/a.zip`,
        ok: false,
        errorKind: 'unsupported',
        error: 'Document parsing is not supported for .zip',
        fileType: 'zip',
      },
    })
    expect(html).toContain('doc-card is-failed')
    expect(html).toContain('.zip')
    expect(html).toContain(zh() ? '不支持的文档格式' : 'Unsupported document format')
    expect(html).not.toContain('Document parsing is not supported')
  })

  it('too_large：给出大小与上限', () => {
    const html = expand({
      isError: true,
      uiData: {
        file: FILE,
        ok: false,
        errorKind: 'too_large',
        byteSize: 60 * 1024 * 1024,
        limit: 50 * 1024 * 1024,
        fileType: 'pdf',
      },
    })
    expect(html).toContain('60.0 MB')
    expect(html).toContain('50.0 MB')
  })

  it('sheet_not_found：表名 + 可用工作表清单', () => {
    const html = expand({
      isError: true,
      uiData: {
        file: `${WORKSPACE}/a.xlsx`,
        ok: false,
        errorKind: 'sheet_not_found',
        requestedSheet: 'Nope',
        sheets: ['Sheet1', '销售'],
      },
    })
    expect(html).toContain('Nope')
    expect(html).toContain('Sheet1, 销售')
  })

  it('denied / backend 这类技术原文原样给', () => {
    const html = expand({
      isError: true,
      uiData: {
        file: `${WORKSPACE}/secret.txt`,
        ok: false,
        errorKind: 'denied',
        error: 'path is denied by the security policy',
      },
    })
    expect(html).toContain('path is denied by the security policy')
  })
})

describe('展开视图：落盘', () => {
  beforeEach(() => settingsState.setValue('defaultWorkspace', WORKSPACE))

  it('多份文档只渲染一张卡：文件名位置是下拉（不再逐份堆卡）', () => {
    const html = expand({
      uiData: {
        files: [
          { ...OK_UI },
          {
            file: `${WORKSPACE}/b.zip`,
            ok: false,
            errorKind: 'unsupported',
            fileType: 'zip',
          },
        ],
      },
    })
    expect(html.match(/doc-card/g)?.length).toBe(1) // 只渲当前选中那张
    expect(html).toContain('doc-file-switcher')
    // 只断言「文件名本身不再由 .doc-name 显示」（外层还有 .doc-name-wrapper 容器，
    // 这里不能用子串 'doc-name'：它会被容器名误伤 —— 该容器是后来加的）
    expect(html).not.toContain('class="doc-name"') // 文件名改由下拉显示
    expect(html).toContain('报告.docx') // 下拉当前的标签
    expect(html).toContain('季度报告')
    expect(html).not.toContain('b.zip') // 未选中的那份不渲染（在下拉里）
  })

  it('outTxtFile：已保存 / 失败两种说法', () => {
    const ok = expand({
      uiData: {
        ...OK_UI,
        outTxtFile: { path: `${WORKSPACE}/out/full.txt`, ok: true, charCount: 20272, byteSize: 28000 },
      },
    })
    expect(ok).toContain('full.txt')
    expect(ok).toContain('20272')
    expect(ok).toContain(zh() ? '全文已保存到' : 'Full text saved to')

    const bad = expand({
      uiData: {
        ...OK_UI,
        outTxtFile: { path: `${WORKSPACE}/out/full.txt`, ok: false, error: 'Permission denied' },
      },
    })
    expect(bad).toContain('Permission denied')
    expect(bad).toContain('doc-outfile is-failed')
  })
})

describe('展开视图：多文档下拉切换', () => {
  const MULTI = {
    files: [
      { ...OK_UI },
      {
        file: `${WORKSPACE}/b.xlsx`,
        ok: true,
        fileType: 'xlsx',
        byteSize: 2048,
        charCount: 42,
        sheet: '销售',
        text: 'SHEET_B_TEXT',
      },
      {
        file: `${WORKSPACE}/c.zip`,
        ok: false,
        errorKind: 'unsupported',
        error: 'Document parsing is not supported for .zip',
        fileType: 'zip',
      },
    ],
  }

  const switcher = (host: HTMLElement) =>
    host.querySelector('.doc-file-switcher') as HTMLElement | null
  const options = () =>
    [...document.querySelectorAll('.custom-select__option')] as HTMLElement[]

  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let errors: string[]
  let origConsoleError: typeof console.error

  function Harness({ uiData = MULTI }: { uiData?: any }) {
    return (
      <div className="host">
        {inst.getExpandView({
          useContent,
          message: msg({ uiData }),
          expand: true,
        }) as any}
      </div>
    )
  }

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
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

  it('只渲染一张卡；下拉列出全部文档，选中后卡内容跟着换', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    expect(host.querySelectorAll('.doc-card').length).toBe(1)
    expect(switcher(host)?.textContent).toBe('报告.docx')
    expect(switcher(host)?.getAttribute('title')).toBe(FILE)
    expect(host.querySelector('.doc-text')?.textContent).toContain('季度报告')

    await act(async () => {
      switcher(host)!.click()
    })
    const list = options()
    expect(list.map((o) => o.textContent)).toEqual(['报告.docx', 'b.xlsx', 'c.zip'])
    expect(list.map((o) => o.getAttribute('title'))).toEqual([
      FILE,
      `${WORKSPACE}/b.xlsx`,
      `${WORKSPACE}/c.zip`,
    ])

    await act(async () => {
      list[1].click()
    })

    // 仍只有一张卡，且换成了第二份的内容与元信息
    expect(host.querySelectorAll('.doc-card').length).toBe(1)
    expect(switcher(host)?.textContent).toBe('b.xlsx')
    expect(host.querySelector('.doc-text')?.textContent).toContain('SHEET_B_TEXT')
    expect(host.querySelector('.doc-head')?.textContent).toContain('销售')
    // 下拉已收起
    expect(options().length).toBe(0)
    expect(errors).toEqual([])
  })

  it('失败项也能被选中：同一位置的下拉，卡片自己报原因', async () => {
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      switcher(host)!.click()
    })
    await act(async () => {
      options()[2].click()
    })

    expect(switcher(host)?.textContent).toBe('c.zip')
    expect(host.querySelector('.doc-card')?.className).toContain('is-failed')
    expect(host.querySelector('.doc-error')?.textContent).toContain(
      zh() ? '不支持的文档格式' : 'Unsupported document format',
    )
    expect(host.textContent).not.toContain('Document parsing is not supported')
    // 失败卡没有正文区
    expect(host.querySelector('.doc-text')).toBeNull()
    expect(errors).toEqual([])
  })

  it('切文档换掉正文节点（滚动位置随之归零，不留在上一个文档的偏移上）', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const before = host.querySelector('.doc-text') as HTMLElement
    // jsdom 没有布局，scrollTop 恒为 0：盖一个可写值，模拟「用户已经滚下去了」
    Object.defineProperty(before, 'scrollTop', {
      value: 300,
      writable: true,
      configurable: true,
    })

    await act(async () => {
      switcher(host)!.click()
    })
    await act(async () => {
      options()[1].click()
    })

    const after = host.querySelector('.doc-text') as HTMLElement
    expect(after).not.toBe(before)
    expect(after.scrollTop).toBe(0)
    expect(errors).toEqual([])
  })

  it('单份文档不出现下拉，文件名仍是静态文本', async () => {
    await act(async () => {
      root.render(<Harness uiData={{ ...OK_UI }} />)
    })
    expect(switcher(host)).toBeNull()
    expect(host.querySelector('.doc-name')?.textContent).toBe('报告.docx')
    expect(errors).toEqual([])
  })
})

describe('展开视图：回退与占位', () => {
  it('无 uiData（旧消息）：非错误回落原文，错误走 error 分支', () => {
    const legacy = expand({ content: 'LEGACY_DOC_TEXT' })
    expect(legacy).toContain('doc-raw')
    expect(legacy).toContain('LEGACY_DOC_TEXT')

    const legacyErr = expand({ content: 'LEGACY_FAIL', isError: true })
    expect(legacyErr).toContain('class="error"')
    expect(legacyErr).toContain('LEGACY_FAIL')
  })

  it('结果还没回来：占位卡（解析中…）', () => {
    const html = renderToStaticMarkup(
      <>
        {inst.getExpandView({
          useContent,
          message: undefined as any,
          expand: true,
        }) as any}
      </>,
    )
    expect(html).toContain('doc-pending')
    expect(html).toContain(zh() ? '解析中…' : 'Parsing…')
  })

  it('折叠时不渲染', () => {
    expect(expand({ uiData: { ...OK_UI } }, false)).toBe('')
  })
})

describe('展开视图：交互与「打开即居中」', () => {
  const message = msg({ uiData: { ...OK_UI } })

  function Harness({ expanded }: { expanded: boolean }) {
    return (
      <div className="host">
        {inst.getExpandView({ useContent, message, expand: expanded }) as any}
      </div>
    )
  }

  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let errors: string[]
  let origConsoleError: typeof console.error
  const scrollCalls: unknown[] = []
  const origScrollTo = (Element.prototype as any).scrollTo

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    settingsState.setValue('defaultWorkspace', WORKSPACE)
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

  it('折叠不挂载，每次展开居中一次，且无 React 内部报错', () => {
    act(() => root.render(<Harness expanded={false} />))
    expect(container.querySelector('.doc-view')).toBeNull()
    expect(scrollCalls.length).toBe(0)

    act(() => root.render(<Harness expanded />))
    expect(container.querySelector('.doc-view')).toBeTruthy()
    expect(scrollCalls.length).toBe(1)

    act(() => root.render(<Harness expanded={false} />))
    expect(container.querySelector('.doc-view')).toBeNull()

    act(() => root.render(<Harness expanded />))
    expect(scrollCalls.length).toBe(2)

    expect(errors).toEqual([])
  })

  it('「复制文本」按钮把正文写进剪贴板（不触发折叠）', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    await act(async () => {
      root.render(<Harness expanded />)
    })
    const btn = container.querySelector(
      '.doc-icon-btn[aria-label]',
    ) as HTMLButtonElement
    expect(btn.getAttribute('aria-label')).toBe(zh() ? '复制文本' : 'Copy text')

    await act(async () => {
      btn.click()
    })
    expect(writeText).toHaveBeenCalledWith(OK_UI.text)
    // 卡片仍在（点击按钮没有让调用行折叠）
    expect(container.querySelector('.doc-view')).toBeTruthy()
    expect(errors).toEqual([])
  })
})
