/**
 * welcome-screen — 空会话欢迎页
 *
 * 无当前会话时展示，提供快捷操作入口。
 * 每天展示 5 个不同的 quick-action，每个按钮点击循环使用不同文本。
 */
import { useState, useMemo } from 'react'
import { AppLogoSvg } from '@/ui/constants'
import { getDailyQuickActions } from '@/ui/constants/quickActions'
import type { QuickAction } from '@/ui/constants/quickActions'
import { t } from '@/ui/i18n'
import './style.scss'

interface WelcomeScreenProps {
  /** 设置输入框文本 */
  setText: (text: string) => void
}

function WelcomeScreen({ setText }: WelcomeScreenProps) {
  // 每天基于日期确定性选取 5 个不同的 quick-action
  const dailyActions: QuickAction[] = useMemo(() => getDailyQuickActions(5), [])

  // 记录每个按钮当前轮到 textList 中的第几个文本（索引）
  const [textIndexMap, setTextIndexMap] = useState<Record<number, number>>({})

  const handleClick = (actionIdx: number, action: QuickAction) => {
    const currentIdx = textIndexMap[actionIdx] ?? 0
    const text = action.textList[currentIdx]

    setText(text)

    // 循环：下次点击取下一个
    const nextIdx = (currentIdx + 1) % action.textList.length
    setTextIndexMap((prev) => ({ ...prev, [actionIdx]: nextIdx }))
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-icon">
        <AppLogoSvg size={120} />
      </div>
      <h2>{t('Virlen 未霖')}</h2>
      <p>
        {t('作为你的AI伙伴，写文案、写代码、理思路、整理文档等，都可以交给我')}
      </p>
      <div className="quick-actions">
        {dailyActions.map((action, idx) => (
          <button key={idx} onClick={() => handleClick(idx, action)}>
            {action.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export default WelcomeScreen
