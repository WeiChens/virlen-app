/**
 * memory-settings — 长期记忆面板（记忆功能 P0）
 *
 * 覆盖四件容易出错的事：
 * 1. **分区与计数**：永久 / 普通两块必须按 `level` 分开（级别就是注入策略，混在一起用户没法审）；
 * 2. **写操作真的落到仓储**：新增 / 删除 / 升级 / 停用都是「调仓储 + 重新拉列表」，
 *    少了 reload 会出现「界面上改了、实际没生效」；
 * 3. **注入预览展示的是后端渲染结果**：前端不自己拼 `# Memory` 段（否则用户看到的不是模型收到的）；
 * 4. **蒸馏整理（P2）**：按钮按「昨天」触发、状态行如实展示上次结果、失败可重跑 ——
 *    整理是**花了钱的动作**，界面绝不能让它显得「点了没反应」。
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
}

/** 第 2 条永久 —— 「分区全选」与「半选态」需要一个以上的同区条目 */
const permanentMemory2: MemoryRecord = {
  id: 'm_p2',
  level: 'permanent',
  kind: 'decision',
  summary: '改动一律走 worktree',
  hits: 1,
}

/** 已停用的普通记忆 —— 批量操作必须跳过「本来就如此」的条目 */
const disabledNormalMemory: MemoryRecord = {
  id: 'm_n2',
  level: 'normal',
  kind: 'fact',
  summary: '旧的技术选型笔记（已过时）',
  disabled: true,
}

async function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<MemorySettings />)
  })
  return { host, root }
}

/** 按文本找按钮（面板里按钮很多，按文案定位最贴近用户行为） */
function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`找不到按钮：${text}`)
  return found as HTMLButtonElement
}

/**
 * 某一行的行内按钮。
 *
 * ⚠️ 必须按行定位：批量栏里的按钮与行内按钮**同名**（「停用」「删除」…），
 * 用 `buttonByText` 会随「批量栏在不在」而指向不同元素 —— 那种用例测的不是用户看到的东西。
 */
function rowButton(summary: string, text: string): HTMLButtonElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.memory-item')).find((el) =>
    el.querySelector('.memory-item-summary')?.textContent?.includes(summary),
  )
  if (!row) throw new Error(`找不到记忆条目：${summary}`)
  const found = Array.from(row.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`条目「${summary}」里找不到按钮：${text}`)
  return found as HTMLButtonElement
}

/** 批量栏里的按钮（批量栏不存在时直接失败，而不是静默拿到行内按钮） */
function batchButton(text: string): HTMLButtonElement {
  const bar = document.querySelector('.memory-batch-bar')
  if (!bar) throw new Error('批量栏未渲染')
  const found = Array.from(bar.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`批量栏里找不到按钮：${text}`)
  return found as HTMLButtonElement
}

/** 记忆行里的复选框（分区标题的全选框也用 .memory-check，所以必须按容器分） */
function itemChecks(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('.memory-item .memory-check'),
  )
}

/** 分区标题的全选框（顺序 = 渲染顺序：永久区在前） */
function sectionChecks(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('.memory-section-title .memory-check'),
  )
}

