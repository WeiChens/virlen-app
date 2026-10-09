/**
 * 文档删除（`knowledge-base/doc-delete.ts`）—— 单份删除的返回口径 + 清空的进度/取消/计数
 *
 * 为什么值得测：
 * 1. **删除是要花时间的**（后端要清掉这份文档在向量库里的片段）。清空几十份更是逐份来，
 *    所以它必须走进度弹窗、必须能停在整份的边界上 —— 这一套「第 x / y 份 + 可取消」
 *    的语义不是写在组件里、而是写在循环里，只有这里能守住；
 * 2. **记忆详情正文删不掉**（后端会拒），提前摘出来时必须**在确认框里说清**
 *    「不是全部都会删」—— 用户点的是「全部删除」，不该事后才发现还剩几份；
 * 3. 返回值决定调用方要不要刷新列表（0 份动手 / 被拒绝时刷新没有意义），
 *    以及「续删」与「确认」是不是两步（「删除中…」不能在确认框还弹着时出现）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRemoveDocument = vi.fn()
const mockPropt = vi.fn()

/** 进度弹窗的假手柄：测试关心的是「报名了哪些文案 / 结束语算不算被取消」 */
const h = vi.hoisted(() => ({
  tasks: [] as any[],
  state: { autoCancelAt: 0 },
}))

vi.mock('@/ui/components/shared/TaskProgress', () => ({
  beginTask: (options: any) => {
    const task: any = {
      options,
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
    removeDocument: (...a: any[]) => mockRemoveDocument(...a),
  },
}))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: (...a: any[]) => mockPropt(...a) },
}))

import {
  clearAllDocuments,
  confirmRemoveDocument,
  removeDocumentNow,
  summarizeDelete,
} from '@/ui/pages/Settings/knowledge-base/doc-delete'
import { showToast } from '@/ui/components/shared/Toast'
import type { KnowledgeBaseDocument } from '@/domain/ports'

beforeEach(() => {
  vi.clearAllMocks()
  h.tasks.length = 0
  h.state.autoCancelAt = 0
  mockPropt.mockResolvedValue(true)
  mockRemoveDocument.mockResolvedValue(undefined)
})

function doc(id: string, name: string, extra: Partial<KnowledgeBaseDocument> = {}) {
  return {
    id,
    file_name: name,
    file_type: 'md',
    file_size: 10,
    chunk_count: 1,
    status: 'ready',
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  } as KnowledgeBaseDocument
}

describe('summarizeDelete', () => {
  it('只说删掉的份数；有没删掉的才补一句（这两件事对用户的意味完全不同）', () => {
    expect(summarizeDelete({ success: 3, failed: 0 })).toBe('已删除 3 份')
    expect(summarizeDelete({ success: 3, failed: 2 })).toBe('已删除 3 份，2 份没删掉')
    expect(summarizeDelete({ success: 0, failed: 1 })).toBe('已删除 0 份，1 份没删掉')
  })
})

describe('单份删除：确认（只弹框） → 删除（真删 + toast）', () => {
  it('确认框：文案在 doc-delete 里统一，用户点确认返回 true', async () => {
    const ok = await confirmRemoveDocument('笔记.md')

    expect(mockPropt).toHaveBeenCalledWith(
      '删除文档',
      '删除「笔记.md」后，AI 就查不到它的内容了。',
      { danger: true, confirmText: '删除' },
    )
    expect(ok).toBe(true)
    // 只是确认：这一步不碰后端（「删除中…」要等用户确认后才出现）
    expect(mockRemoveDocument).not.toHaveBeenCalled()
  })

  it('确认框里点取消：返回 false，且不删', async () => {
    mockPropt.mockResolvedValue(false)

    expect(await confirmRemoveDocument('笔记.md')).toBe(false)
    expect(mockRemoveDocument).not.toHaveBeenCalled()
  })

  it('真删：删掉后一句 toast，返回 true（调用方据此刷新列表）', async () => {
    const ok = await removeDocumentNow('kb1', 'd1')

    expect(mockRemoveDocument).toHaveBeenCalledWith('kb1', 'd1')
    expect(showToast).toHaveBeenCalledWith('文档已删除')
    expect(ok).toBe(true)
  })

  it('删除失败：说清原因并返回 false（列表不该刷新）', async () => {
    mockRemoveDocument.mockRejectedValue(new Error('正在被使用'))

    expect(await removeDocumentNow('kb1', 'd1')).toBe(false)
    expect(showToast).toHaveBeenCalledWith('删除失败：正在被使用', 3000)
  })
})

