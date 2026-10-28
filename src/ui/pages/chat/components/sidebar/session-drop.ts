/**
 * 「把右侧栏的标签拖到侧栏会话项上 = 把这个标签转移到那个会话」的落点判定与拖动提示。
 *
 * 为什么不用 HTML5 拖拽 / React state：
 * 1. `dragDropEnabled: true`（拖文件进输入框要真实路径，见 §11.8）时页面收不到 HTML5 drag / drop，
 *    拖标签只能用鼠标事件（`side-panel/index.tsx::startTabDrag`）；
 * 2. 指针每动一帧都要问一次「现在压在哪一行上」—— 走 state 等于每帧重渲染整个侧栏，
 *    拖动会把界面刷成幻灯片。所以这里只做两件事：**按 rect 命中**、**按 class 提示**。
 *
 * 五条口径：
 * 1. **命中不靠 `elementFromPoint`**：被拖的标签跟着指针走、永远压在指针底下（还带 translate），
 *    拿「最顶层元素」判定会一直命中它自己。改成遍历会话行的 rect，简单且不受遮挡影响；
 * 2. **看不见的行一个都不接**（这条最容易写错，见下）：折叠的分组是 `grid-template-rows: 0fr`
 *    + `overflow: hidden` 把内容**裁掉**的，行本身照样有尺寸正确的 rect —— 不筛掉的话，
 *    指针压在展开分组里的可见行上，会先命中前面某个收起分组里同坐标的**看不见的行**，
 *    于是「拖到 A 却进了 B」。筛的条件是 inert 祖先（折叠的分组是 `inert`）+ 浏览器侧的
 *    `checkVisibility`（`display:none` / `visibility:hidden` / 祖先 `opacity:0`）；
 * 3. **行间缝隙吸附**：`.session-item` 之间有 1px 外边距，指针压在两行之间时按
 *    「距离最近且不超过 `ROW_SNAP`」落那一行 —— 否则差一个像素就什么都不发生，像坏了；
 * 4. **登记的是列表容器**（侧栏的 `.session-list`），行还是行：列表重渲染 / 分组折叠 / 搜索过滤
 *    都不用重新登记；
 * 5. **提示只标「松手就落这一行」的那一行**（`.tab-drop-target`）：拖动中给每一行都描一圈虚线
 *    会把侧栏弄成一堆框（用户明确不要那个），而落点始终只有一行；
 * 6. **标签栏与聊天区也是落点**（`registerDropArea`）：拖会话的徽标上去 = 把那一整批标签
 *    搬进**当前**会话。两处都必须排除「0 尺寸」（面板收起 / 聊天区被面板挤没）。
 *    落点的提示都直接写 class（拖动中每帧都问一次，走 React state 会把界面刷成幻灯片）。
 */
export const SESSION_ROW_ATTR = 'data-session-row'

/** 指针落在两行之间的缝隙里时，向内吸附多少像素（px） */
const ROW_SNAP = 4
/** 拖动中挂在**指针压着的那一行**上的类：松手就落这儿 */
const DROP_TARGET_CLASS = 'tab-drop-target'
/** 拖动中挂在「大片落点」上的类：样式各自在 `side-panel/style.scss` / `chat-view.scss` */
const AREA_DROP_CLASS = 'is-drop-target'

/**
 * 「大片落点」：拖会话徽标时，指针落在这些地方都算「搬进当前会话」。
 * - `tabbar`：右侧面板的标签栏（最精确、最直觉）；
 * - `chat-main`：聊天区（整个对话区域）—— 标签栏只有 36px 高，逼用户去命中一条细缝没道理。
 */
export type DropArea = 'tabbar' | 'chat-main'

/** 列表容器的来源（侧栏登记：一个 `.session-list`） */
let listProvider: (() => HTMLElement | null) | null = null
/** 大片落点的来源（面板登记标签栏、聊天页登记 chat-main） */
const areaProviders = new Map<DropArea, () => HTMLElement | null>()
/** 当前高亮的行（换行时先清旧的） */
let highlighted: HTMLElement | null = null

/**
 * 登记会话列表容器（侧栏挂载时调；返回注销函数）。
 * 传的是 `ref.current` 的读取函数而不是元素本身：侧栏折叠 / 重挂时元素会换。
 */
export function registerSessionDropList(
  provider: () => HTMLElement | null,
): () => void {
  listProvider = provider
  return () => {
    if (listProvider === provider) listProvider = null
  }
}

/** 拿登记过的列表（已经不在 DOM 里就当没登记） */
function listElement(): HTMLElement | null {
  const element = listProvider?.() ?? null
  return element && element.isConnected ? element : null
}

/** 指针底下的会话行（含会话 id 与那一行的元素）；不在任何一行上 → `null` */
export interface SessionDropHit {
  sessionId: string
  row: HTMLElement
}

/**
 * 这一行此刻**真的看得见**吗。
 *
 * 为什么不能只看 rect：折叠的分组用 `grid-template-rows: 0fr` + 「内层 `overflow: hidden`」
 * 把内容裁掉，行本身的 `getBoundingClientRect()` 仍是完整尺寸、坐标还落在后面的可见内容上
 *（裁切只影响画出来和命中测试，不影响 rect）。少了这道筛，拖到展开分组里的行时会先撞上
 * 前面收起分组里同坐标的隐形行 —— 高亮不亮（亮在一个看不见的行上），标签却进了那个会话。
 */
