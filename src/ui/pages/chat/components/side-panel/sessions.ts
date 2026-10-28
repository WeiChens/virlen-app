/**
 * 右侧面板的**会话分桶**（纯函数：宿主与容器共用这一份，不碰 DOM、不碰 React）。
 *
 * 为什么要有它：右侧面板的标签**不属于窗口，属于会话**。
 * - **收起只是隐藏**：面板关掉时标签、草稿、终端屏幕全留着，展开就原样回来
 *   （旧口径是「收起 = 关掉所有标签」，于是一次误按就没了三个未保存的草稿）；
 * - **切会话只是换一桶**：每个会话一套标签，切回去原样还在；两个会话同时开着
 *   同一个文件也互不影响（各持一份草稿）。
 *
 * 四条口径：
 * 1. **桶 key = 会话 id**，新对话页（还没有会话 id）单独一桶（`NEW_PANEL_KEY`）；
 * 2. **标签 id 带会话前缀**：文件的标签 id 本来是「路径即身份」，跨会话就会撞
 *    （同一个仓库的两个会话各开一份 = 同一个 id → 同一份稿、同一个 xterm 抢一个伪控制台）。
 *    落库时给**没有前缀的**补上 `<key>\u0000`（`\u0000` 不会出现在任何 id 里，前缀不会互相包含），
 *    去重仍按内容判（见 `tabs.ts` 头注释）。
 *    ⚠️ 前缀只保证**跨桶唯一**、且**只加一次就不再改**：它同时是容器的渲染 key
 *    （`side-panel/index.tsx` 的 `key={tab.id}`），改前缀 = 内容块卸载重挂（草稿 / 撤销栈 /
 *    终端屏幕一起没）。所以过继到别的桶时前缀保持原样（见 `adoptNewBucket`），**别按
 *    「前缀 = 桶 key」写判断** —— 「这一桶里有开始页吗」这类问题按 `kind` 找（`guideTabIdIn`）；
 * 3. **`open` 是每个会话自己的**：在 A 收起面板，切到 B 时 B 该展开就展开（宿主的按钮徽标
 *    这才有意义 —— 它是「这个会话里还开着几个标签」）；**加标签自动展开**（用户点了门 / AI 交付了文件，
 *    要让人看见），改地址 / 改标题 / 关标签都不碰它。
 * 4. **新对话页那一桶会过继给刚建出来的会话**（`adoptNewBucket`）：用户在新对话里攒下的标签，
 *    发第一条消息时会话 id 才落地 —— 不过继的话右侧栏突然换成（空的）新桶，
 *    用户的观感就是「好端端的右侧栏直接消失」。
 * 5. **「哪一桶还开着标签栏」也得能说清**：面板一次只显示一桶，切走后用户就没有任何线索 ——
 *    `panelTabSummaries`（侧栏徽标）/ `parkedBucketsOf`（开始页清单）/ `withBucketActive`（点一行直达）
 *    就是给这两处外显供数据的：只做镜像与分组，不碰 DOM、不改标签。
 */
import { closeTab, tabContentKey, type SidePanelTab } from './tabs'

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

/** id 上已经有会话前缀了吗（有就不再改，见文件头第 2 条） */
function hasScope(id: string): boolean {
  return id.includes(SCOPE_SEP)
}

/** 会话 → 分桶 key（`null` / `''` = 新对话页） */
export function panelKeyOf(sessionId: string | null | undefined): string {
  return sessionId ? sessionId : NEW_PANEL_KEY
}

/**
 * 给标签 id 加会话前缀。
 *
 * ⚠️ **已经带前缀的一律原样返回**（不管是不是这一桶的）：前缀是渲染 key 的一部分、改不得；
 * 新对话页过继来的标签就靠这条留住原来的前缀（见 `adoptNewBucket`）。唯一性由
 * 「一个前缀只属于一个桶」保证 —— 过继时源桶整个搬走，不会两边各留一份。
 */
export function scopeTabId(key: string, id: string): string {
  return hasScope(id) ? id : `${key}${SCOPE_SEP}${id}`
}

