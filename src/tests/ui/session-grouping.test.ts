import { describe, expect, it } from 'vitest'
import {
  groupSessions,
  toggleGroupPin,
  UNGROUPED_KEY,
  type GroupableSession,
} from '@/ui/pages/chat/components/sidebar/session-grouping'

/**
 * 会话分组 —— 侧边栏「会话」页签的分组规则。
 *
 * 需要守住的语义（错一条用户就会觉得「分组没了 / 置顶没用」）：
 *   1. 置顶的**分组**排到列表最前（置顶组之间保持名称序）；
 *   2. 组内顺序 = 入参顺序（排序统一由 `sessionStore.listSessions()` 负责，
 *      这里只做聚合，不能顺手再排一遍）；
 *   3. 已置顶的 key 属于另一个维度 / 已消失的分组时被忽略，不能炸、也不能凭空造组。
 */

/** 最小会话：分组只依赖 id / title / pinned / agentId / workspace */
function makeSession(
  id: string,
  title: string,
  patch: Partial<GroupableSession> = {},
): GroupableSession {
  return { id, title, ...patch }
}

const AGENTS: Record<string, { name: string; description?: string }> = {
  a1: { name: '代码助手', description: '写代码的' },
  a2: { name: '文档助手' },
  a3: { name: '翻译助手' },
}
const lookupAgent = (id: string) => AGENTS[id]

/**
 * 三个 Agent 分组（按名称序：代码助手(d) < 翻译助手(f) < 文档助手(w) → a1 < a3 < a2）
 */
const NAME_ORDER = ['a1', 'a3', 'a2']

function threeAgentGroups(pinnedGroups?: string[]) {
  return groupSessions(
    [
      makeSession('s1', '甲', { agentId: 'a1' }),
      makeSession('s2', '乙', { agentId: 'a2' }),
      makeSession('s3', '丙', { agentId: 'a3' }),
    ],
    { type: 'agent', lookupAgent, pinnedGroups },
  )
}

describe('groupSessions — 按 Agent 分组', () => {
  it('已知 Agent 在前、未分组殿后，组间按名称排', () => {
    const groups = groupSessions(
      [
        makeSession('s1', '无 Agent'),
        makeSession('s2', '文档', { agentId: 'a2' }),
        makeSession('s3', '代码', { agentId: 'a1' }),
      ],
      { type: 'agent', lookupAgent },
    )
    // 代码助手(a1) < 文档助手(a2)，未分组最后
    expect(groups.map((g) => g.key)).toEqual(['a1', 'a2', UNGROUPED_KEY])
    expect(groups[2].name).toBe('未分组')
    expect(groups[2].title).toBe('未关联 Agent 的会话')
  })

  it('Agent 已删除（查不到）→ 落到该 id 的分组，名称为「未知代理」', () => {
    const groups = groupSessions(
      [makeSession('s1', '孤儿', { agentId: 'gone' })],
      { type: 'agent', lookupAgent },
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('gone')
    expect(groups[0].name).toBe('未知代理')
  })

  it('Agent 简介作为悬停提示；没有简介时退回名称', () => {
    const groups = groupSessions(
      [
        makeSession('s1', '甲', { agentId: 'a1' }),
        makeSession('s2', '乙', { agentId: 'a2' }),
      ],
      { type: 'agent', lookupAgent },
    )
    expect(groups.find((g) => g.key === 'a1')!.title).toBe('写代码的')
    expect(groups.find((g) => g.key === 'a2')!.title).toBe('文档助手')
  })

  it('组内保持入参顺序（会话级置顶只在组内排最前，靠 listSessions 的入参顺序）', () => {
    const groups = groupSessions(
      [
        makeSession('p1', '置顶的', { agentId: 'a1', pinned: true }),
        makeSession('s1', '普通的', { agentId: 'a1' }),
      ],
      { type: 'agent', lookupAgent },
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['p1', 's1'])
  })
})

describe('groupSessions — 按工作目录分组', () => {
  it('分组名取目录末级名，未设置工作目录的殿后', () => {
    const groups = groupSessions(
      [
        makeSession('s1', '甲', { workspace: 'C:\\code\\virlen\\virlen-app' }),
        makeSession('s2', '乙'),
        makeSession('s3', '丙', { workspace: 'C:/ws/zeta' }),
      ],
      { type: 'workspace' },
    )
    expect(groups.map((g) => g.key)).toEqual([
      'C:\\code\\virlen\\virlen-app',
      'C:/ws/zeta',
      UNGROUPED_KEY,
    ])
    expect(groups[0].name).toBe('virlen-app')
    expect(groups[0].icon).toBe('folder')
    expect(groups[2].name).toBe('未设置工作目录')
  })
})

describe('groupSessions — 分组置顶', () => {
  it('未传 / 空列表 → 顺序不变', () => {
    expect(threeAgentGroups().map((g) => g.key)).toEqual(NAME_ORDER)
    expect(threeAgentGroups([]).map((g) => g.key)).toEqual(NAME_ORDER)
  })

  it('置顶分组排到最前，置顶组之间保持名称序', () => {
    expect(threeAgentGroups(['a3']).map((g) => g.key)).toEqual(['a3', 'a1', 'a2'])
    // 传入顺序（a3, a2）不影响展示：置顶组内部仍按名称序（a3 翻译 < a2 文档）
    expect(threeAgentGroups(['a2', 'a3']).map((g) => g.key)).toEqual([
      'a3',
      'a2',
      'a1',
    ])
  })

  it('置顶 key 属于另一个维度 / 已被删除 → 被忽略，且不凭空造组', () => {
    // 工作目录维度的残留 key 混进来（真实场景：切换分组方式后传错列表）
    const groups = threeAgentGroups(['C:/ws/other', 'gone'])
    expect(groups.map((g) => g.key)).toEqual(NAME_ORDER)
  })

  it('未分组也可以置顶（不特殊处理，用户自己决定）', () => {
    const groups = groupSessions(
      [
        makeSession('s1', '无 Agent'),
        makeSession('s2', '有 Agent', { agentId: 'a1' }),
      ],
      { type: 'agent', lookupAgent, pinnedGroups: [UNGROUPED_KEY] },
    )
    expect(groups.map((g) => g.key)).toEqual([UNGROUPED_KEY, 'a1'])
  })

  it('不修改入参与置顶列表', () => {
    const sessions = [makeSession('s1', '甲', { agentId: 'a1' })]
    const pinned = ['a1']
    groupSessions(sessions, { type: 'agent', lookupAgent, pinnedGroups: pinned })
    expect(sessions).toHaveLength(1)
    expect(pinned).toEqual(['a1'])
  })
})

describe('toggleGroupPin', () => {
  it('未置顶 → 追加入列', () => {
    expect(toggleGroupPin([], 'a1')).toEqual(['a1'])
    expect(toggleGroupPin(undefined, 'a1')).toEqual(['a1'])
  })

  it('已置顶 → 从列中移除', () => {
    expect(toggleGroupPin(['a1', 'a2'], 'a1')).toEqual(['a2'])
  })

  it('返回新数组，不改入参（便于直接塞回 MobX observable）', () => {
    const pinned = ['a1']
    const next = toggleGroupPin(pinned, 'a2')
    expect(pinned).toEqual(['a1'])
    expect(next).not.toBe(pinned)
  })

  it('幂等性：连续两次翻转回到原状', () => {
    expect(toggleGroupPin(toggleGroupPin(['a1'], 'a2'), 'a2')).toEqual(['a1'])
  })
})
