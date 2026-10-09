/**
 * 文件夹 / 压缩包导入：进度弹窗 + 可取消 + .gitignore 过滤
 *
 * 守的五件事：
 * 1. **文件夹导入走 Rust 扫描**（`scanImportFolder`），前端不再自己遍历目录 ——「哪些文件该进来」
 *    因此只有一套答案（与压缩包导入同一套 .gitignore 规则）；
 * 2. **取消停在整份的边界**：导入到一半按取消，当前这份照样进库、下一份不再开始
 *    （不会出现「半个文件进了库」）；
 * 3. **压缩包逐条读**（`readKnowledgeBaseZipEntry`）—— 这是「能报进度、能取消」的前提；
 * 4. 跳过的份数要在弹窗里**分原因说一句**（被 .gitignore 排除 / 依赖或构建目录 / 不是文本 / 超过上限），
 *    而不是只给一句「什么都没找到」——2 MB 的文本上限与 50 MB 的 PDF 上限都出自这一套口径；
 * 5. **PDF 与纯文本走两条路**：PDF 交给后端解析（`addDocument`），其余文件当纯文本试读
 *    （不再看扩展名）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockListDocuments = vi.fn()
const mockWriteText = vi.fn()
const mockEditTextDocument = vi.fn()
const mockAddDocument = vi.fn()
const mockEditDocument = vi.fn()
const mockScanImportFolder = vi.fn()
const mockPreviewZip = vi.fn()
const mockReadZipEntry = vi.fn()
const mockPropt = vi.fn()

/** 进度弹窗的假手柄：测试关心的是「报过哪些文案 / 收尾算不算被取消」 */
const h = vi.hoisted(() => ({
  tasks: [] as any[],
  state: { autoCancelAt: 0 },
}))

vi.mock('@/ui/components/shared/TaskProgress', () => ({
  beginTask: (options: any) => {
    const task: any = {
      title: options.title,
      source: options.source ?? '',
      total: options.total,
      doneText: options.doneText,
      stoppedText: options.stoppedText,
      cancelled: false,
      steps: [] as Array<{ current: number; latest: string; summary: string }>,
      finished: null as null | { cancelled: boolean; summary: string },
      step(current: number, latest: string, summary: string) {
        task.steps.push({ current, latest, summary })
        // 模拟「用户在第 N 份之后按了取消」：循环的下一轮开头会读到 cancelled
        if (h.state.autoCancelAt && current >= h.state.autoCancelAt) {
          task.cancelled = true
        }
      },
      finish(cancelled: boolean, summary: string) {
        task.finished = { cancelled, summary }
      },
    }
    h.tasks.push(task)
    return task
  },
}))

vi.mock('@/services/rag-service', () => ({
  ragService: {
    listDocuments: (...a: any[]) => mockListDocuments(...a),
    writeText: (...a: any[]) => mockWriteText(...a),
    editTextDocument: (...a: any[]) => mockEditTextDocument(...a),
    addDocument: (...a: any[]) => mockAddDocument(...a),
    editDocument: (...a: any[]) => mockEditDocument(...a),
    scanImportFolder: (...a: any[]) => mockScanImportFolder(...a),
    previewKnowledgeBaseZip: (...a: any[]) => mockPreviewZip(...a),
    readKnowledgeBaseZipEntry: (...a: any[]) => mockReadZipEntry(...a),
  },
}))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: (...a: any[]) => mockPropt(...a) },
}))

const mockOpen = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...a: any[]) => mockOpen(...a),
}))
const mockReadTextFile = vi.fn()
const mockStat = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (...a: any[]) => mockReadTextFile(...a),
  readFile: vi.fn(),
  stat: (...a: any[]) => mockStat(...a),
}))

import {
  pickUploadFolder,
  importZipEntries,
} from '@/ui/pages/Settings/knowledge-base/file-import'
import type { BatchTask } from '@/ui/components/shared/TaskProgress'
import { importKnowledgeBaseZip } from '@/ui/pages/Settings/knowledge-base/export'
import { showToast } from '@/ui/components/shared/Toast'

