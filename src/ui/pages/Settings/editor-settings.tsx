/**
 * editor-settings — 打开编辑器配置页：预设（EDITOR_PRESETS，不可修改）在前，自定义在后且可编辑。
 * 点卡片 = 选中为默认编辑器，自定义卡片右上角的编辑图标才进编辑。
 * 命令支持 ${filePath} ${line} ${column} 占位符。
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import type { EditorOpenConfig } from '@/ui/store'
import EditorEditModal from './editor-edit-modal'
import { EDITOR_PRESETS } from '@/domain/editor'
import type { EditorPreset } from '@/domain/editor'
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

  function handleSelectCustom(config: EditorOpenConfig) {
    if (config.id === defaultId) return
    settingsState.setValue('editorOpenDefaultId', config.id)
    showToast(tpl('已切换默认编辑器：$__name__', { name: config.name }))
  }

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
                <button
                  className="template-main"
                  onClick={() => handleSelectPreset(preset)}>
                  <div className="template-header">
                    <span className="template-icon">
                      <img src={preset.iconPath} alt={preset.name} />
                    </span>
                    <span className="template-label">{preset.name}</span>
                  </div>
                </button>
              </div>
            )
          })}
        </div>

        {/* 自定义（保存的数据，显示在后面，与预设留白分隔） */}
        <div className="custom-section">
          <div className="template-grid">
            {customConfigs.map((config) => {
              const isActive = config.id === defaultId
              return (
                <button
                  onClick={() => handleSelectCustom(config)}
                  key={config.id}
                  className={`template-card custom-item has-actions ${isActive ? 'is-active' : ''
                    }`}>
                  <div
                    className="template-main"
                  >
                    <div className="template-header">
                      <span className="template-icon">⚙️</span>
                      <span className="template-label">{config.name}</span>
                    </div>
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
                      {t('编辑')}
                    </button>
                    <button
                      className="template-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteCustom(config)
                      }}
                      title={t('删除')}>
                      <DeleteSvg />
                      {t('删除')}
                    </button>
                  </div>
                </button>
              )
            })}

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
