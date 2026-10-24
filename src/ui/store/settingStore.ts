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
import {
  pickKnownSettings,
  settingsRepo,
  RESERVED_PREFIX,
  SETTINGS_MIGRATED_FROM_KEY,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
} from '@/infrastructure/settingsRepo'
import type { ModelPrice } from '@/domain/pricing'
import type { CompressMode } from '@/domain/ports'
import { DEFAULT_CODE_DISPLAY_SETTINGS } from '@/domain/code-display'
import { DEFAULT_ZOOM } from '@/domain/zoom'

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
  /**
   * 界面缩放倍率（1 = 100%，0.5–2.0）。
   * 落到 webview 原生缩放（Tauri `setZoom`，见 ui/hooks/useZoom.ts），与 fontSize 相互独立：
   * fontSize 只动字号令牌，缩放连图标、间距、窗口内边距一起放大。
   */
  zoomFactor: number
  /**
   * 代码显示（代码块 / 可编辑编辑器 / 差异视图共用一套口径）：主题、字族、字号、行高、行号。
   * 平铺存 app_settings：埋点里 key 就是字段名，比一个嵌套对象好诊断；默认值见
   * src/domain/code-display/index.ts 的 DEFAULT_CODE_DISPLAY_SETTINGS（唯一源）。
   */
  codeThemeMode: 'fixed' | 'follow'
  /** 固定主题 id（CODE_THEMES 的键；'fixed' 档才生效） */
  codeThemeId: string
  /** 代码字号（px，11–20），与界面字号 fontSize 解耦 */
  codeFontSize: number
  /** 字族 id（CODE_FONT_STACKS 的键） */
  codeFontFamily: string
  /** 行高倍率（1.2–2.0） */
  codeLineHeight: number
  /** 连字（JetBrains Mono / Fira Code 才有区别） */
  codeFontLigatures: boolean
  /** 代码块默认显示行号（调用点显式传值时以调用点为准） */
  codeShowLineNumbers: boolean
  /**
   * 主题色（品牌色）：'' = 内置默认；'#rrggbb' = 用户选的色。
   * 亮 / 暗两档由 theme.scss 与 accentPalette.ts 派生。
   */
  accentColor: string
  /** 隐藏 toolCall 思考过程消息 */
  hideToolCallThink: boolean
  /** 权限三态表：allow | ask | deny */
  permissions: PermissionMap
  /** 沙盒模式：on 写隔离 / off 裸跑 / readonly 只读 */
  sandboxMode: SandboxMode
  /** 是否在系统提示词中包含环境信息 */
  allowEnvPrompt: boolean
  /**
   * 用户终端用哪种 shell（上次选择；`''` = 从没选过，让 Rust 用默认的 Windows PowerShell）。
   * 取值是稳定 id（`cmd` / `powershell` / `pwsh` / `gitbash`，见 `user_shell/shells.rs`）：
   * `Ctrl + \`` 直接开这一种，菜单里也把它标成「上次使用」。
   * ⚠️ 存 id 而不是可执行文件路径：路径跟着机器变，换台机器就会指向不存在的东西。
   */
  terminalShell: string
  providers: ProviderConfig[]
  /** 搜索供应商（持久化在 app_settings，localStorage 不再保存） */
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
  /** 最大工具调用轮数，防无限循环 */
  maxToolRounds: number
  /** 迭代模式最大重试次数（执行→验证→修复） */
  maxIterations: number
  /** 是否预加载技能元数据 */
  skillMetaPreload: boolean
  /** 快捷输入模板列表 */
  quickInputTemplates: QuickInputTemplate[]
  /** 验证目标快捷输入模板（迭代模式 Goal） */
  goalQuickInputTemplates: QuickInputTemplate[]
  /** 会话侧边栏分组方式 */
  sessionGroupType: SessionGroupType
  /**
   * 已置顶的分组 key（按维度分开存）：分组是虚拟的，置顶只能住在设置里；
   * UNGROUPED_KEY 两个维度共用同一个字面量，混一份会互相串。
   */
  pinnedSessionGroups: Record<SessionGroupType, string[]>
  /** 是否对上传图片自动执行 vision_analyze */
  imageVisionAnalyzeOptimize: boolean
  /**
   * 图片预览是否**打开就识别文字**（只做 OCR，不做视觉识别）。
   * false（默认）= 打开预览不跑推理，点工具栏「识别文字」才识别 —— OCR 是秒级 CPU 密集操作，
   * 不该在用户只是「看一眼图」时自动扣掉。识别结果两层缓存（进程内 memo + Rust 内容指纹落盘），
   * 同一张图只会真跑一次。
   */
  imageOcrAutoPreview: boolean
  /** 知识库默认检索数量 */
  ragDefaultTopK: number
  /**
   * 长期记忆开关 —— 固定启用（界面已无开关）。还留着这个键是因为 Rust 侧按同名键读取，
   * 老版本可能写过 false，水合时会被纠正为 true。
   */
  memoryEnabled: boolean
  /** 普通记忆注入条数；永久记忆不受它影响 */
  memoryNormalTopK: number
  /**
   * 记忆再蒸馏的逃生开关（默认开，界面无控件）：候选条数越线时后台合并旧条目，旧条停用不删。
   * 它不是 memoryEnabled 那种「水合时纠正」的键：用户想关就是真关，不做 fixup。
   */
  memoryRedistillEnabled: boolean
  /** 是否用 AI 生成会话标题；关掉后直接截取首条用户消息 */
  aiGenerateTitle: boolean
  /**
   * 上下文压缩方式：ai = LLM 总结（省 token 但慢、花钱）；raw = 本地渲染（零消耗，保留正文）。
   */
  contextCompressMode: CompressMode
  /** 上下文窗口（token），即 token 环的 100% 口径；桌面端可编辑，CLI 只读 */
  contextWindowTokens: number
  /** 是否启用「打开编辑器」功能 */
  editorOpenEnabled: boolean
  /**
   * HTML 预览：是否允许页面脚本执行（iframe sandbox 给 `allow-scripts`）。
   * 全局设置而不是面板内开关：用户实测反馈——每次打开文件都要重新勾一遍不现实。
   */
  htmlPreviewAllowScripts: boolean
  /**
   * HTML 预览：是否允许外部脚本与网络请求（CDN 上的库 / fetch）。
   * 依赖 `htmlPreviewAllowScripts`：脚本都不跑时它无意义。
   */
  htmlPreviewAllowRemote: boolean
  /** 编辑器配置列表（可配多个，如 vscode、idea） */
  editorOpenConfigs: EditorOpenConfig[]
  /** 默认编辑器配置 id */
  editorOpenDefaultId: string
  /**
   * 右侧面板的网页标签切走后多久销毁原生视图（秒，0 = 不销毁）。
   * 销毁只省内存，切回来会重新加载当前地址（页面内状态丢失）——「切标签不卸载」的例外，取舍见
   * `side-panel/browser/view-policy.ts`。
   */
  browserSleepAfterSec: number
  /** 同时存活的网页视图上限（0 = 不限）：超出时销毁最久没看的**隐藏中**视图 */
  browserMaxViews: number
  /** AI 回复完成或需用户选择时，窗口未激活则强制置前 */
  forceWindowActive: boolean
  /**
   * `user_choice` 提问在**会话内**回答（消息列表下方），不弹窗打断 —— 默认开。
   * 关 = 回到跨会话模态框（引导用户立即解决）。仅决定**新到的**交互怎么呈现，切换不影响已挂起的项。
   */
  userChoiceInline: boolean
  /**
   * 权限授权在**会话内**回答 —— 默认关（仍弹窗立即确认）。语义同上，仅影响新到的交互。
   */
  authorizationInline: boolean
  /** 关闭窗口时隐藏到托盘；关 = 直接退进程（托盘不可用也回退成这个） */
  closeToTray: boolean
  /** AI 回复完成且窗口未显示 / 未激活时是否提醒（任务栏闪烁 + 托盘提示） */
  notifyOnComplete: boolean
  /** 诊断埋点开关（默认关；仅本地采集，不外发） */
  telemetryEnabled: boolean
  /**
   * 模型单价表，键为 priceKey(providerConfigId, modelId)；未配置的模型回退内置价目表。
   * 单位：每 1,000,000 tokens 的金额。
   */
  modelPricing: Record<string, ModelPrice>
  /** 费用币种（仅影响展示；默认人民币） */
  usageCurrency: 'USD' | 'CNY'
}