beforeEach(() => {
  vi.clearAllMocks()
  h.tasks.length = 0
  h.state.autoCancelAt = 0
  mockPropt.mockResolvedValue(false) // 默认「跳过同名」
  mockListDocuments.mockResolvedValue([])
  mockWriteText.mockResolvedValue({ id: 'new' })
  mockEditTextDocument.mockResolvedValue({ id: 'edited' })
  mockAddDocument.mockResolvedValue({ id: 'added' })
  mockEditDocument.mockResolvedValue({ id: 'replaced' })
  mockReadTextFile.mockResolvedValue('一份文本')
  mockStat.mockResolvedValue({ size: 1024 })
})

describe('文件夹导入：扫描交给 Rust，全程有进度、可取消', () => {
  it('扫描结果逐份入库；被 .gitignore 排除的份数先说明一句', async () => {
    mockOpen.mockResolvedValue('C:/proj/docs')
    mockScanImportFolder.mockResolvedValue({
      files: ['C:/proj/docs/a.md', 'C:/proj/docs/子/b.txt'],
      ignored: 3,
    })
    const refresh = vi.fn()

    await pickUploadFolder('kb1', '我的库', refresh)

    expect(mockScanImportFolder).toHaveBeenCalledWith('C:/proj/docs')
    // 文档名用相对路径（保留目录结构）
    expect(mockWriteText).toHaveBeenNthCalledWith(1, 'kb1', 'a.md', '一份文本')
    expect(mockWriteText).toHaveBeenNthCalledWith(2, 'kb1', '子/b.txt', '一份文本')

    const task = h.tasks[0]
    expect(task.title).toBe('正在添加文档')
    expect(task.total).toBe(2)
    expect(task.source).toContain('我的库')
    expect(task.steps[0].current).toBe(0)
    expect(task.steps[0].latest).toContain('.gitignore')
    expect(task.steps[0].latest).toContain('3')
    expect(task.finished).toEqual({ cancelled: false, summary: '新增 2 份' })
    expect(refresh).toHaveBeenCalled()
  })

  it('取消：当前这份照常入库，下一份不再开始（停在整份的边界）', async () => {
    mockOpen.mockResolvedValue('C:/proj/docs')
    mockScanImportFolder.mockResolvedValue({
      files: ['C:/proj/docs/a.md', 'C:/proj/docs/b.md', 'C:/proj/docs/c.md'],
      ignored: 0,
    })
    h.state.autoCancelAt = 1

    await pickUploadFolder('kb1', '我的库')

    expect(mockWriteText).toHaveBeenCalledTimes(1)
    expect(mockWriteText).toHaveBeenCalledWith('kb1', 'a.md', '一份文本')
    expect(h.tasks[0].finished).toEqual({ cancelled: true, summary: '新增 1 份' })
  })

  it('一份能导的都没有：不弹进度窗，把每种跳过原因都说清楚', async () => {
    mockOpen.mockResolvedValue('C:/proj/docs')
    mockScanImportFolder.mockResolvedValue({
      files: [],
      ignored: 0,
      skipped_dirs: 0,
      not_text: 0,
      text_too_large: 0,
      pdf_too_large: 0,
    })
    await pickUploadFolder('kb1', '我的库')
    expect(h.tasks).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith(
      '这个文件夹里没有能导入的内容（只收 PDF 和纯文本文件）',
      3000,
    )

    mockScanImportFolder.mockResolvedValue({
      files: [],
      ignored: 4,
      skipped_dirs: 0,
      not_text: 0,
      text_too_large: 0,
      pdf_too_large: 0,
    })
    await pickUploadFolder('kb1', '我的库')
    expect(showToast).toHaveBeenCalledWith(
      '这个文件夹里没有能导入的内容：4 份被 .gitignore 排除，已跳过',
      3000,
    )
  })

  it('四种跳过原因都在弹窗首条里说清（.gitignore / 依赖目录 / 不是文本 / 超过上限）', async () => {
    mockOpen.mockResolvedValue('C:/proj/docs')
    mockScanImportFolder.mockResolvedValue({
      files: ['C:/proj/docs/a.json'],
      ignored: 3,
      skipped_dirs: 2,
      not_text: 5,
      text_too_large: 1,
      pdf_too_large: 2,
    })

    await pickUploadFolder('kb1', '我的库')

    const first = h.tasks[0].steps[0]
    expect(first.current).toBe(0)
    expect(first.latest.split('\n')).toEqual([
      '3 份被 .gitignore 排除，已跳过',
      '2 个依赖或构建目录（node_modules、dist 之类）已跳过',
      '5 份不是文本文件，已跳过',
      '1 份超过 2 MB，已跳过',
      '2 份 PDF 超过 50 MB，已跳过',
    ])
    // 任意扩展名的文本照旧入库
    expect(mockWriteText).toHaveBeenCalledWith('kb1', 'a.json', '一份文本')
  })

  it('文件夹里的 PDF 交给后端解析（addDocument），文档名用相对路径', async () => {
    mockOpen.mockResolvedValue('C:/proj/docs')
    mockScanImportFolder.mockResolvedValue({
      files: ['C:/proj/docs/子/手册.pdf'],
      ignored: 0,
      skipped_dirs: 0,
      not_text: 0,
      text_too_large: 0,
      pdf_too_large: 0,
    })
    mockAddDocument.mockResolvedValue({ id: 'doc_pdf' })

    await pickUploadFolder('kb1', '我的库')

    // 相对路径要当文档名传下去（后端默认只取基础名）
    expect(mockAddDocument).toHaveBeenCalledWith(
      'kb1',
      'C:/proj/docs/子/手册.pdf',
      '子/手册.pdf',
    )
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(mockReadTextFile).not.toHaveBeenCalled()
    expect(h.tasks[0].finished).toEqual({ cancelled: false, summary: '新增 1 份' })
  })
})

