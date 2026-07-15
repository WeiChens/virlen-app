/**
 * withCancel — 为 Promise 添加 AbortSignal 取消支持
 *
 * 函数：
 *   1. withCancelResult(signal, promise<T>, cancelCallback) => Promise<T>
 *      取消时执行 cancelCallback 返回兜底值
 *
 *   2. timeoutWithSignal(timeoutMs, abortSignal?) => { signal, cancel }
 *      创建一个 AbortController，同时连接到外部 abortSignal，
 *      超时后自动 abort。返回 signal 和 cancel 清理函数。
 *
 * 用法（推荐 withCancelResult）：
 *   const results = await withCancelResult(
 *     ctx.abortSignal,
 *     invoke('some_command', args),
 *     () => [],
 *   )
 */

/**
 * withCancelResult — 取消时执行 cancelCallback 返回兜底值，不抛异常
 */
export async function withCancelResult<T>(
  abortSignal: AbortSignal,
  promise: Promise<T>,
  cancelCallback: () => T,
): Promise<T> {
  if (abortSignal.aborted) {
    return cancelCallback()
  }

  const cancelPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error('__CANCELLED__'))
    abortSignal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([promise, cancelPromise])
  } catch (e: any) {
    if (e.message === '__CANCELLED__') {
      return cancelCallback()
    }
    throw e
  }
}

/**
 * timeoutWithSignal — 带超时的 AbortSignal 工厂
 *
 * 创建一个新的 AbortController，同时绑定到外部 abortSignal。
 * 外部 abort 或超时任一触发都会取消。返回 { signal, cancel }。
 * cancel() 用于提前清理（清除定时器、解绑监听）。
 *
 * 用法：
 *   const { signal, cancel } = timeoutWithSignal(10000, ctx.abortSignal)
 *   try {
 *     const res = await fetch(url, { signal })
 *   } finally {
 *     cancel()
 *   }
 */
export function timeoutWithSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController()

  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)

  const onExternalAbort = () => {
    ctrl.abort('external_cancelled')
  }
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  const cancel = () => {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }

  return { signal: ctrl.signal, cancel }
}
