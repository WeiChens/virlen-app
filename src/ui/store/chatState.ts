import RuntimeState from '@/utils/runtimeState'
export interface ModelInfo {
  providerConfigId: string
  modelId: string
}
export interface ChatStore {
  currentSessionId: string | null
  loading: boolean
  /** 工作状态描述文本（如"视觉分析中"、"正在工作中"），空字符串表示不显示 */
  loadingText: string
  error: string | null
  sidebarOpen: boolean
  selectModel: ModelInfo
  /** 无会话时选中的 Agent ID */
  selectedAgentId: string
  /** 无会话时的工作目录（由 Agent 快照或用户手动选择） */
  selectedWorkspace: string
}

const defaultChat: ChatStore = {
  currentSessionId: null,
  loading: false,
  loadingText: '',
  error: null,
  sidebarOpen: true,
  selectModel: { providerConfigId: '', modelId: '' },
  selectedAgentId: '',
  selectedWorkspace: '',
}

export const chatState = new RuntimeState(defaultChat)
