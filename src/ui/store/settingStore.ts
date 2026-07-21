import type { ProviderConfig } from '@/types'
import type { SearchProviderConfig } from '@/domain/search/config'
import StorageState from '@/utils/storageState'

export type CommandApprovalMode = 'all' | 'risky' | 'install' | 'none'
export type SessionGroupType = 'agent' | 'workspace'

/** 快捷输入模板 */
export interface QuickInputTemplate {
  id: string
  /** 模板内容文本 */
  text: string
}

export interface SettingsStore {
  language: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  fontSize: 'small' | 'medium' | 'large'
  /** 隐藏 toolCall 思考过程消息 */
  hideToolCallThink: boolean
  /** 命令执行弹窗授权模式 */
  commandApprovalMode: CommandApprovalMode
  /** 是否在系统提示词中包含环境信息 */
  allowEnvPrompt: boolean
  providers: ProviderConfig[]
  /** 搜索供应商配置列表（持久化到 localStorage） */
  searchProviders: SearchProviderConfig[]
  /** 默认搜索供应商 id */
  defaultSearchProviderId: string
  /** 默认系统提示词，创建新会话时沿用 */
  defaultSystemPrompt: string
  defaultSelectModel: {
    providerConfigId: string
    modelId: string
  }
  /** 全局 maxTokens，每次 API 调用时传入 */
  maxTokens: number
  /** 默认工作目录 */
  defaultWorkspace: string
  /** 最大工具调用轮数，防止无限循环 */
  maxToolRounds: number
  /** 是否预加载技能元数据（启动时拉取技能描述、参数等信息） */
  skillMetaPreload: boolean
  /** 快捷输入模板列表 */
  quickInputTemplates: QuickInputTemplate[]
  /** 会话侧边栏分组方式 */
  sessionGroupType: SessionGroupType
  /** 是否对上传的图片自动执行 vision_analyze 提取结构化数据 */
  imageVisionAnalyzeOptimize: boolean
  /** RAG 知识库配置 */
  ragEnabled: boolean
  /** 默认知识库 ID */
  ragDefaultKnowledgeBaseId: string
  /** 默认检索数量 */
  ragDefaultTopK: number
}

const defaultSettings: SettingsStore = {
  language: 'zh-CN',
  theme: 'system',
  fontSize: 'medium',
  hideToolCallThink: true,
  commandApprovalMode: 'install',
  allowEnvPrompt: true,
  providers: [],
  searchProviders: [],
  defaultSearchProviderId: '',
  defaultSystemPrompt: '',
  defaultSelectModel: {
    providerConfigId: '',
    modelId: '',
  },
  maxTokens: 32768,
  defaultWorkspace: '',
  maxToolRounds: 30,
  skillMetaPreload: false,
  quickInputTemplates: [],
  sessionGroupType: 'agent',
  imageVisionAnalyzeOptimize: true,
  ragEnabled: false,
  ragDefaultKnowledgeBaseId: '',
  ragDefaultTopK: 5,
}

export const settingsState = new StorageState(
  'virlen-settings',
  defaultSettings,
).mixins({
  /**
   * 是否可使用的模型
   * @param model
   * @returns
   */
  availableModel(model: { providerConfigId: string; modelId: string }) {
    if (!model) return false
    if (!model.providerConfigId || !model.modelId) return false
    return settingsState.value.providers.some((p) => {
      if (!p.enabled) return false
      return (
        p.id === model.providerConfigId &&
        p.models.some((m) => m === model.modelId)
      )
    })
  },
  getAvailableModel() {
    if (settingsState.availableModel(settingsState.value.defaultSelectModel)) {
      return settingsState.value.defaultSelectModel
    }
    for (const provider of settingsState.value.providers) {
      if (!provider.enabled) continue
      for (const model of provider.models) {
        settingsState.value.defaultSelectModel = {
          providerConfigId: provider.id,
          modelId: model,
        }
        return { providerConfigId: provider.id, modelId: model }
      }
    }

    return null
  },
})

/**
 * 解析默认工作目录
 * Tauri 环境下返回用户的文档目录，否则返回空字符串。
 * 结果缓存，只解析一次。
 */
let _resolvedWorkspace: string | null = null

export async function resolveDefaultWorkspace(): Promise<string> {
  if (_resolvedWorkspace !== null) return _resolvedWorkspace
  try {
    const { documentDir } = await import('@tauri-apps/api/path')
    _resolvedWorkspace = await documentDir()
  } catch {
    // 非 Tauri 环境或获取失败
    _resolvedWorkspace = ''
  }
  return _resolvedWorkspace
}

/** 应用启动时调用：解析默认工作目录 */
export async function initDefaultWorkspace(): Promise<void> {
  if (!settingsState.value.defaultWorkspace) {
    settingsState.setValue('defaultWorkspace', await resolveDefaultWorkspace())
  }
}