const defaultSettings: SettingsStore = {
  language: 'zh-CN',
  theme: 'system',
  fontSize: 'medium',
  zoomFactor: DEFAULT_ZOOM,
  // 代码显示：默认 = 改造前的外观（固定 virlen-dark、13px、Consolas 优先、无连字、带行号）
  ...DEFAULT_CODE_DISPLAY_SETTINGS,
  accentColor: '',
  hideToolCallThink: true,
  permissions: withDefaultPermissions(undefined),
  sandboxMode: 'on',
  allowEnvPrompt: true,
  // 终端类型：空 = 没选过（Rust 默认 powershell）
  terminalShell: '',
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
  pinnedSessionGroups: { agent: [], workspace: [] },
  imageVisionAnalyzeOptimize: true,
  // 图片预览：默认不显示识别文字，也不自动识别（点工具栏「识别文字」才跑）
  imageOcrAutoPreview: false,
  ragDefaultTopK: 5,
  memoryEnabled: true,
  memoryNormalTopK: 20,
  // 再蒸馏：默认开、不进 UI（见 memoryRedistillEnabled）
  memoryRedistillEnabled: true,
  aiGenerateTitle: true,
  contextCompressMode: 'ai',
  contextWindowTokens: 200000,
  editorOpenEnabled: true,
  // ⚠️ 两个预览安全开关都必须默认 false：开脚本等于允许页面代码在本机执行
  htmlPreviewAllowScripts: false,
  htmlPreviewAllowRemote: false,
  editorOpenConfigs: [],
  editorOpenDefaultId: '',
  // 网页标签：切走 20 秒后释放原生视图；同时最多留 10 个
  browserSleepAfterSec: 20,
  browserMaxViews: 10,
  forceWindowActive: false,
  // 交互呈现：提问默认「不打断」（会话内卡片），权限授权默认仍弹窗（马上确认更安全）
  userChoiceInline: true,
  authorizationInline: false,
  closeToTray: true,
  notifyOnComplete: true,
  telemetryEnabled: false,
  modelPricing: {},
  usageCurrency: 'CNY',
}

