/** 会话运行时状态 — 维护每个会话的工作状态和流式中间内容，跨会话切换不丢失 */
import { runInAction } from 'mobx'
import RuntimeState from '@/utils/runtimeState'

/** 单个会话的运行时状态 */
export interface SessionRuntime {
  /** 是否正在 AI 回复中 */
  working: boolean
  /** 流式回复中累积的内容（切换会话时保留） */
  pendingContent: string
  /** 正在进行的流式消息 ID */
  streamingMessageId: string | null
  /** 工具调用是否被暂停等待恢复 */
  paused: boolean
  /** 是否正在压缩中 */
  compacting: boolean
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
      // sessionRuntimeState.value.sessions[sessionId].compacting = compacting
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
        pendingContent: '',
        streamingMessageId: null,
        paused: false,
      }
    })
  }
  return sessionRuntimeState.value.sessions[sessionId]
}

/**
 * 原子更新会话运行时状态（action 包装，避免 MobX strict-mode 警告）
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
