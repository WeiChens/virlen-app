/**
 * memory-settings — 长期记忆设置页（记忆功能 P0）+ 列表弹窗（`memory/MemoryListModal`）
 *
 * 覆盖这些容易出错的事：
 * 1. **表格展示**：每条记忆的字段（内容 / 分类 / 级别 / 记录日 / 来源日 / 命中 / 状态）各就其列
 *    —— 字段错列比不好看严重得多，用户会照着一列做判断；
 * 2. **写操作真的落到仓储**：新增 / 编辑 / 删除 / 升级 / 停用都是「调仓储 + 重新拉列表」，
 *    少了 reload 会出现「界面上改了、实际没生效」；
 * 3. **注入预览展示的是后端渲染结果**：前端不自己拼 `# Memory` 段（否则用户看到的不是模型收到的）；
 * 4. **蒸馏整理（P2）**：按钮按「昨天」触发、状态行如实展示上次结果、失败可重跑 ——
 *    整理是**花了钱的动作**，界面绝不能让它显得「点了没反应」；
 * 5. **列表只在弹窗里**：设置页 content 只留设置项 + 一个「记忆列表（N 条）」入口。
 *    因此本文件里除入口与设置项外，断言列表的用例都先打开弹窗（`render()` 默认就开，
 *    要测「默认不开」的用例传 `{ openList: false }`）；
 * 6. **记录日期**：每条要标出「什么时候记下的」（`createdAt`，缺失时不编日期）；
 * 7. **筛选与分页**：内容模糊搜索、分类 / 级别两个下拉筛选、分页 —— 三者的组合最容易出
 *    「看起来空了」这类假象（页码停在越界处、筛选后不重置页），所以逐条守着；
 * 8. **多选与批量**：行内已无操作按钮，停用 / 删除 / 升降级全走「勾选 + 批量栏」，
 *    因此「勾选真的生效、条数与事实一致」比过去更关键；批量栏**常驻**（未选中时全禁用），
 *    所以不再断言「没选中时它不存在」，而是断言「它在、但不可点」。
 *
 * 仓储全部 mock：本用例只验界面行为，Rust 侧的选取 / 渲染规则由 `cargo test -p virlen-core --lib memory` 守。
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import MemorySettings from '@/ui/pages/Settings/memory-settings'
import { settingsState } from '@/ui/store'
import type { MemoryRecord } from '@/domain/memory'

vi.mock('@/infrastructure/memoryRepo', () => ({
  listMemories: vi.fn(),
  upsertMemory: vi.fn(),
  deleteMemory: vi.fn(),
  setMemoryLevel: vi.fn(),
  setMemoryDisabled: vi.fn(),
  loadMemorySection: vi.fn(),
  touchMemories: vi.fn(),
  // P2：蒸馏整理（面板的「立即整理昨天」+ 状态行）
  consolidateMemories: vi.fn(),
  listMemoryRuns: vi.fn(),
  // P3：导出 JSON（Rust 给文本，面板负责选路径写文件）
  exportMemories: vi.fn(),
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
// 删除是二次确认的：默认一律「点了确定」（要测「取消」的用例自己覆写一次）
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve<boolean | null>(true)) },
}))
// 导出走「选路径 + 写文件」（与导出会话 / 用量 CSV 同一范式）：这里把两个插件换成桩，
// 才能断言「真的把文本写给用户选的文件」，而不是只看 toast。
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(() => Promise.resolve('C:/tmp/virlen-memory.json')),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn(() => Promise.resolve()) }))

import {
  consolidateMemories,
  deleteMemory,
  exportMemories,
  listMemories,
  listMemoryRuns,
  loadMemorySection,
  setMemoryDisabled,
  setMemoryLevel,
  upsertMemory,
} from '@/infrastructure/memoryRepo'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const permanentMemory: MemoryRecord = {
  id: 'm_p1',
  level: 'permanent',
  kind: 'user',
  summary: '用户偏好中文回复',
  hits: 3,
  sourceDay: '2026-10-05',
}

const normalMemory: MemoryRecord = {
  id: 'm_n1',
  level: 'normal',
  kind: 'project',
  summary: '在 virlen-app 实现记忆功能',
  hits: 0,
  sourceDay: '2026-10-05',
  projectPath: 'C:/code/virlen-app',
}

/** 已停用的普通记忆 —— 批量操作必须跳过「本来就如此」的条目 */
const disabledNormalMemory: MemoryRecord = {
  id: 'm_n2',
  level: 'normal',
  kind: 'fact',
  summary: '旧的技术选型笔记（已过时）',
  disabled: true,
}

