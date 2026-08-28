/**
 * editor-settings — 打开编辑器配置页面
 *
 * 布局：预设列表（EDITOR_PRESETS，不可修改）显示在前面，
 * 自定义编辑器（用户保存的数据）显示在后面、可编辑。
 * 点击卡片 = 选中（设为默认编辑器），自定义卡片右上角 Edit 图标才进入编辑。
 * 支持 ${filePath} ${line} ${column} 占位符。
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import type { EditorOpenConfig } from '@/ui/store'
import EditorEditModal from './editor-edit-modal'
import { EDITOR_PRESETS } from './editor-presets'
import type { EditorPreset } from './editor-presets'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import EditSvg from '@/ui/components/icons/EditSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import './editor-settings.scss'

/** 预设名称集合，用于区分「预设」与「自定义」配置 */
const PRESET_NAMES = EDITOR_PRESETS.map((p) => p.name)

function EditorSettings() {
  const [modalState, setModalState] = useState<
    | { mode: 'add'; name?: string; command?: string }
    | { mode: 'edit'; config: EditorOpenConfig }
    | null
  >(null)

  const s = settingsState.value
  const configs = s.editorOpenConfigs
  const defaultId = s.editorOpenDefaultId
  // 自定义配置 = 非预设名称的配置（预设不可修改，单独展示在前）
  const customConfigs = configs.filter((c) => !PRESET_NAMES.includes(c.name))

  // ==================== 新增（自定义）====================

  function handleSaveNew(config: { name: string; command: string }) {
    const now = Date.now()
    const newConfig: EditorOpenConfig = {
      id: `editor-${now}`,
      name: config.name,
      command: config.command,
      createdAt: now,
      updatedAt: now,
    }
    const updated = [...configs, newConfig]
    settingsState.setValue('editorOpenConfigs', updated)
    // 第一个配置自动设为默认
    if (!settingsState.value.editorOpenDefaultId) {
      settingsState.setValue('editorOpenDefaultId', newConfig.id)
    }
    setModalState(null)
    showToast(tpl('已添加：$__name__', { name: newConfig.name }))
  }

  // ==================== 编辑保存 ====================

  function handleSaveEdit(config: { name: string; command: string }) {
    if (!modalState || modalState.mode !== 'edit') return
    const updated = configs.map((c) =>
      c.id === modalState.config.id
        ? {
          ...c,
          name: config.name,
          command: config.command,
          updatedAt: Date.now(),
        }
        : c,
    )
    settingsState.setValue('editorOpenConfigs', updated)
    setModalState(null)
    showToast(t('已保存'))
  }

  // ==================== 点击预设 = 选中（预设命令不可修改）====================

  function handleSelectPreset(preset: EditorPreset) {
    const existing = configs.find((c) => c.name === preset.name)
    if (existing) {
      if (existing.id === defaultId) return
      settingsState.setValue('editorOpenDefaultId', existing.id)
      showToast(tpl('已切换默认编辑器：$__name__', { name: existing.name }))
    } else {
      const now = Date.now()
      const newConfig: EditorOpenConfig = {
        id: `editor-${now}`,
        name: preset.name,
        command: preset.command,
        createdAt: now,
        updatedAt: now,
      }
      settingsState.setValue('editorOpenConfigs', [...configs, newConfig])
      settingsState.setValue('editorOpenDefaultId', newConfig.id)
      showToast(tpl('已切换默认编辑器：$__name__', { name: newConfig.name }))
    }
  }

  // ==================== 点击自定义 = 选中 ====================

  function handleSelectCustom(config: EditorOpenConfig) {
    if (config.id === defaultId) return
    settingsState.setValue('editorOpenDefaultId', config.id)
    showToast(tpl('已切换默认编辑器：$__name__', { name: config.name }))
  }

  // ==================== 删除自定义 ====================

  async function handleDeleteCustom(config: EditorOpenConfig) {
    const flag = await MessageBox.warn(
      t('删除编辑器'),
      t('确定要删除这个编辑器配置吗？此操作无法撤销'),
    )
    if (!flag) return

    const updated = configs.filter((c) => c.id !== config.id)
    settingsState.setValue('editorOpenConfigs', updated)

    // 删除默认项后自动切换到第一个配置（或清空）
    if (defaultId === config.id) {
      if (updated.length > 0) {
        settingsState.setValue('editorOpenDefaultId', updated[0].id)
      } else {
        settingsState.setValue('editorOpenDefaultId', '')
      }
    }
    showToast(t('已删除'))
  }

  // ==================== 渲染 ====================

  return (
    <div className="editor-settings">
      <div className="add-section">
        <h3>{t('配置编辑器')}</h3>
        <p className="add-hint">{t('选择常用编辑器预设，或自定义命令模板')}</p>

        {/* 预设（不可修改） */}
        <div className="template-grid">
          {EDITOR_PRESETS.map((preset) => {
            const config = configs.find((c) => c.name === preset.name)
            const isActive = config ? config.id === defaultId : false
            return (
              <div
                key={preset.name}
                className={`template-card ${isActive ? 'is-active' : ''}`}>
                {/* 主体：点击 = 选中 */}
                <button
                  className="template-main"
                  onClick={() => handleSelectPreset(preset)}>
                  <div className="template-header">
                    <span className="template-icon">
                      <img src={preset.iconPath} alt={preset.name} />
                    </span>
                    <span className="template-label">{preset.name}</span>
                  </div>
                  {/* <code className="template-desc">{preset.command}</code> */}
                </button>
              </div>
            )
          })}
        </div>

        {/* 自定义（保存的数据，显示在后面，与预设留白分隔） */}
        <div className="custom-section">
          <div className="template-grid">
            {/* 已保存的自定义 */}
            {customConfigs.map((config) => {
              const isActive = config.id === defaultId
              return (
                <button
                  onClick={() => handleSelectCustom(config)}
                  key={config.id}
                  className={`template-card custom-item has-actions ${isActive ? 'is-active' : ''
                    }`}>
                  {/* 主体：点击 = 选中 */}
                  <div
                    className="template-main"
                  >
                    <div className="template-header">
                      <span className="template-icon">⚙️</span>
                      <span className="template-label">{config.name}</span>
                    </div>
                    {/* <code className="template-desc">{config.command}</code> */}
                  </div>
                  <div className='actions-list'>
                    <button
                      className="template-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setModalState({ mode: 'edit', config })
                      }}
                      title={t('编辑')}>
                      <EditSvg />
                      编辑
                    </button>
                    {/* 右上角 Delete 图标：点击 = 删除 */}
                    <button
                      className="template-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteCustom(config)
                      }}
                      title={t('删除')}>
                      <DeleteSvg />
                      删除
                    </button>
                  </div>
                </button>
              )
            })}

            {/* 新增自定义（显示在最最后面） */}
            <div className="template-card custom">
              <button
                className="template-main"
                onClick={() => setModalState({ mode: 'add' })}>
                <div className="template-header">
                  <span className="template-icon">⚙️</span>
                  <span className="template-label">{t('自定义')}</span>
                </div>
                <span className="template-desc">
                  {t('手动输入命令模板')}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div >

      {/* 弹窗 */}
      < EditorEditModal
        visible={!!modalState
        }
        onClose={() => setModalState(null)}
        onSave={modalState?.mode === 'edit' ? handleSaveEdit : handleSaveNew}
        initialConfig={
          modalState?.mode === 'edit' ? modalState.config : undefined
        }
        initialName={modalState?.mode === 'add' ? modalState.name : undefined}
        initialCommand={
          modalState?.mode === 'add' ? modalState.command : undefined
        }
      />
    </div >
  )
}

export default observer(EditorSettings)
