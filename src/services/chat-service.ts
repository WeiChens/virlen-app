/**
 * chat-service — 聊天数据服务层（模块入口 / barrel）
 *
 * 实现已按职责拆分到 `./chat/*`，本文件只做统一重导出，保持既有 import 路径不变：
 *   import { sendMessage } from '@/services/chat-service'
 *
 * 职责：封装所有与引擎 + store 的数据交互，
 *       不依赖 React 组件，只通过回调通知 UI 层更新。
 *
 * 核心能力：
 * - sendMessage(): 正常发送消息，支持 tool call 暂停/恢复
 * - resumePausedRun(): 从暂停的 run 快照恢复执行（统一恢复入口）
 * - cancelMessage(): 取消正在处理的请求
 * - deleteSessions(): 删除会话（唯一入口：先断流再删库，防止孤儿消息）
 *
 * 注意：暂停/恢复机制基于 Run Snapshot 模型，旧版 shelvedChoiceState 已废弃。
 *
 * 子模块分工：
 * - ./chat/flow.ts          编排：发送 / 恢复 / 取消 / 上下文压缩 / 建会话
 * - ./chat/event-handler.ts AgentEventType 契约落点 + 收尾（finishWorking）
 * - ./chat/messages.ts      内存消息 CRUD + 按引擎路径落库
 * - ./chat/repair.ts        悬空 tool_calls 修复 + 发送前准备
 * - ./chat/common.ts        无状态辅助函数 + getEngine
 * - ./chat/trace.ts         埋点链路上下文
 * - ./chat/types.ts         ChatServiceEvents 契约
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
