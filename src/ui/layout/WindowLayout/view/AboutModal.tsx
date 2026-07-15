import { useEffect, useState } from 'react'
import './AboutModal.scss'
import RemoveSvg from '@/ui/components/icons/RemoveSvg'

import { appLogo, AppLogoSvg, appName } from '@/ui/constants'
import { getName, getTauriVersion, getVersion } from '@tauri-apps/api/app'
import { t } from '@/ui/i18n'
// import { useI18n } from '@/i18n'
interface Props {
  show: boolean
  onHide: () => void
}

const AboutModal = ({ show, onHide }: Props) => {
  const [version, setVersion] = useState<string>('x.x.x')
  const [name, setName] = useState<string>(appName)
  const [tauriVersion, setTauriVersion] = useState<string>('x.x.x')
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
            <div className="span">
              {t('版本')}：{version}
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