/**
 * 写给 StorageState 的只读 localStorage 适配器：权威源是 app_settings 表。
 * getItem 仍读真 localStorage（同步初值）；setItem 在 Tauri 下有意丢弃，非 Tauri 照写。
 */
const settingsLocalStorage: Storage = {
  get length() {
    return localStorage.length
  },
  clear: () => localStorage.clear(),
  getItem: (key: string) => localStorage.getItem(key),
  key: (index: number) => localStorage.key(index),
  removeItem: (key: string) => localStorage.removeItem(key),
  setItem: (key: string, value: string) => {
    // Tauri（有表）：有意丢弃，不产生第二份权威源，也不把 apiKey 写进 localStorage
    if (settingsRepo.isAvailable()) return
    localStorage.setItem(key, value)
  },
}

export const settingsState = new StorageState(
  'virlen-settings',
  defaultSettings,
  1000,
  settingsLocalStorage,
).mixins({
  /** 该模型是否可用（供应商已启用且在它列表里） */
  availableModel(model: { providerConfigId: string; modelId: string } | null) {
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

// 埋点：任意设置项变更。敏感键打码；provider / 单价表只报数量，避免泄漏。
settingsState.onChange = (key, oldValue, newValue) => {
  // telemetryEnabled 由 telemetry.toggle 记录，此处跳过避免不对称
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
    // 单价表只需条数：整表上报会把埋点体积顶爆，且无诊断价值
    key === 'modelPricing'
  ) {
    return value && typeof value === 'object'
      ? { count: Object.keys(value as object).length }
      : value
  }
  return value
}

// ── 打开编辑器：一次性迁移旧版单命令 editorOpenCommand → editorOpenConfigs ──
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
    // 迁移结果随首启 import 进表，不再写回 localStorage
  }
  // 清掉旧字段（类型未声明）
  const raw = settingsState.value as any
  if ('editorOpenCommand' in raw) {
    delete raw.editorOpenCommand
  }
} catch {
  // 非浏览器环境忽略
}

