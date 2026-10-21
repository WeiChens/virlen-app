/**
 * 消息的「界面元数据」—— 挂在 `message.uiData` 上、随消息一起落库的非正文信息。
 *
 * 为什么走 `uiData` 而不是新增顶层字段：消息的顶层列由 Rust 侧 `Message`
 *（`src-tauri/virlen-core/src/agent/types.rs`）与 `messages` 表结构定义，加一个顶层字段要连带改
 * core 结构 / DDL / 读写语句（跨语言契约）；而 `uiData` 本就是「给界面看的结构化数据」的既有载体
 *（任务清单快照、上下文占用都走它），JSON 原样落库、原样回读。
 *
 * ⚠️ 与 `messageContent.ts` 同一层：那里管 `content` 块，这里管 `uiData`；两者都不许在别处
 * 另写一份判据（界面与 service 必须同源）。
 */
import type { Message } from '@/types'

/** 本轮 agent 循环总耗时的 uiData 键（毫秒） */
export const AGENT_ELAPSED_KEY = 'agentElapsedMs'

/**
 * 读取「本轮 agent 循环总耗时」（毫秒）。
 *
 * 只有正常跑完的那一轮才会写入（见 `services/chat/event-handler.ts` 的 `stream_end`）：
 * 出错 / 取消 / 暂停都不完结循环，不带这个值 → 界面也就不显示。
 * 非法值（NaN / 负数 / 0）一律当没有，交给界面走「不显示」分支而不是渲染出 ``或 `0ms`。
 */
export function agentElapsedMsOf(message: Message): number | undefined {
  const value = message.uiData?.[AGENT_ELAPSED_KEY]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return value
}

/**
 * 写入总耗时的消息补丁：**合并** `uiData`（同一条消息可能已有别的界面元数据，不能整个覆盖）。
 * 返回的是 `Partial<Message>`，交给 `updateSessionMessage` 应用。
 */
export function withAgentElapsedMs(
  message: Message,
  elapsedMs: number,
): Partial<Message> {
  return {
    uiData: {
      ...(message.uiData ?? {}),
      [AGENT_ELAPSED_KEY]: Math.max(0, Math.round(elapsedMs)),
    },
  }
}
