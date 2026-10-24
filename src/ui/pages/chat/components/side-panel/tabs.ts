/**
 * 右侧面板的标签页模型（纯函数：容器与宿主共用这一份，不碰 DOM、不碰 React）。
 *
 * 三条口径：
 * 1. **id 由内容决定**：文件是 `file:<绝对路径>`，服务终端是 `service:<会话id>:<服务id>`
 *    （服务 id 只在会话内唯一）。同一个内容再点一次是「激活已有标签」而不是再开一个 ——
 *    文件开两份会各持一份草稿、互相踩；终端开两份则是两个 xterm 抢同一个伪控制台；
 * 2. **kind 目前两种**：`file`（文本编辑 / 预览）与 `service`（后台服务终端）。渲染分支在
 *    `index.tsx::renderTab()`，之后接网址访问（`url`）等就在那里加一支；
 *    打开/关闭/选中这套逻辑不用改；
 * 3. **关掉当前激活的标签**：请**右边**那位上来（浏览器的口径：关掉当前页，右边那页顶上来），
 *    没有右邻居再退到左边；全关光就是 `null`（宿主据此把整个容器卸掉）。
 * 4. **批量关闭（标签右键菜单）**：按「逐个 `closeTab`」的口径收敛激活态 —— 语义只有一份，
 *    免得「关闭其他」自己再写一套邻居规则。
 * 5. **重排（拖标签）**：`moveTab` 的下标是「插入到最终位置」，与拖动时的落点算法同口径
 *    （见 `index.tsx::startTabDrag`：数「其他标签中线在指针左边」的个数），两边不能各算一套。
 */

/** 右侧面板的一个标签页（扩 kind 时在这里加联合项） */
export type SidePanelTab =
  | {
      id: string
      kind: 'file'
      /** 文件绝对路径（工作目录内） */
      path: string
      /** 打开时落在哪个视图（缺省 = 编辑；present 的交付物是预览） */
      view?: FileTabView
      /** 「又请你看一次」的序号：present 每次都自增，面板据此把视图迁回去 */
      viewSeq?: number
    }
  | {
      id: string
      kind: 'service'
      /** 归属会话（同一服务 id 只在**它自己的**会话里唯一） */
      sessionId: string
      serviceId: string
      /** 标签上显示的服务名：列表还没轮询回来时也要有标题 */
      name: string
      /** 归属会话标签（新对话页的全局视图才有；本会话视图不显示） */
      sessionLabel?: string
    }

/** 文件标签打开时落在哪个视图：present 的交付物默认给人看，普通打开仍是给人改 */
export type FileTabView = 'edit' | 'preview'

/** 文件标签的 id：路径即身份（同一个文件不会开出两个标签） */
export function fileTabId(path: string): string {
  return `file:${path}`
}

/** 造一个文件标签 */
export function fileTab(
  path: string,
  view?: FileTabView,
  viewSeq?: number,
): SidePanelTab {
  return { id: fileTabId(path), kind: 'file', path, view, viewSeq }
}

/** 服务终端标签的 id：会话 + 服务（服务 id 只在会话内唯一，跨会话会撞） */
export function serviceTabId(sessionId: string, serviceId: string): string {
  return `service:${sessionId}:${serviceId}`
}

/** 造一个服务终端标签 */
export function serviceTab(input: {
  sessionId: string
  serviceId: string
  name: string
  sessionLabel?: string
}): SidePanelTab {
  return {
    id: serviceTabId(input.sessionId, input.serviceId),
    kind: 'service',
    ...input,
  }
}

/** 打开一个服务终端标签：已开着就只切过去（同一个伪控制台不能交给两份 xterm） */
export function openServiceTab(
  tabs: SidePanelTab[],
  input: { sessionId: string; serviceId: string; name: string; sessionLabel?: string },
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const id = serviceTabId(input.sessionId, input.serviceId)
  if (tabs.some((tab) => tab.id === id)) return { tabs, activeId: id, added: false }
  return { tabs: [...tabs, serviceTab(input)], activeId: id, added: true }
}

