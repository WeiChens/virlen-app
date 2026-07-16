import { useEffect, useState, useRef } from 'react'
import './UpdateModal.scss'
import RemoveSvg from '@/ui/components/icons/RemoveSvg'
import { t } from '@/ui/i18n'
import { getVersion } from '@tauri-apps/api/app'
import { downloadAndInstall, launchInstaller } from '@/services/download-service'
import type { DownloadProgress } from '@/services/download-service'
import type { ICheckUpdateResponse } from '@/types'

interface Props {
  show: boolean
  updateInfo: ICheckUpdateResponse | null
  onHide: () => void
  /** 当强制更新被取消时调用 */
  onForceCancel?: () => void
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

const UpdateModal = ({ show, updateInfo, onHide, onForceCancel }: Props) => {
  const [visible, setVisible] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')

  // 下载状态
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    status: 'idle',
    loaded: 0,
    total: 0,
    percent: 0,
  })
  const downloadingRef = useRef(false)

  useEffect(() => {
    getVersion().then(setCurrentVersion)
  }, [])

  useEffect(() => {
    if (show) {
      requestAnimationFrame(() => setVisible(true))
    } else {
      setVisible(false)
      // 关闭时重置下载状态
      setDownloading(false)
      setDownloadProgress({ status: 'idle', loaded: 0, total: 0, percent: 0 })
      downloadingRef.current = false
    }
  }, [show])

  if (!show || !updateInfo || !updateInfo.latest_version) return null

  const { latest_version } = updateInfo
  const isForceUpdate = latest_version.update_policy === 'force'
  const isRecommended = latest_version.update_policy === 'recommended'
  const isDownloading = downloadProgress.status === 'downloading'
  const isDone = downloadProgress.status === 'done'
  const isError = downloadProgress.status === 'error'

  async function handleUpdate() {
    if (downloadingRef.current) return
    downloadingRef.current = true
    setDownloading(true)

    const url = latest_version.download.url
    const fileName = latest_version.download.original_name || `Virlen_${latest_version.version}.exe`

    try {
      const filePath = await downloadAndInstall(url, fileName, (progress) => {
        setDownloadProgress({ ...progress })
      })

      // 下载完成 → 启动安装包
      await launchInstaller(filePath)

      // 强制更新 → 安装包启动后关闭应用
      if (isForceUpdate) {
        onForceCancel?.()
      } else {
        onHide()
      }
    } catch (err: any) {
      setDownloadProgress((prev) => ({
        ...prev,
        status: 'error',
        error: err.message || '下载失败',
      }))
    } finally {
      downloadingRef.current = false
    }
  }

  function handleCancel() {
    if (isForceUpdate) {
      onForceCancel?.()
    } else {
      onHide()
    }
  }

  function handleClose() {
    if (isForceUpdate) {
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
          {!isForceUpdate && !isDownloading && (
            <div className="remove" onClick={handleClose}>
              <RemoveSvg fill="var(--accent-color)" />
            </div>
          )}
        </div>

        {isDownloading || isDone ? (
          // ===== 下载进度界面 =====
          <div className="download-section">
            <div className="download-title">
              {isDone ? t('下载完成') : t('正在下载更新...')}
            </div>

            <div className="progress-bar-container">
              <div
                className={`progress-bar-fill ${isDone ? 'done' : ''}`}
                style={{ width: `${Math.min(downloadProgress.percent, 100)}%` }}
              />
            </div>

            <div className="progress-info">
              <span className="progress-percent">{downloadProgress.percent}%</span>
              <span className="progress-size">
                {formatSize(downloadProgress.loaded)}
                {downloadProgress.total > 0 && ` / ${formatSize(downloadProgress.total)}`}
              </span>
            </div>

            {isDone && (
              <div className="download-done-hint">
                {t('正在启动安装程序...')}
              </div>
            )}
          </div>
        ) : isError ? (
          // ===== 下载错误界面 =====
          <div className="download-section">
            <div className="download-error-title">{t('下载失败')}</div>
            <div className="download-error-msg">{downloadProgress.error}</div>
            <div className="actions" style={{ marginTop: 16 }}>
              <button className="btn-update" onClick={handleUpdate}>
                {t('重试')}
              </button>
              <button className="btn-skip" onClick={handleCancel}>
                {t('取消')}
              </button>
            </div>
          </div>
        ) : (
          // ===== 更新提示界面 =====
          <>
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
              <button className={isForceUpdate ? 'btn-force-update' : 'btn-update'} onClick={handleUpdate}>
                {isForceUpdate ? t('立即更新') : t('更新')}
              </button>
              <button className="btn-skip" onClick={handleCancel}>
                {isForceUpdate ? t('退出应用') : t('稍后再说')}
              </button>
            </div>
          </>
        )}
      </div>
      <div className={`mask ${visible ? 'show' : ''}`}></div>
    </div>
  )
}

export default UpdateModal
