/**
 * about-settings — 设置 → 关于：应用名、版本号、Tauri 版本与检查更新。
 * 内容来自原窗口状态栏的「关于」弹窗：入口并入设置后弹窗下线，逻辑搬到这里。
 */
import { useEffect, useState } from 'react'
import { AppLogoSvg, appName } from '@/ui/constants'
import { getName, getTauriVersion, getVersion } from '@tauri-apps/api/app'
import { t } from '@/ui/i18n'
import { checkUpdate } from '@/services/update-service'
import updateEvent from '@/events/updateEvent'
import { showToast } from '@/ui/components/shared/Toast'
import './about-settings.scss'

function AboutSettings() {
  const [version, setVersion] = useState<string>('x.x.x')
  const [name, setName] = useState<string>(appName)
  const [tauriVersion, setTauriVersion] = useState<string>('x.x.x')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    getVersion().then(setVersion)
    getName().then(setName)
    getTauriVersion().then(setTauriVersion)
  }, [])

  async function handleCheckUpdate() {
    if (checking) return
    setChecking(true)
    try {
      const result = await checkUpdate()
      if (result && result.has_update && result.latest_version) {
        updateEvent.emit('showUpdateModal', result)
        return
      }
      showToast(t('已是最新版本'), 2000)
    } catch {
      showToast(t('检查更新失败'), 2500)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="about-settings">
      <div className="about-header">
        <h2 className="section-title">{t('关于')}</h2>
      </div>
      <div className="about-body">
        <div className="about-logo">
          <AppLogoSvg size={150} />
        </div>
        <div className="about-name">{name}</div>
        <div className="about-rows">
          <div className="about-row">
            <span className="about-row-label">{t('版本')}</span>
            <span className="about-row-value">{version}</span>
            <button
              className="about-link"
              onClick={handleCheckUpdate}
              disabled={checking}>
              {checking ? t('检查中...') : t('检查更新')}
            </button>
          </div>
          <div className="about-row">
            <span className="about-row-label">{t('Tauri 版本')}</span>
            <span className="about-row-value">{tauriVersion}</span>
          </div>
          <div className="about-row">
            <span className="about-row-label">{t('作者')}</span>
            <span className="about-row-value">WEI</span>
          </div>
          <div className="about-row">
            <span className="about-row-label">{t('邮箱')}</span>
            <span className="about-row-value">2016645682@qq.com</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AboutSettings
