/**
 * 剪贴板文件路径 — 原生读取 + Ctrl+V 兜底
 *
 * 路径优先问原生要：Windows 上「复制文件」的真身是剪贴板里的 CF_HDROP（资源管理器）
 * 或 code/file-list（VS Code），页面的 DataTransfer 只剩一个没有路径的 File。
 * 原生拿不到时（macOS / Linux / 浏览器调试模式）退回页面给的路径文本。
 */
import { useCallback, useEffect, useRef } from 'react'
import { readClipboardFilePaths } from './hooks'
import { extractPathsFromClipboard } from './helpers'

export function useClipboardFiles(
  acceptPaths: (paths: string[]) => Promise<void>,
) {
  // 本轮 Ctrl+V 是否已经由 paste 事件处理（原生兜底用，见 scheduleClipboardFileFallback）
  const pasteSeenRef = useRef(false)
  const pasteFallbackTimerRef = useRef<number | null>(null)

  /**
   * 把剪贴板里的文件挂成附件
   *
   * @returns 是否真的挂上了附件（调用方据此决定要不要提示用户）
   */
  const acceptClipboardFiles = useCallback(
    async (dt: DataTransfer | null) => {
      const nativePaths = await readClipboardFilePaths()
      const paths =
        nativePaths.length > 0
          ? nativePaths
          : dt
            ? extractPathsFromClipboard(dt)
            : []
      if (paths.length === 0) return false
      await acceptPaths(paths)
      return true
    },
    [acceptPaths],
  )

  /**
   * Ctrl+V 的原生兜底
   *
   * 资源管理器里复制的文件，在 WebView2 里可能连 paste 事件都不触发
   * （对页面而言剪贴板是“空的”，默认粘贴也没东西可插），只在 paste 事件里做就漏一半。
   * 策略：这里不拦默认粘贴，只在下一轮事件循环里确认 paste 事件确实没来、
   * 而剪贴板里真有文件时才补挂一次附件——正常粘贴文字 / 图片完全不受影响。
   */
  const scheduleClipboardFileFallback = useCallback(() => {
    pasteSeenRef.current = false
    if (pasteFallbackTimerRef.current !== null) {
      window.clearTimeout(pasteFallbackTimerRef.current)
    }
    pasteFallbackTimerRef.current = window.setTimeout(() => {
      pasteFallbackTimerRef.current = null
      if (pasteSeenRef.current) return
      void acceptClipboardFiles(null)
    }, 0)
  }, [acceptClipboardFiles])

  // 卸载时清掉待触发的兜底定时器
  useEffect(
    () => () => {
      if (pasteFallbackTimerRef.current !== null) {
        window.clearTimeout(pasteFallbackTimerRef.current)
      }
    },
    [],
  )

  return { acceptClipboardFiles, scheduleClipboardFileFallback, pasteSeenRef }
}
