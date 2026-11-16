/**
 * chat/auto-compress — agent 跑完一轮回复循环后的**上下文自动压缩**。
 *
 * ## 触发时机
 * 「一轮回复循环跑完」= `flow.ts` 里 `sendMessage` / `sendMessageWithGoal` / `resumePausedRun`
 * 三条路径的 `finishWorking(...)` 之后（即引擎已 emit `stream_end`、最后一轮的助手消息与用量都已落地）。
 * 只在这一刻判一次：中途（工具轮次之间）不压 —— 压缩会整体替换消息列表，跑到一半换掉历史
 * 会让引擎手里的那份上下文与界面不一致。
 *
 * ## 判据
 * ① 设置开关 `contextAutoCompress` 打开（默认**关**）；
 * ② 会话 idle（没在跑、没在压缩、没暂停等回答）；
 * ③ 上下文已**满**：占用 ≥ 上下文窗口（`contextWindowTokens`，即 token 环满环的 100%）。
 *    口径与 token 环同一份（`@/domain/usage/context-occupancy`），不另立一套百分比。
 *
 * ## 压缩方式
 * 用**设置里的默认方式**（`contextCompressMode`）—— 不给 `compressContext` 传 `modeOverride`，
 * 与点 token 环左键的行为完全一致。
 *
 * ## 为什么占用要读库而不是读内存
 * 引擎跑完最后一轮后，`assistant` 消息的 `usage` 可能还没同步进前端内存列表（落库在 Rust 侧，
 * 经事件回写内存是另一条路），而「占用」只认**最新**那条带 `usage` / `uiData.contextTokens` 的消息。
 * 所以优先取库里的尾部窗口（`cmd_get_message_page`，一次 IPC 拿 30 条即可命中），
 * 读不到时才退回内存 —— 宁可漏压一次（下一轮结束再判），也不能误压。
 */
import { sessionRuntimeState, sessionStore, settingsState } from '@/ui/store'
import {
  contextWindowOf,
  isContextFull,
  pickContextTokens,
} from '@/domain/usage/context-occupancy'
import type { ContextInfoDTO } from 'virlen-remote'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'
import { track } from '@/utils/telemetry'
import { compressContext } from './flow'
import { getSessionMessages } from './messages'
import type { ChatServiceEvents } from './types'

/** 尾窗条数：每轮助手消息都带 `usage`，30 条足够命中「最新一条有用量的消息」 */
const CONTEXT_TAIL_WINDOW = 30

/**
 * 该会话此刻的上下文占用。
 *
 * 先读库尾窗（权威，含刚落库的最后一轮用量），读不到退内存。
 * 两条路都拿不到时 `tokens` 为 `null` —— 判定方按「未满」处理。
 */
export async function currentContextInfo(
  sessionId: string,
): Promise<ContextInfoDTO> {
  const windowTokens = contextWindowOf(settingsState.value.contextWindowTokens)
  const page = await sessionRepo.getMessagePage(sessionId, {
    limit: CONTEXT_TAIL_WINDOW,
  })
  const fromDb = pickContextTokens(page.messages)
  return {
    tokens: fromDb ?? pickContextTokens(getSessionMessages(sessionId)),
    windowTokens,
  }
}

/** 会话是否真的闲着（没在跑、没在压缩、没暂停等回答） */
function isSessionIdle(sessionId: string): boolean {
  const rt = sessionRuntimeState.value.sessions[sessionId]
  if (!rt) return true
  return !rt.working && !rt.compacting && !rt.paused
}

/**
 * 一轮回复循环跑完后调用：满足全部判据就自动压一次。
 * @returns 是否真的发起了压缩
 */
export async function maybeAutoCompress(
  sessionId: string,
  events?: ChatServiceEvents,
): Promise<boolean> {
  if (!settingsState.value.contextAutoCompress) return false
  // 会话必须真正闲着：暂停等回答 / 又开了新一轮都不压（压缩会整体替换消息列表）
  if (!isSessionIdle(sessionId)) return false
  if (!sessionStore.getSession(sessionId)) return false

  const context = await currentContextInfo(sessionId)
  if (!isContextFull(context)) return false
  // 等 IPC 期间状态可能变了（用户刚好发了下一条）：再核一次，避免和正在跑的 run 抢消息列表
  if (!isSessionIdle(sessionId)) return false

  track('chat.context.auto_compress', {
    tokens: context.tokens,
    window_tokens: context.windowTokens,
    mode: settingsState.value.contextCompressMode,
  })
  showToast(t('上下文已满，正在自动压缩...'), 2000)
  // 不传方式 = 沿用设置里的默认压缩方式（与点 token 环左键同一行为）
  await compressContext(sessionId, events)
  return true
}