// ── 权限迁移：旧 commandApprovalMode（全局枚举）→ 新 permissions（各三态） ──
// 迁移后删旧字段，避免与新模型并存（新用户无旧值 → 用注册表默认）。
try {
  const raw = settingsState.value as any
  const legacy = raw.commandApprovalMode as string | undefined
  const migrated = migrateApprovalMode(legacy)
  if (migrated && !localStorage.getItem('virlen-permissions-migrated')) {
    // 以旧枚举为准，其余项按默认值补齐
    settingsState.value.permissions = {
      ...withDefaultPermissions(settingsState.value.permissions),
      ...migrated,
    }
    // 迁移结果随首启 import 进表，不再写回 localStorage
    localStorage.setItem('virlen-permissions-migrated', '1')
  }
  if ('commandApprovalMode' in raw) {
    delete raw.commandApprovalMode
  }
} catch {
  // 非浏览器环境忽略
}

/** 解析默认工作目录（Tauri 取用户文档目录），结果缓存 */
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

/** 应用启动时：解析默认工作目录 */
export async function initDefaultWorkspace(): Promise<void> {
  if (!settingsState.value.defaultWorkspace) {
    settingsState.setValue('defaultWorkspace', await resolveDefaultWorkspace())
  }
}

// 配置下沉：设置 → Rust 侧 app_settings。权威源是表，localStorage 只作同步初值；
// 键名与 SettingsStore 字段同名同层，不建映射表（避免字段漂移）。
export const SETTINGS_STORAGE_KEY = '_storage_state_virlen-settings'

/** SettingsStore 认识的键（用于过滤表里的遗留键） */
const SETTINGS_KNOWN_KEYS: string[] = Object.keys(defaultSettings)

/** 落库 debounce（连续拖动开关只写一次） */
const SETTINGS_SAVE_DEBOUNCE_MS = 400

/** 待落库的键值（只累积用户改过的键，不整份覆盖） */
let pendingSettings: Record<string, unknown> = {}
let saveTimer: ReturnType<typeof setTimeout> | null = null
let persistInstalled = false
/** 水合期间不把刚读出来的值再写回表 */
let hydrating = false

/** 当前设置的浅拷贝（只含已知键） */
function snapshotSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SETTINGS_KNOWN_KEYS) {
    out[key] = (settingsState.value as unknown as Record<string, unknown>)[key]
  }
  return out
}

/** 落库待写设置（debounce 到期 / 退出前） */
function flushPendingSettings(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const entries = pendingSettings
  pendingSettings = {}
  if (Object.keys(entries).length === 0) return
  settingsRepo.save(entries).catch((e) => {
    console.warn('[settings] 写入 Rust 侧 app_settings 失败:', e)
  })
}

/** 退出前立刻落库（否则 debounce 未触发会丢最后一次改动） */
export function flushSettingsPersist(): void {
  flushPendingSettings()
}

