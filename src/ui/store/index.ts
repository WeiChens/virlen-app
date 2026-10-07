/** 全局状态管理 Barrel —— 统一导出所有状态模块（userChoice / session / sessionRuntime / todoDraft /
 * setting / security / agent / chat）。 */
export { userChoiceState } from './userChoiceState'
export type { UserChoiceState } from './userChoiceState'

export { sessionStore } from './sessionStore'

export {
  sessionRuntimeState,
  getSessionRuntime,
  updateSessionRuntime,
  dropSessionRuntime,
  isSessionRuntimeBusy,
} from './sessionRuntimeStore'
export type { SessionRuntime } from './sessionRuntimeStore'
export {
  todoDraftState,
  getTodoDraft,
  hasTodoDraft,
  isTodoDraftCommitted,
  markTodoDraftCommitted,
  ensureTodoDraft,
  updateTodoDraftItems,
  clearTodoDraft,
  dropTodoDrafts,
} from './todoDraftStore'
export type { TodoDraft } from './todoDraftStore'
export { settingsState, resolveDefaultWorkspace } from './settingStore'
export type {
  SettingsStore,
  SandboxMode,
  QuickInputTemplate,
  SessionGroupType,
} from './settingStore'
export type { SearchProviderConfig } from '@/domain/search/config'
export type { EditorOpenConfig } from '@/domain/editor'
export { agentStore } from './agentStore'
export type { AgentStoreData } from './agentStore'
export { chatState } from './chatState'
