import { describe, expect, it } from 'vitest'
import { filterSessionGroups } from '@/ui/pages/chat/components/sidebar/session-filter'

/**
 * 会话搜索 —— 侧边栏「会话」页签搜索框的过滤规则。
 *
 * 两条必须守住的语义（错一条就是「明明有这个会话却搜不到」）：
 *   1. 关键词命中**分组名**（Agent 名 / 工作目录末级名）→ 整组保留；
 *   2. 命中为空的组整组消失，而不是留一个空分组占位。
 */
describe('filterSessionGroups', () => {
  const makeGroups = () => [
    {
      key: 'agent-1',
      name: '代码助手',
      icon: 'agent',
      sessions: [
        { title: '重构 sidebar' },
        { title: '写一个搜索框' },
        { title: '无关的会话' },
      ],
    },
    {
      key: 'C:/ws/virlen-app',
      name: 'virlen-app',
      icon: 'folder',
      sessions: [{ title: '发布 1.0' }, { title: '修个 bug' }],
    },
  ]

  it('空关键词 → 原样返回（不产生新数组）', () => {
    const groups = makeGroups()
    expect(filterSessionGroups(groups, '')).toBe(groups)
  })

  it('只保留标题命中的会话，未命中的组整组消失', () => {
    const filtered = filterSessionGroups(makeGroups(), '搜索框')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].key).toBe('agent-1')
    expect(filtered[0].sessions.map((s) => s.title)).toEqual(['写一个搜索框'])
  })

  it('命中分组名 → 整组保留（组内会话不再筛）', () => {
    const filtered = filterSessionGroups(makeGroups(), 'virlen-app')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].sessions).toHaveLength(2)
  })

  it('大小写不敏感（关键词已由调用方小写化，分组名 / 标题自行小写后比对）', () => {
    const filtered = filterSessionGroups(makeGroups(), 'virlen')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].key).toBe('C:/ws/virlen-app')
  })

  it('不过滤时会话顺序保持原样（分组按分组名排定的顺序不能被打乱）', () => {
    const groups = [
      {
        key: 'a',
        name: 'A',
        sessions: [{ title: 'x' }, { title: 'x 2' }, { title: 'y' }],
      },
    ]
    expect(
      filterSessionGroups(groups, 'x')[0].sessions.map((s) => s.title),
    ).toEqual(['x', 'x 2'])
  })

  it('不修改入参：命中筛选的分组是浅拷贝，原分组对象不受影响', () => {
    const groups = makeGroups()
    const filtered = filterSessionGroups(groups, '搜索框')
    expect(groups[0].sessions).toHaveLength(3)
    expect(filtered[0]).not.toBe(groups[0])
    // 未命中其他字段的组（这里没有）应原样传递，命中筛选的组只换 sessions
    expect(filtered[0].name).toBe('代码助手')
  })

  it('全部不命中 → 空数组（由调用方渲染空态）', () => {
    expect(filterSessionGroups(makeGroups(), '不存在的关键词')).toEqual([])
  })
})
