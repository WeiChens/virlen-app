/**
 * message-list 虚拟滚动常量与稳定空值
 *
 * 与「虚拟滚动核心」（use-virtual-list）强相关；改数值前请连同
 * rangeExtractor / 贴底阈值（AT_BOTTOM_THRESHOLD）/ 回补阈值一起评估。
 */
import type { Message } from '@/types'

/**
 * 单条消息「未被测量前」的初始估算高度。
 * 首次测量后会用「已测量条目的平均高度」动态逼近（见 use-virtual-list 的 avgItemHeightRef）。
 */
export const ESTIMATED_ITEM_HEIGHT = 120
/**
 * 视口外前后额外渲染的条目数。
 * 注意：实际渲染范围已改由 rangeExtractor 按「像素」决定，
 * 这里只影响虚拟库在「平滑滚动」时允许测量的条目窗口。
 */
export const OVERSCAN = 32
/**
 * 视口上下各自额外渲染的像素缓冲（视口更高时按「一屏」计）。
 *
 * 库默认的 overscan 是「条数」，而消息气泡矮的只有几十像素、高的上千像素，
 * 按条数扩展时缓冲区的真实像素可能只有一两百 → 快速滚动 / 惯性滚动时
 * 新条目还没来得及挂载就已经进入视口，表现为露白 + 抖动。
 * 改成按像素扩展后，视口上下始终各有约一屏的已渲染内容作为缓冲。
 */
export const OVERSCAN_PX = 800
/**
 * 单侧最多额外渲染的条数。
 * 条目很矮（短句）时防止一次性挂载过多 DOM；默认下限 20，OVERSCAN 调大时跟随。
 */
export const MAX_OVERSCAN_ITEMS = Math.max(20, OVERSCAN)
/** 距底部 ≤ 该值视为「贴在底部」：新消息 / 流式增长时自动跟随 */
export const AT_BOTTOM_THRESHOLD = 120
/** 距顶部 ≤ 该值触发回补更早消息 */
export const SCROLL_TOP_THRESHOLD = 400
/** 列表上下内边距（由虚拟容器承担，保证滚动偏移计算与真实布局一致） */
export const LIST_PADDING = 8
/** 「点击查看更多」提示条高度（预留占位，避免与首条消息重叠） */
export const LOAD_MORE_HINT_HEIGHT = 36
/**
 * 切会话「等布局稳定」的轮询上限（50ms/次 → 约 1s）。
 * 兜底：无论高度是否还在变，到点都必须显示，避免任何异常情况下永久空白。
 */
export const MAX_SETTLE_POLLS = 20
/**
 * 锚点列表最多渲染的圆点数（安全上限，避免极端会话挂载过多 DOM）。
 * 正常会话（数千消息）全部渲染，超出部分通过滚动条查看。
 */
export const MAX_ANCHOR_DOTS = 2000

/** 稳定的空 tool 结果数组（无 toolCalls 的消息共用，保证 memo 命中） */
export const EMPTY_TOOL_RESULTS: (Message | undefined)[] = []
