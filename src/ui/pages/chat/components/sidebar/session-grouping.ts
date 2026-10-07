/**
 * 侧边栏「会话」页签的分组规则（纯函数，无 React / store 依赖）。
 *
 * 维度由 `settings.sessionGroupType` 决定：按 Agent 或按工作目录。置顶分组排最前（置顶组之间保持名称序）；
 * 置顶 key 按维度分开存（见 `settingStore.pinnedSessionGroups`）—— `UNGROUPED_KEY` 在两个维度里是同一个
 * 字面量，混一份列表会互相串。
 *
 * ⚠️ **组内顺序 = 入参顺序**：会话排序（会话级 `pinned` → `updatedAt` 倒序）的唯一来源是
 * `sessionStore.listSessions()`，这里只做聚合 + 分组置顶，调用方必须传已排序的列表。
 * Agent 名称 / 简介由 `lookupAgent` 回调注入（不直接依赖 agentStore，方便单测）。
 */
import { t, tpl } from '@/ui/i18n'

/** 未分组会话 / 未设置工作目录的虚拟 key */
export const UNGROUPED_KEY = '__ungrouped__'

/** 分组图标：`folder` = 工作目录，`agent` = Agent */
export type SessionGroupIcon = 'agent' | 'folder'

export interface SessionGroup<S> {
  key: string
  name: string
  icon: SessionGroupIcon
  /** 悬停提示：Agent 简介 / 工作目录完整路径 */
  title: string
  sessions: S[]
}

/** 分组只依赖这几个字段（结构化类型：单测可传最小对象，不必造完整 Session） */
export interface GroupableSession {
  id: string
  title: string
  /** 未置顶时可能是 undefined（老数据），一律按「未置顶」处理 */
  pinned?: boolean
  agentId?: string
  workspace?: string
}

/** Agent 名称 / 简介的最小结构（与 `types.Agent` 兼容） */
export interface GroupableAgent {
  name: string
  description?: string
}

export interface GroupSessionsOptions<S extends GroupableSession> {
  /** 'agent' = 按 Agent 分组；'workspace' = 按工作目录分组 */
  type: 'agent' | 'workspace'
  /** 取 Agent 元信息（按 Agent 分组时用于分组名 / 提示）；未知 id 返回 undefined */
  lookupAgent?: (agentId: string) => GroupableAgent | undefined
  /** 已置顶的分组 key（**当前维度**的那一份，见 `pinnedSessionGroups`） */
  pinnedGroups?: readonly string[]
}

/** 把（已排序的）会话列表聚合成分组，置顶分组排最前 */
export function groupSessions<S extends GroupableSession>(
  sessions: S[],
  options: GroupSessionsOptions<S>,
): SessionGroup<S>[] {
  const groups =
    options.type === 'workspace'
      ? groupByWorkspace(sessions)
      : groupByAgent(sessions, options.lookupAgent)
  return pinnedFirst(groups, options.pinnedGroups)
}

/**
 * 翻转某个分组的置顶态：返回**新数组**（不改入参，便于直接塞回 MobX observable）。
 * 数组顺序不是展示顺序（展示 = 置顶优先 + 组名序，见 `pinnedFirst`），所以直接追加即可。
 */
export function toggleGroupPin(
  pinned: readonly string[] | undefined,
  key: string,
): string[] {
  const list = pinned ?? []
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
}

/** 置顶分组提前；置顶组之间、未置顶组之间都保持入参顺序。未置顶任何分组时原样返回 */
function pinnedFirst<S>(
  groups: SessionGroup<S>[],
  pinnedKeys: readonly string[] | undefined,
): SessionGroup<S>[] {
  if (!pinnedKeys || pinnedKeys.length === 0) return groups
  const pinnedSet = new Set(pinnedKeys)
  const first = groups.filter((g) => pinnedSet.has(g.key))
  if (first.length === 0 || first.length === groups.length) return groups
  return [...first, ...groups.filter((g) => !pinnedSet.has(g.key))]
}

/** 按 Agent 分组：已知 Agent 的分组在前、未分组殿后，组间按名称排 */
function groupByAgent<S extends GroupableSession>(
  sessions: S[],
  lookupAgent?: (agentId: string) => GroupableAgent | undefined,
): SessionGroup<S>[] {
  const groupMap = new Map<string, SessionGroup<S>>()

  for (const session of sessions) {
    const key = session.agentId || UNGROUPED_KEY
    let group = groupMap.get(key)
    if (!group) {
      let name: string
      let title: string
      if (key === UNGROUPED_KEY) {
        name = t('未分组')
        title = t('未关联 Agent 的会话')
      } else {
        const agent = lookupAgent?.(key)
        name = agent?.name || t('未知代理')
        title = agent?.description || name
      }
      group = { key, name, icon: 'agent', title, sessions: [] }
      groupMap.set(key, group)
    }
    group.sessions.push(session)
  }

  return Array.from(groupMap.values()).sort((a, b) => {
    const aKnown = a.key !== UNGROUPED_KEY && !!lookupAgent?.(a.key)
    const bKnown = b.key !== UNGROUPED_KEY && !!lookupAgent?.(b.key)
    if (aKnown !== bKnown) return aKnown ? -1 : 1
    if (a.key === UNGROUPED_KEY) return 1
    if (b.key === UNGROUPED_KEY) return -1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

/** 按工作目录分组：未设置工作目录的会话殿后，组间按目录末级名排 */
function groupByWorkspace<S extends GroupableSession>(
  sessions: S[],
): SessionGroup<S>[] {
  const groupMap = new Map<string, SessionGroup<S>>()

  for (const session of sessions) {
    const key = session.workspace || UNGROUPED_KEY
    let group = groupMap.get(key)
    if (!group) {
      const name =
        key === UNGROUPED_KEY
          ? t('未设置工作目录')
          : key.split(/[/]|[\\]/).pop() || key
      const title =
        key === UNGROUPED_KEY
          ? t('未设置工作目录的会话')
          : tpl('工作目录: $__path__', { path: key })
      group = { key, name, icon: 'folder', title, sessions: [] }
      groupMap.set(key, group)
    }
    group.sessions.push(session)
  }

  return Array.from(groupMap.values()).sort((a, b) => {
    if (a.key === UNGROUPED_KEY) return 1
    if (b.key === UNGROUPED_KEY) return -1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}
