/**
 * todo/state — 任务清单纯函数测试
 *
 * 覆盖：归一化（脏输入）、统计、软规则校验、给模型/给人的渲染、
 * 差异比对，以及「唯一的那份清单」的派生（pickCurrentTodos）。
 */
import { describe, it, expect } from 'vitest'
import {
  checkTodoLimit,
  computeStats,
  diffTodos,
  pickCurrentTodos,
  renderTodoContent,
  renderUserTodoContent,
  sanitizeTodos,
  shouldShowTodoEntry,
  validateTodos,
  sameTodoList,
} from '@/domain/todo/state'
import type { Message } from '@/types'
import type { TodoItem, TodoStatus } from '@/domain/todo/types'

function toolMsg(id: string, uiData?: Record<string, any>): Message {
  return { id, role: 'tool', content: '', uiData, timestamp: 0 }
}

describe('sanitizeTodos', () => {
  it('非数组输入返回空清单', () => {
    expect(sanitizeTodos(undefined)).toEqual([])
    expect(sanitizeTodos(null)).toEqual([])
    expect(sanitizeTodos('x')).toEqual([])
    expect(sanitizeTodos({})).toEqual([])
  })

  it('丢弃 content 为空的项，status 非法时回落 pending', () => {
    const todos = sanitizeTodos([
      { id: '1', content: '   ', status: 'completed' },
      { id: '2', content: '有效任务', status: 'weird' },
      { id: '3', content: '另一项' },
      'not-an-object',
    ])
    expect(todos.map((t) => t.content)).toEqual(['有效任务', '另一项'])
    expect(todos[0].status).toBe('pending')
    expect(todos[1].status).toBe('pending')
  })

  it('id 缺失或重复时自动补唯一 id', () => {
    const todos = sanitizeTodos([
      { content: 'a' },
      { id: 'x', content: 'b' },
      { id: 'x', content: 'c' },
    ])
    const ids = todos.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('x')
  })

  it('裁剪超长正文与备注，保留 activeForm', () => {
    const todos = sanitizeTodos([
      {
        id: '1',
        content: 'x'.repeat(400),
        note: 'y'.repeat(200),
        activeForm: '正在进行',
        status: 'in_progress',
      },
    ])
    expect(todos[0].content.length).toBeLessThan(400)
    expect(todos[0].note!.length).toBeLessThan(200)
    expect(todos[0].activeForm).toBe('正在进行')
  })
})

describe('computeStats', () => {
  it('统计三态数量', () => {
    const stats = computeStats([
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'in_progress' },
      { id: '3', content: 'c', status: 'pending' },
      { id: '4', content: 'd', status: 'pending' },
    ])
    expect(stats).toEqual({ total: 4, completed: 1, inProgress: 1, pending: 2 })
  })
})

describe('validateTodos', () => {
  it('多个 in_progress 只报警不改数据', () => {
    const todos = [
      { id: '1', content: 'a', status: 'in_progress' as const },
      { id: '2', content: 'b', status: 'in_progress' as const },
    ]
    const warnings = validateTodos(todos)
    expect(warnings).toHaveLength(1)
    // 数据未被篡改
    expect(todos.every((t) => t.status === 'in_progress')).toBe(true)
  })

  it('单个 in_progress 无警告', () => {
    expect(
      validateTodos([{ id: '1', content: 'a', status: 'in_progress' }]),
    ).toEqual([])
  })
})

describe('checkTodoLimit', () => {
  it('超过 50 项返回错误文本，恰好 50 项通过', () => {
    expect(checkTodoLimit(50)).toBeNull()
    expect(checkTodoLimit(51)).toContain('max 50')
  })
})

