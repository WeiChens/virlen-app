/**
 * 轨迹概览条：整段会话的「地图」。
 *
 * 三条泳道（输入 / 助手 / 工具）从左到右铺开，每条记录一根细条。点一根条 → 表格滚过去；
 * 在空白处拖出一个区间 → 表格里只提亮那个时间段的记录（其余淡化，但不隐藏 ——
 * 隐藏会让人瞬间失去上下文，而且行号会跳）。
 *
 * 两种模式由工具栏切换：
 * - `sequence` 等宽：每条记录一格，永远可用
 * - `time` 真实时间：按记录的实际起止投影；不知道起点的记录**不画**（不猜位置）
 *
 * 缩放：滚轮以光标位置为锚点放大 / 缩小（1×–32×），放大后内容层比视口宽，横向滚动条由滚动层给出
 * （Shift+滚轮也能左右平移，双击空白处回到 1×）。缩放只改「看多细」，不改坐标系 ——
 * 百分比仍是整段会话的域，选区与点击跳转都不受影响。
 *
 * ⚠️ 条子 / 分隔线 / 选区都由 **canvas** 画（几何在 `domain/trajectory/paint.ts`）：长会话上千条
 * 记录，用 DOM 就是上千个节点，而流式回答每个 token 都会重建一次投影。画布只有视口那么大、
 * 绝对定位垫在滚动层之上（`pointer-events: none`，指针事件全落在滚动层上），所以放大 32×
 * 也不会去撑一张几万像素宽的画布。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  type PointerEvent,
} from 'react'
import {
  STRIP_HEIGHT,
  timelineHitTest,
  timelinePaintOps,
  timelineSpanPx,
  type TimelineColorSlot,
  type TimelinePaintOp,
  type TrajectoryTimelineMode,
  type TrajectoryTimelineModel,
} from '@/domain/trajectory'
import { t } from '@/ui/i18n'

export interface TrajectoryTimelineProps {
  model: TrajectoryTimelineModel | null
  mode: TrajectoryTimelineMode
  /** 当前选区（同一模式的坐标系）；null = 没有选区 */
  range: { start: number; end: number } | null
  /** 当前选中的记录 key（高亮它那根条） */
  selectedKey: string | null
  /** 点击某根条：表格定位到那条记录（传 key：前插历史后行号会变） */
  onSelectRecord: (recordKey: string) => void
  /** 拖选 / 清除选区 */
  onRangeChange: (range: { start: number; end: number } | null) => void
}

/** 拖动超过这个距离才算「拉选区」，否则当点击 */
const DRAG_THRESHOLD_PX = 3
/** 缩放区间：1× = 整段会话铺满视口，32× 足够把一根条彻底拉开 */
const MIN_ZOOM = 1
const MAX_ZOOM = 32
/** 滚轮 → 缩放倍率（像素口径）：一格 ≈100px ≈ ±15% */
const WHEEL_ZOOM_RATE = 0.0015
/** 缩到离 1× 这么近就直接吸附回 1×，否则视口会一直挂着一条缝宽的滚动条 */
const ZOOM_SNAP = 1.02
/** 把选中的条拉回可视区时留的边距（px） */
const REVEAL_PAD_PX = 8

/** 颜色槽位 → CSS 变量（读不到就用兜底色）：canvas 不认 `var()`，只能先读进来再涂 */
const COLOR_VARS: Record<TimelineColorSlot, { name?: string; fallback: string }> = {
  boundary: { name: '--border-color', fallback: '#e5e5e5' },
  accent: { name: '--accent-color', fallback: '#4f46e5' },
  text: { name: '--text-primary', fallback: '#1a1a1a' },
  warning: { name: '--color-warning', fallback: '#f59e0b' },
  // 压缩段原先就是硬编码的紫（主题里没有对应令牌）
  violet: { fallback: '#8b5cf6' },
  muted: { name: '--text-tertiary', fallback: '#767676' },
  danger: { name: '--color-error', fallback: '#cf222e' },
}

type Palette = Record<TimelineColorSlot, string>

