/**
 * 文件面板的预览分支：xlsx / xls（表格网格）、docx / pptx（Markdown）、pdf（字节交给 pdfjs）、
 * csv / tsv（草稿现场解析成表）。
 *
 * 守四件事：
 * 1. **判定 → 分支**：`previewKindOf` 给的 kind 决定面板画哪一块（这里用真实的判定函数，
 *    只把「载入」与 Monaco / pdfjs 换成替身）；
 * 2. **表格的结构**：列标 A、B…、行号从 1 开始、多张表可切换、行 / 列被上限截断时如实提示；
 * 3. **文稿的正文**：Markdown 原样交给渲染器；太长时给截断提示（不是静默丢内容）；
 * 4. **CSV 预览的是草稿**：改成不合法的空内容就退回编辑器，不显示一张空表。
 *
 * pdfjs / Monaco 在 jsdom 里起不来：都换成替身，只验面板把正确的数据交给了它们。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkspaceFilePanel from '@/ui/pages/chat/components/workspace-file'
import { settingsState } from '@/ui/store'
import type { LoadedWorkspaceFile } from '@/services/workspace-file-service'

const { loadMock, watchMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  watchMock: vi.fn(),
}))

vi.mock('@/services/workspace-file-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workspace-file-service')>()
  return { ...actual, loadWorkspaceFile: loadMock }
})
vi.mock('@tauri-apps/plugin-fs', () => ({ watch: watchMock }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@/services/security-service', () => ({
  securityService: {
    getWorkspace: async (): Promise<string> => 'E:/repo',
    resolveSafePath: async (path: string): Promise<string> => path,
  },
}))
vi.mock('@/infrastructure/preview-asset', () => ({
  allowPreviewRoot: vi.fn(),
  revokePreviewRoot: vi.fn(),
  previewBaseUrl: () => '',
  newPreviewToken: () => 'token',
}))
/** 真实 MarkdownRenderer 静态引 monaco（jsdom 加载不了）：换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div className="mock-markdown">{content}</div>,
}))
/** Monaco 在 jsdom 里起不来：换成同语义的 textarea（受控 + onChange） */
vi.mock('@/ui/components/code-editor/CodeEditor', () => ({
  default: (props: {
    value: string
    onChange: (value: string) => void
    ariaLabel?: string
  }) => (
    <textarea
      className="mock-code-editor"
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}))
/** pdfjs 依赖 canvas / worker：只验面板把**字节**交给了它 */
vi.mock('@/ui/pages/chat/components/workspace-file/pdf-view', () => ({
  default: ({ bytes, name }: { bytes: Uint8Array; name: string }) => (
    <div className="mock-pdf" data-name={name} data-bytes={String(bytes.length)} />
  ),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

async function mount(path: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <WorkspaceFilePanel path={path} onClose={() => {}} onDirtyChange={() => {}} />,
    ),
  )
  await act(async () => {})
}

const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')]
const tabByText = (text: string) => tabs().find((tab) => tab.textContent === text)
const sheetTabs = () => [...document.querySelectorAll<HTMLButtonElement>('.wfp-sheet-tab')]
const cells = () =>
  [...document.querySelectorAll<HTMLTableCellElement>('.wfp-sheet-table tbody td')].map(
    (cell) => cell.textContent,
  )
const headers = () =>
  [...document.querySelectorAll<HTMLTableCellElement>('.wfp-sheet-table thead th')].map(
    (cell) => cell.textContent,
  )
const rowNumbers = () =>
  [...document.querySelectorAll<HTMLTableCellElement>('.wfp-sheet-table tbody th')].map(
    (cell) => cell.textContent,
  )
const editor = () => document.querySelector<HTMLTextAreaElement>('.mock-code-editor')

/** 改 textarea 必须走原生 setter，React 才认这次 input */
function type(value: string) {
  const el = editor()!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  loadMock.mockReset()
  watchMock.mockReset()
  watchMock.mockResolvedValue(() => {})
  settingsState.value.htmlPreviewAllowScripts = false
  settingsState.value.htmlPreviewAllowRemote = false
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

/** `.xlsx`：第一张表 2×2，第二张多行列（用来验截断提示与切换） */
function sheetFile(): LoadedWorkspaceFile {
  return {
    kind: 'sheet',
    preview: {
      kind: 'xlsx',
      text: '',
      charCount: 0,
      truncated: false,
      byteSize: 1024,
      sheets: [
        {
          name: '销售',
          rows: [
            ['地区', '金额'],
            ['华东', '100'],
          ],
          rowCount: 2,
          colCount: 2,
          merges: [],
        },
        { name: '汇总', rows: [['合计']], rowCount: 8, colCount: 3, merges: [] },
        {
          name: '合并',
          rows: [
            ['标题'],
            ['华东', '上海', '100'],
            ['', '杭州', '200'],
          ],
          rowCount: 3,
          colCount: 3,
          // A1:C1 横跨 3 列；A2:A3 纵跨 2 行
          merges: [
            { rowFirst: 0, rowLast: 0, colFirst: 0, colLast: 2 },
            { rowFirst: 1, rowLast: 2, colFirst: 0, colLast: 0 },
          ],
        },
      ],
    },
  }
}

it('xlsx：多张工作表可切换，列标 / 行号按表格口径画', async () => {
  loadMock.mockResolvedValue(sheetFile())
  await mount('E:/repo/报表.xlsx')

  expect(sheetTabs().map((tab) => tab.textContent)).toEqual(['销售', '汇总', '合并'])
  // 表头：左上角空 + 列标 A / B；行号从 1 开始
  expect(headers()).toEqual(['', 'A', 'B'])
  expect(rowNumbers()).toEqual(['1', '2'])
  expect(cells()).toEqual(['地区', '金额', '华东', '100'])

  // 第二张表被上限截断（物化 1 行 1 列，真实 8 行 3 列）→ 如实提示
  await act(async () => sheetTabs()[1].click())
  expect(document.querySelector('.wfp-sheet-note')?.textContent).toContain(
    '仅显示前 1 行（共 8 行）',
  )
  expect(document.querySelector('.wfp-sheet-note')?.textContent).toContain(
    '仅显示前 1 列（共 3 列）',
  )
})

it('xlsx：合并区域画成 colspan / rowspan，被覆盖的位置不画空格子', async () => {
  loadMock.mockResolvedValue(sheetFile())
  await mount('E:/repo/报表.xlsx')
  await act(async () => sheetTabs()[2].click())

  const rows = [...document.querySelectorAll<HTMLTableRowElement>('.wfp-sheet-table tbody tr')]
  const first = [...rows[0].querySelectorAll<HTMLTableCellElement>('td')]
  expect(first).toHaveLength(1)
  expect(first[0].getAttribute('colspan')).toBe('3')
  expect(first[0].textContent).toBe('标题')

  const second = [...rows[1].querySelectorAll<HTMLTableCellElement>('td')]
  expect(second).toHaveLength(3)
  expect(second[0].getAttribute('rowspan')).toBe('2')

  // 被 A2:A3 覆盖的第三行首格整格不画：这一行只剩两格
  const third = [...rows[2].querySelectorAll<HTMLTableCellElement>('td')]
  expect(third.map((cell) => cell.textContent)).toEqual(['杭州', '200'])
})

it('docx：正文是 Markdown；过长时给截断提示并留「系统程序打开」的出口', async () => {
  loadMock.mockResolvedValue({
    kind: 'document',
    preview: {
      kind: 'docx',
      text: '# 标题\n\n正文',
      charCount: 900,
      truncated: true,
      sheets: [],
      byteSize: 2048,
    },
  } satisfies LoadedWorkspaceFile)
  await mount('E:/repo/报告.docx')

  expect(document.querySelector('.mock-markdown')?.textContent).toContain('# 标题')
  const note = document.querySelector('.wfp-preview-note')
  expect(note?.textContent).toContain('内容过长')
  expect(note?.textContent).toContain('8')
  // 文档不可编辑：保存按钮不该出现，也没有编辑 tab
  expect(document.querySelector('.wfp-action.is-primary')).toBeNull()
  expect(tabByText('编辑')).toBeUndefined()
})

it('pdf：把字节原样交给 pdfjs 那一路', async () => {
  loadMock.mockResolvedValue({
    kind: 'pdf',
    bytes: new Uint8Array([1, 2, 3, 4]),
    byteSize: 4,
  } satisfies LoadedWorkspaceFile)
  await mount('E:/repo/说明.pdf')

  const pdf = document.querySelector<HTMLElement>('.mock-pdf')
  expect(pdf?.dataset.name).toBe('说明.pdf')
  expect(pdf?.dataset.bytes).toBe('4')
})

it('csv：预览画的是草稿（且草稿清空后退回编辑器）', async () => {
  loadMock.mockResolvedValue({
    kind: 'text',
    content: '地区,金额\n华东,100\n',
    hash10: 'h1',
    byteSize: 30,
    lineCount: 2,
  } satisfies LoadedWorkspaceFile)
  await mount('E:/repo/销售.csv')

  // 默认停在编辑器（CSV 仍是可编辑文本）
  expect(editor()).not.toBeNull()

  // 改草稿（与磁盘上的内容不同）→ 预览必须画**改过之后**的内容
  type('x,y\n9,8\n')
  await act(async () => tabByText('预览')!.click())
  expect(cells()).toEqual(['x', 'y', '9', '8'])

  // 回编辑、清空 → 预览解析不出行 → 退回编辑器，不画一张空表
  await act(async () => tabByText('编辑')!.click())
  type('')
  await act(async () => tabByText('预览')!.click())
  expect(document.querySelector('.wfp-sheet-table')).toBeNull()
  expect(editor()).not.toBeNull()
})