/** 造一批普通记忆（分页用例要 > 1 页的数据） */
function manyMemories(n: number): MemoryRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m_${i + 1}`,
    level: 'normal',
    kind: 'fact',
    summary: `批量记忆 ${i + 1}`,
    hits: i,
  }))
}

async function render(options: { openList?: boolean } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<MemorySettings />)
  })
  // 列表在一个弹窗里（设置页只留一个入口按钮）：断言列表的用例先把它打开。
  // 默认打开是为了让「列表行为」的用例读起来仍像在操作列表，而不是每处都重复点一下入口。
  if (options.openList !== false) await click(listButton())
  return { host, root }
}

/** 「记忆列表（N 条）」入口按钮 —— 设置页上列表的**唯一**入口 */
function listButton(): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith('记忆列表'),
  )
  if (!found) throw new Error('找不到「记忆列表」入口按钮')
  return found as HTMLButtonElement
}

/** 按文本找按钮（面板里按钮很多，按文案定位最贴近用户行为） */
function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`找不到按钮：${text}`)
  return found as HTMLButtonElement
}

/** 表格里的数据行 */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.memory-table tbody tr'))
}

/** 按内容定位一行 */
function rowBy(summary: string): HTMLElement {
  const row = rows().find((r) =>
    r.querySelector('.memory-cell-summary')?.textContent?.includes(summary),
  )
  if (!row) throw new Error(`找不到记忆行：${summary}`)
  return row
}

/** 某一行的某一列 */
function cell(summary: string, cls: string): HTMLElement {
  const el = rowBy(summary).querySelector<HTMLElement>(`.${cls}`)
  if (!el) throw new Error(`行「${summary}」里找不到列：${cls}`)
  return el
}

/**
 * 行内的复选框。
 *
 * ⚠️ 表头全选框用的是同一个 `.memory-check`：必须按容器分，否则「勾第 1 行」会勾到表头。
 */
function itemChecks(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('.memory-table tbody .memory-check'),
  )
}

/** 表头全选框（只作用于本页） */
function headerCheck(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.memory-table thead .memory-check')
  if (!el) throw new Error('表头全选框未渲染')
  return el
}

/** 勾选一条（按内容定位，别按序号 —— 序号会随后端排序变） */
async function selectRow(summary: string) {
  await click(cell(summary, 'memory-cell-check').querySelector('input')!)
}

/**
 * 批量栏。
 *
 * ⚠️ 它现在**常驻**（未选中时按钮全禁用），所以「取不到」就是 bug —— 直接报错而不是返回 null，
 * 避免用例里写成 `?.textContent` 后静默地什么都验不到。
 */
function batchBar(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.memory-batch-bar')
  if (!el) throw new Error('批量栏未渲染（它是常驻的）')
  return el
}

/** 批量栏里的按钮（按文案定位） */
function batchButton(text: string): HTMLButtonElement {
  const found = Array.from(batchBar().querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`批量栏里找不到按钮：${text}`)
  return found as HTMLButtonElement
}

/** 批量栏的文案 */
function batchText(): string {
  return batchBar().textContent ?? ''
}

/** 分页栏（表格为空时不渲染） */
function pager(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.memory-pager')
  if (!el) throw new Error('分页栏未渲染')
  return el
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * 往受控输入里打字。
 *
 * ⚠️ 受控组件：必须走原生 setter + `input` 事件，直接赋 `value` 不会触发 React 的 onChange。
 */
async function typeInto(selector: string, text: string) {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`找不到输入框：${selector}`)
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 工具栏第二行的筛选下拉（共享 `Select`，下拉面板 Portal 到 body） */
async function pickFilter(cls: 'memory-filter-kind' | 'memory-filter-level', label: string) {
  const trigger = document.querySelector<HTMLElement>(`.memory-filter-selects .${cls}`)
  if (!trigger) throw new Error(`找不到筛选下拉：${cls}`)
  await click(trigger)
  const options = Array.from(
    document.querySelectorAll<HTMLElement>('.custom-select__dropdown .custom-select__option'),
  )
  const target = options.find((o) => o.textContent === label)
  if (!target) throw new Error(`${cls} 下拉里找不到：${label}`)
  await click(target)
}

/** 级别筛选 */
const pickLevelFilter = (label: string) => pickFilter('memory-filter-level', label)
/** 分类筛选 */
const pickKindFilter = (label: string) => pickFilter('memory-filter-kind', label)

/** 改每页条数（footer 里的共享 `Select`） */
async function pickPageSize(label: string) {
  const trigger = document.querySelector<HTMLElement>('.memory-pager .custom-select')
  if (!trigger) throw new Error('找不到每页条数下拉')
  await click(trigger)
  const options = Array.from(
    document.querySelectorAll<HTMLElement>('.custom-select__dropdown .custom-select__option'),
  )
  const target = options.find((o) => o.textContent === label)
  if (!target) throw new Error(`每页条数下拉里找不到：${label}`)
  await click(target)
}

beforeEach(() => {
  vi.mocked(listMemories).mockReset()
  vi.mocked(upsertMemory).mockReset()
  vi.mocked(deleteMemory).mockReset()
  vi.mocked(setMemoryLevel).mockReset()
  vi.mocked(setMemoryDisabled).mockReset()
  vi.mocked(loadMemorySection).mockReset()
  vi.mocked(consolidateMemories).mockReset()
  vi.mocked(listMemoryRuns).mockReset()
  vi.mocked(listMemories).mockResolvedValue([permanentMemory, normalMemory])
  vi.mocked(listMemoryRuns).mockResolvedValue([])
  vi.mocked(consolidateMemories).mockResolvedValue(null)
  vi.mocked(upsertMemory).mockResolvedValue(undefined)
  vi.mocked(deleteMemory).mockResolvedValue(true)
  vi.mocked(setMemoryLevel).mockResolvedValue(true)
  vi.mocked(setMemoryDisabled).mockResolvedValue(true)
  vi.mocked(loadMemorySection).mockResolvedValue({
    text: '# Memory\n\n## Permanent\n- [user] 用户偏好中文回复 (id: m_p1)',
    ids: ['m_p1'],
    droppedNormal: 0,
    droppedPermanent: 0,
    chars: 120,
    budget: 4000,
  })
  vi.mocked(exportMemories).mockReset()
  vi.mocked(exportMemories).mockResolvedValue(null)
  // 二次确认默认「确定」（队列里的 once 实现必须清掉，否则会漏到下一条用例）
  vi.mocked(MessageBox.propt).mockReset()
  vi.mocked(MessageBox.propt).mockResolvedValue(true)
  // 文件插件是模块级桩：用例之间必须清干净（否则「取消不写文件」会看到上一条用例的调用）
  vi.mocked(save).mockClear()
  vi.mocked(save).mockResolvedValue('C:/tmp/virlen-memory.json')
  vi.mocked(writeTextFile).mockClear()
})

// ==================== 表格展示 ====================

it('表格展示：一行一条记忆，字段各就其列（含记录日与来源日）', async () => {
  const { root } = await render()

  const headers = Array.from(document.querySelectorAll('.memory-table thead th')).map(
    (n) => n.textContent,
  )
  expect(headers).toEqual(['', '内容', '分类', '项目', '级别', '记录', '来源', '使用次数', '状态'])

  expect(rows()).toHaveLength(2)
  // 顺序沿用后端给的（永久在前 → 新建在前），前端不再自己分区
  expect(cell('用户偏好中文回复', 'memory-cell-summary').textContent).toBe('用户偏好中文回复')
  expect(cell('用户偏好中文回复', 'memory-cell-kind').textContent).toBe('用户偏好')
  expect(cell('用户偏好中文回复', 'memory-cell-level').textContent).toBe('永久')
  expect(cell('在 virlen-app 实现记忆功能', 'memory-cell-level').textContent).toBe('普通')
  expect(cell('在 virlen-app 实现记忆功能', 'memory-cell-kind').textContent).toBe('项目')
  expect(cell('用户偏好中文回复', 'memory-cell-source').textContent).toBe('2026-10-05')
  // 「使用次数」= 被注入 / 被检索到的累计次数（top-k 排序的输入，不是本次会话的数）
  expect(cell('用户偏好中文回复', 'memory-cell-hits').textContent).toBe('3')
  // 没有 createdAt 的条目不编日期（桩数据 / 老数据），显示占位符
  expect(cell('用户偏好中文回复', 'memory-cell-date').textContent).toBe('—')
  expect(cell('用户偏好中文回复', 'memory-cell-state').textContent).toBe('')

  await act(async () => root.unmount())
})

it('列表不常驻设置页：默认没有任何条目，点「记忆列表」才在弹窗里出现', async () => {
  const { root } = await render({ openList: false })

  // 设置项还在（列表搬走 ≠ 面板空了）
  expect(document.querySelector('.memory-switch-row')).not.toBeNull()
  expect(document.querySelector('.memory-run-row')).not.toBeNull()
  expect(document.querySelector('.memory-budget-row')).not.toBeNull()

  // 列表本体（表格 / 分页 / 批量栏）一个都不在设置页里
  expect(document.querySelectorAll('.memory-table')).toHaveLength(0)
  expect(document.querySelector('.memory-pager')).toBeNull()
  expect(document.querySelector('.modal-overlay')).toBeNull()

  // 入口按钮带条数（用户不打开弹窗也能知道库里有多少条）
  expect(listButton().textContent?.trim()).toBe('记忆列表（2 条）')

  await click(listButton())
  expect(document.querySelector('.modal-overlay')).not.toBeNull()
  expect(rows()).toHaveLength(2)
  expect(document.querySelector('.memory-list-modal .memory-table')).not.toBeNull()

  // 关掉后列表重新收起来（设置页恢复成「只有设置项」的样子）
  await click(document.querySelector('.modal-close')!)
  expect(document.querySelector('.modal-overlay')).toBeNull()
  expect(document.querySelectorAll('.memory-table')).toHaveLength(0)
  expect(document.querySelector('.memory-pager')).toBeNull()

  await act(async () => root.unmount())
})

it('每条记忆标出记录日期；来源日单独标出；缺失时不编日期（一律本地时区）', async () => {
  // 用本地时间构造：日期按本地时区格式化，这样断言不受跑测机器的时区影响
  const created = new Date(2026, 9, 5, 14, 20).getTime()
  const updated = new Date(2026, 9, 6, 9, 2).getTime()
  vi.mocked(listMemories).mockResolvedValue([
    // 蒸馏产出：记录日（刚整理完的今天）与来源日（被整理的那一天）本来就可以不同天
    { ...permanentMemory, createdAt: created, updatedAt: updated, sourceDay: '2026-10-04' },
    // 既无 createdAt 也无来源日：两列都显示占位符，不编日期
    { ...normalMemory, createdAt: undefined, sourceDay: undefined },
  ])
  const { root } = await render()

  expect(cell('用户偏好中文回复', 'memory-cell-date').textContent).toBe('2026-10-05')
  expect(cell('用户偏好中文回复', 'memory-cell-source').textContent).toBe('2026-10-04')
  // 表格只放得下日期：精确到分钟的记录 / 更新时间进 title（悬停可看）
  const title = cell('用户偏好中文回复', 'memory-cell-date').getAttribute('title')!
  expect(title).toContain('记录 2026-10-05 14:20')
  expect(title).toContain('更新 2026-10-06 09:02')

  expect(cell('在 virlen-app 实现记忆功能', 'memory-cell-date').textContent).toBe('—')
  expect(cell('在 virlen-app 实现记忆功能', 'memory-cell-source').textContent).toBe('—')

  await act(async () => root.unmount())
})

// ==================== 编辑子弹窗（点整行打开） ====================

it('点击整行打开编辑子弹窗（带出该行内容），保存后写仓储并刷新列表', async () => {
  const { root } = await render()

  // 行内已经没有任何操作按钮了：编辑靠点整行
  expect(rowBy('用户偏好中文回复').querySelectorAll('button')).toHaveLength(0)

  await click(rowBy('用户偏好中文回复'))
  const form = document.querySelector<HTMLTextAreaElement>(
    '.memory-edit-modal .memory-form-summary',
  )!
  expect(form.value).toBe('用户偏好中文回复')
  // 点行 ≠ 选中：批量栏里的计数不能因此变成 1（它是常驻的，所以看计数而不是看有无）
  expect(batchText()).toContain('已选 0 条')
  expect(batchButton('删除').disabled).toBe(true)

  await typeInto('.memory-edit-modal .memory-form-summary', '用户偏好简洁回复')
  await click(buttonByText('保存'))

  const saved = vi.mocked(upsertMemory).mock.calls[0][0]
  expect(saved.id).toBe('m_p1')
  expect(saved.summary).toBe('用户偏好简洁回复')
  expect(saved.level).toBe('permanent')
  // 初次加载 + 打开弹窗时重取 + 保存后刷新
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(3)
  // 保存后子弹窗关闭
  expect(document.querySelector('.memory-edit-modal')).toBeNull()

  await act(async () => root.unmount())
})

it('新增记忆：写入仓储后重新拉列表；空内容则不写只提示', async () => {
  const { root } = await render()

  await click(buttonByText('新增记忆'))
  await typeInto('.memory-edit-modal .memory-form-summary', '用户要求回复简洁')
  await click(buttonByText('保存'))

  expect(upsertMemory).toHaveBeenCalledTimes(1)
  const saved = vi.mocked(upsertMemory).mock.calls[0][0]
  expect(saved.summary).toBe('用户要求回复简洁')
  expect(saved.level).toBe('normal')
  expect(saved.kind).toBe('project')
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(3)

  // 空内容：不写仓储（Rust 侧也会拒，但别让用户白跑一趟 IPC）
  await click(buttonByText('新增记忆'))
  await click(buttonByText('保存'))
  expect(upsertMemory).toHaveBeenCalledTimes(1)
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('记忆内容不能为空'),
    expect.any(Number),
  )

  await act(async () => root.unmount())
})

it('分类 / 级别用共享 Select 组件（下拉选择真的写进草稿）', async () => {
  const { root } = await render()

  await click(buttonByText('新增记忆'))
  await typeInto('.memory-edit-modal .memory-form-summary', '下拉选择要写进草稿')
  const selects = document.querySelectorAll<HTMLElement>(
    '.memory-edit-modal .memory-form .custom-select',
  )
  expect(selects).toHaveLength(2) // 分类 / 级别（项目路径是文本框，不是下拉）
  // 本表单不该用原生 select：原生下拉的视觉 / 键位与其它设置页不一致，且会被弹窗的滚动容器裁剪
  expect(document.querySelectorAll('.memory-form select')).toHaveLength(0)

  // 展开「分类」→ 选「决策」（下拉面板 Portal 到 body）
  await click(selects[0])
  const kindOptions = Array.from(
    document.querySelectorAll<HTMLElement>('.custom-select__dropdown .custom-select__option'),
  )
  expect(kindOptions.map((o) => o.textContent)).toEqual(['用户偏好', '项目', '决策', '事实'])
  await click(kindOptions.find((o) => o.textContent === '决策')!)

  // 展开「级别」→ 选「永久」
  await click(selects[1])
  const levelOptions = Array.from(
    document.querySelectorAll<HTMLElement>('.custom-select__dropdown .custom-select__option'),
  )
  await click(levelOptions.find((o) => o.textContent === '永久')!)

  await click(buttonByText('保存'))
  const saved = vi.mocked(upsertMemory).mock.calls[0][0]
  expect(saved.kind).toBe('decision')
  expect(saved.level).toBe('permanent')

  await act(async () => root.unmount())
})

it('项目路径：只在「项目」分类下出现；非项目保存时被清掉；留空 = 不限定项目', async () => {
  await act(async () => {
    settingsState.setValue('defaultWorkspace', 'C:/code/virlen-app')
  })
  const { root } = await render()

  // 新增默认就是「项目」→ 路径输入框在，且能一键填默认工作目录
  await click(buttonByText('新增记忆'))
  expect(document.querySelector('.memory-form-path')).not.toBeNull()
  await click(buttonByText('用默认工作目录'))
  await typeInto('.memory-edit-modal .memory-form-summary', '项目约定：pnpm build')
  await click(buttonByText('保存'))
  expect(vi.mocked(upsertMemory).mock.calls[0][0].projectPath).toBe('C:/code/virlen-app')

  // 改成「用户偏好」→ 路径输入框消失，且草稿里的路径被清空（不留半状态）
  await click(buttonByText('新增记忆'))
  await click(buttonByText('用默认工作目录'))
  await typeInto('.memory-edit-modal .memory-form-summary', '用户偏好中文')
  const kindSelect = document.querySelector<HTMLElement>(
    '.memory-edit-modal .memory-form .custom-select',
  )!
  await click(kindSelect)
  const opts = Array.from(
    document.querySelectorAll<HTMLElement>('.custom-select__dropdown .custom-select__option'),
  )
  await click(opts.find((o) => o.textContent === '用户偏好')!)
  expect(document.querySelector('.memory-form-path')).toBeNull()
  await click(buttonByText('保存'))
  expect(vi.mocked(upsertMemory).mock.calls[1][0].kind).toBe('user')
  expect(vi.mocked(upsertMemory).mock.calls[1][0].projectPath).toBeNull()

  // 用完恢复全局设置（defaultWorkspace 是全局 store，留着会影响后面的用例）
  await act(async () => {
    settingsState.setValue('defaultWorkspace', '')
  })
  await act(async () => root.unmount())
})

it('项目列：项目记忆显示路径（悬停看全文），非项目留空，不限项目明说「所有项目」', async () => {
  vi.mocked(listMemories).mockResolvedValue([
    normalMemory, // project + 有路径
    permanentMemory, // user → 该列留空
    { ...disabledNormalMemory, kind: 'project' }, // project 但没限项目
  ])
  const { root } = await render()

  const scoped = cell('在 virlen-app 实现记忆功能', 'memory-cell-project')
  expect(scoped.textContent).toBe('C:/code/virlen-app')
  expect(scoped.title).toBe('C:/code/virlen-app')
  expect(cell('用户偏好中文回复', 'memory-cell-project').textContent).toBe('')
  expect(cell('旧的技术选型笔记（已过时）', 'memory-cell-project').textContent).toBe('所有项目')

  await act(async () => root.unmount())
})

// ==================== 设置项 ====================

it('注入预览展示后端渲染的段文本（前端不自己拼）', async () => {
  const { root } = await render()

  await click(buttonByText('查看注入预览'))
  const body = document.querySelector('.memory-preview-body')!
  expect(body.textContent).toContain('# Memory')
  expect(body.textContent).toContain('- [user] 用户偏好中文回复 (id: m_p1)')

  await act(async () => root.unmount())
})

it('开关与注入条数写进设置（键名与 Rust 侧同名）', async () => {
  const { root } = await render()

  const toggle = document.querySelector<HTMLInputElement>(
    '.virlen-toggle input[type="checkbox"]',
  )!
  const before = settingsState.value.memoryEnabled
  expect(toggle.checked).toBe(before)

  await click(toggle)
  expect(settingsState.value.memoryEnabled).toBe(!before)

  const numberInput = document.querySelector<HTMLInputElement>(
    '.memory-num input[type="number"]',
  )!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(numberInput, '7')
    numberInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(settingsState.value.memoryNormalTopK).toBe(7)

  await act(async () => root.unmount())
})

// ==================== 蒸馏整理（P2） ====================

/** 本地「昨天」（`YYYY-MM-DD`）—— 与组件里的算法一致 */
function yesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

it('尚未整理过时给出状态行；点「立即整理昨天」按昨天触发并刷新列表', async () => {
  const { root } = await render()

  expect(document.querySelector('.memory-run-status')!.textContent).toContain('尚未整理过')

  vi.mocked(consolidateMemories).mockResolvedValue({
    status: 'ok',
    days: [
      {
        day: yesterday(),
        status: 'done',
        items: 2,
        details: 1,
        sourceSessions: 3,
        model: 'p1/m1',
      },
    ],
    items: 2,
    details: 1,
    calls: 1,
  })

  await click(buttonByText('立即整理昨天'))

  // 传的是「昨天」且不强制（幂等：同一天只整理一次）
  expect(consolidateMemories).toHaveBeenCalledWith(yesterday(), false)
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('已整理'),
    expect.any(Number),
  )
  // 整理后重新拉列表与流水（否则用户看不到刚产的条目）
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(3)
  expect(vi.mocked(listMemoryRuns)).toHaveBeenCalledTimes(3)

  await act(async () => root.unmount())
})

it('状态行展示最近一次整理的结果；失败时可「重新整理这一天」', async () => {
  vi.mocked(listMemoryRuns).mockResolvedValue([
    {
      day: '2026-10-04',
      status: 'failed',
      items: 0,
      details: 0,
      sourceSessions: 0,
      error: '模型返回非 JSON',
      attempts: 1,
      startedAt: 1,
    },
  ])
  const { root } = await render()

  expect(document.querySelector('.memory-run-status')!.textContent).toContain('2026-10-04')
  expect(document.querySelector('.memory-run-status')!.textContent).toContain('失败')
  expect(document.querySelector('.memory-preview-warn')!.textContent).toContain(
    '模型返回非 JSON',
  )

  await click(buttonByText('重新整理这一天'))
  expect(consolidateMemories).toHaveBeenCalledWith('2026-10-04', true)

  await act(async () => root.unmount())
})

it('成功整理后状态行显示条数与详情数', async () => {
  vi.mocked(listMemoryRuns).mockResolvedValue([
    {
      day: '2026-10-04',
      status: 'done',
      items: 3,
      details: 1,
      sourceSessions: 2,
      attempts: 1,
      startedAt: 1,
    },
  ])
  const { root } = await render()

  const text = document.querySelector('.memory-run-status')!.textContent!
  expect(text).toContain('2026-10-04')
  expect(text).toContain('3')
  expect(text).toContain('1')

  await act(async () => root.unmount())
})

it('整理被关掉 / 没有模型时给出可读提示，而不是静默', async () => {
  vi.mocked(consolidateMemories).mockResolvedValue({
    status: 'disabled',
    days: [],
    items: 0,
    details: 0,
    calls: 0,
  })
  const { root } = await render()

  await click(buttonByText('立即整理昨天'))
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('记忆功能已关闭'),
    expect.any(Number),
  )

  vi.mocked(consolidateMemories).mockResolvedValue({
    status: 'no-model',
    days: [],
    items: 0,
    details: 0,
    calls: 0,
  })
  await click(buttonByText('立即整理昨天'))
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('没有可用的模型配置'),
    expect.any(Number),
  )

  await act(async () => root.unmount())
})

// ==================== 注入预算告警（P3） ====================

it('常驻预算行展示后端算出的字符数与预算（不用点预览）', async () => {
  const { root } = await render()

  const row = document.querySelector('.memory-budget-row')!
  expect(row.textContent).toContain('120')
  expect(row.textContent).toContain('4000')
  expect(row.textContent).toContain('已注入 1 条 / 共 2 条')
  // 没被裁 → 不告警（告警必须是真的有事）
  expect(row.classList.contains('is-warn')).toBe(false)
  expect(document.querySelectorAll('.memory-preview-warn')).toHaveLength(0)

  await act(async () => root.unmount())
})

it('超出预算时常驻行变告警并给出可操作建议', async () => {
  vi.mocked(loadMemorySection).mockResolvedValue({
    text: '# Memory',
    ids: ['m_p1'],
    droppedNormal: 5,
    droppedPermanent: 2,
    chars: 4200,
    budget: 4000,
  })
  const { root } = await render()

  expect(document.querySelector('.memory-budget-row')!.classList.contains('is-warn')).toBe(true)
  const warn = document.querySelector('.memory-preview-warn')!
  expect(warn.textContent).toContain('永久 2 条')
  expect(warn.textContent).toContain('普通 5 条')
  // 光说「超了」没用，得告诉用户怎么改
  expect(warn.textContent).toContain('建议降级为普通、停用或删除')

  await act(async () => root.unmount())
})

it('写操作后重新取注入段：告警必须是当前状态', async () => {
  const { root } = await render()
  // 初次加载 + 打开列表弹窗时重取
  expect(vi.mocked(loadMemorySection)).toHaveBeenCalledTimes(2)
  // 面板取段一律带 `true`：后端据此不打截断告警埋点（否则指标被面板刷高）；
  // 第二个参数是工作目录 —— 面板传设置里的**默认工作目录**（项目作用域的基准）
  expect(vi.mocked(loadMemorySection)).toHaveBeenCalledWith(true, '')

  await selectRow('用户偏好中文回复')
  await click(batchButton('停用'))
  expect(vi.mocked(loadMemorySection)).toHaveBeenCalledTimes(3)

  await act(async () => root.unmount())
})

// ==================== 导出 JSON（P3） ====================

it('导出 JSON：Rust 给文本，面板选路径写文件', async () => {
  vi.mocked(exportMemories).mockResolvedValue(
    JSON.stringify({
      format: 'virlen.memory',
      schemaVersion: 1,
      exportedAt: 1,
      count: 7,
      memories: [],
    }),
  )
  const { root } = await render()

  await click(buttonByText('导出 JSON'))

  expect(exportMemories).toHaveBeenCalledTimes(1)
  expect(vi.mocked(save)).toHaveBeenCalled()
  // 逐字写入：面板不得自己拼 JSON（记忆字段只有 Rust 一份口径）
  const [path, text] = vi.mocked(writeTextFile).mock.calls[0]
  expect(path).toBe('C:/tmp/virlen-memory.json')
  expect(JSON.parse(text as string).format).toBe('virlen.memory')
  // 条数取自文件本身（导出读的是库里当前状态，可能比面板列表新）
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('7'),
    expect.any(Number),
  )

  await act(async () => root.unmount())
})

it('导出：用户取消保存 / 后端无文本时都不静默', async () => {
  vi.mocked(exportMemories).mockResolvedValue('{"count":1}')
  vi.mocked(save).mockResolvedValueOnce(null)
  const { root } = await render()

  await click(buttonByText('导出 JSON'))
  expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled()

  // 后端给不出文本（非 Tauri / 读取失败）→ 明确提示，不当作成功
  vi.mocked(exportMemories).mockResolvedValue(null)
  await click(buttonByText('导出 JSON'))
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('导出失败'),
    expect.any(Number),
  )

  await act(async () => root.unmount())
})

// ==================== 筛选（模糊搜索 / 级别） ====================

it('模糊搜索：按内容过滤（大小写不敏感），没有命中时给可读提示', async () => {
  const { root } = await render()

  await typeInto('.memory-search', 'VIRLEN')
  expect(rows()).toHaveLength(1)
  expect(rows()[0].querySelector('.memory-cell-summary')!.textContent).toContain('virlen-app')
  // 筛选后的条数如实显示（否则用户不知道筛掉了多少）
  expect(document.querySelector('.memory-count')!.textContent).toContain('筛选出 1 条')

  await typeInto('.memory-search', '没有这条')
  expect(rows()).toHaveLength(0)
  expect(document.querySelector('.memory-empty')!.textContent).toContain('没有匹配的记忆')
  // 空结果时不该渲染一个无意义的分页栏
  expect(document.querySelector('.memory-pager')).toBeNull()

  await typeInto('.memory-search', '')
  expect(rows()).toHaveLength(2)

  await act(async () => root.unmount())
})

it('级别筛选：只留永久 / 只留普通；与搜索叠加', async () => {
  const { root } = await render()

  await pickLevelFilter('永久')
  expect(rows()).toHaveLength(1)
  expect(cell('用户偏好中文回复', 'memory-cell-level').textContent).toBe('永久')

  await pickLevelFilter('普通')
  expect(rows()).toHaveLength(1)
  expect(cell('在 virlen-app 实现记忆功能', 'memory-cell-level').textContent).toBe('普通')

  // 两个条件叠加：级别=普通 + 内容搜索命中永久那条 → 空结果（不是「忽略掉其中一个条件」）
  await typeInto('.memory-search', '用户偏好')
  expect(rows()).toHaveLength(0)

  await pickLevelFilter('全部')
  expect(rows()).toHaveLength(1)

  await act(async () => root.unmount())
})

it('分类筛选：只留选中的分类；与级别、搜索三者叠加', async () => {
  vi.mocked(listMemories).mockResolvedValue([
    permanentMemory, // user / permanent
    normalMemory, // project / normal
    disabledNormalMemory, // fact / normal（已停用也要能筛出来 —— 否则没地方管理它们）
  ])
  const { root } = await render()

  expect(rows()).toHaveLength(3)

  await pickKindFilter('事实')
  expect(rows()).toHaveLength(1)
  expect(cell('旧的技术选型笔记（已过时）', 'memory-cell-kind').textContent).toBe('事实')
  // 计数如实反映筛选（用户得知道被筛掉了多少）
  expect(document.querySelector('.memory-count')!.textContent).toContain('筛选出 1 条 / 共 3 条')

  // 与级别叠加：事实里没有永久 → 空（不是「忽略掉其中一个条件」）
  await pickLevelFilter('永久')
  expect(rows()).toHaveLength(0)
  expect(document.querySelector('.memory-empty')!.textContent).toContain('没有匹配的记忆')

  await pickLevelFilter('全部')
  await pickKindFilter('项目')
  expect(rows()).toHaveLength(1)
  expect(rows()[0].querySelector('.memory-cell-summary')!.textContent).toContain('virlen-app')

  // 与搜索叠加：项目 + 搜「用户偏好」 → 空
  await typeInto('.memory-search', '用户偏好')
  expect(rows()).toHaveLength(0)

  await pickKindFilter('全部')
  expect(rows()).toHaveLength(1)

  await act(async () => root.unmount())
})

it('工具栏两行：两个筛选下拉都在第二行左侧，批量栏常驻在第二行右侧', async () => {
  const { root } = await render()

  const row = document.querySelector('.memory-action-row')!
  // 两个下拉（分类 / 级别）都在第二行的筛选组里；第一行只留搜索与导出 / 新增
  expect(row.querySelectorAll('.memory-filter-selects .custom-select')).toHaveLength(2)
  expect(document.querySelector('.memory-filter-row .custom-select')).toBeNull()
  // 批量栏与筛选同住第二行（右侧），**未选中时也在**，只是按钮全禁用
  expect(row.querySelector('.memory-batch-bar')).not.toBeNull()
  expect(batchText()).toContain('已选 0 条')

  await act(async () => root.unmount())
})

// ==================== 分页 ====================

it('分页：默认每页 20 条，可翻页、可改每页条数，切页不丢选中', async () => {
  vi.mocked(listMemories).mockResolvedValue(manyMemories(25))
  const { root } = await render()

  expect(rows()).toHaveLength(20)
  expect(pager().textContent).toContain('共 25 条')
  expect(pager().querySelector('.memory-pager-page')!.textContent).toContain('1 / 2')
  // 第一页是 20 条：上一页按钮必须禁用
  expect(buttonByText('上一页').disabled).toBe(true)

  // 表头全选只作用于**本页**（否则一不小心就删掉 25 条）
  await click(headerCheck())
  expect(batchText()).toContain('已选 20 条')

  await click(buttonByText('下一页'))
  expect(rows()).toHaveLength(5)
  expect(pager().querySelector('.memory-pager-page')!.textContent).toContain('2 / 2')
  // 选中集跨页保留；提示里说清有 20 条不在这一页（否则「删除」会删掉看不见的）
  expect(headerCheck().checked).toBe(false)
  expect(batchText()).toContain('已选 20 条')
  expect(batchText()).toContain('其中 20 条不在当前页')

  // 改每页条数 → 回第 1 页并显示全部；选中集这时全在眼前，提示应消失
  await pickPageSize('50')
  expect(rows()).toHaveLength(25)
  expect(pager().querySelector('.memory-pager-page')!.textContent).toContain('1 / 1')
  expect(batchText()).toContain('已选 20 条')
  expect(batchText()).not.toContain('不在当前页')

  await act(async () => root.unmount())
})

it('筛选后页码回到第 1 页（否则会停在越界的页上，看起来像「空了」）', async () => {
  vi.mocked(listMemories).mockResolvedValue(manyMemories(25))
  const { root } = await render()

  await click(buttonByText('下一页'))
  expect(rows()).toHaveLength(5)

  // 搜索只剩 1 条命中 → 页码必须回到 1（25 条里的第二页在新结果集里根本不存在）
  await typeInto('.memory-search', '批量记忆 3')
  expect(rows()).toHaveLength(1)
  expect(pager().querySelector('.memory-pager-page')!.textContent).toContain('1 / 1')

  await act(async () => root.unmount())
})

// ==================== 多选与批量操作 ====================
//
// 行内已经没有任何操作按钮（升级 / 降级 / 停用 / 删除全去掉），所以这一组是**唯一的操作路径**：
// 勾选 → 批量栏。三件事必须守住：
// ① 常态下批量栏也在（只是全禁用，不说「点不动」的废话）；② 计数与事实一致（刷新后收敛、越界提示）；
// ③ 只动「确实需要改」的条目。

it('批量栏常驻：未选中时按钮全禁用且给出「怎么开始」，勾选后才可点，取消选择后回到禁用', async () => {
  const { root } = await render()

  // 常驻：位置固定在第二行右侧，不会因为勾选而冒出来把表格上下顶动
  expect(document.querySelectorAll('.memory-batch-bar')).toHaveLength(1)
  expect(batchText()).toContain('已选 0 条')
  for (const label of ['升级为永久', '降级为普通', '停用', '启用', '删除', '取消选择']) {
    expect(batchButton(label).disabled, `${label} 未选中时应当是禁用的`).toBe(true)
  }
  // 灰着的同时要说清怎么开始（否则一排灰按钮看着就像坏了）
  expect(batchButton('删除').title).toContain('先勾选')
  expect(batchBar().classList.contains('is-active')).toBe(false)

  await click(itemChecks()[0])
  expect(batchText()).toContain('已选 1 条')
  expect(rows()[0].classList.contains('is-selected')).toBe(true)
  expect(batchBar().classList.contains('is-active')).toBe(true) // 选中才亮底
  expect(batchButton('删除').disabled).toBe(false)

  await click(itemChecks()[1])
  expect(batchText()).toContain('已选 2 条')

  await click(buttonByText('取消选择'))
  expect(batchText()).toContain('已选 0 条')
  expect(batchBar().classList.contains('is-active')).toBe(false)
  expect(batchButton('删除').disabled).toBe(true)
  expect(document.querySelectorAll('.memory-table tbody tr.is-selected')).toHaveLength(0)

  await act(async () => root.unmount())
})

it('表头全选：支持半选态，且只作用于本页', async () => {
  const { root } = await render()

  expect(headerCheck().checked).toBe(false)

  await click(itemChecks()[0]) // 2 条里只选了 1 条
  expect(headerCheck().checked).toBe(false)
  expect(headerCheck().indeterminate).toBe(true) // 半选：不能显示成「全都没选」

  await click(headerCheck())
  expect(headerCheck().indeterminate).toBe(false)
  expect(headerCheck().checked).toBe(true)
  expect(batchText()).toContain('已选 2 条')

  await click(headerCheck()) // 再点一次 = 取消本页
  expect(batchText()).toContain('已选 0 条')
  expect(batchButton('删除').disabled).toBe(true)

  await act(async () => root.unmount())
})

it('批量停用 / 启用：跳过已经如此的条目，并报真实条数', async () => {
  vi.mocked(listMemories).mockResolvedValue([permanentMemory, disabledNormalMemory])
  const { root } = await render()

  await selectRow('旧的技术选型笔记（已过时）') // 这条本来就是停用的
  expect(batchButton('停用').disabled).toBe(true) // 没有可停用的 → 按钮必须是禁的
  expect(batchButton('停用').title).toContain('都已停用')
  expect(batchButton('启用').disabled).toBe(false)

  await click(batchButton('启用'))
  expect(setMemoryDisabled).toHaveBeenCalledTimes(1)
  expect(setMemoryDisabled).toHaveBeenCalledWith('m_n2', false)
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('已启用 1 条记忆'),
    expect.any(Number),
  )

  await act(async () => root.unmount())
})

it('单条停用 / 升级：勾一条再点批量按钮（行内已无按钮）', async () => {
  const { root } = await render()

  await selectRow('在 virlen-app 实现记忆功能')
  expect(batchButton('降级为普通').disabled).toBe(true) // 本来就是普通 → 不该让人点
  await click(batchButton('升级为永久'))
  expect(setMemoryLevel).toHaveBeenCalledWith('m_n1', 'permanent')
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('已升级为永久 1 条记忆'),
    expect.any(Number),
  )

  await selectRow('用户偏好中文回复')
  await click(batchButton('停用'))
  expect(setMemoryDisabled).toHaveBeenCalledWith('m_p1', true)

  await act(async () => root.unmount())
})

it('批量删除：二次确认带条数；取消则不删', async () => {
  const { root } = await render()

  await click(itemChecks()[0])
  await click(itemChecks()[1])
  vi.mocked(MessageBox.propt).mockResolvedValueOnce(null) // 用户取消（Esc / 关窗）

  await click(batchButton('删除'))
  expect(vi.mocked(MessageBox.propt).mock.calls[0][1]).toContain('2')
  expect(deleteMemory).not.toHaveBeenCalled()

  await click(batchButton('删除')) // 这次默认实现 = 点了确定
  expect(deleteMemory).toHaveBeenCalledTimes(2)
  expect(deleteMemory).toHaveBeenCalledWith('m_p1')
  expect(deleteMemory).toHaveBeenCalledWith('m_n1')
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('已删除 2 条记忆'),
    expect.any(Number),
  )

  await act(async () => root.unmount())
})

it('批量操作失败不静默：成功与失败条数分开报', async () => {
  const { root } = await render()

  await click(itemChecks()[0])
  await click(itemChecks()[1])
  vi.mocked(deleteMemory)
    .mockResolvedValueOnce(true) // m_p1
    .mockRejectedValueOnce(new Error('磁盘只读')) // m_n1 → 单条失败不拖垮整批

  await click(batchButton('删除'))
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('已删除 1 条记忆，1 条失败'),
    expect.any(Number),
  )
  // 成功与否都要重新拉列表：界面不能停在「以为删掉了」的状态
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(3)

  await act(async () => root.unmount())
})

it('刷新后选中集收敛：已不存在的条目不会留在计数里', async () => {
  // ⚠️ 上一条「开关」用例会把全局开关翻到 false，而「刷新」按钮在记忆关闭时是禁用的 ——
  // 这里显式打开，让本用例不依赖执行顺序
  settingsState.setValue('memoryEnabled', true)
  const { root } = await render()

  await click(itemChecks()[0])
  expect(batchText()).toContain('已选 1 条')

  vi.mocked(listMemories).mockResolvedValue([]) // 模拟「在别处被删掉 / 整理覆盖了」
  await click(buttonByText('刷新'))
  // 收敛后回到「什么都没选」，批量栏仍在但按钮全禁用
  expect(batchText()).toContain('已选 0 条')
  expect(batchButton('删除').disabled).toBe(true)
  // 列表空了 → 分页栏也不该留着
  expect(document.querySelector('.memory-pager')).toBeNull()
  expect(document.querySelector('.memory-empty')).not.toBeNull()

  await act(async () => root.unmount())
})
