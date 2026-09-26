/**
 * StepIndicator — 引导流程顶部的步骤进度指示
 *
 * 让用户始终知道「共几步、当前第几步、还剩几步」，降低中途放弃率。
 * 已完成步骤显示对勾，当前步骤高亮并带光环。
 */
import { t } from '@/ui/i18n'
import type { SetupStep } from '../../types'
import './style.scss'

const STEPS: { key: SetupStep; label: string }[] = [
  { key: 'welcome', label: '欢迎' },
  { key: 'setWorkdir', label: '工作目录' },
  { key: 'setup', label: '模型配置' },
]

interface Props {
  /** 当前所处步骤 */
  current: SetupStep
}

function StepIndicator({ current }: Props) {
  const currentIndex = STEPS.findIndex((s) => s.key === current)

  return (
    <ol className="step-indicator" aria-label={t('配置进度')}>
      {STEPS.map((step, index) => {
        const state =
          index < currentIndex
            ? 'done'
            : index === currentIndex
              ? 'active'
              : 'todo'

        return (
          <li
            key={step.key}
            className={`step-indicator-item is-${state}`}
            aria-current={state === 'active' ? 'step' : undefined}>
            <span className="step-indicator-dot" aria-hidden="true">
              {state === 'done' ? (
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                index + 1
              )}
            </span>
            <span className="step-indicator-label">{t(step.label)}</span>
            {index < STEPS.length - 1 && (
              <span className="step-indicator-line" aria-hidden="true" />
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default StepIndicator
