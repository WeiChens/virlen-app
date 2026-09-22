/**
 * 输入框高度拖拽（完全自包含，只碰 textareaRef + localStorage）
 *
 * ⚠️ 高度模型：拖拽给的是「输入区整体高度」，textarea 拿到的是扣掉
 * INPUT_CHROME_HEIGHT 的净高度。改这里请对照 constants.ts 的说明。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { INPUT_CHROME_HEIGHT, MIN_HEIGHT } from './constants'

export function useInputHeight(
  textareaRef: { current: HTMLTextAreaElement | null },
) {
  const [wrapperHeight, setWrapperHeight] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem('_input_wrapper_height')
      return saved
        ? Math.max(MIN_HEIGHT, Math.min(600, parseInt(saved, 10)))
        : null
    } catch {
      return null
    }
  })
  const isResizing = useRef(false)
  const startYRef = useRef(0)
  const startHRef = useRef(0)
  const [isResizingState, setIsResizingState] = useState(false)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isResizing.current = true
    setIsResizingState(true)
    startYRef.current = e.clientY
    // 量的是 textarea（真正被拉伸的元素），但按「输入区整体高度」记账，与 wrapperHeight 语义一致
    const textareaHeight = textareaRef.current?.offsetHeight ?? 0
    startHRef.current =
      (textareaHeight || MIN_HEIGHT - INPUT_CHROME_HEIGHT) + INPUT_CHROME_HEIGHT

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return
      // drag up = delta positive = taller
      const delta = startYRef.current - ev.clientY
      const newH = Math.max(MIN_HEIGHT, Math.min(600, startHRef.current + delta))
      setWrapperHeight(newH)
    }

    function onMouseUp() {
      if (!isResizing.current) return
      isResizing.current = false
      setIsResizingState(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 持久化高度
  useEffect(() => {
    if (wrapperHeight) {
      try {
        localStorage.setItem('_input_wrapper_height', String(wrapperHeight))
      } catch { }
    }
  }, [wrapperHeight])

  return { wrapperHeight, setWrapperHeight, isResizingState, handleResizeStart }
}
