/**
 * 右侧面板的**会话分桶**（纯函数：宿主与容器共用这一份，不碰 DOM、不碰 React）。
 *
 * 为什么要有它：右侧面板的标签**不属于窗口，属于会话**。
 * - **收起只是隐藏**：面板关掉时标签、草稿、终端屏幕全留着，展开就原样回来
 *   （旧口径是「收起 = 关掉所有标签」，于是一次误按就没了三个未保存的草稿）；
 * - **切会话只是换一桶**：每个会话一套标签，切回去原样还在；两个会话同时开着
 *   同一个文件也互不影响（各持一份草稿）。
 *
 * 三条口径：
 * 1. **桶 key = 会话 id**，新对话页（还没有会话 id）单独一桶（`NEW_PANEL_KEY`）；
 * 2. **标签 id 带会话前缀**：文件的标签 id 本来是「路径即身份」，跨会话就会撞
 *    （同一个仓库的两个会话各开一份 = 同一个 id → 同一份稿、同一个 xterm 抢一个伪控制台）。
 *    落库时统一加 `<key>\u0000` 前缀（`\u0000` 不会出现在任何 id 里，前缀不会互相包含），
 *    去重仍按内容判（见 `tabs.ts` 头注释）。⚠️ 标签**不跨桶搬**，前缀一加就不再改；
 * 3. **`open` 是每个会话自己的**：在 A 收起面板，切到 B 时 B 该展开就展开（宿主的按钮徽标
 *    这才有意义 —— 它是「这个会话里还开着几个标签」）；**加标签自动展开**（用户点了门 / AI 交付了文件，
 *    要让人看见），改地址 / 改标题 / 关标签都不碰它。
 */
import { GUIDE_TAB_ID, type SidePanelTab } from './tabs'

/** 新对话页（还没有会话 id）那一桶的 key —— 与真会话 id 不会撞 */
export const NEW_PANEL_KEY = '__new__'

/** 一个会话的右侧栏状态 */
export interface PanelBucket {
  /** 标签列表（id 已带会话前缀，顺序即打开顺序 / 用户拖出来的顺序） */
  tabs: SidePanelTab[]
  /** 当前激活的标签 id（关掉激活的那个时由 `closeTab` 算出邻居） */
  activeId: string | null
  /** 这个会话里右侧栏是展开的吗（收起只隐藏，标签一条不动） */
  open: boolean
}

/** key = 会话（或新对话页） */
export type PanelBuckets = Record<string, PanelBucket>

/** 还没有任何状态时的空桶（共享一份，避免每次渲染换引用） */
export const EMPTY_PANEL_BUCKET: PanelBucket = { tabs: [], activeId: null, open: false }

/** 标签 id 的会话前缀分隔符：`\u0000` 不出现在任何 id 里 */
const SCOPE_SEP = '\u0000'

/** 会话 → 分桶 key（`null` / `''` = 新对话页） */
export function panelKeyOf(sessionId: string | null | undefined): string {
  return sessionId ? sessionId : NEW_PANEL_KEY
}

/** 给标签 id 加会话前缀（已经带同一前缀时原样返回 —— 宿主会在多处复用这个函数） */
export function scopeTabId(key: string, id: string): string {
  const prefix = `${key}${SCOPE_SEP}`
  return id.startsWith(prefix) ? id : prefix + id
}

/** 整批加前缀（没有需要加的就返回**原数组**，宿主据此跳过重渲染） */
export function scopeTabs(key: string, tabs: readonly SidePanelTab[]): SidePanelTab[] {
  const prefix = `${key}${SCOPE_SEP}`
  let changed = false
  const next = tabs.map((tab) => {
    if (tab.id.startsWith(prefix)) return tab
    changed = true
    return { ...tab, id: prefix + tab.id }
  })
  return changed ? next : (tabs as SidePanelTab[])
}

/** 标签属于哪个会话（从 id 前缀反解）；没有前缀（手搓的 / 测试里的标签）→ null */
export function tabScopeOf(tab: SidePanelTab): string | null {
  const at = tab.id.indexOf(SCOPE_SEP)
  return at < 0 ? null : tab.id.slice(0, at)
}

/**
 * 标签所在那一桶对应的 `sessionId`（文件面板要用它解析工作区）。
 * 新对话页 / 没有前缀的标签 → `undefined`（跟着当前会话的兜底值走）。
 */
export function sessionIdOfTab(tab: SidePanelTab): string | undefined {
  const scope = tabScopeOf(tab)
  return !scope || scope === NEW_PANEL_KEY ? undefined : scope
}

