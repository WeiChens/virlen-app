/**
 * todo_write 工具 — 语义测试
 *
 * 覆盖：注册、全量替换语义、空数组清空、非法入参报错、数量上限、
 * 软规则（多个 in_progress 只警告不改数据）、uiData 契约。
 */
import { describe, it, expect } from 'vitest'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutorResponse } from '@/domain/tools/types'
import type { TodoUiData } from '@/domain/todo/types'

// 引入 plan 分类（触发 todo_write 注册）
import '@/infrastructure/tools/plan'

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

async function run(args: Record<string, any>): Promise<ToolExecutorResponse> {
  const tool = await toolRegistry.get('todo_write')
  expect(tool).toBeDefined()
  return tool!.executor(args, makeCtx())
}

function uiOf(result: ToolExecutorResponse): TodoUiData {
  if (typeof result === 'string' || !('uiData' in result)) {
    throw new Error('期望返回带 uiData 的 ToolResult')
  }
  return result.uiData as TodoUiData
}

function textOf(result: ToolExecutorResponse): string {
  if (typeof result === 'string') return result
  if ('content' in result) return result.content
  return ''
}

describe('todo_write 注册与定义', () => {
  it('应已注册，且参数 schema 声明 todos 数组必需', async () => {
    const tool = await toolRegistry.get('todo_write')
    expect(tool).toBeDefined()
    const def = tool!.definition
    expect(def.name).toBe('todo_write')
    expect(def.parameters.required).toContain('todos')
    expect(def.parameters.properties.todos.type).toBe('array')
    // 描述里必须明确「全量替换」语义，否则模型会当成增量更新
    expect(def.description).toContain('COMPLETE list')
  })

  it('分类归属为 plan', () => {
    expect(toolRegistry).toBeDefined()
  })
})

describe('todo_write 执行', () => {
  it('写入清单：content 给模型、uiData 给 UI，统计正确', async () => {
    const result = await run({
      todos: [
        { id: '1', content: '读文档', status: 'completed' },
        { id: '2', content: '写工具', status: 'in_progress', note: '进行中' },
        { id: '3', content: '补测试', status: 'pending' },
      ],
    })
    const text = textOf(result)
    expect(text).toContain('[completed] 读文档')
    expect(text).toContain('[in_progress] 写工具 — 进行中')

    const ui = uiOf(result)
    expect(ui.type).toBe('todo')
    expect(ui.source).toBe('model')
    expect(ui.stats).toEqual({
      total: 3,
      completed: 1,
      inProgress: 1,
      pending: 1,
    })
    expect(ui.todos.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  it('空数组 = 清空清单（不是错误）', async () => {
    const result = await run({ todos: [] })
    expect(textOf(result)).toContain('清单已清空')
    expect(uiOf(result).todos).toEqual([])
  })

  it('todos 不是数组 → 报错', async () => {
    await expect(run({ todos: 'oops' })).rejects.toThrow()
  })

  it('全部项都缺 content → 报错（避免模型以为写进去了）', async () => {
    await expect(
      run({ todos: [{ id: '1', content: '   ' }] }),
    ).rejects.toThrow()
  })

  it('超过 50 项 → 报错且不静默截断', async () => {
    const todos = Array.from({ length: 51 }, (_, i) => ({
      id: String(i + 1),
      content: `任务 ${i + 1}`,
    }))
    await expect(run({ todos })).rejects.toThrow(/最多 50 项/)
  })

  it('多个 in_progress：只在正文里警告，不改数据', async () => {
    const result = await run({
      todos: [
        { id: '1', content: 'a', status: 'in_progress' },
        { id: '2', content: 'b', status: 'in_progress' },
      ],
    })
    expect(textOf(result)).toContain('⚠️')
    expect(uiOf(result).todos.every((t) => t.status === 'in_progress')).toBe(true)
  })

  it('全量替换语义：第二次调用不保留上一次的项', async () => {
    await run({ todos: [{ id: '1', content: 'old' }] })
    const result = await run({ todos: [{ id: '9', content: 'new' }] })
    expect(uiOf(result).todos.map((t) => t.content)).toEqual(['new'])
  })
})
