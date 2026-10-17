/**
 * useSideWidth — 差异弹窗「左清单宽度」：**右侧可拖拽**，并记在 localStorage（下次打开沿用）。
 *
 * 三条口径：
 * - 拖的是**分隔条**（`role="separator"`），不是清单本身 —— 清单里到处是行，拖行会与点行冲突；
 * - 宽度有上下限（[`SIDE_MIN`] / [`SIDE_MAX`]）：拖到 0 会让清单消失，拖太宽会把差异挤没；
 * - 键盘也能调（分隔条聚焦后 ← →）：纯鼠标的调整方式对键盘用户等于不存在。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'

/** 左清单宽度（px） */
export const SIDE_MIN = 180
export const SIDE_MAX = 640
const SIDE_DEFAULT = 260
const KEY = 'virlen-git-side-width'

function readStored(): number {
  try {
    const raw = localStorage.getItem(KEY)
    const value = raw ? Number(raw) : NaN
    if (!Number.isFinite(value)) return SIDE_DEFAULT
    return Math.min(SIDE_MAX, Math.max(SIDE_MIN, value))
  } catch {
    // 隐私模式 / 存储被禁：用默认宽度，不影响使用
    return SIDE_DEFAULT
  }
}

function persist(width: number): void {
  try {
    localStorage.setItem(KEY, String(width))
  } catch {
    // 存不下就算了（只是「下次打开忘了宽度」）
  }
}

export interface SideWidth {
  width: number
  /** 正在拖（宿主据此加 `.is-resizing`：禁选中、光标变 col-resize） */
  resizing: boolean
  startResize: (e: React.MouseEvent) => void
  /** 分隔条键盘调整（← →） */
  nudge: (delta: number) => void
}

export function useSideWidth(): SideWidth {
  const [width, setWidth] = useState(readStored)
  const [resizing, setResizing] = useState(false)
  /** 拖动中的最新宽度（mouseup 时落盘，mousemove 不写 localStorage） */
  const liveRef = useRef(width)

  const apply = useCallback((next: number): void => {
    const clamped = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(next)))
    liveRef.current = clamped
    setWidth(clamped)
  }, [])

  const nudge = useCallback(
    (delta: number) => {
      apply(liveRef.current + delta)
      persist(liveRef.current)
    },
    [apply],
  )

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      // ⚠️ 别让宿主的「点浮层外关闭」把这次 mousedown 当成点在外面
      e.stopPropagation()
      const handle = e.currentTarget as HTMLElement
      const aside = handle.previousElementSibling as HTMLElement | null
      // 以清单左边界为基准：宽度 = 指针位置 − 左边界（用 getBoundingClientRect 而不是宽度差，
      // 弹窗在页面里可能是居中 / 被拖动过的）
      const left = aside?.getBoundingClientRect().left ?? 0
      setResizing(true)

      const onMove = (ev: MouseEvent) => apply(ev.clientX - left)
      const onUp = (): void => {
        setResizing(false)
        persist(liveRef.current)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [apply],
  )

  // 组件卸载（关弹窗）时把松手事件摘掉，免得监听漏在 document 上
  useEffect(() => {
    return () => {
      persist(liveRef.current)
    }
  }, [])

  return { width, resizing, startResize, nudge }
}

/** 分隔条（两个弹窗共用）：视觉 4px，命中区靠两侧 2px 的伪元素撑到 8px */
export function SideResizer({ side }: { side: SideWidth }) {
  return (
    <div
      className="git-diff-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('调整清单宽度')}
      tabIndex={0}
      onMouseDown={side.startResize}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        side.nudge(e.key === 'ArrowLeft' ? -20 : 20)
      }}
    />
  )
}
