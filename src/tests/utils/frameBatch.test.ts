/**
 * frameBatch — 帧合批器语义测试
 *
 * 背景：流式回复期间「每个 chunk 通知一次 UI」，每次都 setState 会让 React
 * 渲染次数与 chunk 同量级（trace 实测主线程 98% 被 Render 阶段占满）。
 * 合批后每帧最多渲染一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFrameBatcher } from '@/utils/frameBatch'

/** 手工驱动的 rAF 桩：完全确定性，不依赖 jsdom / fake timers 对 rAF 的处理 */
let rafQueue: Array<() => void>

function flushFrame() {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb()
}

beforeEach(() => {
  rafQueue = []
  let seq = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    seq += 1
    const id = seq
    rafQueue.push(() => cb(id))
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    // 用序号匹配取消：把对应回调置空
    const index = id - 1
    if (index >= 0 && index < rafQueue.length) rafQueue[index] = () => {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createFrameBatcher', () => {
  it('一帧内多次 schedule 只执行一次，且用最后一次的参数', () => {
    const fn = vi.fn()
    const b = createFrameBatcher<[string]>(fn)

    b.schedule('a')
    b.schedule('b')
    b.schedule('c')

    expect(fn).not.toHaveBeenCalled()
    flushFrame()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('c')
  })

  it('跨帧分别执行（每帧一次）', () => {
    const fn = vi.fn()
    const b = createFrameBatcher<[number]>(fn)

    b.schedule(1)
    flushFrame()
    b.schedule(2)
    b.schedule(3)
    flushFrame()

    expect(fn.mock.calls).toEqual([[1], [3]])
  })

  it('flushNow 立即执行，并取消已排队的帧回调（不会重复执行）', () => {
    const fn = vi.fn()
    const b = createFrameBatcher<[string]>(fn)

    b.schedule('x')
    b.flushNow()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('x')

    flushFrame()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel 丢弃待处理调用', () => {
    const fn = vi.fn()
    const b = createFrameBatcher<[string]>(fn)

    b.schedule('x')
    b.cancel()
    flushFrame()
    expect(fn).not.toHaveBeenCalled()
  })

  it('没有待处理调用时 flushNow 什么都不做', () => {
    const fn = vi.fn()
    const b = createFrameBatcher<[string]>(fn)

    b.flushNow()
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel 后仍可继续 schedule', () => {
    const fn = vi.fn()
    const b = createFrameBatcher<[string]>(fn)

    b.schedule('a')
    b.cancel()
    b.schedule('b')
    flushFrame()

    expect(fn.mock.calls).toEqual([['b']])
  })
})
