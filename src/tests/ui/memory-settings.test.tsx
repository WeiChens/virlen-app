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
// 删除是二次确认的：测试里一律「点了确定」
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve(true)) },
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

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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
  const textarea = document.querySelector<HTMLTextAreaElement>('.memory-form-summary')!
  await act(async () => {
    // React 受控组件：必须走原生 setter + input 事件，直接赋 value 不会触发 onChange
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    setter.call(textarea, '用户要求回复简洁')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

it('删除走二次确认；升级级别调用 setMemoryLevel', async () => {
  const { root } = await render()

  await click(buttonByText('升级为永久'))
  expect(setMemoryLevel).toHaveBeenCalledWith('m_n1', 'permanent')

  await click(buttonByText('删除'))
  expect(deleteMemory).toHaveBeenCalled()
  // 初次加载 + 升级后刷新 + 删除后刷新
  expect(vi.mocked(listMemories)).toHaveBeenCalledTimes(3)

  await act(async () => root.unmount())
})

it('停用：切换 disabled', async () => {
  const { root } = await render()

  await click(buttonByText('停用'))
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

  await click(buttonByText('停用'))
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
