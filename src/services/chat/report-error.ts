/**
 * 「给用户看的错误」唯一出口（error-banner）：**展示文案与埋点同源**。
 *
 * 为什么要有这一层：错误产生点很散（引擎 error 事件 / invoke 抛错 / 前置校验拦截），
 * 而埋点原先只写在引擎 error 事件那一支 —— 其余分支的报错只上了界面，埋点包里查不到；
 * 界面上的文案又是 `transformApiError` 加工过的，与埋点里的原始英文对不上，事后没法按
 * 「界面上那条」回查。现在统一走这里：返回**要展示的文案**，同时把原文与展示文案一起上报。
 *
 * 事件名沿用 `chat.stream.error`（历史数据可继续比对），新增 `source` 区分产生点：
 * 真的失败（engine / invoke）与「前置校验拦下」（guard / resume / goal）在统计里要能分开。
 */
import { getSessionTrace, trackError } from '@/utils/telemetry'
import { transformApiError } from './common'

/** 错误产生点（进埋点 `props.source`） */
export type ChatErrorSource = 'engine' | 'invoke' | 'guard' | 'resume' | 'goal'

/**
 * 上报一条用户可见的错误，返回**应当展示的文案**（调用方据此 `events.onError(...)`）。
 *
 * 埋点字段：`error` = 原始错误（引擎英文原文，已打码）· `display_error` = 界面文案。
 * 两者都留，「API Error (400) ...」这类英文原文可排查，「当前模型不支持上传图片」这类
 * 中文文案可对账 UI，缺任何一半都会让排查断在中间。
 */
export function reportChatError(
  sessionId: string,
  error: unknown,
  source: ChatErrorSource,
  extra?: {
    traceId?: string
    props?: Record<string, any>
  },
): string {
  const raw =
    typeof error === 'string'
      ? error
      : (error as any)?.message || String(error ?? '')
  const display = transformApiError(raw || '未知错误')
  trackError('chat.stream.error', raw || display, {
    traceId: extra?.traceId ?? getSessionTrace(sessionId),
    props: {
      source,
      ...(extra?.props || {}),
      display_error: display,
    },
  })
  return display
}