function rowReachable(row: HTMLElement): boolean {
  // 折叠分组的内容是 `inert`（`sidebar/index.tsx` 的 `session-group-body`）：看不见就不该接
  if (row.closest('[inert]')) return false
  // 浏览器侧一次问清「自己或祖先是 display:none / visibility:hidden / opacity:0」
  //（jsdom 没有这个 API：那边只靠上面那条与 rect 判定，够用例用了）
  const check = (
    row as unknown as {
      checkVisibility?: (options?: Record<string, boolean>) => boolean
    }
  ).checkVisibility
  if (typeof check === 'function') {
    if (!check.call(row, { checkOpacity: true, checkVisibilityCSS: true })) return false
  }
  return true
}

/**
 * 登记右侧面板的**标签栏容器**（`side-panel/index.tsx` 挂载时调；返回注销函数）。
 *
 * 用途：拖会话的徽标（`session-badge-drag.ts`）往上松手 = 把那一整批标签搬进当前会话。
/**
 * 登记一块「大片落点」（面板登标签栏、聊天页登 `chat-main`；返回注销函数）。
 *
 * 用途：拖会话的徽标（`session-badge-drag.ts`）在这些地方松手 = 把那一整批标签搬进当前会话。
 * 与 `registerSessionDropList` 同一条口径：传读取函数而不是元素（面板收起 / 重挂时元素会换）。
 */
export function registerDropArea(
  area: DropArea,
  provider: () => HTMLElement | null,
): () => void {
  areaProviders.set(area, provider)
  return () => {
    if (areaProviders.get(area) === provider) areaProviders.delete(area)
  }
}

function areaElement(area: DropArea): HTMLElement | null {
  const element = areaProviders.get(area)?.() ?? null
  return element && element.isConnected ? element : null
}

/** 这个坐标落在这块落点上吗（收起 / 隐藏 / 被挤成 0 尺寸 → 不接） */
export function dropAreaHitAt(area: DropArea, x: number, y: number): boolean {
  const element = areaElement(area)
  if (!element) return false
  const box = element.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return false
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

/** 这块落点亮 / 收掉「松手就把这批标签搬进来」的提示（没登记时什么都不做） */
export function highlightDropArea(area: DropArea, active: boolean): void {
  areaElement(area)?.classList.toggle(AREA_DROP_CLASS, active)
}

/**
 * 这个坐标（CSS 像素）落在哪个会话行上；没有就是 `null`。
 *
 * 先判列表容器整体范围（多数情况下指针根本不在侧栏里，一次 rect 就否掉），再逐行比 ——
 * 行数是个位数到几十，比每次重建 DOM 便宜得多。
 *
 * 判定顺序：**行内直接命中**优先（`y` 落在行的可视段里），一个都没有才看
 * 「离得最近、且距离不超过 `ROW_SNAP`」的那一行（行与行之间那 1px 缝隙不该漏掉）。
 * 行被列表滚动裁掉的那一段不算：上下边界先和列表可视区求交。
 */
export function sessionDropHitAt(x: number, y: number): SessionDropHit | null {
  const list = listElement()
  if (!list) return null
  const box = list.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null
  const rows = list.querySelectorAll<HTMLElement>(`[${SESSION_ROW_ATTR}]`)
  /** 缝隙吸附的候选（只在没有直接命中时用） */
  let snapped: SessionDropHit | null = null
  let snappedGap = ROW_SNAP + 1
  for (const row of rows) {
    const sessionId = row.getAttribute(SESSION_ROW_ATTR) ?? ''
    if (!sessionId) continue
    const rect = row.getBoundingClientRect()
    // 0 高 / 0 宽（隐藏页签、没渲染的占位）
    if (rect.width <= 0 || rect.height <= 0) continue
    if (!rowReachable(row)) continue
    if (x < rect.left || x > rect.right) continue
    // 滚动裁掉的部分不算：可命中区间 = 行的 rect ∩ 列表可视区
    const top = Math.max(rect.top, box.top)
    const bottom = Math.min(rect.bottom, box.bottom)
    if (bottom <= top) continue
    if (y >= top && y <= bottom) return { sessionId, row }
    const gap = y < top ? top - y : y - bottom
    if (gap <= ROW_SNAP && gap < snappedGap) {
      snappedGap = gap
      snapped = { sessionId, row }
    }
  }
  return snapped
}

/**
 * 高亮「松手就落这一行」的那一行（传 `null` 清掉）。
 *
 * 可以每帧调：换行才动 DOM，同一行上只补一次类（`classList.contains` 不算白）。
 * 为什么要「每帧补齐」：行内内容会因外部状态（新回复红点 / 计时刷新）重渲染，React 重写
 * `className` 时会把我们写上去的类抹掉 —— 拖动中途那一下高亮就没了。
 */
export function highlightSessionDrop(row: HTMLElement | null): void {
  if (highlighted !== row) {
    highlighted?.classList.remove(DROP_TARGET_CLASS)
    highlighted = row
  }
  if (row && !row.classList.contains(DROP_TARGET_CLASS)) {
    row.classList.add(DROP_TARGET_CLASS)
  }
}
