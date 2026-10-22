/**
 * 右侧面板的标签页模型（纯函数：容器与宿主共用这一份，不碰 DOM、不碰 React）。
 *
 * 三条口径：
 * 1. **id 由内容决定**：`file:<绝对路径>`。同一个文件再点一次是「激活已有标签」而不是
 *    再开一个 —— 否则两个标签各持一份草稿、各自保存，必然互相踩掉；
 * 2. **kind 预留**：之后还要接网址访问（`url`）与终端（`terminal`），渲染分支在
 *    `index.tsx::renderTab()`，加一种只加一支；打开/关闭/选中这套逻辑不用改；
 * 3. **关掉当前激活的标签**：请**右边**那位上来（浏览器的口径：关掉当前页，右边那页顶上来），
 *    没有右邻居再退到左边；全关光就是 `null`（宿主据此把整个容器卸掉）。
 */

/** 右侧面板的一个标签页（目前只有「文件」，后续扩 kind 时在这里加联合项） */
export type SidePanelTab = {
  id: string
  kind: 'file'
  /** 文件绝对路径（工作目录内） */
  path: string
}

/** 文件标签的 id：路径即身份（同一个文件不会开出两个标签） */
export function fileTabId(path: string): string {
  return `file:${path}`
}

/** 造一个文件标签 */
export function fileTab(path: string): SidePanelTab {
  return { id: fileTabId(path), kind: 'file', path }
}

/**
 * 打开一个文件：已有同路径的标签就只切过去（`tabs` 原样返回，草稿一个字都不动），
 * 否则追加到末尾。返回新的标签列表与要激活的 id。
 *
 * 注意这里**不需要任何「丢弃草稿」的确认** —— 打开新文件不再挤掉原来那个，
 * 这正是加标签页最直接的收益（旧实现是单面板，换文件必须确认）。
 */
export function openFileTab(
  tabs: SidePanelTab[],
  path: string,
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const tab = fileTab(path)
  const exists = tabs.some((item) => item.id === tab.id)
  return {
    tabs: exists ? tabs : [...tabs, tab],
    activeId: tab.id,
    added: !exists,
  }
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
