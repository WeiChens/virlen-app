/**
 * token-ring — Token 使用量环形进度条。
 *
 * 左键（或聚焦后回车 / 空格）按**设置里的压缩方式**触发上下文压缩；右键在按钮左上方弹菜单，
 * 临时指定本次压缩方式。进度用 stroke-dashoffset 表达，无需额外动画循环。
 */
import { useEffect } from 'react'
import { Observer } from 'mobx-react-lite'
import type { CSSProperties } from 'react'
import { sessionStore, settingsState } from '@/ui/store'
import { compressContext } from '@/services/chat-service'
import {
  COMPRESS_MIN_RATIO,
  contextWindowOf,
  pickContextTokens,
} from '@/domain/usage/context-occupancy'
import type { CompressMode } from '@/domain/ports'
import Tooltip from '@/ui/components/shared/Tooltip'
import { showToast } from '@/ui/components/shared/Toast'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { t } from '@/ui/i18n'

// 窗口缺省值 / 占用阈值 / 占用口径都在 @/domain/usage/context-occupancy（单一真源，手机接口层读同一份）
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

/** 右键菜单里的两种压缩方式（顺序即展示顺序，与设置页一致） */
const MENU_MODES: CompressMode[] = ['ai', 'raw']

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

/** 压缩方式名（中文即 i18n key，与设置页同一批词条） */
function modeLabel(mode: CompressMode) {
  return mode === 'ai' ? t('AI 摘要') : t('正文压缩')
}

/** 当前上下文占用（口径见 @/domain/usage/context-occupancy） */
function findContextTokens(sessionId: string): number | null {
  const msgs = sessionStore.getSession(sessionId)?.messages
  if (!msgs) return null
  return pickContextTokens(msgs)
}

interface Props {
  sessionId?: string
  compacting: boolean
  loading?: boolean
  /** 压缩会整体替换消息列表，而列表数据源是 chat-view 的本地 state，完成后必须回调让它重新同步 */
  onMessagesUpdate?: (sessionId: string) => void
}

export default function TokenRing({
  sessionId,
  compacting,
  loading,
  onMessagesUpdate,
}: Props) {
  /** 右键菜单（左键不经过它，直接按设置压缩） */
  const menu = useContextMenu()
  const { close: closeMenu } = menu

  // 切会话关菜单：Observer 因「无 token 数据」提前 return 时菜单会消失但 state 还在，
  // 回到有数据的会话会按旧坐标凭空弹出
  useEffect(() => {
    closeMenu()
  }, [sessionId, closeMenu])

  return (
    <Observer>
      {() => {
        if (!sessionId) return null
        const totalTokens = findContextTokens(sessionId)
        if (totalTokens == null) return null

        // 「100%」对应多少来自设置（全局，CLI / 手机接口层读同一份）；这里只展示、不编辑
        const contextWindow = contextWindowOf(settingsState.value.contextWindowTokens)

        const ratio = Math.min(totalTokens / contextWindow, 1)
        const settingMode = settingsState.value.contextCompressMode ?? 'ai'

        // 圆头端帽各向外扩半个线宽（合起来一个线宽）：除极小进度外少画一个线宽的弧长，
        // 满环时首尾刚好接上、不被端帽叠粗
        const rawGap = RING_CIRCUMFERENCE * (1 - ratio)
        const dashOffset =
          rawGap + RING_STROKE <= RING_CIRCUMFERENCE
            ? rawGap + RING_STROKE
            : rawGap

        const tip = compacting
          ? t('正在压缩上下文...')
          : `${formatTokens(totalTokens)} / ${formatTokens(contextWindow)} tokens（${Math.round(ratio * 100)}%）\n${t('点击压缩')}`

        /** 触发压缩（`mode` 省略 = 用设置里的方式）；三道闸：正在压缩 / 上下文充裕 / 正在发消息 */
        async function runCompress(mode?: CompressMode) {
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
          await compressContext(sessionId!, { onMessagesUpdate }, mode)
        }

        /** 菜单项现算（`settingMode` 可能刚被设置页改过）：标出设置里的默认方式 */
        const menuItems: ContextMenuItem[] = MENU_MODES.map((mode) => ({
          key: mode,
          label:
            mode === settingMode
              ? `${modeLabel(mode)}（${t('默认')}）`
              : modeLabel(mode),
          onClick: () => void runCompress(mode),
        }))

        return (
          <>
            <Tooltip content={tip} disabled={!!menu.state}>
              <div
                className={`token-ring${compacting ? ' compacting' : ''}${ratio > RING_CRITICAL_RATIO ? ' is-critical' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={tip}
                aria-busy={compacting}
                onClick={() => void runCompress()}
                onContextMenu={(e) => {
                  // 压缩中不给切方式（避免并发两次压缩）
                  if (compacting) return
                  e.preventDefault()
                  e.stopPropagation()
                  // 菜单贴按钮左上方：输入区在窗口右下角，向右下展开会被视口钳回来盖住按钮；
                  // 以按钮左上角往外退 6px 为锚点，配合 placement="top-left" 即成为菜单右下角
                  const rect = e.currentTarget.getBoundingClientRect()
                  menu.openAtPoint(
                    { x: rect.left + 12, y: rect.top + 6 },
                    undefined,
                  )
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault() // 空格默认会滚动页面
                    void runCompress()
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
                    {/* 渐变描边：两端同色只差透明度，颜色仍由用量决定，只多一层光泽 */}
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

            {menu.state && (
              <ContextMenu
                position={menu.state.position}
                placement="top-left"
                items={menuItems}
                onClose={menu.close}
              />
            )}
          </>
        )
      }}
    </Observer>
  )
}
