/**
 * chat-service — 聊天数据服务层入口（barrel）。
 *
 * 实现拆在 ./chat/*，本文件只做统一重导出以保持既有 import 路径。封装引擎 + store 的数据交互，
 * 不依赖 React，只通过回调通知 UI（暂停/恢复基于 Run Snapshot 模型）。
 *
 * 子模块：flow(编排) / session(会话激活) / event-handler(事件契约+收尾) / messages(内存 CRUD+落库)
 *          / repair(悬空 tool_calls 修复) / common(无状态辅助+getEngine) / trace(埋点链路) / types(事件契约)
 */
export type { ChatServiceEvents } from './chat/types'

export { getEngine } from './chat/common'

export {
  createSession,
  transferSummaryToNewSession,
  deleteSessions,
  sendMessage,
  resumePausedRun,
  sendMessageWithGoal,
  cancelMessage,
  cancelPausedRun,
  getRunSnapshot,
  compressContext,
} from './chat/flow'

export {
  addSessionMessage,
  updateSessionMessage,
  getSessionMessages,
  deleteSessionMessage,
  clearSessionMessages,
  replaceSessionMessages,
} from './chat/messages'

export {
  repairSessionIfNeeded,
  checkAndRepairMessageList,
} from './chat/repair'

/** 会话激活（数据侧）—— 组件与手机接口层共用的唯一入口；并含会话写操作用例（M4） */
export { activateSession, renameSession, setSessionPinned, MAX_SESSION_TITLE_LEN } from './chat/session'