describe('压缩包导入：逐条读 + 同名策略 + 失败不中断', () => {
  const existing = new Map([['b.md', 'docB']])

  it('新的走 writeText、同名按「覆盖」走 editTextDocument、读不了的只算那一份', async () => {
    mockOpen.mockResolvedValue('C:/tmp/backup.zip')
    mockPreviewZip.mockResolvedValue({
      names: ['笔记.md', '扫描件.pdf', 'b.md'],
      ignored: 2,
    })
    mockReadZipEntry.mockImplementation(async (_zip: string, name: string) => {
      if (name === '扫描件.pdf') throw new Error('「扫描件.pdf」不是文本')
      return name === 'b.md' ? '新正文' : '正文'
    })
    mockPropt.mockResolvedValue(true) // 覆盖

    const changed = await importKnowledgeBaseZip('kb1', '我的库', existing)

    expect(mockPreviewZip).toHaveBeenCalledWith('C:/tmp/backup.zip')
    expect(mockReadZipEntry).toHaveBeenCalledTimes(3)
    expect(mockWriteText).toHaveBeenCalledWith('kb1', '笔记.md', '正文')
    expect(mockEditTextDocument).toHaveBeenCalledWith('kb1', 'docB', 'b.md', '新正文')
    expect(changed).toBe(true)

    const task = h.tasks[0]
    expect(task.title).toBe('正在导入压缩包')
    expect(task.total).toBe(3)
    expect(task.steps[0].latest).toContain('.gitignore')
    // 读不了的那份只是「没成功」，不影响另外两份
    expect(task.steps.some((s: any) => s.latest.includes('扫描件.pdf'))).toBe(true)
    expect(task.finished).toEqual({
      cancelled: false,
      summary: '新增 1 份，覆盖 1 份，1 份没成功',
    })
  })

  it('同名但选「跳过同名」：那一份连读都不读，只加新的', async () => {
    mockOpen.mockResolvedValue('C:/tmp/backup.zip')
    mockPreviewZip.mockResolvedValue({ names: ['b.md', 'c.md'], ignored: 0 })
    mockReadZipEntry.mockResolvedValue('正文')
    mockPropt.mockResolvedValue(false)

    const changed = await importKnowledgeBaseZip('kb1', '我的库', existing)

    expect(mockReadZipEntry).toHaveBeenCalledTimes(1)
    expect(mockReadZipEntry).toHaveBeenCalledWith('C:/tmp/backup.zip', 'c.md')
    expect(mockEditTextDocument).not.toHaveBeenCalled()
    expect(changed).toBe(true)
    expect(h.tasks[0].finished?.summary).toBe('新增 1 份，跳过同名 1 份')
  })

  it('包里一份都不可导入（全被 .gitignore 排除）：不弹进度窗并说明原因', async () => {
    mockOpen.mockResolvedValue('C:/tmp/backup.zip')
    mockPreviewZip.mockResolvedValue({ names: [], ignored: 5, too_large: 0 })

    const changed = await importKnowledgeBaseZip('kb1', '我的库', existing)

    expect(changed).toBe(false)
    expect(h.tasks).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith(
      '这个压缩包里没有能导入的内容：5 份被 .gitignore 排除，已跳过',
      3000,
    )
  })

  it('包里有超过 2 MB 的条目：不弹窗时也要说清（而不是只报「没有文档」）', async () => {
    mockOpen.mockResolvedValue('C:/tmp/backup.zip')
    mockPreviewZip.mockResolvedValue({ names: [], ignored: 0, too_large: 2 })

    const changed = await importKnowledgeBaseZip('kb1', '我的库', existing)

    expect(changed).toBe(false)
    expect(h.tasks).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith(
      '这个压缩包里没有能导入的内容：2 份超过 2 MB，已跳过',
      3000,
    )
  })

  it('导入时先报一句「排掉了多少」（.gitignore 与超限分开说）', async () => {
    mockOpen.mockResolvedValue('C:/tmp/backup.zip')
    mockPreviewZip.mockResolvedValue({
      names: ['c.md'],
      ignored: 1,
      too_large: 3,
    })
    mockReadZipEntry.mockResolvedValue('正文')

    await importKnowledgeBaseZip('kb1', '我的库', existing)

    expect(h.tasks[0].steps[0].latest.split('\n')).toEqual([
      '1 份被 .gitignore 排除，已跳过',
      '3 份超过 2 MB，已跳过',
    ])
  })
})

