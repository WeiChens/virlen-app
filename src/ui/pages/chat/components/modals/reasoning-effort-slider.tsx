/**
 * reasoning-effort-slider — 推理强度（会话级）
 *
 * 收起态只显示当前档位（如 medium / 默认），点击后在上方弹出横向拖动条。
 * 档位来自服务商配置的 reasoningEffortList（用户在设置里多选的并集子集），
 * 按并集顺序排列保证单调；最左一档是「默认（不设置）」，此时回退到服务商默认值。
 * 有会话 → 写入 session.params.reasoningEffort；无会话 → 暂存 chatState，创建会话时带入。
 */
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState, sessionStore, chatState } from '@/ui/store'
import {
  DEFAULT_REASONING_EFFORT_LIST,
  sortReasoningEfforts,
} from '@/domain/provider/config'
import { t, tpl } from '@/ui/i18n'
import Tooltip from '@/ui/components/shared/Tooltip'

/**
 * 圆球液面图标
 *
 * 液面高度 = 档位进度：默认档是空球，档位越高越满（最高档接近满球）。
 * 液面用两层反向、不同速度的波纹错位叠加，形成「荡漾」感；
 * 外层组用行内 transform 控制液面高度（CSS 过渡，松手吸附时会滑过去）。
 */
function EffortBall({ level, dragging }: { level: number; dragging: boolean }) {
  const filled = Math.min(1, Math.max(0, level))
  return (
    <svg
      className={`effort-ball ${filled > 0 ? 'is-filled' : ''} ${dragging ? 'is-dragging' : ''}`}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false">
      <defs>
        <clipPath id="effort-ball-clip">
          <circle cx="12" cy="12" r="10" />
        </clipPath>
      </defs>

      {/* 球体轮廓（跟随 currentColor） */}
      <circle className="ball-rim" cx="12" cy="12" r="10" />

      {/* 液体：静息液面在 y=22（球底），上移 22 即到球顶（y=2）；空球时再下沉 2 → 完全不露液面。
          水体画到 y=48（远超球底），这样满球上移后下半部分仍是实心的，多余部分被 clipPath 裁掉。 */}
      <g clipPath="url(#effort-ball-clip)">
        <g
          className="ball-liquid"
          style={{ transform: `translateY(${2 - 18 * filled}px)` }}>
          <path
            className="ball-wave back"
            d="M0 22 C 4 18.4 8 18.4 12 22 S 20 25.6 24 22 S 32 18.4 36 22 S 44 25.6 48 22 L 48 48 L 0 48 Z"
          />
          <path
            className="ball-wave front"
            d="M0 22 C 4 25.6 8 25.6 12 22 S 20 18.4 24 22 S 32 25.6 36 22 S 44 18.4 48 22 L 48 48 L 0 48 Z"
          />
        </g>
      </g>
    </svg>
  )
}

