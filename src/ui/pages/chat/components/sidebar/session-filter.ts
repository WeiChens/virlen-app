/**
 * session-filter —— 会话分组的关键词过滤（纯函数，无 React / store 依赖）
 *
 * 侧边栏「会话」页签的搜索框走这里。规则（缺一条就会「明明有却搜不到」）：
 *   1. 关键词命中**分组名**（Agent 名 / 工作目录末级名）→ 整组保留，组内会话不再筛；
 *      否则只保留标题命中的会话；
 *   2. 命中为空的组整组丢弃（而不是留一个空分组在列表里）。
 *
 * 关键词由调用方 trim + 小写；这里对空关键词也做一次兜底（原样返回），
 * 避免调用方漏判时把列表清空。
 *
 * 用泛型而不是直接引用 Session / SessionGroup：类型定义在页面组件里，
 * 这里只依赖「组有 name、会话有 title」这一最小结构，便于单测。
 */

/** 分组过滤：返回新数组 + 新分组对象，不修改入参 */
export function filterSessionGroups<
  G extends { name: string; sessions: { title: string }[] },
>(groups: G[], keyword: string): G[] {
  if (!keyword) return groups

  const result: G[] = []
  for (const group of groups) {
    // 命中分组名 → 整组保留（搜「virlen」时该工作目录下的会话应当全在）
    if (group.name.toLowerCase().includes(keyword)) {
      result.push(group)
      continue
    }
    const sessions = group.sessions.filter((session) =>
      session.title.toLowerCase().includes(keyword),
    )
    if (sessions.length === 0) continue
    // 只换 sessions，key / name / icon / title 原样带过
    const next: G = { ...group }
    next.sessions = sessions
    result.push(next)
  }
  return result
}
