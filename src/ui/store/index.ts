/**
 * 全局状态管理 Barrel — 统一导出所有状态模块
 *
 * 各模块职责：
 *  - userChoiceState.ts        → 用户选择弹窗状态
 *  - sessionStore.ts           → 会话 CRUD
 *  - messages.ts               → 已合并至 services/chat-service.ts
 *  - sessionRuntimeStore.ts    → 会话运行时 RuntimeState
 *  - settingStore.ts           → 全局设置
 *  - securityStore.ts          → 安全配置
 *  - agentStore.ts             → Agent CRUD
 */
export { userChoiceState } from './userChoiceState'
export type { UserChoiceState } from './userChoiceState'

export { sessionStore } from './sessionStore'
/** 向后兼容 */
// export const saveSession = (
//   session: Parameters<typeof sessionStore.saveSession>[0],
// ) => sessionStore.saveSession(session)
// export const getSession = (id: string) => sessionStore.getSession(id)
// export const listSessions = () => sessionStore.listSessions()
// export const updateSession = (
//   id: string,
//   patch: Parameters<typeof sessionStore.updateSession>[1],
// ) => sessionStore.updateSession(id, patch)
// export const updateSessionTitle = (id: string, title: string) =>
//   sessionStore.updateSessionTitle(id, title)
// export const deleteSession = (id: string) => sessionStore.deleteSession(id)
// export const toggleSessionPin = (id: string) =>
//   sessionStore.toggleSessionPin(id)
// export const notifySessionChanged = (id: string) =>
//   sessionStore.notifySessionChanged(id)

export {
  sessionRuntimeState,
  getSessionRuntime,
  updateSessionRuntime,
} from './sessionRuntimeStore'
export type { SessionRuntime } from './sessionRuntimeStore'
export { settingsState, resolveDefaultWorkspace } from './settingStore'
export type {
  SettingsStore,
  CommandApprovalMode,
  QuickInputTemplate,
  SessionGroupType,
} from './settingStore'
export type { SearchProviderConfig } from '@/domain/search/config'
export { agentStore } from './agentStore'
export type { AgentStoreData } from './agentStore'
export { chatState } from './chatState'
