/**
 * 上下文占用口径 —— **单一真源**（§22）。
 *
 * 消费方（三处，此前各写一份，必然分叉）：
 * 1. 桌面 token 环（`ui/pages/chat/components/input/token-ring.tsx`）；
 * 2. 手机控制接口层（`bridge/host-source.ts::getContext` 快照）；
 * 3. 手机推送（`bridge/store-bridge.ts` 的 `context.changed` 增量）。
 *
 * 若各写一份，同一会话在手机与电脑上会显示两个不同的百分比 —— 用户无法判断该信哪个。
 *
 * 依赖方向：本模块只依赖 `Message` 类型与共享包的两个**协议常量**
 * （`COMPRESS_MIN_RATIO` / `DEFAULT_CONTEXT_WINDOW_TOKENS`），不碰任何 store，
 * 因此可以被 UI 与 bridge 同时引用而不引入循环依赖。
 */
import { COMPRESS_MIN_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS, type ContextInfoDTO } from 'virlen-remote'
import type { Message } from '@/types'

export { COMPRESS_MIN_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS }

/**
 * 取「当前上下文占用」——从后往前，命中即止。
 *
 * 两个口径必须区分（见 `services/chat/flow.ts::compressContext`）：
 * - `uiData.contextTokens`：压缩产物的「压缩后上下文大小」（本地估算）；
 * - `usage.totalTokens`：该消息所属那轮调用的真实 token（供应商回报）。
 *
 * AI 摘要消息的 `usage` 是**那次摘要调用**的消耗（prompt 含压缩前的全部历史），
 * 拿它当占用会显示成「压缩后反而更大」，所以带 contextTokens 的消息一律优先。
 *
 * @returns 无法判定（消息未加载 / 无用量）时返回 `null` —— 调用方不得当成 0。
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

/**
 * 是否达到「值得压缩」的占用。
 *
 * 低于阈值时：桌面 token 环只提示、电脑侧 RPC 直接拒、手机端不显示按钮 —— 同一条判据。
 */
export function shouldCompress(context: ContextInfoDTO): boolean {
  return (context.tokens ?? 0) > 0 && contextRatio(context) >= COMPRESS_MIN_RATIO
}