describe('清空文档：逐份删、有进度、可取消', () => {
  const docs = [doc('d1', 'a.md'), doc('d2', 'b.md'), doc('d3', 'c.md')]

  it('逐份报进度、结束时给汇总，结束语是「删除完成」', async () => {
    const touched = await clearAllDocuments('kb1', '我的库', docs)

    expect(touched).toBe(true)
    expect(mockRemoveDocument.mock.calls.map((c) => c[1])).toEqual([
      'd1',
      'd2',
      'd3',
    ])

    const task = h.tasks[0]
    // 标题 / 来源 / 结束语都由调用方给 —— 弹窗不猜「这是导入还是删除」
    expect(task.options.title).toBe('正在删除文档')
    expect(task.options.source).toBe('「我的库」· 共 3 份')
    expect(task.options.total).toBe(3)
    expect(task.options.doneText).toBe('删除完成')
    expect(task.options.stoppedText).toBe('已停止删除')
    expect(task.options.stoppingHint).toContain('已经删掉的收不回来')

    expect(task.steps).toEqual([
      { current: 1, latest: '正在删除「a.md」', summary: '已删除 0 份' },
      { current: 2, latest: '正在删除「b.md」', summary: '已删除 1 份' },
      { current: 3, latest: '正在删除「c.md」', summary: '已删除 2 份' },
    ])
    expect(task.finished).toEqual({ cancelled: false, summary: '已删除 3 份' })
  })

  it('取消停在整份的边界：中断处那一份已删掉、后面的不再开始', async () => {
    h.state.autoCancelAt = 1

    const touched = await clearAllDocuments('kb1', '我的库', docs)

    expect(touched).toBe(true)
    expect(mockRemoveDocument).toHaveBeenCalledTimes(1)
    expect(mockRemoveDocument).toHaveBeenCalledWith('kb1', 'd1')
    expect(h.tasks[0].finished).toEqual({ cancelled: true, summary: '已删除 1 份' })
  })

  it('单份失败不打断整批，失败份数进汇总', async () => {
    mockRemoveDocument.mockImplementation(async (_kb: string, docId: string) => {
      if (docId === 'd2') throw new Error('删不掉')
    })

    const touched = await clearAllDocuments('kb1', '我的库', docs)

    expect(touched).toBe(true)
    expect(mockRemoveDocument).toHaveBeenCalledTimes(3)
    expect(h.tasks[0].finished).toEqual({
      cancelled: false,
      summary: '已删除 2 份，1 份没删掉',
    })
  })

  it('记忆详情正文摘出来删：确认框里说清「另外几份会跳过」', async () => {
    const withDetail = [
      doc('d1', 'a.md'),
      doc('m1', '记忆详情：某条.md', { memory_detail_of: 'm_abc' }),
      doc('d2', 'b.md'),
    ]

    await clearAllDocuments('kb1', '我的库', withDetail)

    const [title, content] = mockPropt.mock.calls[0]
    expect(title).toBe('清空文档')
    expect(content).toContain('「我的库」里的 2 份文档会被全部删除，无法恢复。')
    expect(content).toContain('另外 1 份是记忆的详情正文，会跳过（删记忆时才会一起清）')

    // 被锁定的那份连碰都不碰
    expect(mockRemoveDocument.mock.calls.map((c) => c[1])).toEqual(['d1', 'd2'])
    expect(h.tasks[0].options.total).toBe(2)
  })

  it('一份能删的都没有：不弹确认框、不开进度窗，直接说明原因', async () => {
    const touched = await clearAllDocuments('kb1', '我的库', [
      doc('m1', '记忆详情：某条.md', { memory_detail_of: 'm_abc' }),
    ])

    expect(touched).toBe(false)
    expect(mockPropt).not.toHaveBeenCalled()
    expect(h.tasks).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith(
      '这里的文档都是记忆的详情正文，不能在这个列表里删',
      3000,
    )
  })

  it('确认框里点取消：不开进度窗，也没删任何一份', async () => {
    mockPropt.mockResolvedValue(false)

    const touched = await clearAllDocuments('kb1', '我的库', docs)

    expect(touched).toBe(false)
    expect(h.tasks).toHaveLength(0)
    expect(mockRemoveDocument).not.toHaveBeenCalled()
  })
})
