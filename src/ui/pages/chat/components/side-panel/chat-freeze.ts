/**
 * 右侧栏宽度过渡（展开 / 全屏 / 收起 / 定宽）期间，把聊天区**消息列表**的宽度钉在终值。
 *
 * 为什么要钉：面板宽度是从 0 ↔ 实宽过渡的，`.chat-main` 是同一行的 `flex: 1` —— 不钉的话
 * 消息列表在那 200ms 里一帧换一个宽度，每一行都得重新折行：`use-virtual-list` 的逐行
 * ResizeObserver 会一轮接一轮地报实测高度，虚拟滚动再按行高差补偿 `scrollTop`。
 * 观感就是「一边滑一边抖」，长会话里还会明显掉帧。
 * 钉住之后整段过渡**只折行一次**，而且是在第一帧就按终值算好的那一次；后面面板滑过去只是
 * 盖住 / 让出空白，内容一动不动（视觉上就是面板从内容上滑过去）。
 *
 * 实现：给 `.chat-main` 挂一个 CSS 变量，由 `message-list.scss` 的
 * `.chat-messages-container { width: var(--chat-freeze-width, auto) }` 消费。
 * 变量挂在 `.chat-main` 而不是根节点 / 面板上：它既是「这条聊天列的宽度」的唯一持有者，
 * 又天然把影响圈在列内（面板里的文件树 / 终端不受牵连）。
 *
 * ⚠️ 变量名是**本文件与 `message-list.scss` 的成对契约**（写入点只有这儿）：改名要一起改。
 */

/** 钉住的宽度（px）。挂在 `.chat-main` 上，过渡窗口过去由 `freezeChatWidth` 摘掉 */
export const CHAT_FREEZE_VAR = '--chat-freeze-width'

/**
 * 面板宽度过渡时长，与 `style.scss` 里 `.side-panel { transition: width 200ms … }` 同一档。
 * ⚠️ 跨实现镜像：这里只用来算「什么时候摘锁」的兜底 —— 早摘会白闪一帧、晚摘最多多等几十毫秒，
 * 不参与布局。改样式表里的时长要同步这里（`side-panel-style-contract` 用例钉着这对数）。
 */
export const PANEL_WIDTH_MOTION_MS = 200

/**
 * 摘锁时刻 = 过渡时长 + 余量。
 * 余量要比「一帧」更宽：退出占满态时聊天区的 `display: none` 是**宿主**在面板的 passive
 * effect 里才去掉的（比这个 layout effect 晚一拍），所以锁要活到那之后、直到过渡真正跑完。
 */
const RELEASE_DELAY_MS = PANEL_WIDTH_MOTION_MS + 120

/**
 * 把消息列表的宽度钉在「面板宽 `panelWidth` 时的聊天区宽度」，返回摘锁函数。
 *
 * 终值只用**当前真实布局**算：`容器宽度 - 聊天区左缘 - 面板终宽`。三个量在过渡里都是常量
 * （左缘被左侧栏钉住、容器宽度就是窗口、面板终宽是整数 px），所以算出来的正是过渡结束时的
 * 宽度 —— 不经过 `available` 那个取整过的 state，摘锁时不会有半像素的二次折行。
 *
 * @param main `.chat-main`（与面板同一行的兄弟）
 * @param panelWidth 过渡结束时的面板宽度（收起 = 0；进入占满态那一帧由调用方直接跳过）
 * @param fallbackInset 量不到聊天区左缘时用的「左侧栏 + 分隔条」宽度（调用方记下的上次实测值）。
 *   退出占满态那一帧聊天区还是 `display: none`（宿主晚一拍才放开），矩形全 0，必须靠它兜底 ——
 *   否则那一帧直接跳过，之后就再也没有时机了。
 */
export function freezeChatWidth(
  main: HTMLElement | null,
  panelWidth: number,
  fallbackInset = 0,
): () => void {
  const noop = () => {}
  const parent = main?.parentElement
  if (!main || !parent) return noop

  const parentRect = parent.getBoundingClientRect()
  if (!(parentRect.width > 0)) return noop
  const mainRect = main.getBoundingClientRect()
  /*
   * 聊天区量得到就用它的真实左缘（最准）；量不到（`display: none` 时矩形全 0 —— 占满态与
   * 刚退出占满态那一帧都是）就用调用方记下的 inset。
   * ⚠️ 不能因为量不到就跳过：这一帧正是「从宽度 0 涨到终值」的起点，不钉的话整段过渡逐帧折行。
   * 两样都没有（从未量过、又没有左侧栏）时宁可不动 —— 拿 0 凑数会把宽度钉宽一个左侧栏。
   */
  const measurable = mainRect.width > 0 || mainRect.height > 0
  if (!measurable && !(fallbackInset > 0)) return noop
  const inset = measurable ? mainRect.left - parentRect.left : fallbackInset
  const free = parentRect.width - inset - panelWidth
  if (!(free > 0)) return noop

  main.style.setProperty(CHAT_FREEZE_VAR, `${free}px`)
  const timer = window.setTimeout(
    () => main.style.removeProperty(CHAT_FREEZE_VAR),
    RELEASE_DELAY_MS,
  )
  return () => {
    window.clearTimeout(timer)
    main.style.removeProperty(CHAT_FREEZE_VAR)
  }
}
