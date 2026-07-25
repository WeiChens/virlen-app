import { useEffect, useState } from 'react'
import './AboutModal.scss'
import RemoveSvg from '@/ui/components/icons/RemoveSvg'

import { appLogo, AppLogoSvg, appName } from '@/ui/constants'
import { getName, getTauriVersion, getVersion } from '@tauri-apps/api/app'
import { t } from '@/ui/i18n'
import { checkUpdate } from '@/services/update-service'
import updateEvent from '@/events/updateEvent'
// import { useI18n } from '@/i18n'
interface Props {
  show: boolean
  onHide: () => void
}

const AboutModal = ({ show, onHide }: Props) => {
  const [version, setVersion] = useState<string>('x.x.x')
  const [name, setName] = useState<string>(appName)
  const [tauriVersion, setTauriVersion] = useState<string>('x.x.x')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    getVersion().then((v) => {
      setVersion(v)
    })
    getName().then((v) => {
      setName(v)
    })
    getTauriVersion().then((v) => {
      setTauriVersion(v)
    })
  }, [])

  async function handleCheckUpdate() {
    if (checking) return
    setChecking(true)
    try {
      const result = await checkUpdate()
      if (result && result.has_update && result.latest_version) {
        onHide() // 关闭关于弹窗
        updateEvent.emit('showUpdateModal', result)
      } else {
        // 没有新版本，使用 Toast 提示？这里简单用 alert 或 console
        // 实际上可以用 Toast，但需要引入 useToast
        // 为简单起见，使用 alert
        alert(t('已是最新版本'))
      }
    } catch {
      alert(t('检查更新失败'))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="AboutModal-component">
      <div className={`AboutModal ${show ? 'show' : ''}`}>
        <div className="top">
          <div className="title">
            <span>{t('关于')}</span>
          </div>
          <div className="remove" onClick={onHide}>
            <RemoveSvg fill="var(--accent-color)" />
          </div>
        </div>
        <div className="center-box">
          <div className="logo">
            {show && (
              // <img draggable={false} src={appLogo} width={150} height={150} />
              <AppLogoSvg size={150} />
            )}
          </div>
          <div className="span">
            <div className="name">{name}</div>
            <div className="span version-line">
              {t('版本')}：{version}
              <button
                className="check-update-link"
                onClick={handleCheckUpdate}
                disabled={checking}>
                {checking ? t('检查中...') : t('检查更新')}
              </button>
            </div>
            <div className="span">
              {t('Tauri 版本')}：{tauriVersion}
            </div>
            <div className="span">{t('作者')}：WEI</div>
            <div className="span">{t('邮箱')}：2016645682@qq.com</div>
          </div>
        </div>
      </div>
      <div className={`mask ${show ? 'show' : ''}`}></div>
    </div>
  )
}

export default AboutModal
