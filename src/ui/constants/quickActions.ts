import QUICK_ACTIONS_POOL_DATA from './QUICK_ACTIONS_POOL.json'
/**
 * quick-actions 数据配置
 *
 * 每个 quick-action：name（按钮文本）+ textList（点击时循环使用的文本列表）。每天基于日期 + 设备种子确定性随机取 5 个，
 * 确保同人同天看到同一组。
 */

export interface QuickAction {
  name: string
  textList: string[]
}

/**
 * 完整 quick-actions 池 —— 50 个类别，每个 20 条文本
 */
const QUICK_ACTIONS_POOL: QuickAction[] = QUICK_ACTIONS_POOL_DATA
/** 生成一个简单的数值哈希。 */
function simpleHash(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

/** 今天的日期字符串 YYYY-MM-DD。 */
function getTodayDateStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 设备种子 —— 首次调用时随机生成并持久化到 localStorage，保证不同用户 / 设备每天看到的 quick-actions 不同。
 */
function getDeviceSeed(): string {
  const KEY = 'quick_action_seed'
  try {
    let seed = localStorage.getItem(KEY)
    if (!seed) {
      seed = Math.random().toString(36).substring(2, 10)
      localStorage.setItem(KEY, seed)
    }
    return seed
  } catch {
    // localStorage 不可用时（如 SSR）回退为固定值
    return 'fallback'
  }
}

/**
 * 从池中选 count 个 quick-action（设备种子 + 日期确定性选取：同人同天刷新不变，不同人 / 天不同）。
 */
export function getDailyQuickActions(count: number = 5): QuickAction[] {
  const dateStr = getTodayDateStr()
  const seed = getDeviceSeed()
  const hash = simpleHash(dateStr + ':' + seed)

  const shuffled = [...QUICK_ACTIONS_POOL].sort((a, b) => {
    const idxA = QUICK_ACTIONS_POOL.indexOf(a)
    const idxB = QUICK_ACTIONS_POOL.indexOf(b)
    const ra = ((idxA + 1) * (hash + 1)) % 7919
    const rb = ((idxB + 1) * (hash + 1)) % 7919
    return ra - rb
  })

  return shuffled.slice(0, count)
}
