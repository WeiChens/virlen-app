/**
 * withCancel — 为 Promise 添加 AbortSignal 取消支持。
 *  - withCancelResult(signal, promise, cancelCallback)：取消时执行 cancelCallback 返回兜底值
 *  - timeoutWithSignal(timeoutMs, abortSignal?)：建 AbortController 并连接外部 signal，超时自动 abort
 */

/**
 * withCancelResult — 取消时执行 cancelCallback 返回兜底值，不抛异常。
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
 * timeoutWithSignal — 带超时的 AbortSignal 工厂：创建 AbortController 并绑定外部 signal，外部 abort 或超时
 * 任一触发即取消。返回 { signal, cancel }，cancel() 用于提前清理（清定时器、解绑监听）。
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