/**
 * 文件面板该用哪个 `sessionId` 解析工作区（容器调用）：
 * - **带会话前缀的标签** → 用它自己的（挂着的那份不能跟着眼前这个会话跑：
 *   否则它会去当前工作区里找路径 → 读不到，甚至把草稿当成「外面的文件」）；
 * - **没前缀的标签**（新对话页 / 手搓的）→ 用宿主传的兼底值。
 */
export function paneSessionIdOf(
  tab: SidePanelTab,
  fallback?: string,
): string | undefined {
  return tabScopeOf(tab) === null ? fallback : sessionIdOfTab(tab)
}

/** 某个会话里「开始页」标签的 id（宿主判断「开始页还开着吗」用） */
export function guideTabIdOf(key: string): string {
  return scopeTabId(key, GUIDE_TAB_ID)
}

/** 取一桶（没有就是共享的空桶） */
export function bucketOf(buckets: PanelBuckets, key: string): PanelBucket {
  return buckets[key] ?? EMPTY_PANEL_BUCKET
}

/** 面板该不该露出来：展开着且至少有一个标签 */
export function isBucketVisible(bucket: PanelBucket): boolean {
  return bucket.open && bucket.tabs.length > 0
}

/**
 * 落一次标签状态（打开 / 关闭 / 重排 / 地址回写都走这一条）。
 *
 * 两条口径：**id 统一加这桶的前缀**；**标签变多了就展开面板**（点了门 / AI 交付了文件，
 * 要让人看见），其余改动（关掉一个、拖顺序、网页改地址与标题）不碰 `open`。
 */
export function withBucketTabs(
  buckets: PanelBuckets,
  key: string,
  next: { tabs: readonly SidePanelTab[]; activeId: string | null },
): PanelBuckets {
  const prev = bucketOf(buckets, key)
  const tabs = scopeTabs(key, next.tabs)
  const activeId = next.activeId ? scopeTabId(key, next.activeId) : null
  const open = tabs.length > prev.tabs.length ? true : prev.open
  if (tabs === prev.tabs && activeId === prev.activeId && open === prev.open) return buckets
  return { ...buckets, [key]: { tabs, activeId, open } }
}

/** 展开 / 收起一个会话的面板（收起 ≠ 关标签：标签与内容都留着） */
export function withBucketOpen(
  buckets: PanelBuckets,
  key: string,
  open: boolean,
): PanelBuckets {
  const prev = bucketOf(buckets, key)
  if (prev.open === open) return buckets
  return { ...buckets, [key]: { ...prev, open } }
}

/** 关掉**这一桶**的全部标签（切工作目录这条路径用；会话之间互不影响） */
export function clearBucketTabs(buckets: PanelBuckets, key: string): PanelBuckets {
  const prev = bucketOf(buckets, key)
  if (prev.tabs.length === 0 && prev.activeId === null) return buckets
  return { ...buckets, [key]: { ...prev, tabs: [], activeId: null } }
}

/**
 * 其它会话的标签：**内容照旧挂着**（草稿 / 撤销栈 / 终端屏幕都活着），只是不在标签栏里、
 * 也不显示 —— 靠容器的 `parkedTabs` 一直渲染。切回来时就是原来那份，一个字都没动。
 */
export function parkedTabsOf(buckets: PanelBuckets, key: string): SidePanelTab[] {
  const parked: SidePanelTab[] = []
  for (const [other, bucket] of Object.entries(buckets)) {
    if (other === key) continue
    parked.push(...bucket.tabs)
  }
  return parked
}

/**
 * 会话被删掉了：把它的桶连同标签一起丢掉（**返回被丢掉的标签** —— 宿主据此杀终端，
 * 否则那一桶里的用户终端再没有人能看见 / 关掉，`npm run dev` 会一直占着端口）。
 *
 * `keep` = 当前这一桶（切会话的瞬间列表可能还没跟上，别把眼前这个丢了）；
 * 新对话页那一桶与真实会话无关，永远保留。
 */
export function withoutSessions(
  buckets: PanelBuckets,
  alive: Iterable<string>,
  keep: string,
): { buckets: PanelBuckets; dropped: SidePanelTab[] } {
  const aliveSet = new Set(alive)
  const next: PanelBuckets = {}
  const dropped: SidePanelTab[] = []
  let changed = false
  for (const [key, bucket] of Object.entries(buckets)) {
    if (key === keep || key === NEW_PANEL_KEY || aliveSet.has(key)) {
      next[key] = bucket
      continue
    }
    dropped.push(...bucket.tabs)
    changed = true
  }
  return { buckets: changed ? next : buckets, dropped }
}
