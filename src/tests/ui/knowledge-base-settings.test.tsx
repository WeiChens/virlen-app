/**
 * knowledge-base-settings — 知识库设置页：**系统自建库不能删**这一条契约。
 *
 * 为什么要单独守：默认知识库 / 记忆详情是功能自己创建与维护的（`builtin` 标记来自 Rust），
 * 删掉它们只会让对应功能静默失效（记忆条目指向的详情库就没了）。做法是「卡片上不画删除按钮，
 * 只留一句说明」—— 这条完全落在 JSX 的条件渲染里，jsdom 之外没人会提醒它被改回去。
 *
 * 仓储全 mock：本用例只验界面；「后端也拒绝删除」由
 * `cargo test -p virlen-core rag` 守（`test_builtin_kb_is_marked_and_cannot_be_deleted`）。
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
  // 删除按钮的位置留给说明（否则用户会找「为什么这一行没有删除」）
  expect(systemCard.querySelector('.kb-card-locked')?.textContent?.trim()).toBe('不能删除')
  expect(buttonTexts(systemCard)).not.toContain('删除')
  // 别的动作照常：系统库里的文档一样能增、能导出
  expect(buttonTexts(systemCard)).toEqual(['添加文档', '添加文件夹', '导出'])

  // 手建的库不受影响
  expect(myCard.querySelector('.kb-card-badge')).toBeNull()
  expect(buttonTexts(myCard)).toContain('删除')

  await act(async () => root.unmount())
})
