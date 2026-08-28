/**
 * editor-service — 打开编辑器服务
 *
 * 负责「选哪个编辑器」的编排：
 *   1. 从 settingsState 读取启用开关 / 配置列表 / 默认配置
 *   2. 解析出当前选中的编辑器配置（默认 → 首个配置 → 首个预设）
 *   3. 根据传入的 EditorCommandParams 调用领域层
 *      （buildEditorCommand / spawnEditorCommand）
 *
 * 类比 search-provider-service.ts 的模式：service 面向 store + domain，UI 不直接碰领域细节。
 */
import { settingsState } from '@/ui/store'
import {
  EDITOR_PRESETS,
  buildEditorCommand,
  spawnEditorCommand,
} from '@/domain/editor'
import type {
  EditorCommandParams,
  EditorOpenConfig,
  SpawnResult,
} from '@/domain/editor'

export interface EditorService {
  /** 「打开编辑器」功能是否启用 */
  isEnabled(): boolean

  /** 获取当前选中的编辑器配置（未启用 / 未配置时返回 undefined） */
  getSelectedConfig(): EditorOpenConfig | undefined

  /** 获取当前选中的编辑器命令模板 */
  getSelectedCommand(): string

  /**
   * 在选中的编辑器中打开文件：
   * 解析选中配置 → buildEditorCommand 构建 → spawnEditorCommand 启动
   */
  openFile(params: EditorCommandParams): Promise<SpawnResult>

  /** 使用指定编辑器配置打开文件（不依赖默认选中项） */
  openWithConfig(
    config: EditorOpenConfig,
    params: EditorCommandParams,
  ): Promise<SpawnResult>
}

class EditorServiceImpl implements EditorService {
  isEnabled(): boolean {
    return settingsState.value.editorOpenEnabled
  }

  /**
   * 解析当前选中的编辑器配置。
   * 优先级：editorOpenDefaultId → 第一个已保存配置 → 第一个预设。
   */
  getSelectedConfig(): EditorOpenConfig | undefined {
    if (!settingsState.value.editorOpenEnabled) return undefined
    const configs = settingsState.value.editorOpenConfigs

    // 1. 默认配置优先
    const defaultId = settingsState.value.editorOpenDefaultId
    if (defaultId) {
      const def = configs.find((c) => c.id === defaultId)
      if (def) return def
    }

    // 2. 无默认 / 默认已失效 → 取第一个已保存配置
    if (configs.length > 0) return configs[0]

    // 3. 完全未配置 → 回退到第一个预设
    const preset = EDITOR_PRESETS[0]
    if (preset) {
      return {
        id: `preset-${preset.name}`,
        name: preset.name,
        command: preset.command,
        createdAt: 0,
        updatedAt: 0,
      }
    }
    return undefined
  }

  getSelectedCommand(): string {
    return this.getSelectedConfig()?.command ?? ''
  }

  async openFile(params: EditorCommandParams): Promise<SpawnResult> {
    const config = this.getSelectedConfig()
    if (!config) {
      return { ok: false, message: 'editor not configured' }
    }
    return spawnEditorCommand(config.command, params)
  }

  async openWithConfig(
    config: EditorOpenConfig,
    params: EditorCommandParams,
  ): Promise<SpawnResult> {
    return spawnEditorCommand(config.command, params)
  }
}

/** 全局打开编辑器服务单例 */
export const editorService: EditorService = new EditorServiceImpl()
