/** message-list 虚拟滚动常量与稳定空值。改数值前连同 rangeExtractor / 贴底阈值 / 回补阈值一起评估。 */
import type { Message } from '@/types'

/** 单条消息「未被测量前」的初始估算高度；测过之后用「已测量条目的平均高度」逼近（见 use-virtual-list）。 */
export const ESTIMATED_ITEM_HEIGHT = 120
/** 视口外额外渲染的条目数（实际渲染范围已由 rangeExtractor 按像素决定，这里只影响虚拟库在平滑滚动时允许测量的条目窗口）。 */
export const OVERSCAN = 32
/**
 * 渲染范围相对视口高度的倍数（上下各分一半作缓冲，见 rangeExtractor）：值越大越不易露白，代价是 DOM 里消息越多。
 * 3 → 上下各 1 屏；10 → 上下各 4.5 屏。
 */
export const RENDER_RANGE_SCREENS = 10
/** 单侧像素缓冲的「屏数」= (总倍数 - 1) / 2（随 RENDER_RANGE_SCREENS 联动） */
export const OVERSCAN_SCREENS = (RENDER_RANGE_SCREENS - 1) / 2
/**
 * 视口上下各自额外渲染的像素缓冲**下限**（视口高度未知 / 窗口极窄时兜底）。
 *
 * 库默认的 overscan 按「条数」，而气泡矮的几十像素、高的上千像素，按条数扩展的真实缓冲可能只有一两百
 * → 快速 / 惯性滚动时新条目还没挂载就进了视口，表现为露白 + 抖动。改按像素扩展后缓冲随视口高度走，本值只兜底。
 */
export const OVERSCAN_PX = 800
/**
 * 单侧最多额外渲染的条数（条目很矮时防止一次性挂载过多 DOM 的保险丝）。
 * 与单侧屏数等比放大：原值 32（= OVERSCAN）对应 1 屏，现单侧 4.5 屏 → 144；否则矮消息会先撞条数上限，像素倍数被压回去。
 */
export const MAX_OVERSCAN_ITEMS = Math.max(20, OVERSCAN) * OVERSCAN_SCREENS
/** 距底部 ≤ 该值视为「贴在底部」：新消息 / 流式增长时自动跟随 */
export const AT_BOTTOM_THRESHOLD = 120
/** 距顶部 ≤ 该值触发回补更早消息 */
export const SCROLL_TOP_THRESHOLD = 400
/** 列表上下内边距（由虚拟容器承担，保证滚动偏移计算与真实布局一致） */
export const LIST_PADDING = 8
/** 「点击查看更多」提示条高度（预留占位，避免与首条消息重叠） */
export const LOAD_MORE_HINT_HEIGHT = 36
/** 切会话「等布局稳定」的轮询上限（50ms/次 → 约 1s）。兜底：无论高度是否还在变，到点必须显示。 */
export const MAX_SETTLE_POLLS = 20
/** 锚点列表最多渲染的圆点数（安全上限）；正常会话（数千消息）全部渲染，超出部分靠滚动条查看。 */
export const MAX_ANCHOR_DOTS = 2000
/**
 * 锚点定位时最多向上回补的页数（兜底：目标已被删除等情况下不能无限取）。
 * 每页已按「可见行」在 Rust 侧补足（≥ `MESSAGE_MIN_VISIBLE` 行），1000 页足以覆盖任何真实会话。
 */
export const JUMP_LOAD_MAX_PAGES = 1000

/** 稳定的空 tool 结果数组（无 toolCalls 的消息共用，保证 memo 命中） */
export const EMPTY_TOOL_RESULTS: (Message | undefined)[] = []
