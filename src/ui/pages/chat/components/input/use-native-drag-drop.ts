/**
 * 原生拖放（能拿到真实路径）
 *
 * 事件来自 Rust 的 drag_drop 模块（自定义 OLE 拖放目标），按落点是否在输入框内决定接不接。
 * 仅在 Tauri 环境生效；浏览器调试模式走页面的 HTML5 drop（拿不到路径）。
 */
import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'
import { isTauriEnv, type DragDropPayload } from './helpers'

export function useNativeDragDrop({
  acceptPaths,
  wrapperRef,
  setIsDragOver,
}: {
  acceptPaths: (paths: string[]) => Promise<void>
  wrapperRef: { current: HTMLDivElement | null }
  setIsDragOver: (v: boolean) => void
}) {
  useEffect(() => {
    if (!isTauriEnv()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    /** 落点是否在输入框内（事件给的是物理像素，需换算成 CSS 像素） */
    const isInsideInput = (position: { x: number; y: number }) => {
      const el = wrapperRef.current
      if (!el) return false
      const rect = el.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const x = position.x / ratio
      const y = position.y / ratio
      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      )
    }

    listen<DragDropPayload>('virlen:drag-drop', (event) => {
      const payload = event.payload
      if (payload.type === 'enter' || payload.type === 'over') {
        setIsDragOver(isInsideInput(payload.position))
      } else if (payload.type === 'leave') {
        setIsDragOver(false)
      } else if (payload.type === 'drop') {
        setIsDragOver(false)
        // 拖进来的不是文件（如拖选中的文本）：paths 为空，交给系统/页面原有行为，不插手
        if (!payload.paths || payload.paths.length === 0) return
        // 落在输入框外：不静默丢弃，给个提示，否则用户会以为功能没生效
        if (!isInsideInput(payload.position)) {
          showToast(t('请把文件拖到输入框内'))
          return
        }
        void acceptPaths(payload.paths)
      }
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {
        // 非 Tauri 环境 / 事件不可用
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptPaths])
}
