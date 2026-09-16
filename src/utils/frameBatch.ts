/**
 * frameBatch — 把「一帧内的高频调用」合并成一次（requestAnimationFrame 合批）
 *
 * 场景：流式回复期间每个 chunk 都通知 UI 更新。若每次都 setState，React 的
 * 渲染次数就等于 chunk 次数（每秒可达上百次）；合并到每帧一次后，渲染上限被
 * 钉在帧率（~60fps），视觉上无差别，但 CPU 曲线是数量级的差别。
 *
 * 语义：
 *  - schedule(...)：记录最新一次参数；若本帧还没排队，就排一个 rAF
 *  - 一帧内多次 schedule → 只执行一次，且用「最后一次」的参数
 *  - flushNow()：立刻执行待处理调用（同步路径需要马上生效时用）
 *  - cancel()：丢弃待处理调用（不执行）
 *
 * 非浏览器环境（无 requestAnimationFrame，如 SSR/部分测试环境）退化为 16ms 定时器。
 */

/** 无 rAF 时的兜底帧间隔 */
const FRAME_MS = 16

interface FrameHandle {
  id: number
  raf: boolean
}

function scheduleFrame(cb: () => void): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    return { id: requestAnimationFrame(() => cb()), raf: true }
  }
  return { id: setTimeout(cb, FRAME_MS) as unknown as number, raf: false }
}

function cancelFrame(handle: FrameHandle): void {
  if (handle.raf) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handle.id)
    }
    return
  }
  clearTimeout(handle.id)
}

export interface FrameBatcher<A extends unknown[]> {
  /** 排队一次调用（一帧内多次调用只执行最后一次的参数） */
  schedule(...args: A): void
  /** 立即执行待处理调用，并取消已排队的帧回调 */
  flushNow(): void
  /** 丢弃待处理调用，不执行 */
  cancel(): void
}

export function createFrameBatcher<A extends unknown[]>(
  fn: (...args: A) => void,
): FrameBatcher<A> {
  let handle: FrameHandle | null = null
  let pending: A | null = null

  const run = () => {
    handle = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }

  return {
    schedule(...args: A) {
      pending = args
      if (handle === null) handle = scheduleFrame(run)
    },
    flushNow() {
      if (handle !== null) {
        cancelFrame(handle)
        handle = null
      }
      run()
    },
    cancel() {
      if (handle !== null) {
        cancelFrame(handle)
        handle = null
      }
      pending = null
    },
  }
}