describe('渲染', () => {
  const todos = [
    { id: '1', content: '读文档', status: 'completed' as const },
    { id: '2', content: '写工具', status: 'in_progress' as const, note: '进行中' },
  ]

  it('renderTodoContent 给模型：含 english status、序号、规则', () => {
    const text = renderTodoContent(todos)
    expect(text).toContain('[completed] 读文档')
    expect(text).toContain('[in_progress] 写工具 — 进行中')
    expect(text).toContain('at most one item may be in_progress')
  })

  it('renderTodoContent 空清单 = 已清空提示', () => {
    expect(renderTodoContent([])).toContain('task list was cleared')
  })

  it('警告会被附在给模型的正文里', () => {
    const text = renderTodoContent(todos, ['2 items are in_progress'])
    expect(text).toContain('⚠️ 2 items are in_progress')
  })

  it('renderUserTodoContent 标明「用户改的」并禁止复原被移除项', () => {
    const text = renderUserTodoContent(todos, [
      { type: 'remove', content: '补充单测' },
    ])
    expect(text).toContain('[User updated the task list]')
    expect(text).toContain('removed "补充单测"')
    expect(text).toContain('do not re-add tasks the user removed')
  })
})

describe('diffTodos', () => {
  const base: TodoItem[] = [
    { id: '1', content: 'a', status: 'pending' as const },
    { id: '2', content: 'b', status: 'pending' as const },
    { id: '3', content: 'c', status: 'pending' as const },
  ]

  it('识别新增 / 移除 / 状态变更 / 改写', () => {
    const next = [
      { id: '1', content: 'a', status: 'completed' as const },
      { id: '2', content: 'b2', status: 'pending' as const },
      { id: '4', content: 'd', status: 'pending' as const },
    ]
    const changes = diffTodos(base, next)
    const types = changes.map((c) => c.type).sort()
    expect(types).toContain('add')
    expect(types).toContain('remove')
    expect(types).toContain('status')
    expect(types).toContain('edit')
    expect(changes.find((c) => c.type === 'status')!.to).toBe('completed')
  })

  it('无变化时返回空数组', () => {
    expect(diffTodos(base, base.map((t) => ({ ...t })))).toEqual([])
  })

  it('识别顺序变更', () => {
    const next = [base[1], base[0], base[2]].map((t) => ({ ...t }))
    expect(diffTodos(base, next).some((c) => c.type === 'reorder')).toBe(true)
  })

  it('识别备注变更（只改备注也算一次修改）', () => {
    const next = base.map((t) => ({ ...t }))
    next[0].note = '补充说明'
    const changes = diffTodos(base, next)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('note')
    expect(changes[0].content).toBe('a')
    expect(changes[0].to).toBe('补充说明')
  })

  it('备注改回原样 → 无变化', () => {
    const withNote = base.map((t) => ({ ...t }))
    withNote[0].note = 'x'
    expect(diffTodos(base, withNote).some((c) => c.type === 'note')).toBe(true)
    // 清掉备注回到 base → 不再有任何差异
    const back = withNote.map((t) => {
      const c = { ...t }
      delete c.note
      return c
    })
    expect(
      diffTodos(base, back).filter((c) => c.type === 'note'),
    ).toHaveLength(0)
  })
})

describe('pickCurrentTodos（唯一的那份清单）', () => {
  it('没有清单消息时返回 null', () => {
    expect(pickCurrentTodos([])).toBeNull()
    expect(pickCurrentTodos([toolMsg('m1', { foo: 1 })])).toBeNull()
    expect(pickCurrentTodos([toolMsg('m1', { type: 'todo' })])).toBeNull()
  })

  it('取最后一条清单快照（模型写入 / 用户修改同构，不限 role）', () => {
    const model = toolMsg('m1', {
      type: 'todo',
      todos: [{ id: '1', content: 'a', status: 'pending' }],
      stats: { total: 1, completed: 0, inProgress: 0, pending: 1 },
      source: 'model',
    })
    const user: Message = {
      id: 'm2',
      role: 'feedback',
      content: '',
      timestamp: 1,
      uiData: {
        type: 'todo',
        todos: [{ id: '1', content: 'a', status: 'completed' }],
        stats: { total: 1, completed: 1, inProgress: 0, pending: 0 },
        source: 'user',
      },
    }
    const cur = pickCurrentTodos([model, user])
    expect(cur!.message.id).toBe('m2')
    expect(cur!.data.source).toBe('user')
    expect(cur!.index).toBe(1)
  })
})

