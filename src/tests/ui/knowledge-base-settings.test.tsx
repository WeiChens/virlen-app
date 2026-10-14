/**
 * knowledge-base-settings — 知识库设置页的三条契约：
 *  1. **系统自建库不能重命名也不能删**：卡片上连「更多」按钮都没有（按钮直接拿掉而不置灰：
 *     置灰的删除按钮只会诱发点击，而它永远不会生效），只用「自动创建」小标解释；
 *  2. **库级动作收在「更多」菜单里**：卡片上不平铺按钮，点开菜单才是「重命名 / 删除」；
 *  3. **删库要花时间**：确认之后卡片要切「在干活」（更多按钮换成转圈 + 禁用整卡动作），删完恢复。
 *
 * 为什么值得单独守：前两条完全落在 JSX 的条件渲染里，jsdom 之外没人会提醒它们被改回去；
 * 第三条是因为整个库连同里面的文档 / 内容一起清掉比删一份文档慢得多，没有反馈用户会以为没点上。
 *
 * 仓储全 mock：本用例只验界面；「后端也拒」由 `cargo test -p virlen-core rag` 守
 *（`test_default_kb_is_builtin_and_undeletable` / `test_update_knowledge_base_rejects_empty_name_and_builtin`）。
 *
 * ⚠️ 每个用例挂到自己的 host 上并 unmount，别只往 body 里塞：菜单是 portal 到 body 的，
 * 留在 body 里的上一个用例会让 querySelector 抓到它的按钮（踩过：改名弹窗抓到了别人的卡片）。
 */
import { beforeEach, expect, it, vi } from 'vitest'
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

const BUILTIN_KB: KnowledgeBase = {
  id: 'kb_default',
  name: '默认知识库',
  description: '由 Virlen 自动创建：放常用的文档和资料。',
  document_count: 0,
  chunk_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  builtin: true,
}

const MY_KB: KnowledgeBase = {
  id: 'kb_mine',
  name: '我的资料',
  description: '放一些资料',
  document_count: 3,
  chunk_count: 12,
  created_at: '2026-01-02T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
}

async function render(kbs: KnowledgeBase[]) {
  vi.mocked(ragService.listKnowledgeBases).mockResolvedValue(kbs)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<KnowledgeBaseSettings />)
  })
  return {
    host,
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

const cardsOf = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLElement>('.kb-card'))

const moreButtonOf = (card: HTMLElement) =>
  card.querySelector<HTMLButtonElement>('.kb-card-more')!

/** 点某张卡片上的「更多」打开菜单（菜单 portal 到 body，故按整篇文档找） */
async function openMenu(host: HTMLElement, index = 0) {
  await act(async () => moreButtonOf(cardsOf(host)[index]).click())
}

/** 当前菜单里的项（按 DOM 顺序的文案） */
const menuLabels = () =>
  Array.from(document.querySelectorAll('.context-menu-item')).map(
    (el) => el.textContent?.trim() ?? '',
  )

const menuButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(ragService.deleteKnowledgeBase).mockReset().mockResolvedValue(undefined as any)
})

it('系统自建的库：标出「自动创建」、没有「更多」按钮（不能重命名也不能删）', async () => {
  const { host, unmount } = await render([BUILTIN_KB, MY_KB])
  const [systemCard, myCard] = cardsOf(host)

  expect(systemCard.querySelector('.kb-card-badge')?.textContent?.trim()).toBe('自动创建')
  // 「更多」按钮直接拿掉（不是置灰）：置灰只会诱发点击，而它永远不会生效
  expect(systemCard.querySelector('.kb-card-more')).toBeNull()
  // 连动作区（那条分组竖线）都不画，免得剩一根孤零零的线
  expect(systemCard.querySelector('.kb-card-actions')).toBeNull()
  expect(systemCard.querySelectorAll('button')).toHaveLength(1) // 只剩「进下一层」那个

  // 手建的库不受影响
  expect(myCard.querySelector('.kb-card-badge')).toBeNull()
  const actionButtons = Array.from(
    myCard.querySelectorAll<HTMLButtonElement>('.kb-card-actions button'),
  )
  expect(actionButtons).toHaveLength(1)
  expect(actionButtons[0].className).toContain('kb-card-more')
  // 行上不再平铺动作：文案只在菜单里出现（见下一个用例）
  expect(
    Array.from(myCard.querySelectorAll('button')).map((b) => b.textContent?.trim()),
  ).not.toContain('重命名')

  await unmount()
})

it('手建的库：点「更多」才出现「重命名 / 删除」；点「重命名」打开弹窗并填好现有名字与说明', async () => {
  const { host, unmount } = await render([MY_KB])

  // 没点之前不该有菜单
  expect(document.querySelector('.context-menu')).toBeNull()

  await openMenu(host)
  expect(menuLabels()).toEqual(['重命名', '删除'])
  expect(moreButtonOf(cardsOf(host)[0]).getAttribute('aria-expanded')).toBe('true')

  await act(async () => menuButtons()[0].click())

  // 菜单先关再执行动作（动作要弹 Modal，菜单留着会压在弹窗上）
  expect(document.querySelector('.context-menu')).toBeNull()

  // 弹窗里的输入框要用**当前值**填好（而不是空着或留着上一次的残值）
  const input = host.querySelector<HTMLInputElement>('.kb-create-input')
  const textarea = host.querySelector<HTMLTextAreaElement>('.kb-create-textarea')
  expect(input?.value).toBe('我的资料')
  expect(textarea?.value).toBe('放一些资料')

  await unmount()
})

it('删库：菜单里点「删除」→ 确认后卡片切「在干活」并禁用整卡动作，删完恢复', async () => {
  // 把删库「挂住」，好在「正在删」这一刻断言
  let resolveDelete!: () => void
  vi.mocked(ragService.deleteKnowledgeBase).mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolveDelete = r
      }),
  )

  const { host, unmount } = await render([MY_KB])
  await openMenu(host)
  await act(async () => menuButtons()[1].click())

  expect(ragService.deleteKnowledgeBase).toHaveBeenCalledWith('kb_mine')

  const card = cardsOf(host)[0]
  // 「在干活」的样子：菜单点完就关了，卡片自己得说明（转圈 + 禁用，光标是「等」）
  expect(card.querySelector('.kb-card-more-spinner')).not.toBeNull()
  expect(moreButtonOf(card).disabled).toBe(true)
  expect(moreButtonOf(card).title).toBe('删除中…')
  // 「进下一层」的入口也关上（点进去只会看到一份正在消失的文档列表）
  expect(card.querySelector<HTMLButtonElement>('.kb-card-main')!.disabled).toBe(true)
  // 正在删时再点「更多」不会开出菜单（按钮已禁用）
  await openMenu(host)
  expect(document.querySelector('.context-menu')).toBeNull()

  await act(async () => {
    resolveDelete()
    await new Promise((r) => setTimeout(r, 0))
  })

  expect(card.querySelector('.kb-card-more-spinner')).toBeNull()
  expect(moreButtonOf(card).disabled).toBe(false)
  expect(card.querySelector<HTMLButtonElement>('.kb-card-main')!.disabled).toBe(false)

  await unmount()
})