describe('importZipEntries（逐条导入循环本身）', () => {
  /** 手搓一个够用的任务手柄（不走弹窗那条 mock） */
  function fakeTask(autoCancelAt = 0) {
    const steps: Array<{ current: number; latest: string }> = []
    const task = {
      cancelled: false,
      steps,
      finished: null as null | { cancelled: boolean; summary: string },
      step(current: number, latest: string) {
        steps.push({ current, latest })
        if (autoCancelAt && current >= autoCancelAt) task.cancelled = true
      },
      finish(cancelled: boolean, summary: string) {
        task.finished = { cancelled, summary }
      },
    }
    return task as unknown as BatchTask & typeof task
  }

  it('空内容算失败（后端会拒「文本内容为空」），并如实收尾', async () => {
    mockReadZipEntry.mockResolvedValue('   ')
    const task = fakeTask()

    const counts = await importZipEntries(
      'kb1',
      'C:/tmp/x.zip',
      ['空.md'],
      { existing: new Map(), overwrite: false },
      undefined,
      task,
    )

    expect(counts).toEqual({ created: 0, overwritten: 0, skipped: 0, failed: 1 })
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(task.finished).toEqual({ cancelled: false, summary: '1 份没成功' })
  })

  it('中途取消：剩下的条目不再读', async () => {
    mockReadZipEntry.mockResolvedValue('正文')
    const task = fakeTask(1)

    const counts = await importZipEntries(
      'kb1',
      'C:/tmp/x.zip',
      ['a.md', 'b.md', 'c.md'],
      { existing: new Map(), overwrite: false },
      undefined,
      task,
    )

    expect(mockReadZipEntry).toHaveBeenCalledTimes(1)
    expect(counts.created).toBe(1)
    expect(task.finished).toEqual({ cancelled: true, summary: '新增 1 份' })
  })
})
