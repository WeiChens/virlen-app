/**
 * StormBreaker — 工具调用风暴防护
 *
 * 检测模型工具调用的死循环模式：相同 (name, args) 在滑动窗口中重复出现≥阈值次时拦截。
 * 状态为内存级 (Map)，随页面生命周期，引擎销毁时自动清理。
 */
const WINDOW_SIZE = 6
const THRESHOLD = 3

interface CallRecord {
  /** 序列化的调用签名 */
  signature: string
  timestamp: number
}

const history = new Map<string, CallRecord[]>()

/**
 * 检查指定会话的工具调用是否触发了风暴阈值。
 * 每次调用都会将当前调用记录写入滑动窗口。
 *
 * @returns true = 命中风暴模式，应拦截此次调用
 */
export function checkToolCallStorm(
  sessionId: string,
  toolName: string,
  input: Record<string, any>,
): boolean {
  const signature = `${toolName}(${JSON.stringify(input)})`
  const records = history.get(sessionId) || []

  // 追加当前调用
  records.push({ signature, timestamp: Date.now() })

  // 只保留最近 WINDOW_SIZE 条
  const recent = records.slice(-WINDOW_SIZE)
  history.set(sessionId, recent)

  // 统计相同 signature 的出现次数
  const count = recent.filter((r) => r.signature === signature).length
  return count >= THRESHOLD
}

/**
 * 清除指定会话的调用历史（会话结束时调用）
 */
export function clearToolCallHistory(sessionId: string): void {
  history.delete(sessionId)
}

/**
 * 清除所有会话的调用历史（引擎销毁时调用）
 */
export function clearAllToolCallHistories(): void {
  history.clear()
}
