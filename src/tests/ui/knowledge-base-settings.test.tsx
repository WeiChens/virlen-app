/**
 * knowledge-base-settings — 知识库设置页：**系统自建库不能改名也不能删**这一条契约，
 * 以及「手建的库能从卡片上打开改名弹窗」。
 *
 * 为什么要单独守：默认知识库 / 记忆详情是功能自己创建与维护的（`builtin` 标记来自 Rust），
 * 名字还是这两个功能「缓存失效后认领自己那个库」的锚点 —— 改名或删掉都会让对应功能
 * 静默失效（记忆条目指向的详情库就没了）。做法是「卡片上不画改名 / 删除按钮，只留一句说明」
 * —— 这条完全落在 JSX 的条件渲染里，jsdom 之外没人会提醒它被改回去。
 *
 * 另外守一条「删库要花时间」：整个库连同里面的文档 / 内容一起清掉比删一份文档慢得多，
 * 确认之后卡片要把删除按钮切「删除中…」、并禁用整张卡片的动作（包括「进下一层」的入口）。
 *
 * 仓储全 mock：本用例只验界面；「后端也拒」由 `cargo test -p virlen-core rag` 守
 *（`test_default_kb_is_builtin_and_undeletable` / `test_update_knowledge_base_rejects_empty_name_and_builtin`）。
 */
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import KnowledgeBaseSettings from '@/ui/pages/Settings/knowledge-base-settings'
import type { KnowledgeBase } from '@/domain/ports'

vi.mock('@/services/rag-service', () => ({
  ragService: {
    listKnowledgeBases: vi.fn(),
    deleteKnowledgeBase: vi.fn(),
    updateKnowledgeBase: vi.fn(),
  },
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
// 删除是二次确认的；本文件不测确认框，一律「点了确定」
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve<boolean | null>(true)) },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(), message: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn() }))

import { ragService } from '@/services/rag-service'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 卡片右侧动作区的按钮文案（按用户看到的样子判断，而不是按类名）
 *
 * ⚠️ 只取 `.kb-card-actions`：卡片主体本身也是个按钮（点它进文档列表），拿整张卡片会把
 * 「默认知识库自动创建…」那一大块文本也算进来。
 */
function buttonTexts(card: Element): string[] {
  const actions = card.querySelector('.kb-card-actions')
  if (!actions) throw new Error('卡片里找不到动作区')
  return Array.from(actions.querySelectorAll('button')).map(
    (b) => b.textContent?.trim() ?? '',
  )
}

async function render(kbs: KnowledgeBase[]) {
  vi.mocked(ragService.listKnowledgeBases).mockResolvedValue(kbs)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<KnowledgeBaseSettings />)
  })
  return { root }
}

it('系统自建的库：标出「自动创建」、不显示删除按钮、原地给一句说明', async () => {
  const { root } = await render([
    {
      id: 'kb_default',
      name: '默认知识库',
      description: '由 Virlen 自动创建：放常用的文档和资料。',
      document_count: 0,
      chunk_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      builtin: true,
    },
    {
      id: 'kb_mine',
      name: '我的资料',
      description: '',
      document_count: 1,
      chunk_count: 3,
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    },
  ])

  const cards = Array.from(document.querySelectorAll('.kb-card'))
  expect(cards).toHaveLength(2)

  const [systemCard, myCard] = cards
  expect(systemCard.querySelector('.kb-card-badge')?.textContent?.trim()).toBe('自动创建')
  // 改名 / 删除按钮的位置留给说明（否则用户会找「为什么这一行没有那两个按钮」）
  expect(systemCard.querySelector('.kb-card-locked')?.textContent?.trim()).toBe('不能改')
  expect(buttonTexts(systemCard)).not.toContain('删除')
  expect(buttonTexts(systemCard)).not.toContain('改名')
  // 卡片右侧只有库级动作：文档级的动作（添加文档 / 添加文件夹 / 导入压缩包 / 导出）
  // 都已收进文档列表弹窗（`DocListModal`），卡片上不应再冒出按钮来。
  expect(buttonTexts(systemCard)).toEqual([])

  // 手建的库不受影响
  expect(myCard.querySelector('.kb-card-badge')).toBeNull()
  expect(buttonTexts(myCard)).toEqual(['改名', '删除'])

  await act(async () => root.unmount())
})

it('删库：确认后卡片切「删除中…」并禁用整卡动作，删完恢复', async () => {
  // 把删库「挂住」，好在「正在删」这一刻断言
  let resolveDelete!: () => void
  vi.mocked(ragService.deleteKnowledgeBase).mockReset()
  vi.mocked(ragService.deleteKnowledgeBase).mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolveDelete = r
      }),
  )

  const { root } = await render([
    {
      id: 'kb_mine',
      name: '我的资料',
      description: '',
      document_count: 3,
      chunk_count: 12,
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    },
  ])

  const card = document.querySelector('.kb-card')!
  const deleteButton = Array.from(
    card.querySelectorAll<HTMLButtonElement>('.kb-card-actions button'),
  ).find((b) => b.textContent?.trim() === '删除')!

  await act(async () => deleteButton.click())

  expect(ragService.deleteKnowledgeBase).toHaveBeenCalledWith('kb_mine')
  // 「在干活」的样子：转圈 + 不提淡
  expect(buttonTexts(card)).toEqual(['改名', '删除中…'])
  const busy = card.querySelector<HTMLButtonElement>('.kb-card-actions .kb-btn-danger')!
  expect(busy.disabled).toBe(true)
  expect(busy.className).toContain('kb-btn-busy')
  // 同一张卡片的其它动作也不能再点：否则可能在「库正在消失」时又发起改名 / 再删一次
  expect(
    card.querySelector<HTMLButtonElement>('.kb-card-actions button')!.disabled,
  ).toBe(true)
  expect(card.querySelector<HTMLButtonElement>('.kb-card-main')!.disabled).toBe(true)

  await act(async () => {
    resolveDelete()
    await new Promise((r) => setTimeout(r, 0))
  })

  expect(buttonTexts(card)).toEqual(['改名', '删除'])
  expect(card.querySelector<HTMLButtonElement>('.kb-card-main')!.disabled).toBe(false)

  await act(async () => root.unmount())
})

it('手建的库：点「改名」打开弹窗，并填好现有的名字与说明', async () => {
  const { root } = await render([
    {
      id: 'kb_mine',
      name: '我的资料',
      description: '放一些资料',
      document_count: 0,
      chunk_count: 0,
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    },
  ])

  const renameButton = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.kb-card-actions button'),
  ).find((b) => b.textContent?.trim() === '改名')
  expect(renameButton, '卡片上要有「改名」入口').toBeTruthy()

  await act(async () => renameButton!.click())

  // 弹窗里的输入框要用**当前值**填好（而不是空着或留着上一次的残值）
  const input = document.querySelector<HTMLInputElement>('.kb-create-input')
  const textarea = document.querySelector<HTMLTextAreaElement>('.kb-create-textarea')
  expect(input?.value).toBe('我的资料')
  expect(textarea?.value).toBe('放一些资料')

  await act(async () => root.unmount())
})
