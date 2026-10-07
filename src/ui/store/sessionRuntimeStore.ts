/** 会话运行时状态 — 维护每个会话的工作状态和流式中间内容，跨会话切换不丢失 */
import { runInAction } from 'mobx'
import RuntimeState from '@/utils/runtimeState'

/** 单个会话的运行时状态 */
export interface SessionRuntime {
  /**
   * 是否正在 AI 回复中 —— **引擎 run 的锁**。并发保护的唯一判据（chat/flow.ts::isSessionBusy）：手机端 /
   * 托盘 / 多窗口靠它挡「同一会话同时起两个 run 写同一份 messages」。
   *
   * ⚠️ 别拿它当「界面在忙」的展示位：发送**之前**的本地准备请用 preparing，否则会把同一次发送的后续步骤锁死。
   */
  working: boolean
  /**
   * 本地前置处理中（图片视觉分析等）—— **尚无引擎 run**。
   *
   * 与 working 的唯一差别：working 有引擎 run 在跑（同时是并发锁）；preparing 是发送**之前**的本地准备
   *（doSend 逐张跑 vision.analyzeBase64，可能好几秒），纯展示。
   *
   * 为什么必须分开（2026-10 回归缺陷）：本地识别曾用 working:true 点亮指示器，而那把锁是同一次发送稍后要过的关
   * —— 识别结束后紧接着的 sendMessage 被自己判成「该会话正在回复中」：用户消息已显示却永远等不到回复。
   * 界面表达「在忙」用 isSessionRuntimeBusy(rt)（两者取或）。除 chat-view.doSend 外**不要**再写这个字段。
   */
  preparing: boolean
  /** 流式回复中累积的内容（切换会话时保留） */
  pendingContent: string
  /** 正在进行的流式消息 ID */
  streamingMessageId: string | null
  /** 工具调用是否被暂停等待恢复 */
  paused: boolean
  /** 是否正在压缩中 */
  compacting: boolean
  /** 非当前会话回复完成后是否还有未查看的新回复（侧边栏红点） */
  hasNewReply: boolean
  /** 该会话最近一次 AI 回复的错误信息（跨会话切换保留，切回时仍展示） */
  error: string | null
  /**
   * 正在生成的工具调用进度（引擎在累积参数期间推送；无 = null）。语义：working=true 时的「在生成什么」——
   * 没有它时，模型写大参数（如 2000 字的 write_file）会让界面停在「AI 正在处理…」数十秒（§27）。
   */
  toolProgress: { name: string; chars: number } | null
}

interface SessionRuntimeStore {
  sessions: Record<string, SessionRuntime>
}

const defaultSessionRuntime: SessionRuntimeStore = {
  sessions: {},
}

export const sessionRuntimeState = new RuntimeState(
  defaultSessionRuntime,
).mixins({
  setCompacting(sessionId: string, compacting: boolean) {
    if (!sessionId) return
    runInAction(() => {
      const sessions = { ...sessionRuntimeState.value.sessions }
      sessions[sessionId].compacting = compacting
      sessionRuntimeState.value.sessions = sessions
    })
  },
})

/** 获取或初始化某个会话的运行时状态 */
export function getSessionRuntime(sessionId: string): SessionRuntime {
  if (!sessionRuntimeState.value.sessions[sessionId]) {
    runInAction(() => {
      sessionRuntimeState.value.sessions[sessionId] = {
        compacting: false,
        working: false,
        preparing: false,
        pendingContent: '',
        streamingMessageId: null,
        paused: false,
        hasNewReply: false,
        error: null,
        toolProgress: null,
      }
    })
  }
  return sessionRuntimeState.value.sessions[sessionId]
}

/**
 * 原子更新会话运行时状态（action 包装，避免 MobX strict-mode 警告）。
 */
export function updateSessionRuntime(
  sessionId: string,
  patch: Partial<SessionRuntime>,
): void {
  const rt = getSessionRuntime(sessionId)
  runInAction(() => {
    Object.assign(rt, patch)
  })
}

/**
 * 该会话在**界面上**是否显示「忙碌」（引擎 run 在跑 或 本地前置处理中）。
 *
 * ⚠️ 这不是并发锁 —— 锁只认 working（chat/flow.ts::isSessionBusy）。这里多算 preparing，只为让「点发送 → 本地识别
 * 图片 → 引擎开跑」这条链路上，指示器 / 侧边栏圆点 / 托盘状态不出现闪断。
 */
export function isSessionRuntimeBusy(rt: SessionRuntime): boolean {
  return rt.working || rt.preparing
}

/**
 * 丢弃已删除会话的运行时状态（否则 sessions 条目永久残留、working / hasNewReply 挂在已不存在的 id 上）。
 */
export function dropSessionRuntime(ids: Iterable<string>): void {
  const drop = new Set(ids)
  if (drop.size === 0) return
  runInAction(() => {
    const sessions = { ...sessionRuntimeState.value.sessions }
    for (const id of drop) delete sessions[id]
    sessionRuntimeState.value.sessions = sessions
  })
}
