/**
 * session-fold —— 组内会话的折叠规则（纯函数，无 React / store 依赖）。
 *
 * 侧边栏分组默认只铺「未归档」，归档的会话一律收进组尾的「展示全部」按钮后面：
 * 混排时归档的本来就被 `listSessions` 排在组内最后（归档殿后），照铺只会把活跃会话挤到后面，
 * 而「归档 = 暂时不想动它」该多看一层。
 *
 * 三条规则（缺一条都会让人以为会话丢了）：
 *   1. 组内**同时有**归档与未归档 → 收起态只铺未归档，归档的进折叠；
 *   2. **全归档 / 全未归档**不因归档而折叠：全归档的分组已经沉到列表尾部（见 `archivedLast`），
 *      再把内容藏起来就只剩一个空分组；全未归档的组没有可折叠的东西；
 *   3. 收起态超过 11 条只铺前 10 条：一口气铺满侧栏反而找不到目标。
 *
 * 搜索时调用方传 `expanded = true` —— 命中的归档会话藏在折叠里等于「搜了却看不见」。
 */

/** 折叠只依赖归档标记（结构化类型：单测可传最小对象） */
export interface FoldableSession {
  /** 未归档时可能是 undefined（老数据），一律按「未归档」处理 */
  archived?: boolean
}

export interface FoldedSessions<S> {
  /** 收起态实际渲染的会话；展开态 = 全部 */
  visible: S[]
  /** 是否还要渲染「展示全部」按钮 */
  folded: boolean
  /** 按钮后面藏起来的条数（= 全部 - visible） */
  hidden: number
}

/** 超过这个条数就折叠 */
const COLLAPSE_OVER = 11
/** 折叠后铺多少条（留一行给「展示全部」按钮） */
const COLLAPSED_COUNT = 10

/** 按归档态与条数折叠组内会话 */
export function foldGroupSessions<S extends FoldableSession>(
  sessions: S[],
  expanded = false,
): FoldedSessions<S> {
  if (expanded) return { visible: sessions, folded: false, hidden: 0 }

  const archivedCount = sessions.filter((s) => s.archived === true).length
  // 混排才折归档：全归档组已经沉底，全未归档组没有可折的
  const mixed = archivedCount > 0 && archivedCount < sessions.length
  const base = mixed ? sessions.filter((s) => s.archived !== true) : sessions
  const visible =
    base.length > COLLAPSE_OVER ? base.slice(0, COLLAPSED_COUNT) : base
  return {
    visible,
    folded: visible.length < sessions.length,
    hidden: sessions.length - visible.length,
  }
}
