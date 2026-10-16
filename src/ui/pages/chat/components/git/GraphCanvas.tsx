/**
 * GraphCanvas — 提交图的画布（Canvas 2D）。
 *
 * 四件事（每件都是「错了就白画」的那类）：
 *
 * 1. **只画可视区**：canvas 与滚动容器等高、绝对定位垫在它**上面**（`pointer-events: none`，让悬停 /
 *    点选穿过去），每次滚动重画 `[scrollTop, scrollTop + clientHeight]` 覆盖到的行 —— canvas 天生
 *    没有 DOM 节点，几十万行的仓库也不存在「几千个元素要布局」的问题（换 Canvas 的主要理由就是这个）。
 *    ⚠️ 因此**行高必须是常量**（`GRAPH_ROW_H`）：行数据 → 像素坐标全靠它，跟界面字号缩放就会逐行错位。
 * 2. **绘制指令来自纯函数**（`domain/git/graph.ts::paintOps`）：jsdom 里没有 2D 上下文，
 *    这里只做 `moveTo/lineTo/bezierCurveTo/arc` 的翻译（连半径与线宽也在指令里 —— 列密时它们
 *    要跟着缩）—— 任何几何计算写进本组件就等于放弃用例。画布宽度与列宽同样不自己推：
 *    取 `graphGeometry(layout)`（与行内的空位宽度**同一个出口**，§11.53 ㊱⑪）。
 * 3. **颜色从 CSS 变量读**（`--git-graph-1..8`，亮 / 暗两套）：canvas 不认 CSS 变量，只能读进来再涂。
 *    主题 / 界面字号一变（都写在 `<html>` 的属性上）就得重读，所以挂一个属性 MutationObserver。
 * 4. **`getContext('2d')` 拿不到就静默跳过**（jsdom / 极端环境）：图没画出来，但界面不崩、
 *    其余功能照常 —— 这也让用例可以给 `getContext` 挂替身来断言「真的调了哪些绘制 API」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GRAPH_PAD_X,
  GRAPH_PALETTE_FALLBACK,
  GRAPH_ROW_H,
  PALETTE_SIZE,
  graphGeometry,
  paintOps,
  type GraphLayout,
  type PaintOp,
} from '@/domain/git'

interface Props {
  layout: GraphLayout
  /** 当前 HEAD 指向的提交（画成空心加粗的节点） */
  headOid: string | null
  /** 行列表的滚动容器：画布从它读 `scrollTop` / 可视高度，并跟着它滚 */
  listRef: React.RefObject<HTMLDivElement | null>
  /** 无障碍名（canvas 里的信息对读屏是不可见的，给一句话说明它画的是什么） */
  label: string
}

/** 调色板：优先读 CSS 变量，读不到（非浏览器环境）用兵底（与暗色块逐个相等，见 `GRAPH_PALETTE_FALLBACK`） */
function readPalette(): string[] {
  const out = [...GRAPH_PALETTE_FALLBACK]
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return out
  const cs = getComputedStyle(document.documentElement)
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const v = cs.getPropertyValue(`--git-graph-${i + 1}`).trim()
    if (v) out[i] = v
  }
  return out
}

export function GraphCanvas({ layout, headOid, listRef, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [palette, setPalette] = useState<string[]>(readPalette)
  const rafRef = useRef<number>(0)
  // 画布宽度 / 列宽与行内空位宽度同源（`graphGeometry`）：各推一遍就是「画线用 A、留位用 B」
  const geometry = useMemo(() => graphGeometry(layout), [layout])
  const width = geometry.canvasWidth

  // 主题 / 强调色 / 界面字号都是写在 <html> 上的属性 —— 变了就重读调色板（否则暗色主题上留着亮色的线）
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const html = document.documentElement
    const mo = new MutationObserver(() => setPalette(readPalette()))
    mo.observe(html, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-font-size'],
    })
    return () => mo.disconnect()
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const list = listRef.current
    if (!canvas || !list) return
    const ctx = canvas.getContext('2d')
    // jsdom / 极端环境：没有 2D 上下文就什么都不画（不抛错）
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const height = list.clientHeight
    const pixelW = Math.round(width * dpr)
    const pixelH = Math.round(height * dpr)
    if (canvas.width !== pixelW) canvas.width = pixelW
    if (canvas.height !== pixelH) canvas.height = pixelH
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const ops = paintOps(layout, {
      scrollTop: list.scrollTop,
      viewHeight: height,
      geometry: {
        laneWidth: geometry.laneWidth,
        rowHeight: GRAPH_ROW_H,
        padX: GRAPH_PAD_X,
      },
      headOid,
    })
    for (const op of ops) paintOp(ctx, op, palette)
  }, [layout, headOid, listRef, palette, geometry])

  /** 滚动事件一帧可能来十几个：用 rAF 合并成每帧一次重画 */
  const schedule = useCallback(() => {
    if (rafRef.current) return
    if (typeof requestAnimationFrame !== 'function') {
      draw()
      return
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onScroll = (): void => schedule()
    list.addEventListener('scroll', onScroll, { passive: true })
    // 可视高度变化（窗口缩放 / 字号变化）也要重画。⚠️ jsdom 没有 ResizeObserver —— 守卫一下
    const ro =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
    ro?.observe(list)
    // 首帧**同步**画一次（不等一帧）：否则打开弹窗会先闪一帧空白；
    // 之后由 scroll / resize 触发，那些事件一帧可能来十几个 → 才走 rAF 合并
    draw()
    return () => {
      list.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [listRef, schedule, draw])

  // 卸载时把排队中的那一帧撤掉（弹窗刚开就关：回调里读到的 ref 已经是 null）
  useEffect(
    () => () => {
      if (rafRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    },
    [],
  )

  return (
    <canvas
      ref={canvasRef}
      className="git-graph-canvas"
      role="img"
      aria-label={label}
      style={{ width }}
    />
  )
}

/**
 * 一条绘制指令 → 一次 canvas 调用（**几何与尺寸全在纯函数里**，这里只翻译）。
 *
 * 斜线用三次贝塞尔（两端切线都竖直）：这样它接进上下两条竖线时是平滑的，而不是一个折角。
 */
function paintOp(ctx: CanvasRenderingContext2D, op: PaintOp, palette: string[]): void {
  const color = palette[op.color] ?? palette[0] ?? '#888'
  ctx.strokeStyle = color
  ctx.fillStyle = color
  // 线宽 / 半径由指令带着（列密时列被压窄 → 它们跟着缩，见 graph.ts::nodeRadius / strokeWidth）
  ctx.lineWidth = op.width
  if (op.kind === 'dot') {
    ctx.beginPath()
    ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2)
    if (op.head) {
      // 当前 HEAD 画成空心圆（实心点表示「别的提交」，一圈空心一眼就分得开）
      ctx.stroke()
    } else {
      ctx.fill()
    }
    return
  }
  ctx.beginPath()
  ctx.moveTo(op.x1, op.y1)
  if (op.kind === 'curve') {
    const dy = op.y2 - op.y1
    ctx.bezierCurveTo(op.x1, op.y1 + dy * 0.5, op.x2, op.y2 - dy * 0.5, op.x2, op.y2)
  } else {
    ctx.lineTo(op.x2, op.y2)
  }
  ctx.stroke()
}

export default GraphCanvas