/**
 * 打开一个文件：已有同路径的标签就只切过去，否则追加到末尾。返回新的标签列表与要激活的 id。
 *
 * 已开着时**不重建标签**（草稿一个字都不动）；唯一会改的是「打开时的视图」——present 再看一次
 * 同一个文件（带 `view` / 自增的 `viewSeq`）要把面板请回预览；两个值都没变就返回原引用。
 *
 * 注意这里**不需要任何「丢弃草稿」的确认** —— 打开新文件不再挤掉原来那个，
 * 这正是加标签页最直接的收益（旧实现是单面板，换文件必须确认）。
 */
export function openFileTab(
  tabs: SidePanelTab[],
  path: string,
  view?: FileTabView,
  viewSeq?: number,
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const tab = fileTab(path, view, viewSeq)
  const index = tabs.findIndex((item) => item.id === tab.id)
  if (index < 0) return { tabs: [...tabs, tab], activeId: tab.id, added: true }

  const current = tabs[index]
  // 普通打开（无 view）不碰已开着标签的视图；值没变也不换引用，避免无意义重渲染
  if (current.kind !== 'file' || !view) {
    return { tabs, activeId: tab.id, added: false }
  }
  if (current.view === view && current.viewSeq === viewSeq) {
    return { tabs, activeId: tab.id, added: false }
  }
  const next = [...tabs]
  next[index] = { ...current, view, viewSeq }
  return { tabs: next, activeId: tab.id, added: false }
}

/**
 * 关掉一个标签。关的不是当前激活的那个 → 激活态不动；关的是激活的 →
 * 右邻居上来，没有右邻居取左邻居，都没有则 `null`。
 */
export function closeTab(
  tabs: SidePanelTab[],
  id: string,
  activeId: string | null,
): { tabs: SidePanelTab[]; activeId: string | null } {
  const index = tabs.findIndex((item) => item.id === id)
  // 已经关过了（双击 / 竞态）：原样返回，别把激活态弄丢
  if (index < 0) return { tabs, activeId }

  const rest = tabs.filter((item) => item.id !== id)
  if (id !== activeId) return { tabs: rest, activeId }
  const next = rest[index] ?? rest[index - 1] ?? null
  return { tabs: rest, activeId: next?.id ?? null }
}

/**
 * 关掉**一批**标签（右键菜单的关闭其他 / 关闭右侧标签页 / 关闭已保存 / 全部关闭）。
 *
 * 收敛口径就是逐个走 `closeTab`：被关的里面有激活标签时，右邻居一路顶上来，
 * 于是「关闭其他」自然停在唯一剩下的那个标签上（不需要额外的「激活谁」参数）。
 * 只多一条兜底：关到「剩一个但激活态是 null」时退回第一个 —— 宿主 `activeId=null`
 * 虽然会被容器兜底显示，但下次关标签的邻居计算会失去基准。
 */
export function closeTabs(
  tabs: SidePanelTab[],
  ids: readonly string[],
  activeId: string | null,
): { tabs: SidePanelTab[]; activeId: string | null } {
  const doomed = new Set(ids)
  let state = { tabs, activeId }
  // 按 tabs 顺序关（不是按 ids 顺序）：邻居规则依赖原顺序，乱序关会让激活态跳得没有道理
  for (const tab of tabs) {
    if (doomed.has(tab.id)) state = closeTab(state.tabs, tab.id, state.activeId)
  }
  if (state.tabs === tabs) return state
  return {
    tabs: state.tabs,
    activeId: state.activeId ?? state.tabs[0]?.id ?? null,
  }
}

/**
 * 把 `id` 挪到第 `toIndex` 位（数组下标，按「先取出再插入」算：右移时落点即最终下标）。
 * 越界夹进范围、位置没变就返回原引用（宿主据此不做无意义的重渲染）。
 */
export function moveTab(
  tabs: SidePanelTab[],
  id: string,
  toIndex: number,
): SidePanelTab[] {
  const from = tabs.findIndex((item) => item.id === id)
  if (from < 0) return tabs
  const to = Math.max(0, Math.min(tabs.length - 1, toIndex))
  if (to === from) return tabs
  const next = [...tabs]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** 标签上显示的名字：文件名（路径可能是 Windows 反斜杠） */
export function tabLabel(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

/** 文件名之外的目录部分（空串 = 就在根上）；标签栏和面板头都用它做次要信息 */
export function tabDir(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/')
}
