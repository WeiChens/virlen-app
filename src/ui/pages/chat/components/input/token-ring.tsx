/**
 * token-ring — Token 使用量环形进度条
 * 展示当前会话的 token 使用比例，点击触发上下文压缩
 */
import { Observer } from 'mobx-react-lite'
import { sessionStore } from '@/ui/store'
import { compressContext } from '@/services/chat-service'
import Tooltip from '@/ui/components/shared/Tooltip'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'

const MAX_TOKENS_FULL = 200_000 // 100% = 200k tokens

const tokenFormat = (tokens: number) => {
  return `${(tokens / 1000).toFixed(1)}k`
}

interface Props {
  sessionId?: string
  compacting: boolean
  loading?: boolean
}

export default function TokenRing({ sessionId, compacting, loading }: Props) {
  return (
    <Observer>
      {() => {
        // 从会话最后一条 assistant 消息中读取 usage
        const lastUsage = (() => {
          if (!sessionId) return null
          const session = sessionStore.getSession(sessionId)
          if (!session) return null
          const msgs = session.messages
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]
            if (m.usage) {
              return m.usage
            }
          }
          return null
        })()
        const usageRatio =
          lastUsage?.totalTokens != null
            ? Math.min(lastUsage.totalTokens / MAX_TOKENS_FULL, 1)
            : null

        if (usageRatio == null) {
          return <></>
        }
        // 环形进度条 SVG
        const ringSize = 28
        const strokeWidth = 3
        const radius = (ringSize - strokeWidth) / 2
        const circumference = 2 * Math.PI * radius
        const offset =
          usageRatio != null ? circumference * (1 - usageRatio) : circumference

        return (
          <Tooltip
            content={
              compacting
                ? t('正在压缩上下文...')
                : `${tokenFormat(lastUsage!.totalTokens)} / ${tokenFormat(MAX_TOKENS_FULL)} tokens\n${t('点击进行上下文压缩')}`
            }>
            <div
              className={`token-ring${compacting ? ' compacting' : ''}`}
              onClick={async () => {
                if (compacting) {
                  showToast(t('正在压缩上下文，请稍候...'))
                  return
                }
                if (usageRatio < 0.4) {
                  showToast(t('当前上下文很充裕，无需压缩'))
                  return
                }
                if (loading) {
                  showToast(t('正在发送消息，请稍候...'))
                  return
                }
                await compressContext(sessionId)
              }}>
              <svg
                width={ringSize}
                height={ringSize}
                viewBox={`0 0 ${ringSize} ${ringSize}`}>
                <circle
                  cx={ringSize / 2}
                  cy={ringSize / 2}
                  r={radius}
                  fill="none"
                  stroke="var(--border-color, #dddada)"
                  strokeWidth={strokeWidth}
                />
                <circle
                  cx={ringSize / 2}
                  cy={ringSize / 2}
                  r={radius}
                  fill="none"
                  stroke={
                    usageRatio > 0.8
                      ? 'var(--color-error, #ef4444)'
                      : usageRatio > 0.6
                        ? 'var(--accent-warn, #f59e0b)'
                        : 'var(--accent-color, #4f46e5)'
                  }
                  strokeWidth={strokeWidth}
                  strokeDasharray={circumference}
                  strokeDashoffset={offset}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
                  style={{ transition: 'stroke-dashoffset 0.3s ease' }}
                />
              </svg>
            </div>
          </Tooltip>
        )
      }}
    </Observer>
  )
}