/** 从 `<html>` 上读当前主题的色值（主题 / 强调色切换后要重读） */
function readPalette(): Palette {
  const palette = {} as Palette
  const style =
    typeof document !== 'undefined' && typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement)
      : null
  for (const slot of Object.keys(COLOR_VARS) as TimelineColorSlot[]) {
    const { name, fallback } = COLOR_VARS[slot]
    const raw = style && name ? style.getPropertyValue(name).trim() : ''
    // 主题里可能是 `var()` 链：没解析成具体色值就别拿去涂（canvas 认不了 var()）
    palette[slot] = raw && !raw.startsWith('var(') ? raw : fallback
  }
  return palette
}

/** 把三种 deltaMode 折算成像素（行 / 页口径的滚轮不直接给像素值） */
function wheelDelta(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16
  if (event.deltaMode === 2) return event.deltaY * 400
  return event.deltaY
}

/** 一条绘制指令 → 一次 canvas 调用（几何与配色全在纯函数里，这里只翻译） */
function paintOp(
  ctx: CanvasRenderingContext2D,
  op: TimelinePaintOp,
  palette: Palette,
): void {
  const color = palette[op.color]
  if (op.kind === 'ring') {
    // 选中环：压在相邻条子上面（对应原先 CSS 的 box-shadow）
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.strokeRect(op.x, op.y, op.w, op.h)
    return
  }
  ctx.globalAlpha = op.alpha
  ctx.fillStyle = color
  if (op.kind === 'vline') {
    // 1px 竖线落到整数像素上才不发虚（小数 x 会被抗锯齿抹成两像素灰线）
    ctx.fillRect(Math.round(op.x), op.y, 1, op.h)
    return
  }
  if (op.radius > 0 && typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(op.x, op.y, op.w, op.h, op.radius)
    ctx.fill()
    return
  }
  ctx.fillRect(op.x, op.y, op.w, op.h)
}

interface DragState {
  pointerId: number
  startX: number
  /** 起点换算成域值 */
  from: number
  moved: boolean
  /** 按下时压在哪根条子上（没拖动就当成点了它） */
  hitKey: string | null
}

