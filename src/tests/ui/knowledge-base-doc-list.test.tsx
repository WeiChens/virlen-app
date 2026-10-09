/**
 * DocListModal 的搜索 / 分页 / 记忆详情保护
 *
 * 守的四个回归（前三个都是「同一份过滤逻辑写两遍」时期的 bug）：
 * 1. **清空搜索框要恢复完整列表**（含「按内容」模式：以前命中 id 在关键词为空时照样生效）；
 * 2. **筛选后回到第 1 页**（「按名称」是即时过滤，不回页会停在「筛选结果的第 3 页」）；
 * 3. **切到「按内容」要真的发起搜索**（按钮里刚 setState，同一 tick 读到的还是旧模式）；
 * 4. **记忆详情正文**：删除 / 编辑的位置换成说明（后端也会拒，这里不让用户白点）；
 * 5. **删除单份时的行内反馈**：按钮切「删除中…」+ 整行动作禁用（删一份要清向量库里的片段，
 *    不是瞬返回；否则用户会以为没点上）。
 */
import { expect, it, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const mockListDocuments = vi.fn()
const mockSearchDocumentsContent = vi.fn()
const mockRemoveDocument = vi.fn()

vi.mock('@/services/rag-service', () => ({
  ragService: {
    listDocuments: (...a: any[]) => mockListDocuments(...a),
    searchDocumentsContent: (...a: any[]) => mockSearchDocumentsContent(...a),
    removeDocument: (...a: any[]) => mockRemoveDocument(...a),
    query: vi.fn(),
  },
}))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve(true)) },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn(), readFile: vi.fn() }))

