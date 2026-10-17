/**
 * VirtualList — 固定行高的**窗口化列表**（只渲染视口内那几十行）。
 *
 * 为什么自己写而不引库：这里的两处列表行高是常量（单行、`nowrap`），窗口就是「前缀和 + 二分」；
 * 引一个动态测量的虚拟器反而要处理「测量值抖动 → 滚动跳」。
 *
 * 四条口径：
 * - **行高由调用方给**（`heights`，与 `items` 等长）：列表里混着段标题与文件行，高度不一样，
 *   统一按平均高估会在滚动时越走越偏；
 * - **行数少就不虚拟化**（`threshold`）：几十行时全量渲染更简单，也让测试与键盘 Tab 顺序保持原样；
 * - **量不到视口高度就退化**（`clientHeight === 0`，如 jsdom / 首帧）：全量渲染，绝不留白屏；
 * - 上下留白用两个 `spacer`（占位 div）撑出滚动高度 —— 不用绝对定位，行仍是正常流里的元素。
 *
 * ⚠️ `render` 返回的元素**必须自带 `key`**：这里按数组下标切片渲染，不给 key 就是 React
 * 的「重复 key / 缺 key」告警（本组件不包一层 keyed 容器 —— 多一层 DOM 会打断 flex 布局）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

interface Props<T> {
  items: T[]
  /** 每一项的高度（px），与 `items` 等长 */
  heights: number[]
  render: (item: T, index: number) => ReactNode
  /** 滚动容器自己的类名（`.git-list` / `.git-diff-side`） */
  className?: string
  /** 滚动容器自己的内联样式（差异弹窗的清单宽度就靠它：可拖拽） */
  style?: CSSProperties
  /** 视口外多渲染几行：滚动时减少白边 */
  overscan?: number
  /** 少于这么多项就全量渲染（默认 120） */
  threshold?: number
}

/** 前缀和（`prefix[i]` = 第 i 项之前的总高度） */
function prefixSum(heights: number[]): number[] {
  const prefix = new Array<number>(heights.length + 1)
  prefix[0] = 0
  for (let i = 0; i < heights.length; i += 1) prefix[i + 1] = prefix[i] + heights[i]
  return prefix
}

export function VirtualList<T>({
  items,
  heights,
  render,
  className,
  style,
  overscan = 8,
  threshold = 120,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ scrollTop: 0, height: 0 })

  // 视口高度只在挂载 / 容器尺寸变化时更新；滚动只改 scrollTop
  const sync = useCallback((): void => {
    const el = ref.current
    if (!el) return
    setView((prev) =>
      prev.height === el.clientHeight && prev.scrollTop === el.scrollTop
        ? prev
        : { scrollTop: el.scrollTop, height: el.clientHeight },
    )
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    // ResizeObserver 在 jsdom 里没有 —— 没有它也不影响正确性（退化成全量渲染）
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [sync])

  // ⚠️ 数据到位后容器才有高度（面板挂载时列表是空的，clientHeight = 0）：
  //    只在挂载时量一次会让大列表永远停在「全量渲染」。
  useEffect(() => {
    sync()
  }, [sync, items.length])

  const prefix = useMemo(() => prefixSum(heights), [heights])
  const total = prefix[heights.length] ?? 0
  const virtualized = items.length >= threshold && view.height > 0

  let start = 0
  let end = items.length
  if (virtualized) {
    // 二分找第一项「底部越过视口顶部」的行
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (prefix[mid + 1] <= view.scrollTop) lo = mid + 1
      else hi = mid
    }
    start = Math.max(0, lo - overscan)
    end = items.length
    for (let i = lo; i < items.length; i += 1) {
      if (prefix[i] >= view.scrollTop + view.height) {
        end = Math.min(items.length, i + overscan)
        break
      }
    }
  }

  const padTop = virtualized ? prefix[start] : 0
  const padBottom = virtualized ? Math.max(0, total - prefix[end]) : 0

  return (
    <div className={className} style={style} ref={ref} data-virtualized={virtualized || undefined}>
      {padTop > 0 && <div style={{ height: padTop }} aria-hidden />}
      {items.slice(start, end).map((item, i) => render(item, start + i))}
      {padBottom > 0 && <div style={{ height: padBottom }} aria-hidden />}
    </div>
  )
}

export default VirtualList