export function TrajectoryTimeline({
  model,
  mode,
  range,
  selectedKey,
  onSelectRecord,
  onRangeChange,
}: TrajectoryTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  /** 滚动层：只负责原生滚动条与手势，内容宽度由里面的空占位撑开 */
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  /** 横向缩放比例：1 = 整段会话铺满视口 */
  const [zoom, setZoom] = useState(1)
  /** 原生 wheel 监听只挂一次，拿不到最新的 zoom，所以走 ref */
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  /** 悬停的条（高亮 + 悬浮提示）：没命中任何条时为 null */
  const [hovered, setHovered] = useState<{ key: string; label: string } | null>(null)
  const [palette, setPalette] = useState<Palette>(readPalette)
  /** 缩放后要落的滚动位置：得等 DOM 尺寸更新完再写，否则滚不到位 */
  const pendingScrollLeft = useRef<number | null>(null)
  const rafRef = useRef(0)
  const drawRef = useRef<() => void>(() => {})

  const hasTimeline = model !== null && model.end > model.start

  const draw = () => {
    const canvas = canvasRef.current
    const scroll = scrollRef.current
    if (!canvas || !scroll || !model || !hasTimeline) return
    const ctx = canvas.getContext('2d')
    // jsdom / 极端环境没有 2D 上下文：不画，但界面与其余功能照常
    if (!ctx) return
    const viewWidth = scroll.clientWidth
    if (viewWidth <= 0) return
    const dpr = window.devicePixelRatio || 1
    const pixelW = Math.round(viewWidth * dpr)
    const pixelH = Math.round(STRIP_HEIGHT * dpr)
    if (canvas.width !== pixelW) canvas.width = pixelW
    if (canvas.height !== pixelH) canvas.height = pixelH
    const cssWidth = `${viewWidth}px`
    const cssHeight = `${STRIP_HEIGHT}px`
    if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth
    if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewWidth, STRIP_HEIGHT)
    const ops = timelinePaintOps(model, {
      viewWidth,
      viewHeight: STRIP_HEIGHT,
      // 内容层宽度 = 视口宽 × 缩放倍率（与空占位的 100% × 倍率同一个口径）
      contentWidth: viewWidth * zoomRef.current,
      scrollLeft: scroll.scrollLeft,
      range,
      selectedKey,
      hoveredKey: hovered?.key ?? null,
    })
    for (const op of ops) paintOp(ctx, op, palette)
    ctx.globalAlpha = 1
  }
  drawRef.current = draw

  /** 滚动一帧可能来十几个事件：rAF 合并成每帧一次重画 */
  const schedule = useCallback(() => {
    if (rafRef.current) return
    if (typeof requestAnimationFrame !== 'function') {
      drawRef.current()
      return
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawRef.current()
    })
  }, [])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || pendingScrollLeft.current === null) return
    scroll.scrollLeft = pendingScrollLeft.current
    pendingScrollLeft.current = null
  }, [zoom])

  // 投影 / 缩放 / 选区 / 选中 / 悬停 / 主题变了就重画（同步画一次，否则会先闪一帧空白）
  useLayoutEffect(() => {
    drawRef.current()
  }, [model, zoom, range, selectedKey, hovered, palette, hasTimeline])

  // 主题 / 强调色都是写在 <html> 上的属性 —— 变了要重读颜色，否则暗色主题上留着亮色的条
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => setPalette(readPalette()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-font-size'],
    })
    return () => observer.disconnect()
  }, [])

  // 滚动 / 尺寸变化（窗口缩放、切面板）→ 重画可视窗口
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const onScroll = (): void => schedule()
    scroll.addEventListener('scroll', onScroll, { passive: true })
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
    observer?.observe(scroll)
    schedule()
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [schedule, hasTimeline])

  // 卸载时撤掉排队中的那一帧（回调里读到的 ref 已经是 null）
  useEffect(
    () => () => {
      if (rafRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    },
    [],
  )

  /**
   * 滚轮 = 缩放。WebView 里 Ctrl+滚轮默认是整页缩放，必须拦。
   *
   * ⚠️ 只能用原生非 passive 监听：React 的 onWheel 挂在根节点上是 passive 的，preventDefault 无效。
   * Shift+滚轮不拦，交给原生当横向平移用。
   */
  useEffect(() => {
    const viewport = viewportRef.current
    const scroll = scrollRef.current
    if (!viewport || !scroll) return
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey) return
      const delta = wheelDelta(event)
      if (delta === 0) return
      // 到边界也要拦：不拦的话 WebView 会把它当整页缩放 / 滚动吃掉
      event.preventDefault()
      const current = zoomRef.current
      let next = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, current * Math.exp(-delta * WHEEL_ZOOM_RATE)),
      )
      if (next < ZOOM_SNAP) next = MIN_ZOOM
      if (next === current) return
      // 光标下那一刻的域值比例缩放前后停在原地，否则放大一次就得重新找位置
      const contentWidth = scroll.clientWidth * current
      if (contentWidth > 0) {
        const pointerX = event.clientX - viewport.getBoundingClientRect().left
        const ratio = (scroll.scrollLeft + pointerX) / contentWidth
        pendingScrollLeft.current = Math.max(
          0,
          ratio * contentWidth * (next / current) - pointerX,
        )
      }
      setZoom(next)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [hasTimeline])

  // 放大后选中的条可能已经滚出视口：把它拉回来（表格里点一行，地图上要跟得上）
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !model || selectedKey === null) return
    const span = model.spans.find((item) => item.recordKey === selectedKey)
    if (!span) return
    const contentWidth = scroll.clientWidth * zoomRef.current
    const { left, right } = timelineSpanPx(model, span, contentWidth)
    if (left < scroll.scrollLeft) {
      scroll.scrollLeft = Math.max(0, left - REVEAL_PAD_PX)
    } else if (right > scroll.scrollLeft + scroll.clientWidth) {
      scroll.scrollLeft = right - scroll.clientWidth + REVEAL_PAD_PX
    }
  }, [selectedKey])

  if (!hasTimeline) {
    return (
      <div className="trajectory-timeline is-empty">
        <span>{t('这段对话还没有可投影的记录')}</span>
      </div>
    )
  }

  /** 视口内坐标（相对左上角） */
  const pointOf = (event: { clientX: number; clientY: number }) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  /** 客户端坐标 → 命中哪根条子 */
  const hitAt = (event: { clientX: number; clientY: number }) => {
    const scroll = scrollRef.current
    if (!scroll) return null
    return timelineHitTest(model, pointOf(event), {
      contentWidth: scroll.clientWidth * zoom,
      scrollLeft: scroll.scrollLeft,
    })
  }

  /** 客户端坐标 → 域值（以内容层为准：它比视口宽时，滚动偏移要一起算） */
  const domainAt = (clientX: number): number => {
    const scroll = scrollRef.current
    const domain = model.end - model.start
    const contentWidth = scroll ? scroll.clientWidth * zoom : 0
    if (!scroll || contentWidth <= 0 || domain <= 0) return model.start
    const ratio = Math.min(
      1,
      Math.max(0, (scroll.scrollLeft + pointOf({ clientX, clientY: 0 }).x) / contentWidth),
    )
    return model.start + ratio * domain
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // 按在横向滚动条上（滚动条属于滚动层本身）：让它自己滚，别当成选区操作
    if (event.target === scrollRef.current) return
    // 开始拖选就把悬停高亮收起（否则条子上会留着上一帧的外框）
    setHovered(null)
    const hit = hitAt(event)
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      from: domainAt(event.clientX),
      moved: false,
      hitKey: hit?.recordKey ?? null,
    })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) {
      if (event.target === scrollRef.current) return
      // 悬停：命中哪根就高亮它，并把它的摘要当悬浮提示
      const hit = hitAt(event)
      if ((hit?.recordKey ?? null) !== (hovered?.key ?? null)) {
        setHovered(hit ? { key: hit.recordKey, label: hit.label } : null)
      }
      return
    }
    if (drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) {
      return
    }
    const to = domainAt(event.clientX)
    setDrag({ ...drag, moved: true })
    onRangeChange({
      start: Math.min(drag.from, to),
      end: Math.max(drag.from, to),
    })
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    // 没拖动 = 点击：点在条子上就定位它，点空白就清掉选区
    if (!drag.moved) {
      if (drag.hitKey) onSelectRecord(drag.hitKey)
      else onRangeChange(null)
    }
    setDrag(null)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  /** 双击空白处回到 1×（拖选区要超过 DRAG_THRESHOLD_PX，双击不会被它吃掉） */
  const resetZoom = () => {
    if (zoom === MIN_ZOOM) return
    pendingScrollLeft.current = 0
    setZoom(MIN_ZOOM)
  }

  return (
    <div className="trajectory-timeline">
      <div className="trajectory-timeline__lanes" aria-hidden="true">
        <span>{t('输入')}</span>
        <span>{t('助手')}</span>
        <span>{t('工具')}</span>
      </div>
      <div
        className="trajectory-timeline__viewport"
        ref={viewportRef}
        role="presentation"
        // 悬停在条子上时给可点的光标（条子不是 DOM 节点了，只能在这里代它表达）
        style={{ cursor: hovered ? 'pointer' : undefined }}
        title={
          hovered?.label ?? t('滚轮缩放，Shift + 滚轮左右平移，双击空白处回到 100%')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setHovered(null)}
        onDoubleClick={resetZoom}
        onContextMenu={(event) => {
          // 右键 = 清除选区（与「在放大的视口上拖动」区分：这里只清选区）
          event.preventDefault()
          onRangeChange(null)
        }}>
        {/* 滚动层：只提供原生横向滚动条与手势，内容宽度由空占位撑开 */}
        <div className="trajectory-timeline__scroll" ref={scrollRef}>
          <div
            className="trajectory-timeline__spacer"
            style={{ width: `${zoom * 100}%` }}
          />
        </div>
        {/* 画布：只有视口大小，垫在滚动层之上且不吃指针事件 */}
        <canvas
          className="trajectory-timeline__canvas"
          ref={canvasRef}
          role="img"
          aria-label={t('轨迹概览条')}
        />
      </div>
      <span className="trajectory-timeline__mode">
        {mode === 'time' ? t('真实时间') : t('等宽')}
      </span>
    </div>
  )
}
