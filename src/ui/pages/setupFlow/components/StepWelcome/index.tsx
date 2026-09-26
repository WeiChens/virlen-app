/**
 * StepWelcome — 引导第一步：欢迎页
 *
 * 展示应用介绍与价值主张，引导用户进入配置流程。
 */
import { t } from '@/ui/i18n'
import { AppLogoSvg, appName } from '@/ui/constants'
import './style.scss'

interface Props {
  onNext: () => void
}

function StepWelcome({ onNext }: Props) {
  return (
    <div className="welcome-page">
      <div className="welcome-logo">
        <AppLogoSvg size={150} />
      </div>
      <h1 className="welcome-title">{appName}</h1>
      <p className="welcome-subtitle">
        {t('你的 AI 伙伴，写文案、写代码、理思路、整理文档，都可以交给我。')}
      </p>

      <button className="btn-primary btn-start" onClick={onNext} type="button">
        {t('开始使用')}
      </button>
    </div>
  )
}

export default StepWelcome
