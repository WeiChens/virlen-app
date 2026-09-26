/**
 * StepWorkdir — 引导第二步：设置默认工作目录
 *
 * 允许用户选择一个文件夹作为默认工作目录，或直接跳过（稍后设置）。
 */
import { useState, useEffect } from 'react'
import { t } from '@/ui/i18n'
import {
  settingsState,
  resolveDefaultWorkspace,
} from '@/ui/store/settingStore'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import './style.scss'

interface Props {
  onNext: () => void
}

function StepWorkdir({ onNext }: Props) {
  const [workdir, setWorkdir] = useState(settingsState.value.defaultWorkspace)
  const [loading, setLoading] = useState(false)

  // 首次挂载时尝试解析默认目录
  useEffect(() => {
    if (!workdir) {
      resolveDefaultWorkspace().then((dir) => {
        if (dir) setWorkdir(dir)
      })
    }
  }, [])

  async function handleSelect() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: workdir || undefined,
      })
      if (selected) {
        setWorkdir(selected.replace(/\\/g, '/'))
      }
    } catch {
      // 非 Tauri 环境忽略
    }
  }

  async function handleConfirm() {
    setLoading(true)
    settingsState.setValue('defaultWorkspace', workdir || '')
    // 等待存储持久化
    await new Promise((r) => setTimeout(r, 100))
    setLoading(false)
    onNext()
  }

  return (
    <div className="setup-workdir">
      <h2>{t('默认工作目录')}</h2>
      <p className="setup-desc">
        {t(
          '选择一个文件夹作为默认工作目录，AI 将在该目录下读写文件、执行命令。',
        )}
      </p>

      <div className="workdir-display">
        <div className="workdir-path">
          <span className="workdir-path-icon">
            {/* 传入 currentColor，使图标随主题色（此处为主色）着色 */}
            <FolderSvg fill="currentColor" />
          </span>
          <span className={'workdir-path-text' + (workdir ? '' : ' is-empty')}>
            {workdir || t('尚未选择目录')}
          </span>
        </div>
      </div>

      <button className="btn-secondary" onClick={handleSelect} type="button">
        {t('选择文件夹')}
      </button>

      <p className="workdir-hint">
        {t('你也可以跳过此步骤，之后在设置中随时修改。')}
      </p>

      <div className="setup-actions">
        <button className="btn-ghost" onClick={() => onNext()} type="button">
          {t('稍后设置')}
        </button>
        <button
          className="btn-primary"
          disabled={loading}
          onClick={handleConfirm}
          type="button">
          {loading ? (
            <span className="btn-loading">
              <span className="btn-spinner" />
              {t('保存中...')}
            </span>
          ) : (
            t('确认，下一步')
          )}
        </button>
      </div>
    </div>
  )
}

export default StepWorkdir
