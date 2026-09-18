import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFY_INTERVAL_MS,
  toolOutputStore,
} from '@/infrastructure/tools/output-store'

/**
 * `toolOutputStore` 输出节流回归。
 *
 * 背景（见 docs/terminal-live-output-investigation.md）：
 * 只做「前沿节流」会丢帧 —— 落在同一 50ms 窗口内的后续分片永不补发。交互式命令
 * （`npm init`）刷一波就停在等输入，尾片（无换行的提示符 `package name: (wei) `）
 * 恰好落在窗口内 → 一直不上屏，**要等用户敲一个键才被顺带刷出来**。
 * 这里钉住「前沿节流 + 尾沿补发」的语义。
 */
describe('toolOutputStore 输出节流（前沿 + 尾沿补发）', () => {
  const ID = 'tc-out'
  /** 非 0 基准时间：`lastNotify` 缺省 0 时首片必须仍算「已过窗口」→ 立即通知 */
  const T0 = 1_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    toolOutputStore.remove(ID)
  })

  afterEach(() => {
    toolOutputStore.remove(ID)
    vi.useRealTimers()
  })

  /** 订阅并记录每次通知时看到的「全量输出」 */
  function collect() {
    const seen: string[] = []
    const unsub = toolOutputStore.subscribe((id, out) => {
      if (id === ID) seen.push(out.output)
    })
    toolOutputStore.register(ID, { toolName: 'execute_command', output: '' })
    seen.length = 0 // 丢弃 register 自身那次通知
    return { seen, unsub }
  }

  it('窗口内的后续分片不逐条通知，但窗口结束补发最新全量（尾片不丢）', () => {
    const { seen, unsub } = collect()

    // 三片都落在同一窗口内
    toolOutputStore.append(ID, 'a')
    toolOutputStore.append(ID, 'b')
    toolOutputStore.append(ID, 'c')
    expect(seen).toEqual(['a']) // 只有前沿那一片

    // 窗口结束 → 尾沿补发（这正是 `npm init` 提示符上屏所依赖的那一次）
    vi.advanceTimersByTime(NOTIFY_INTERVAL_MS)
    expect(seen[seen.length - 1]).toBe('abc')
    expect(seen).toEqual(['a', 'abc'])
    unsub()
  })

  it('间隔 ≥ 窗口时逐条通知', () => {
    const { seen, unsub } = collect()

    toolOutputStore.append(ID, 'a')
    vi.advanceTimersByTime(NOTIFY_INTERVAL_MS)
    toolOutputStore.append(ID, 'b')
    vi.advanceTimersByTime(NOTIFY_INTERVAL_MS)
    toolOutputStore.append(ID, 'c')
    expect(seen).toEqual(['a', 'ab', 'abc'])
    unsub()
  })

  it('flush 立即刷新并取消未触发的尾沿', () => {
    const { seen, unsub } = collect()

    toolOutputStore.append(ID, 'a')
    toolOutputStore.append(ID, 'b')
    toolOutputStore.flush(ID)
    const afterFlush = seen.length
    expect(seen[seen.length - 1]).toBe('ab')

    // 尾沿已被取消 → 窗口过后不再补发
    vi.advanceTimersByTime(NOTIFY_INTERVAL_MS * 2)
    expect(seen.length).toBe(afterFlush)
    unsub()
  })

  it('remove 后不再补发', () => {
    const { seen, unsub } = collect()

    toolOutputStore.append(ID, 'a')
    toolOutputStore.append(ID, 'b')
    toolOutputStore.remove(ID)
    const afterRemove = seen.length

    vi.advanceTimersByTime(NOTIFY_INTERVAL_MS * 2)
    expect(seen.length).toBe(afterRemove)
    unsub()
  })

  it('register 会取消上一个会话遗留的尾沿（不会把旧内容补发出来）', () => {
    const { seen, unsub } = collect()

    toolOutputStore.append(ID, 'a') // 前沿：立即通知
    toolOutputStore.append(ID, 'b') // 窗口内：挂尾沿
    toolOutputStore.register(ID, { toolName: 'execute_command', output: '' })
    seen.length = 0

    vi.advanceTimersByTime(NOTIFY_INTERVAL_MS * 2)
    expect(seen).toEqual([])
    unsub()
  })
})