/** 批量栏的文案（不存在则返回 null，便于断言「没选中时不该有它」） */
function batchText(): string | null {
  return document.querySelector('.memory-batch-bar')?.textContent ?? null
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * 往「记忆内容」里输入。
 *
 * ⚠️ 受控组件：必须走原生 setter + `input` 事件，直接赋 `value` 不会触发 React 的 onChange。
 */
async function typeSummary(text: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('.memory-form-summary')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

it('按级别分区展示，并显示命中次数与来源日', async () => {
  const { root } = await render()

  const sections = Array.from(document.querySelectorAll('.memory-section-title')).map(
    (n) => n.textContent,
  )
  expect(sections[0]).toContain('永久记忆')
  expect(sections[0]).toContain('1')
  expect(sections[1]).toContain('普通记忆')

  const items = Array.from(document.querySelectorAll<HTMLElement>('.memory-item'))
  expect(items).toHaveLength(2)
  expect(items[0].textContent).toContain('用户偏好中文回复')
  expect(items[0].textContent).toContain('命中 3 次')
  expect(items[1].textContent).toContain('在 virlen-app 实现记忆功能')

  await act(async () => root.unmount())
})

it('新增记忆：写入仓储后重新拉列表；空内容则不写只提示', async () => {
  const { root } = await render()

  await click(buttonByText('新增记忆'))
  await typeSummary('用户要求回复简洁')
  await click(buttonByText('保存'))

  expect(upsertMemory).toHaveBeenCalledTimes(1)
  const saved = vi.mocked(upsertMemory).mock.calls[0][0]
  expect(saved.summary).toBe('用户要求回复简洁')
  expect(saved.level).toBe('normal')
  expect(saved.kind).toBe('project')
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(2) // 初次 + 保存后刷新

  // 空内容：不写仓储（Rust 侧也会拒，但别让用户白跑一趟 IPC）
  await click(buttonByText('新增记忆'))
  await click(buttonByText('保存'))
  expect(upsertMemory).toHaveBeenCalledTimes(1)

  await act(async () => root.unmount())
})

it('分类 / 级别用共享 Select 组件（下拉选择真的写进草稿）', async () => {
  const { root } = await render()

  await click(buttonByText('新增记忆'))
  await typeSummary('下拉选择要写进草稿')
  const selects = document.querySelectorAll<HTMLElement>('.memory-form .custom-select')
  expect(selects).toHaveLength(2) // 分类 / 级别
  // 本表单不该再有原生 select：原生下拉的视觉 / 键位与其它设置页不一致，
  // 且会被设置页的滚动容器裁剪
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

it('删除走二次确认；升级级别调用 setMemoryLevel', async () => {
  const { root } = await render()

  await click(rowButton('在 virlen-app 实现记忆功能', '升级为永久'))
  expect(setMemoryLevel).toHaveBeenCalledWith('m_n1', 'permanent')

  await click(rowButton('用户偏好中文回复', '删除'))
  expect(deleteMemory).toHaveBeenCalled()
  // 初次加载 + 升级后刷新 + 删除后刷新
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(3)

  await act(async () => root.unmount())
})

it('停用：切换 disabled', async () => {
  const { root } = await render()

  await click(rowButton('用户偏好中文回复', '停用'))
  expect(setMemoryDisabled).toHaveBeenCalledWith('m_p1', true)

  await act(async () => root.unmount())
})

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
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
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
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(2)
  expect(vi.mocked(listMemoryRuns)).toHaveBeenCalledTimes(2)

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
  expect(vi.mocked(loadMemorySection)).toHaveBeenCalledTimes(1)
  // 面板取段一律带 `true`：后端据此不打截断告警埋点（否则指标被面板刷高）
  expect(vi.mocked(loadMemorySection)).toHaveBeenCalledWith(true)

  await click(rowButton('用户偏好中文回复', '停用'))
  expect(vi.mocked(loadMemorySection)).toHaveBeenCalledTimes(2)

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

// ==================== 多选与批量操作 ====================
//
// 这一组守三件事：
// ① 常态列表不该挂着每条 4 个按钮（操作只在悬停 / 键盘聚焦时显形，样式契约见
//    `memory-settings-style-contract.test.ts`）；
// ② 选中态与批量栏的**数字必须与列表一致** —— 刷新后选中集要收敛，不能出现「已选 3 条」
//    而实际只剩 1 条可操作；
// ③ 批量操作只对「确实需要改」的条目下手，失败的条数如实上报（静默吞掉失败比报错更糟）。

it('未选中时没有批量栏；勾选 / 点整行都能选中，取消选择后批量栏消失', async () => {
  const { root } = await render()

  expect(document.querySelector('.memory-batch-bar')).toBeNull()

  await click(itemChecks()[0]) // 永久那条
  expect(batchText()).toContain('已选 1 条')
  expect(document.querySelectorAll('.memory-item')[0].classList.contains('is-selected')).toBe(
    true,
  )

  // 点整行（不是复选框）也切换选中：复选框本体只有 15px，长列表里逐条去抠太费手
  await click(document.querySelectorAll('.memory-item')[1])
  expect(batchText()).toContain('已选 2 条')

  await click(buttonByText('取消选择'))
  expect(document.querySelector('.memory-batch-bar')).toBeNull()
  expect(document.querySelectorAll('.memory-item.is-selected')).toHaveLength(0)

  await act(async () => root.unmount())
})

it('行内操作不会顺手把这一条选上（否则点「停用」会连选择一起变）', async () => {
  const { root } = await render()

  await click(rowButton('用户偏好中文回复', '停用'))
  expect(setMemoryDisabled).toHaveBeenCalledWith('m_p1', true)
  expect(document.querySelector('.memory-batch-bar')).toBeNull()

  await act(async () => root.unmount())
})

it('分区全选：支持半选态，且只作用于本区', async () => {
  vi.mocked(listMemories).mockResolvedValue([permanentMemory, permanentMemory2, normalMemory])
  const { root } = await render()

  const [permAll, normalAll] = sectionChecks()
  expect(permAll.checked).toBe(false)

  await click(itemChecks()[0]) // 永久区只选了 1 / 2 条
  expect(itemChecks()[0].checked).toBe(true)
  expect(permAll.checked).toBe(false)
  expect(permAll.indeterminate).toBe(true) // 半选：不能显示成「全都没选」

  await click(permAll)
  expect(permAll.indeterminate).toBe(false)
  expect(permAll.checked).toBe(true)
  expect(batchText()).toContain('已选 2 条')
  expect(normalAll.checked).toBe(false) // 本区全选不该波及另一区

  await click(permAll) // 再点一次 = 取消本区
  expect(document.querySelector('.memory-batch-bar')).toBeNull()

  await act(async () => root.unmount())
})

it('批量停用 / 启用：跳过已经如此的条目，并报真实条数', async () => {
  vi.mocked(listMemories).mockResolvedValue([permanentMemory, disabledNormalMemory])
  const { root } = await render()

  await click(sectionChecks()[1]) // 普通区全选 = 只选中那条已停用的
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

it('批量改级别：只动需要改的，提示里报的是真实条数', async () => {
  vi.mocked(listMemories).mockResolvedValue([permanentMemory, normalMemory])
  const { root } = await render()

  await click(itemChecks()[1]) // 普通那条
  expect(batchButton('降级为普通').disabled).toBe(true) // 本来就是普通 → 不该让人点
  expect(batchButton('升级为永久').disabled).toBe(false)

  await click(batchButton('升级为永久'))
  expect(setMemoryLevel).toHaveBeenCalledTimes(1)
  expect(setMemoryLevel).toHaveBeenCalledWith('m_n1', 'permanent')
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining('已升级为永久 1 条记忆'),
    expect.any(Number),
  )

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
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(2)

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
  expect(document.querySelector('.memory-batch-bar')).toBeNull()

  await act(async () => root.unmount())
})
