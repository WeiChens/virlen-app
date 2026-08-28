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

/** 打开编辑器配置 */
export interface EditorOpenConfig {
  id: string
  /** 配置名称，如 VS Code / IntelliJ IDEA */
  name: string
  /** 打开命令模板，支持 ${filePath} ${line} 占位符，如 code -g "${filePath}:${line}" */
  command: string
  createdAt: number
  updatedAt: number
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
  /** 迭代模式最大重试次数（执行→验证→修复） */
  maxIterations: number
  /** 是否预加载技能元数据（启动时拉取技能描述、参数等信息） */
  skillMetaPreload: boolean
  /** 快捷输入模板列表 */
  quickInputTemplates: QuickInputTemplate[]
  /** 验证目标快捷输入模板列表（迭代模式 Goal） */
  goalQuickInputTemplates: QuickInputTemplate[]
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
  /** 是否启用 Rust 原生引擎（默认开启；会话/消息由 Rust SQLite 直落） */
  useRustEngine: boolean
  /** 是否启用「打开编辑器」功能 */
  editorOpenEnabled: boolean
  /** 编辑器配置列表（可配置多个，如 vscode、idea 等） */
  editorOpenConfigs: EditorOpenConfig[]
  /** 默认使用的编辑器配置 id */
  editorOpenDefaultId: string
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
  maxIterations: 5,
  skillMetaPreload: false,
  quickInputTemplates: [],
  goalQuickInputTemplates: [],
  sessionGroupType: 'agent',
  imageVisionAnalyzeOptimize: true,
  ragEnabled: false,
  ragDefaultKnowledgeBaseId: '',
  ragDefaultTopK: 5,
  useRustEngine: true,
  editorOpenEnabled: true,
  editorOpenConfigs: [],
  editorOpenDefaultId: '',
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

// ── Rust 引擎转正一次性迁移（P3 会话持久化） ──
// 老版本 useRustEngine 默认 false 且已被持久化进 localStorage，
// 新默认值 true 无法覆盖已存值。此处一次性强制切换并同步写回，
// 避免老用户升级后仍走 TS 引擎导致消息不落库（数据丢失风险）。
// 迁移完成后用户可自由开关，不再强制。
try {
  if (!localStorage.getItem('virlen-rust-engine-migrated')) {
    if (settingsState.value.useRustEngine === false) {
      settingsState.setValue('useRustEngine', true)
      // 同步写回（setValue 内部是 debounce，立即落盘避免退出丢失）
      localStorage.setItem(
        '_storage_state_virlen-settings',
        JSON.stringify(settingsState.value),
      )
    }
    localStorage.setItem('virlen-rust-engine-migrated', '1')
  }
} catch {
  // 非浏览器环境忽略
}

// ── 打开编辑器：旧版单命令 → 新版多配置 一次性迁移 ──
// 早期版本 editorOpenCommand 为单个命令字符串，现改为 editorOpenConfigs 列表。
// 若已有旧命令且列表为空，将其迁移为默认配置「VS Code」，并设为默认。
try {
  const old = (settingsState.value as any).editorOpenCommand
  if (
    typeof old === 'string' &&
    old.trim() &&
    settingsState.value.editorOpenConfigs.length === 0
  ) {
    const now = Date.now()
    const migrated: EditorOpenConfig = {
      id: `editor-${now}`,
      name: 'VS Code',
      command: old,
      createdAt: now,
      updatedAt: now,
    }
    settingsState.value.editorOpenConfigs = [migrated]
    settingsState.value.editorOpenDefaultId = migrated.id
    localStorage.setItem(
      '_storage_state_virlen-settings',
      JSON.stringify(settingsState.value),
    )
  }
  // 清理旧字段（非枚举属类型定义字段，直接删除避免污染）
  const raw = settingsState.value as any
  if ('editorOpenCommand' in raw) {
    delete raw.editorOpenCommand
    localStorage.setItem(
      '_storage_state_virlen-settings',
      JSON.stringify(settingsState.value),
    )
  }
} catch {
  // 非浏览器环境忽略
}

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
