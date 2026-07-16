import { useEffect, useState } from 'react'
import './UpdateModal.scss'
import RemoveSvg from '@/ui/components/icons/RemoveSvg'
import { t } from '@/ui/i18n'
import { getVersion } from '@tauri-apps/api/app'
import type { ICheckUpdateResponse } from '@/types'

interface Props {
  show: boolean
  updateInfo: ICheckUpdateResponse | null
  onHide: () => void
  /** 当强制更新被取消时调用 */
  onForceCancel?: () => void
}

const UpdateModal = ({ show, updateInfo, onHide, onForceCancel }: Props) => {
  const [visible, setVisible] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')

  useEffect(() => {
    // 获取当前版本号
    getVersion().then(setCurrentVersion)
  }, [])

  useEffect(() => {
    if (show) {
      // 延迟一点点让动画生效
      requestAnimationFrame(() => setVisible(true))
    } else {
      setVisible(false)
    }
  }, [show])

  if (!show || !updateInfo || !updateInfo.latest_version) return null

  const { latest_version } = updateInfo
  const isForceUpdate = latest_version.update_policy === 'force'
  const isRecommended = latest_version.update_policy === 'recommended'

  function getButtonClass(): string {
    if (isForceUpdate) return 'btn-force-update'
    return 'btn-update'
  }

  function getButtonText(): string {
    if (isForceUpdate) return t('立即更新')
    return t('更新')
  }

  async function handleUpdate() {
    // 使用 Tauri 的 opener 打开下载链接
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(latest_version.download.url)
    } catch {
      // 降级：使用 window.open
      window.open(latest_version.download.url, '_blank')
    }
    onHide()
  }

  function handleCancel() {
    if (isForceUpdate) {
      // 强制更新取消 → 关闭应用
      onForceCancel?.()
    } else {
      onHide()
    }
  }

  function handleClose() {
    if (isForceUpdate) {
      // 强制更新 → 关闭按钮也触发关闭应用
      onForceCancel?.()
    } else {
      onHide()
    }
  }

  return (
    <div className="UpdateModal-component">
      <div className={`UpdateModal ${visible ? 'show' : ''}`}>
        <div className="top">
          <div className="title">
            <span>{t('版本更新')}</span>
          </div>
          {!isForceUpdate && (
            <div className="remove" onClick={handleClose}>
              <RemoveSvg fill="var(--accent-color)" />
            </div>
          )}
        </div>

        <div className="header">
          <div className="new-version-badge">
            {t('发现新版本')} v{latest_version.version}
          </div>
          <div className="version-label">
            {t('当前版本')}: v{currentVersion || '...'}
          </div>
          {isForceUpdate && (
            <div
              style={{
                color: '#e74c3c',
                fontSize: '13px',
                marginTop: '8px',
              }}>
              {t('此版本为强制更新，请升级后继续使用')}
            </div>
          )}
          {isRecommended && (
            <div
              style={{
                color: '#f39c12',
                fontSize: '13px',
                marginTop: '8px',
              }}>
              {t('建议更新至最新版本，获得更好的体验')}
            </div>
          )}
        </div>

        <div className="changelog-section">
          <div className="changelog-title">{t('更新日志')}</div>
          <div className="changelog-content">{latest_version.changelog}</div>
        </div>

        <div className="actions">
          {!isForceUpdate && (
            <button className="btn-skip" onClick={handleCancel}>
              {t('稍后再说')}
            </button>
          )}
          <button className={getButtonClass()} onClick={handleUpdate}>
            {getButtonText()}
          </button>

          {isForceUpdate && (
            <button className="btn-skip" onClick={handleCancel}>
              {t('退出应用')}
            </button>
          )}
        </div>
      </div>
      <div className={`mask ${visible ? 'show' : ''}`}></div>
    </div>
  )
}

export default UpdateModal