/** 挂上「设置变更 → 落库」：保留既有 onChange（埋点）并链式调用 */
function installSettingsPersist(): void {
  if (persistInstalled) return
  persistInstalled = true
  const previous = settingsState.onChange
  settingsState.onChange = (key, oldValue, newValue) => {
    previous?.(key, oldValue, newValue)
    if (hydrating) return
    if (typeof key !== 'string' || key.startsWith(RESERVED_PREFIX)) return
    pendingSettings[key] = newValue
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushPendingSettings, SETTINGS_SAVE_DEBOUNCE_MS)
  }
}

/**
 * 从 app_settings 水合设置（幂等；非 Tauri 直接返回）。
 * 表非空 → 以表为准覆盖；表为空 → 把当前设置整份导入（老用户升级无感）。
 * 必须在 init() 里早于 i18n / 工作目录 / 会话加载执行。
 */
export async function hydrateSettings(): Promise<void> {
  if (!settingsRepo.isAvailable()) return
  /** 表已就绪才允许清理本地副本 */
  let authorityReady = false
  try {
    const stored = await settingsRepo.loadAll()
    if (Object.keys(stored).length === 0) {
      // 首启：把现有设置导入表
      authorityReady = await settingsRepo.importIfEmpty({
        ...snapshotSettings(),
        [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION,
        [SETTINGS_MIGRATED_FROM_KEY]: 'localStorage',
      })
    } else {
      const known = pickKnownSettings(stored, SETTINGS_KNOWN_KEYS)
      // 记忆固定启用：老版本可能写过 false，这里纠正为 true 并落库（Rust 按同名键判定）
      const fixups: Record<string, unknown> = {}
      if (known.memoryEnabled === false) fixups.memoryEnabled = true
      if (Object.keys(fixups).length > 0) Object.assign(known, fixups)
      hydrating = true
      try {
        settingsState.set(known as Partial<SettingsStore>)
      } finally {
        hydrating = false
      }
      authorityReady = true
      if (Object.keys(fixups).length > 0) {
        settingsRepo
          .save(fixups)
          .catch((e) => console.warn('[settings] 纠正记忆开关失败:', e))
      }
    }
  } catch (e) {
    console.warn('[settings] 读取 Rust 侧 app_settings 失败，继续使用本地设置:', e)
    return
  }
  // 表已就绪 → 清掉老版本遗留的设置副本（表不可用时保留兜底）
  if (authorityReady) dropLegacyLocalSnapshot()
  installSettingsPersist()
}

/**
 * 删掉老版本遗留在 localStorage 的设置副本。只在表已就绪时调用：表不可用时保留副本作兜底。
 */
function dropLegacyLocalSnapshot(): void {
  try {
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
  } catch {
    // 非浏览器环境忽略
  }
}

/** 代码显示迁移的完成标记（与 virlen-permissions-migrated 同一套做法） */
const CODE_DISPLAY_MIGRATED_KEY = 'virlen-code-display-migrated'

/**
 * 代码显示设置的首次迁移：把旧的「界面字号」三档折算成**独立**的代码字号。
 *
 * 为什么需要：改造前代码块字号是 fontSize 的派生值（small 12 / medium 13 / large 14）。
 * 不迁移的话，原本选「小」的用户升级后会从 12px 变成默认 13px —— 纯视觉回归。
 * 只折算一次；此后两者彻底解耦，用户再改界面字号不会动代码字号（这正是本次改造的目的）。
 *
 * 必须在 hydrateSettings() 之后调（见 src/main.ts）：字号档位的权威值在 app_settings 表里，
 * 早于水合会把默认的 medium 当成用户选择、折成 13px 并打上完成标记。
 */
export function migrateCodeDisplaySettings(): void {
  try {
    if (localStorage.getItem(CODE_DISPLAY_MIGRATED_KEY)) return
    const level = settingsState.value.fontSize
    const px = level === 'small' ? 12 : level === 'large' ? 14 : 13
    if (px !== settingsState.value.codeFontSize) {
      settingsState.setValue('codeFontSize', px)
    }
    localStorage.setItem(CODE_DISPLAY_MIGRATED_KEY, '1')
  } catch {
    // 非浏览器环境忽略（不落标记，下次启动再试）
  }
}
