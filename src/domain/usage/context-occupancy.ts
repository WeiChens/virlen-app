/**
 * 上下文占用口径 —— **单一真源**。
 *
 * 消费方三处（此前各写一份必然分叉，同一会话在手机与电脑上会显示不同百分比）：
 * 桌面 token 环、手机控制接口层（`bridge/host-source.ts::getContext`）、手机推送（`bridge/store-bridge.ts`）。
 *
 * 只依赖 `Message` 与两个协议常量（`COMPRESS_MIN_RATIO` / `DEFAULT_CONTEXT_WINDOW_TOKENS`），
 * 不碰 store，故 UI 与 bridge 可同时引用而不循环依赖。
 */
import { COMPRESS_MIN_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS, type ContextInfoDTO } from 'virlen-remote'
import type { Message } from '@/types'

export { COMPRESS_MIN_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS }

/**
 * 取「当前上下文占用」—— 从后往前、命中即止。
 *
 * 两个口径须区分（见 `services/chat/flow.ts::compressContext`）：`uiData.contextTokens` 是压缩后的
 * 上下文大小（本地估算），`usage.totalTokens` 是该轮调用的真实 token。AI 摘要消息的 `usage` 是那次
 * 摘要调用的消耗（prompt 含压缩前全部历史），拿它当占用会显示「压缩后反而更大」，故带 contextTokens 的优先。
 *
 * @returns 无法判定时返回 `null`，调用方不得当成 0。
 */
export function pickContextTokens(messages: readonly Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ctx = messages[i].uiData?.contextTokens
    if (typeof ctx === 'number' && ctx > 0) return ctx
    const usage = messages[i].usage
    if (usage) return usage.totalTokens
  }
  return null
}

/** 上下文窗口大小（设置项优先，缺省 200k —— 与协议层常量同源）。 */
export function contextWindowOf(configured?: number): number {
  return configured || DEFAULT_CONTEXT_WINDOW_TOKENS
}

/** 组装协议 DTO（电脑侧唯一的投影点）。 */
export function toContextInfo(
  messages: readonly Message[],
  configuredWindow?: number,
): ContextInfoDTO {
  return {
    tokens: pickContextTokens(messages),
    windowTokens: contextWindowOf(configuredWindow),
  }
}

/** 占用比例（`tokens` 未知时按 0 处理；只用于展示与压缩判据）。 */
export function contextRatio(context: ContextInfoDTO): number {
  if (context.tokens == null || context.windowTokens <= 0) return 0
  return Math.min(context.tokens / context.windowTokens, 1)
}

/** 是否达到「值得压缩」的占用（低于阈值时桌面只提示、电脑侧 RPC 直接拒、手机端不显示按钮，同一条判据）。 */
export function shouldCompress(context: ContextInfoDTO): boolean {
  return (context.tokens ?? 0) > 0 && contextRatio(context) >= COMPRESS_MIN_RATIO
}