describe('shouldShowTodoEntry（标题栏入口是否显示）', () => {
  const listMsg = (
    id: string,
    statuses: TodoStatus[],
    role: 'tool' | 'feedback' = 'tool',
  ): Message => {
    const todos = statuses.map((status, i) => ({
      id: `t${i + 1}`,
      content: `任务 ${i + 1}`,
      status,
    }))
    return {
      id,
      role,
      content: '',
      timestamp: 0,
      uiData: {
        type: 'todo',
        todos,
        stats: computeStats(todos),
        source: role === 'tool' ? 'model' : 'user',
      },
    }
  }
  const userMsg = (id: string): Message => ({
    id,
    role: 'user',
    content: '继续',
    timestamp: 0,
  })

  it('从来没有清单 → 不显示', () => {
    expect(shouldShowTodoEntry([])).toBe(false)
    expect(shouldShowTodoEntry([userMsg('u1')])).toBe(false)
  })

  it('清单被清空（0 项）→ 不显示', () => {
    expect(shouldShowTodoEntry([listMsg('m1', [])])).toBe(false)
  })

  it('还有未完成项 → 显示（哪怕用户已经开了新一轮）', () => {
    expect(shouldShowTodoEntry([listMsg('m1', ['completed', 'pending'])])).toBe(
      true,
    )
    expect(
      shouldShowTodoEntry([
        listMsg('m1', ['completed', 'pending']),
        userMsg('u1'),
      ]),
    ).toBe(true)
  })

  it('全部完成、但本轮就是它（用户还没说话）→ 显示', () => {
    expect(shouldShowTodoEntry([listMsg('m1', ['completed'])])).toBe(true)
    expect(
      shouldShowTodoEntry([userMsg('u1'), listMsg('m1', ['completed'])]),
    ).toBe(true)
  })

  it('全部完成 + 用户已开新一轮 → 不显示', () => {
    expect(
      shouldShowTodoEntry([listMsg('m1', ['completed']), userMsg('u1')]),
    ).toBe(false)
  })

  it('用户对清单的编辑（feedback）不算「新一轮」', () => {
    expect(
      shouldShowTodoEntry([
        listMsg('m1', ['completed']),
        listMsg('m2', ['completed'], 'feedback'),
      ]),
    ).toBe(true)
  })

  it('新的一轮里 AI 又写了一份清单 → 重新显示', () => {
    expect(
      shouldShowTodoEntry([
        listMsg('m1', ['completed']),
        userMsg('u1'),
        listMsg('m2', ['pending']),
      ]),
    ).toBe(true)
  })
})

describe('sameTodoList（编辑期间清单权威是否被换过）', () => {
  const item = (id: string, content: string, status: TodoStatus = 'pending') => ({
    id,
    content,
    status,
  })

  it('完全一致（含顺序 / 备注 / activeForm）→ true', () => {
    expect(sameTodoList([], [])).toBe(true)
    expect(
      sameTodoList(
        [item('1', 'A'), item('2', 'B', 'completed')],
        [item('1', 'A'), item('2', 'B', 'completed')],
      ),
    ).toBe(true)
    expect(
      sameTodoList(
        [{ id: '1', content: 'A', status: 'pending', note: 'n' }],
        [{ id: '1', content: 'A', status: 'pending', note: 'n' }],
      ),
    ).toBe(true)
  })

  it('任一字段或顺序有差异 → false', () => {
    expect(sameTodoList([item('1', 'A')], [item('1', 'A', 'completed')])).toBe(
      false,
    )
    expect(sameTodoList([item('1', 'A')], [item('1', 'A 改')])).toBe(false)
    expect(
      sameTodoList(
        [{ id: '1', content: 'A', status: 'pending', note: 'x' }],
        [item('1', 'A')],
      ),
    ).toBe(false)
    expect(
      sameTodoList(
        [{ id: '1', content: 'A', status: 'pending', activeForm: '正在 A' }],
        [item('1', 'A')],
      ),
    ).toBe(false)
    expect(
      sameTodoList([item('1', 'A'), item('2', 'B')], [item('2', 'B'), item('1', 'A')]),
    ).toBe(false)
    expect(sameTodoList([item('1', 'A')], [item('1', 'A'), item('2', 'B')])).toBe(
      false,
    )
  })
})