/** 整批加前缀（只补给没有前缀的；没得补就返回**原数组**，宿主据此跳过重渲染） */
export function scopeTabs(key: string, tabs: readonly SidePanelTab[]): SidePanelTab[] {
  let changed = false
  const next = tabs.map((tab) => {
    if (hasScope(tab.id)) return tab
    changed = true
    return { ...tab, id: `${key}${SCOPE_SEP}${tab.id}` }
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
 *
 * 过继给真会话的标签**仍然是这个结果**（前缀还是新对话页那个）：故意不改 —— 值一变，
 * 文件面板的 `load`（依赖 `[path, sessionId]`）就会重读盘并把未保存草稿洗掉。
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

/**
 * 一桶里「开始页」标签的 id（没有就是 `null`）。宿主判断「开始页还开着吗」用。
 *
 * 按 `kind` 找、**不拿 key 拼 id**：前缀只保证跨桶唯一，过继来的标签前缀还是新对话页那个
 *（见 `adoptNewBucket`），`<key>\u0000guide` 拼出来的 id 会对不上。
 */
export function guideTabIdIn(tabs: readonly SidePanelTab[]): string | null {
  return tabs.find((tab) => tab.kind === 'guide')?.id ?? null
}

/**
 * 新对话页 → 刚建出来的会话：把 `NEW_PANEL_KEY` 那一桶**过继**过去。
 *
 * 为什么需要：新对话页的标签属于「还没有 id 的那一桶」，用户发第一条消息时会话 id 才落地；
 * 不过继的话右侧栏会换成（空的）新桶 —— 用户看到的就是「好端端的右侧栏直接消失」。
 *
 * 三条口径：
 * 1. **只过继、不合并**：目标已经有自己的一桶时原引用返回 —— 那是它自己的状态，不能被
 *    新对话页的标签盖掉（过继只发生在「刚建出来的会话」这一条路上，由 `chat-view` 在
 *    `currentSessionId` 落地的那一刻调用）；
 * 2. **标签对象整体照搬，一个字都不改**：`id` 是容器的渲染 key（改 = 卸载重挂 → 未保存草稿 /
 *    撤销栈 / 终端屏幕 / 网页历史一起没），文件面板的 `sessionId` 也由 id 前缀反解
 *    （新对话页的标签解析成「已选目录」，一改就会触发重读盘把草稿洗掉）；`terminal` 的
 *    `sessionId` 更是 Rust 注册表的 key，改了就读不到那个终端。前缀唯一性照旧：源桶整个搬走；
 * 3. 没有标签可过继（`__new__` 那一桶不存在 / 被关空了）时原引用返回。
 */
export function adoptNewBucket(buckets: PanelBuckets, key: string): PanelBuckets {
  if (key === NEW_PANEL_KEY || buckets[key]) return buckets
  const source = buckets[NEW_PANEL_KEY]
  if (!source || source.tabs.length === 0) return buckets
  const next: PanelBuckets = { ...buckets, [key]: source }
  delete next[NEW_PANEL_KEY]
  return next
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
 * 两条口径：**没有前缀的标签补上这桶的前缀**（已带前缀的一字不改，见 `scopeTabId`）；
 * **标签变多了就展开面板**（点了门 / AI 交付了文件，要让人看见），其余改动（关掉一个、
 * 拖顺序、网页改地址与标题）不碰 `open`。
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

/**
 * 展开某一桶并把它里面的某个标签设为激活（侧栏徽标 / 开始页「其他对话的标签页」两个入口用）。
 *
 * 为什么合成一个函数：分两次调用（先 `withBucketTabs` 改激活、再 `withBucketOpen` 展开）会在
 * 中间多渲染一帧「面板展开了但还是旧标签」的中间态。标签不在这一桶里 → 原引用返回（不凭空造激活态）。
 */
export function withBucketActive(
  buckets: PanelBuckets,
  key: string,
  activeId: string,
): PanelBuckets {
  const prev = bucketOf(buckets, key)
  if (!prev.tabs.some((tab) => tab.id === activeId)) return buckets
  if (prev.activeId === activeId && prev.open) return buckets
  return { ...buckets, [key]: { ...prev, activeId, open: true } }
}

/**
 * 把一个标签从一桶搬到另一桶（标签栏拖到侧栏会话项上：「这个标签归那个会话了」）的结果。
 *
 * 为什么用「结果 + 原因」而不是抛异常 / 返回 null：没搬成的「重复」要跟用户说一句
 * （否则标签凭空不动，看起来像坏了），而「拖回自己那一桶」不该有任何提示。
 */
export interface TabTransfer {
  buckets: PanelBuckets
  /** 搬成了吗（标签已不在 / 源桶就是目标桶 / 目标桶里已有同内容标签 → false） */
  moved: boolean
  /** 没搬成的原因：`duplicate` 需要给用户一句提示，其余静默 */
  reason?: 'duplicate'
}

/**
 * 把一个标签从一桶搬到另一桶（标签栏拖到侧栏会话项上：「这个标签归那个会话了」）。
 *
 * 五条口径：
 * 1. **标签对象整体照搬，`id` 一个字都不改**：它是容器的渲染 key，改 = 卸载重挂
 *    （草稿 / 撤销栈 / 终端屏幕 / 网页历史一起没）；文件面板的工作区也由 id 前缀反解
 *    （与 `adoptNewBucket` 同一条口径，别按「前缀 = 桶 key」写判断）；
 * 2. **目标桶里已有同内容标签就不搬**（`moved: false` + `reason: 'duplicate'`）：
 *    一桶里两条同内容标签，`openFileTab` 按路径找只会认得到第一条，第二条从此点不到；
 * 3. **源桶的激活态按 `closeTab` 的邻居规则收敛**（不在本文件另写一套）；
 * 4. **目标桶追加到末尾并激活 + 自动展开**（`withBucketTabs`）：用户把它放到那儿了，
 *    切回去就该看到它；
 * 5. **不杀任何终端**：搬标签 ≠ 关标签（`killTerminalsIn` 只在真关掉时调），
 *    终端标签里记的 `sessionId` 也照着原样 —— 它代表「这个终端属于谁」，不是「谁在显示它」。
 */
export function transferTab(
  buckets: PanelBuckets,
  tabId: string,
  toKey: string,
): TabTransfer {
  let fromKey: string | null = null
  let tab: SidePanelTab | null = null
  for (const [key, bucket] of Object.entries(buckets)) {
    const found = bucket.tabs.find((item) => item.id === tabId)
    if (!found) continue
    fromKey = key
    tab = found
    break
  }
  // 已经关掉了 / 拖到了自己那一桶：什么都不做（后者是「拖回原位」，不该报错）
  if (!fromKey || !tab || fromKey === toKey) return { buckets, moved: false }
  const from = buckets[fromKey]
  const to = bucketOf(buckets, toKey)
  const contentKey = tabContentKey(tab)
  if (to.tabs.some((item) => tabContentKey(item) === contentKey)) {
    return { buckets, moved: false, reason: 'duplicate' }
  }
  const closed = closeTab(from.tabs, tabId, from.activeId)
  const next: PanelBuckets = {
    ...buckets,
    [fromKey]: { ...from, tabs: closed.tabs, activeId: closed.activeId },
  }
  return {
    buckets: withBucketTabs(next, toKey, { tabs: [...to.tabs, tab], activeId: tab.id }),
    moved: true,
  }
}

/** 关掉**这一桶**的全部标签（切工作目录这条路径用；会话之间互不影响） */
export function clearBucketTabs(buckets: PanelBuckets, key: string): PanelBuckets {
  const prev = bucketOf(buckets, key)
  if (prev.tabs.length === 0 && prev.activeId === null) return buckets
  return { ...buckets, [key]: { ...prev, tabs: [], activeId: null } }
}

/**
 * 把一个会话**开着的那批标签整批**搬到另一个会话的结果（侧栏徒标拖到标签栏 / 另一个会话行上）。
 *
 * 为什么「部分成功」也算搬成：整批里很可能有目标会话已经开着的文件，为了一个重复就把
 * 剩下的全拦下太奇怪；跳过的那几个由 `skipped` 报出去（宿主拿它提示一句）。
 */
export interface SessionTabsTransfer {
  buckets: PanelBuckets
  /** 真搬过去的标签数 */
  moved: number
  /** 目标桶里已有同内容、被跳过的个数 */
  skipped: number
}

/**
 * 把一个会话开着的那批标签整批搬到另一个会话（侧栏徒标拖到标签栏 / 另一个会话行上）。
 *
 * 与 `transferTab` 同一套口径：标签对象**整体照搬、`id` 一个字不改**（渲染 key + 工作区反解），
 * 目标桶里已有同内容标签就跳过（`tabContentKey`），目标桶追加 + 激活 + 自动展开。
 * 差别只有两点：
 * 1. **整批**：搬完源桶就空了（侧栏徒标随之消失，等于「那个会话的右侧栏整体挪过去」）；
 * 2. 全跳过时 `moved === 0`（只有这时才算没搬成），部分跳过不影响其余标签过去。
 */
export function transferSessionTabs(
  buckets: PanelBuckets,
  fromKey: string,
  toKey: string,
): SessionTabsTransfer {
  if (fromKey === toKey) return { buckets, moved: 0, skipped: 0 }
  const from = bucketOf(buckets, fromKey)
  if (from.tabs.length === 0) return { buckets, moved: 0, skipped: 0 }
  const to = bucketOf(buckets, toKey)
  const taken = new Set(to.tabs.map((tab) => tabContentKey(tab)))
  const incoming: SidePanelTab[] = []
  let skipped = 0
  for (const tab of from.tabs) {
    const contentKey = tabContentKey(tab)
    if (taken.has(contentKey)) {
      skipped += 1
      continue
    }
    taken.add(contentKey)
    incoming.push(tab)
  }
  if (incoming.length === 0) return { buckets, moved: 0, skipped }
  const grown = withBucketTabs(buckets, toKey, {
    tabs: [...to.tabs, ...incoming],
    // 激活最后一个：整批搬过来时用户最想看的是「刚搬过来的那批」的最后一张
    activeId: incoming[incoming.length - 1].id,
  })
  return { buckets: clearBucketTabs(grown, fromKey), moved: incoming.length, skipped }
}

/**
 * 别的会话的桶（按桶的插入顺序，跳过空桶）：开始页「其他对话的标签页」清单用。
 *
 * 与 `parkedTabsOf` 同一份口径（**唯一实现**）：那个函数就是它摊平的结果。
 * `NEW_PANEL_KEY` 也在这里出现 —— 新对话页攒下的标签同样会「挂」在别的会话里看不见。
 */
export function parkedBucketsOf(
  buckets: PanelBuckets,
  key: string,
): { key: string; tabs: SidePanelTab[] }[] {
  const parked: { key: string; tabs: SidePanelTab[] }[] = []
  for (const [other, bucket] of Object.entries(buckets)) {
    if (other === key || bucket.tabs.length === 0) continue
    parked.push({ key: other, tabs: bucket.tabs })
  }
  return parked
}

/**
 * 其它会话的标签：**内容照旧挂着**（草稿 / 撤销栈 / 终端屏幕都活着），只是不在标签栏里、
 * 也不显示 —— 靠容器的 `parkedTabs` 一直渲染。切回来时就是原来那份，一个字都没动。
 */
export function parkedTabsOf(buckets: PanelBuckets, key: string): SidePanelTab[] {
  return parkedBucketsOf(buckets, key).flatMap((entry) => entry.tabs)
}

/**
 * 别的会话还开着的标签（开始页「其他对话的标签页」清单的一行）。
 * `label` 是会话标题（宿主从会话 store 补）：容器不该为了显示一个标题去读会话。
 */
export interface OtherSessionTabs {
  sessionId: string
  label: string
  tabs: SidePanelTab[]
}

/** 一个会话的右侧栏摘要（侧栏徽标用） */
export interface PanelTabSummary {
  /** 标签数（与工具栏徽标同一口径：`tabs.length`，开始页也算一格） */
  count: number
  /** 那一桶的面板是展开着的吗（收起时徽标降一档 = 「挂着但看不见」） */
  open: boolean
}

/**
 * 每个会话「还开着几个标签页、面板收没收起」—— 侧栏会话项徽标的数据。
 *
 * 为什么需要它：标签属于会话（本文件头注释），而面板一次只显示一个会话 —— 切走之后
 * 「哪里还开着标签栏」就只剩这条信息能说清。
 *
 * 三条口径：
 * 1. **跳过空桶与新对话页**：侧栏里没有 `__new__` 那一行；空桶挂个 0 只是噪音；
 * 2. **计数口径与工具栏徽标一致**（`tabs.length`，开始页也算一格）：两处说的是同一件事，
 *    口径不同的话「侧栏说 2、工具栏说 3」会被当成 bug；
 * 3. 只做镜像、不做判断：收起 / 展开的差别留给界面（`open` 原样带出去）。
 */
export function panelTabSummaries(
  buckets: PanelBuckets,
): Record<string, PanelTabSummary> {
  const out: Record<string, PanelTabSummary> = {}
  for (const [key, bucket] of Object.entries(buckets)) {
    if (key === NEW_PANEL_KEY || bucket.tabs.length === 0) continue
    out[key] = { count: bucket.tabs.length, open: bucket.open }
  }
  return out
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