function ReasoningEffortSlider() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 拖动中的连续位置（可为小数）：只用于「跟手」渲染；松手后才吸附到最近档位
  const [dragValue, setDragValue] = useState<number | null>(null)
  const dragging = dragValue !== null

  const sessionId = chatState.value.currentSessionId
  const session = sessionId ? sessionStore.getSession(sessionId) : null
  const providerId = sessionId
    ? session?.providerConfigId || ''
    : chatState.value.selectModel?.providerConfigId || ''
  const provider = settingsState.value.providers.find(
    (p) => p.id === providerId,
  )

  // 候选项：服务商勾选出的集合；
  // 未配置过时，仅 OpenAI 兼容类型用默认基础档位兜底（其余类型不支持 reasoning_effort，不显示该控件）
  const configured =
    provider?.reasoningEffortList && provider.reasoningEffortList.length > 0
      ? provider.reasoningEffortList
      : null
  const candidates =
    configured ??
    (provider && provider.type === 'openai'
      ? [...DEFAULT_REASONING_EFFORT_LIST]
      : null)

  const rawValue = sessionId
    ? session?.params?.reasoningEffort || ''
    : chatState.value.selectReasoningEffort || ''
  // 候选集变小后，历史值可能已不在集合里 → 视为「默认（不设置）」
  const value =
    candidates && candidates.includes(rawValue) ? rawValue : ''

  // 档位：第 0 档 = 默认（不设置），其余按并集顺序（保证拖动方向与「思考深度」单调一致）
  const steps = candidates ? ['', ...sortReasoningEfforts(candidates)] : []
  const maxStep = Math.max(0, steps.length - 1)
  const index = Math.max(0, steps.indexOf(value))

  // 跟手：拖动中滑块停在连续位置（可为小数），标签实时预览「松手后会落到哪一档」
  const previewIndex = Math.min(
    maxStep,
    Math.max(0, Math.round(dragValue ?? index)),
  )
  const thumbValue = dragValue ?? index
  const shownValue = dragging ? steps[previewIndex] ?? '' : value
  // 液面进度：0 = 默认（空球）→ 1 = 最高档（满球）；拖动中实时跟手
  const level = maxStep > 0 ? thumbValue / maxStep : 0
  // 图标按钮没有文字了 → 把当前档位挂在 tooltip / aria-label 上
  const effortTitle = tpl('强度：$__level__', {
    level: shownValue || t('默认'),
  })

  function handleChange(next: string) {
    if (sessionId) {
      const current = sessionStore.getSession(sessionId)
      if (current) {
        sessionStore.updateSession(sessionId, {
          params: { ...current.params, reasoningEffort: next || undefined },
        })
      }
    } else {
      chatState.setValue('selectReasoningEffort', next)
    }
  }

  /**
   * 松手：把连续位置吸附到最近档位后落库。
   * 只有这里才写 store —— 拖动过程中每动一下都写会话会触发 persist()
   * 与 updatedAt 变化（会话列表重排），那正是拖动卡顿的主因。
   */
  function commitSnap() {
    if (!dragging) return
    const raw = Number(inputRef.current?.value)
    setDragValue(null)
    if (Number.isNaN(raw)) return
    const next = Math.min(maxStep, Math.max(0, Math.round(raw)))
    handleChange(steps[next] ?? '')
  }

  /** step="any" 下浏览器方向键只走量程的 1%，键盘改为整档移动 */
  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const dir =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown'
        ? -1
        : e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? 1
          : 0
    if (!dir) return
    e.preventDefault()
    setDragValue(null)
    handleChange(steps[Math.min(maxStep, Math.max(0, index + dir))] ?? '')
  }

  // 外部点击关闭
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [open])

  // 兜底：鼠标在窗口外松开、或拖动被系统打断（弹窗 / 触摸手势）时，同样吸附落库。
  // 用 useLayoutEffect：拖动一开始就把监听挂上，避免「按下即松」时错过 pointerup。
  useLayoutEffect(() => {
    if (!dragging) return
    const finish = () => commitSnap()
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [dragging])

  if (!provider || !candidates) return null

  return (
    <div
      className={`reasoning-effort-slider ${open ? 'open' : ''} ${value ? 'is-set' : ''}`}
      ref={containerRef}>
      <Tooltip content={effortTitle} direction="top">
        <button
          className="slider-trigger"
          onClick={() => {
            let index = previewIndex + 1
            if (index > maxStep) {
              index = 0
            }
            const v = steps[index] ?? ''
            handleChange(v)
            // setOpen(!open)
          }}
          // title={effortTitle}
          aria-label={effortTitle}
          aria-expanded={open}
          type="button">
          <EffortBall level={level} dragging={dragging} />
        </button>
      </Tooltip>


      {open && (
        <div className="slider-popover">
          <div className="popover-row">
            <span className="slider-key">{t('强度')}</span>
            {/* step="any" → 拖动时值是连续的（不跳档），松手时才在 commitSnap 里吸附到最近档位。
                React 的 onChange 对 range 就是原生 input 事件：每次移动只更新本地状态，不写 store。 */}
            <input
              ref={inputRef}
              className="slider-input"
              type="range"
              min={0}
              max={maxStep}
              step="any"
              value={thumbValue}
              onChange={(e) => setDragValue(Number(e.target.value))}
              onKeyDown={handleKeyDown}
              onKeyUp={commitSnap}
              onBlur={commitSnap}
              title={t('拖动调节推理强度')}
              aria-label={t('推理强度')}
              aria-valuetext={shownValue || t('默认')}
            />
            <span className="slider-value">{shownValue || t('默认')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default observer(ReasoningEffortSlider)
