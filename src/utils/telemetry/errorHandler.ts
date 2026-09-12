/**
 * telemetry/errorHandler — 全局错误捕获（§5.9 / §9）
 *
 * 安装 window.onerror / unhandledrejection，统一走 trackError。
 * 由 main.ts 在启动时调用一次。
 *
 * 仅处理 JS 运行时错误：资源加载类 error 事件（无 message）忽略，避免噪声。
 */
import { toErrorInfo, track } from './index'

let installed = false

/** 是否为 Tauri/混合环境的 JS 未捕获错误 */
function isRuntimeErrorEvent(e: ErrorEvent): boolean {
  return !!e && (!!e.message || !!e.error)
}

/**
 * 安装全局错误监听（仅一次）
 */
export function installGlobalErrorHandlers(): void {
  if (installed) return
  if (typeof window === 'undefined') return
  installed = true

  // 未捕获异常
  window.addEventListener('error', (ev) => {
    try {
      const e = ev as ErrorEvent
      // 资源加载错误（如 img/script 404）没有 message/error，忽略
      if (!isRuntimeErrorEvent(e)) return
      const info = toErrorInfo(e.error ?? e.message)
      track(
        'error.uncaught',
        {
          message: info.message,
          stack: info.stack,
          source: e.filename ? String(e.filename) : undefined,
          line: typeof e.lineno === 'number' ? e.lineno : undefined,
          col: typeof e.colno === 'number' ? e.colno : undefined,
        },
        {},
      )
    } catch {
      // 忽略
    }
  })

  // 未处理的 Promise rejection
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const e = ev as PromiseRejectionEvent
      const info = toErrorInfo(e.reason)
      track(
        'error.unhandledrejection',
        { reason: info.message, stack: info.stack },
        {},
      )
    } catch {
      // 忽略
    }
  })
}

/** 供 React ErrorBoundary 调用 */
export function reportReactError(error: unknown, componentStack?: string): void {
  const info = toErrorInfo(error)
  track(
    'error.react.boundary',
    {
      component: componentStack ? componentStack.split('\n')[1]?.trim() : undefined,
      error: info.message,
      componentStack: componentStack || info.stack,
    },
    {},
  )
}
