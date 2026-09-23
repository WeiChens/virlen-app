/**
 * token-ring — Token 使用量环形进度条
 *
 * 展示当前会话的 token 使用比例；点击（或聚焦后回车/空格）触发上下文压缩。
 * 进度用 stroke-dashoffset 表达（本身就能过渡），不需要额外动画循环。
 */
import { Observer } from 'mobx-react-lite'
import type { CSSProperties } from 'react'
import { sessionStore } from '@/ui/store'
import { compressContext } from '@/services/chat-service'
import Tooltip from '@/ui/components/shared/Tooltip'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'

// ==================== 口径与几何常量（提到模块级，不在渲染里重算） ====================

/** 100% 对应 200k tokens */
const MAX_TOKENS_FULL = 200_000
/** 用量低于该比例时，点击只提示「无需压缩」 */
const COMPRESS_MIN_RATIO = 0.4
/** 环形尺寸 / 线宽 / 半径 / 周长 */
const RING_SIZE = 30
const RING_STROKE = 4
const RING_CENTER = RING_SIZE / 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** 斜向渐变描边的 id（同色不同透明度，做出液体光泽） */
const RING_GRAD_ID = 'token-ring-grad'

/** 用量颜色阈值：超过警告 → 黄，超过危险 → 红 */
const RING_WARN_RATIO = 0.6
const RING_CRITICAL_RATIO = 0.8

/** 用量越高越警示 */
function ringColor(ratio: number) {
  if (ratio > RING_CRITICAL_RATIO) return 'var(--color-error, #ef4444)'
  if (ratio > RING_WARN_RATIO) return 'var(--accent-warn, #f59e0b)'
  return 'var(--accent-color, #4f46e5)'
}

/** 200000 → 200k，12500 → 12.5k（整数 k 不带多余的 .0） */
function formatTokens(tokens: number) {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}

/**
 * 取「当前上下文占用」——从后往前，命中即止。
 *
 * 两个口径必须区分（见 compress-context.ts）：
 * - `uiData.contextTokens`：压缩产物的「压缩后上下文大小」（本地估算）；
 * - `usage.totalTokens`：该消息所属那轮调用的真实 token（供应商回报）。
 *
 * AI 摘要消息的 `usage` 是**那次摘要调用**的消耗（prompt 含压缩前的全部历史），
 * 拿它当占用会显示成「压缩后反而更大」，所以带 contextTokens 的消息一律优先。
 */
function findContextTokens(sessionId: string): number | null {
  const msgs = sessionStore.getSession(sessionId)?.messages
  if (!msgs) return null
  for (let i = msgs.length - 1; i >= 0; i--) {
    const ctx = msgs[i].uiData?.contextTokens
    if (typeof ctx === 'number' && ctx > 0) return ctx
    const usage = msgs[i].usage
    if (usage) return usage.totalTokens
  }
  return null
}

interface Props {
  sessionId?: string
  compacting: boolean
  loading?: boolean
  /**
   * 压缩会整体替换消息列表，而列表数据源是 chat-view 的本地 state，
   * 压缩完成后必须回调通知它重新同步（否则要切会话才看到压缩结果）
   */
  onMessagesUpdate?: (sessionId: string) => void
}

export default function TokenRing({
  sessionId,
  compacting,
  loading,
  onMessagesUpdate,
}: Props) {
  return (
    <Observer>
      {() => {
        if (!sessionId) return null
        const totalTokens = findContextTokens(sessionId)
        if (totalTokens == null) return null

        const ratio = Math.min(totalTokens / MAX_TOKENS_FULL, 1)

        // 圆头端帽会各向外扩半个线宽（合起来一个线宽）：
        // 除极小进度外，少画一个线宽的弧长，这样满环时首尾刚好接上、不会被端帽叠粗。
        const rawGap = RING_CIRCUMFERENCE * (1 - ratio)
        const dashOffset =
          rawGap + RING_STROKE <= RING_CIRCUMFERENCE
            ? rawGap + RING_STROKE
            : rawGap

        const tip = compacting
          ? t('正在压缩上下文...')
          : `${formatTokens(totalTokens)} / ${formatTokens(MAX_TOKENS_FULL)} tokens（${Math.round(ratio * 100)}%）\n${t('点击进行上下文压缩')}`

        /** 三道闸：正在压缩 → 上下文充裕 → 正在发消息 */
        async function handleActivate() {
          if (compacting) {
            showToast(t('正在压缩上下文，请稍候...'))
            return
          }
          if (ratio < COMPRESS_MIN_RATIO) {
            showToast(t('当前上下文很充裕，无需压缩'))
            return
          }
          if (loading) {
            showToast(t('正在发送消息，请稍候...'))
            return
          }
          await compressContext(sessionId!, { onMessagesUpdate })
        }

        return (
          <Tooltip content={tip}>
            <div
              className={`token-ring${compacting ? ' compacting' : ''}${ratio > RING_CRITICAL_RATIO ? ' is-critical' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={tip}
              aria-busy={compacting}
              onClick={handleActivate}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault() // 空格默认会滚动页面
                  handleActivate()
                }
              }}>
              <svg
                width={RING_SIZE}
                height={RING_SIZE}
                viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
                aria-hidden="true"
                focusable="false"
                style={{ '--ring-color': ringColor(ratio) } as CSSProperties}>
                <defs>
                  {/* 渐变描边：两端同色、只差透明度 —— 颜色仍由用量决定，只是多一层光泽 */}
                  <linearGradient id={RING_GRAD_ID} x1="0" y1="1" x2="1" y2="0">
                    <stop
                      className="ring-grad-stop"
                      offset="0"
                      stopOpacity="0.5"
                    />
                    <stop
                      className="ring-grad-stop"
                      offset="1"
                      stopOpacity="1"
                    />
                  </linearGradient>
                </defs>
                {/* 轨道 */}
                <circle
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke="var(--border-color, #dddada)"
                  strokeWidth={RING_STROKE}
                />
                {/* 进度：从 12 点方向顺时针，颜色随用量切换（多看一眼就知道危不危险） */}
                <circle
                  className="ring-progress"
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke={`url(#${RING_GRAD_ID})`}
                  strokeWidth={RING_STROKE}
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
                />
              </svg>
            </div>
          </Tooltip>
        )
      }}
    </Observer>
  )
}
