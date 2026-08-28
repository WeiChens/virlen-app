/**
 * editor-edit-modal — 打开编辑器配置的添加/编辑弹窗
 *
 * 两种模式：
 *   1. 添加模式：可传 initialName / initialCommand（来自预设模板），也可完全自定义
 *   2. 编辑模式：传入 initialConfig，回填已有配置
 */
import { useState, useEffect } from 'react'
import Modal from '@/ui/components/shared/Modal'
import type { EditorOpenConfig } from '@/ui/store'
import { t } from '@/ui/i18n'
import { buildEditorCommand } from '@/utils/editorCommand'
import './editor-edit-modal.scss'

interface Props {
  visible: boolean
  onClose: () => void
  onSave: (config: { name: string; command: string }) => void
  /** 添加模式：预填名称（来自预设模板） */
  initialName?: string
  /** 添加模式：预填命令（来自预设模板） */
  initialCommand?: string
  /** 编辑模式：已有配置 */
  initialConfig?: EditorOpenConfig
}

export default function EditorEditModal({
  visible,
  onClose,
  onSave,
  initialName,
  initialCommand,
  initialConfig,
}: Props) {
  const isEdit = !!initialConfig

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')

  useEffect(() => {
    if (!visible) return
    if (isEdit && initialConfig) {
      // —— 编辑模式：回填已有配置 ——
      setName(initialConfig.name)
      setCommand(initialConfig.command)
    } else {
      // —— 添加模式：从预设模板预填（可为空，完全自定义）——
      setName(initialName ?? '')
      setCommand(initialCommand ?? '')
    }
  }, [visible, initialConfig, initialName, initialCommand])

  const isValid = name.trim().length > 0 && command.trim().length > 0

  const handleSave = () => {
    if (!isValid) return
    onSave({ name: name.trim(), command: command.trim() })
  }

  const previewCommand = buildEditorCommand(
    command || 'code -g "${filePath}:${line}"',
    { filePath: '/path/to/file.ts', line: 42, column: 1 },
  )

  return (
    <Modal
      visible={visible}
      title={isEdit ? t('编辑编辑器') : t('添加编辑器')}
      onClose={onClose}
      width={520}
      closeOnClickOutside={false}
      move>
      <div className="editor-edit-form">
        {/* 名称 */}
        <div className="form-group">
          <label>{t('名称')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('例如：VS Code / IDEA')}
            autoComplete="off"
          />
        </div>

        {/* 打开命令 */}
        <div className="form-group">
          <label>{t('打开命令')}</label>
          <input
            type="text"
            className="command-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={`code -g "\${filePath}:\${line}"`}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="command-hint">
            {t(
              '支持 ${filePath}（文件路径）、${line}（行号）、${column}（列号）占位符',
            )}
          </p>
        </div>

        {/* 命令预览 */}
        <div className="command-preview">
          <span className="preview-label">{t('预览')}</span>
          <code className="preview-value">{previewCommand}</code>
        </div>

        {/* 按钮 */}
        <div className="form-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('取消')}
          </button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!isValid}>
            {isEdit ? t('保存') : t('添加')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
