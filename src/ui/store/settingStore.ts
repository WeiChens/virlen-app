import type { ProviderConfig } from '@/types'
import type { SearchProviderConfig } from '@/domain/search/config'
import type { EditorOpenConfig } from '@/domain/editor'
import {
  withDefaultPermissions,
  migrateApprovalMode,
  type PermissionMap,
} from '@/domain/permission'
import StorageState from '@/utils/storageState'
import { track, isSensitiveKey } from '@/utils/telemetry'
import type { ModelPrice } from '@/domain/pricing'
import type { CompressMode } from '@/domain/engine'

export type { EditorOpenConfig }

export type SandboxMode = 'on' | 'off' | 'readonly'
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
  /** 权限三态表：权限 name → allow | ask | deny（终端命令 / 脚本执行） */
  permissions: PermissionMap
  /** 终端命令执行沙盒模式：on 写隔离 / off 裸跑 / readonly 只读 */
  sandboxMode: SandboxMode
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
  /**
   * 是否用 AI 生成会话标题（默认开启）。
   * 关闭后不再发起标题生成的 LLM 调用，直接截取首条用户消息作为标题。
   */
  aiGenerateTitle: boolean
  /**
   * 上下文压缩方式（点击 token 环时使用）
   *
   * - `ai`：AI 摘要，一次 LLM 调用把历史总结成一段（最省 token，但慢、要花钱）；
   * - `raw`：正文压缩，本地渲染（毫秒级、零消耗，但保留全部正文、只去掉思考过程并省略超长工具输出）
   */
  contextCompressMode: CompressMode
  /** 是否启用「打开编辑器」功能 */
  editorOpenEnabled: boolean
  /** 编辑器配置列表（可配置多个，如 vscode、idea 等） */
  editorOpenConfigs: EditorOpenConfig[]
  /** 默认使用的编辑器配置 id */
  editorOpenDefaultId: string
  /** 是否在 AI 回复完成或需要用户选择时，若窗口未激活则强制置为活动窗口 */
  forceWindowActive: boolean
  /** 诊断埋点开关（默认关；开启后仅本地采集，不会自动外发） */
  telemetryEnabled: boolean
  /**
   * 模型单价表（用于用量统计的费用估算），键为 `priceKey(providerConfigId, modelId)`，
   * 即 `${providerConfigId}::${modelId}`；未配置的模型回退到内置价目表（`domain/pricing`）。
   * 单位：每 1,000,000 tokens 的金额（币种见 currency）。
   */
  modelPricing: Record<string, ModelPrice>
  /** 费用币种（仅影响展示，与服务商无关；**默认人民币**，可在单价页切换） */
  usageCurrency: 'USD' | 'CNY'
}

const defaultSettings: SettingsStore = {
  language: 'zh-CN',
  theme: 'system',
  fontSize: 'medium',
  hideToolCallThink: true,
  permissions: withDefaultPermissions(undefined),
  sandboxMode: 'on',
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
  maxToolRounds: 100,
  maxIterations: 5,
  skillMetaPreload: false,
  quickInputTemplates: [],
  goalQuickInputTemplates: [],
  sessionGroupType: 'workspace',
  imageVisionAnalyzeOptimize: true,
  ragEnabled: false,
  ragDefaultKnowledgeBaseId: '',
  ragDefaultTopK: 5,
  useRustEngine: true,
  aiGenerateTitle: true,
  contextCompressMode: 'ai',
  editorOpenEnabled: true,
  editorOpenConfigs: [],
  editorOpenDefaultId: '',
  forceWindowActive: false,
  telemetryEnabled: false,
  modelPricing: {},
  usageCurrency: 'CNY',
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

// ── 埋点：任意设置项变更（§12.11 settings.change） ──
// 敏感键整段打码；provider / searchProvider 列表只上报数量，避免 baseUrl/apiKey 泄漏。
settingsState.onChange = (key, oldValue, newValue) => {
  // telemetryEnabled 由 telemetry.toggle 事件记录，此处跳过，避免
  // 「开启时记录 / 关闭时不记录」的不对称（track 在开关关闭时本就是 no-op）。
  if ((key as string) === 'telemetryEnabled') return
  track('settings.change', {
    key,
    old_value: settingChangeValue(key, oldValue),
    new_value: settingChangeValue(key, newValue),
  })
}

function settingChangeValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return '***'
  if (
    key === 'providers' ||
    key === 'searchProviders' ||
    // 单价表只需要条数：整表上报会把埋点体积顶爆，且无诊断价值
    key === 'modelPricing'
  ) {
    return value && typeof value === 'object'
      ? { count: Object.keys(value as object).length }
      : value
  }
  return value
}

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

// ── 权限模块迁移：旧 commandApprovalMode（全局枚举）→ 新 permissions（按权限三态） ──
// 旧值过粗（一个开关管所有命令），现拆成 terminal.normal / install / dangerous +
// script.execute 四类，每类 允许 / 每次弹窗 / 禁止 三态。
// 迁移后删除旧字段，避免与新模型并存造成困惑（新用户无旧值 → 用注册表默认）。
try {
  const raw = settingsState.value as any
  const legacy = raw.commandApprovalMode as string | undefined
  const migrated = migrateApprovalMode(legacy)
  if (migrated && !localStorage.getItem('virlen-permissions-migrated')) {
    // 以旧枚举为准，其余项按注册表默认值补齐
    settingsState.value.permissions = {
      ...withDefaultPermissions(settingsState.value.permissions),
      ...migrated,
    }
    localStorage.setItem(
      '_storage_state_virlen-settings',
      JSON.stringify(settingsState.value),
    )
    localStorage.setItem('virlen-permissions-migrated', '1')
  }
  if ('commandApprovalMode' in raw) {
    delete raw.commandApprovalMode
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