import DocListModal from '@/ui/pages/Settings/knowledge-base/DocListModal'
import type { KnowledgeBaseDocument } from '@/domain/ports'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function doc(i: number, extra: Partial<KnowledgeBaseDocument> = {}): KnowledgeBaseDocument {
  return {
    id: `d${i}`,
    file_name: `文档${String(i).padStart(3, '0')}.md`,
    file_type: 'md',
    file_size: 100,
    chunk_count: 2,
    status: 'ready',
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

/** React 受控输入：必须走原生 setter + input 事件，否则 onChange 不触发 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(input: HTMLInputElement) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

function buttonByText(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`找不到按钮「${text}」`)
  return found as HTMLButtonElement
}

function typeAndEnter(input: HTMLInputElement, value: string) {
  typeInto(input, value)
  pressEnter(input)
}

beforeEach(() => {
  vi.clearAllMocks()
  // 每个用例一个干净的 body：不清的话上一个用例渲染的弹窗还在，
  // document.querySelectorAll 会把它们的节点一起数进来
  document.body.innerHTML = ''
})

async function render(docs: KnowledgeBaseDocument[]) {
  mockListDocuments.mockResolvedValue(docs)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <DocListModal
        visible
        kbId="kb1"
        kbName="我的库"
        onClose={() => {}}
      />,
    )
  })
  return { root }
}

it('按内容搜索：清空输入框后列表恢复完整（不再是上一次的命中结果）', async () => {
  await render(Array.from({ length: 25 }, (_, i) => doc(i + 1)))
  mockSearchDocumentsContent.mockResolvedValue(['d3'])

  const searchInput = document.querySelector<HTMLInputElement>(
    '.kb-doc-search-bar .kb-search-input',
  )!

  // 切到「按内容」并搜一个词 → 列表只剩命中那一份
  await act(async () => {
    buttonByText('按内容').click()
  })
  await act(async () => {
    typeAndEnter(searchInput, '启动')
  })
  expect(mockSearchDocumentsContent).toHaveBeenCalledWith('kb1', '启动')
  expect(document.querySelectorAll('.doc-item')).toHaveLength(1)
  expect(document.querySelector('.doc-item-name')?.textContent).toBe('文档003.md')
  // 命中只有 1 份 → 分页信息也要如实说「筛选出 1 份」
  expect(document.querySelector('.kb-pagination-total')?.textContent).toContain(
    '筛选出 1 份',
  )

  // ⭐ 回归点：把搜索框清空 = 取消筛选，列表必须整个回来
  await act(async () => {
    typeInto(searchInput, '')
  })
  expect(document.querySelectorAll('.doc-item')).toHaveLength(10) // 第 1 页
  expect(document.querySelector('.kb-pagination-total')?.textContent).toContain(
    '共 25 份文档',
  )
})

it('按名称筛选：翻到第 2 页后再筛选，要回到第 1 页', async () => {
  await render(Array.from({ length: 25 }, (_, i) => doc(i + 1)))

  await act(async () => {
    buttonByText('下一页').click()
  })
  expect(document.querySelector('.kb-pagination-info')?.textContent).toBe('2 / 3')

  // 名称过滤是即时生效的，不用点搜索 —— 但页码必须回第 1 页
  const searchInput = document.querySelector<HTMLInputElement>(
    '.kb-doc-search-bar .kb-search-input',
  )!
  await act(async () => {
    typeInto(searchInput, '文档0')
  })
  expect(document.querySelector('.kb-pagination-info')?.textContent).toBe('1 / 3')
  expect(
    Array.from(document.querySelectorAll('.doc-item-name')).map((n) => n.textContent),
  ).toEqual(Array.from({ length: 10 }, (_, i) => `文档${String(i + 1).padStart(3, '0')}.md`))
})

it('记忆详情正文：不画删除 / 编辑按钮，换成一句说明', async () => {
  await render([
    doc(1),
    doc(2, { file_name: '记忆详情：某条记忆.md', memory_detail_of: 'm_abc123' }),
  ])

  const items = Array.from(document.querySelectorAll('.doc-item'))
  expect(items).toHaveLength(2)

  // 普通文档：预览 / 编辑 / 删除
  expect(
    Array.from(items[0].querySelectorAll('button')).map((b) => b.textContent?.trim()),
  ).toEqual(['预览', '编辑', '删除'])

  // 记忆详情：只剩预览，删除 / 编辑的位置是一句说明
  expect(
    Array.from(items[1].querySelectorAll('button')).map((b) => b.textContent?.trim()),
  ).toEqual(['预览'])
  expect(items[1].querySelector('.doc-item-locked')?.textContent?.trim()).toBe(
    '记忆详情',
  )
})

it('删单份：按钮切「删除中…」，删除期间整行动作与「清空文档」都禁用，删完恢复', async () => {
  // 把删除「挂住」，好在「正在删」那一刻断言（真机上这一段是清向量库的等待）
  let resolveRemove!: () => void
  mockRemoveDocument.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolveRemove = r
      }),
  )
  await render([doc(1), doc(2)])

  const items = () => Array.from(document.querySelectorAll('.doc-item'))
  await act(async () => {
    buttonByText('删除', items()[0]).click()
  })

  const busy = buttonByText('删除中…', items()[0])
  expect(busy.disabled).toBe(true)
  // 「在干活」的样子：不提淡 + 转圈（样式契约在 knowledge-base-settings.scss 里）
  expect(busy.className).toContain('kb-btn-busy')
  // 删除期间不允许再对别的行动手：同时删两份会算错份数、连刷两次列表
  expect(buttonByText('删除', items()[1]).disabled).toBe(true)
  expect(buttonByText('编辑', items()[0]).disabled).toBe(true)
  expect(buttonByText('清空文档').disabled).toBe(true)

  await act(async () => {
    resolveRemove()
    await new Promise((r) => setTimeout(r, 0))
  })

  expect(mockRemoveDocument).toHaveBeenCalledWith('kb1', 'd1')
  expect(buttonByText('删除', items()[0]).disabled).toBe(false)
  expect(buttonByText('清空文档').disabled).toBe(false)
})
