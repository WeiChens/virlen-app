import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFY_INTERVAL_MS,
  toolOutputStore,
} from '@/infrastructure/tools/output-store'

/**
 * `toolOutputStore` 输出节流回归。
 *
 * 背景：
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

/**
 * Step 2 ①：`pendingConfirm` 必须**替换为新对象**（而非就地改字段）。
 *
 * UI 侧 `useToolLiveOutput` 靠对象引用变化触发重渲染；若就地改字段，同一引用 →
 * React 不重渲染 →「待确认命令行」永远不出现。这里把这条契约钉住。
 * （原随 `tool-output-idle.test.ts` 一并删除，此处在 output-store 专项测试里补回。）
 */
describe('toolOutputStore.pendingConfirm（终端内确认）', () => {
  const ID = 'tc-pc'

  beforeEach(() => toolOutputStore.remove(ID))
  afterEach(() => toolOutputStore.remove(ID))

  it('setPendingConfirm / clearPendingConfirm 都替换为新对象并保留其余字段', () => {
    toolOutputStore.register(ID, {
      toolName: 'execute_command',
      output: '',
      pty: true,
    })
    const before = toolOutputStore.get(ID)

    toolOutputStore.setPendingConfirm(ID, {
      permName: 'terminal.install.execute',
      title: '终端安装命令执行',
      desc: 'npm login',
      risk: 'install',
    })
    const after = toolOutputStore.get(ID)
    expect(after).not.toBe(before) // 引用变化 → 触发重渲染
    expect(after!.pendingConfirm?.desc).toBe('npm login')
    expect(after!.pendingConfirm?.permName).toBe('terminal.install.execute')
    expect(after!.pty).toBe(true) // 其余字段保留

    toolOutputStore.clearPendingConfirm(ID)
    const cleared = toolOutputStore.get(ID)
    expect(cleared).not.toBe(after)
    expect(cleared!.pendingConfirm).toBeUndefined()
  })

  it('未注册的 toolCallId 也能写入（自行建档）', () => {
    toolOutputStore.setPendingConfirm(ID, { desc: 'ls' })
    expect(toolOutputStore.get(ID)?.pendingConfirm?.desc).toBe('ls')
  })
})

/**
 * `setSandbox` / `register` 对「实际沙盒模式」的读写语义。
 *
 * 背景：终端 header-left 要显示本条命令**实际**的运行模式（Rust 判定，运行中经
 * `agent:tool-env` 事件写入）。两条不变量：
 *  1. `setSandbox` 替换对象引用（否则 UI 的 `useToolLiveOutput` 不重渲染）；同值幂等。
 *  2. `register` 替换 entry 时**不得丢掉**已写入的 sandbox。
 */
describe('toolOutputStore 沙盒模式（sandbox）', () => {
  const ID = 'tc-sandbox'
  beforeEach(() => toolOutputStore.remove(ID))
  afterEach(() => toolOutputStore.remove(ID))

  it('setSandbox 写入；同值不重复通知，变更才逐次通知', () => {
    toolOutputStore.setSandbox(ID, 'write_isolation')
    expect(toolOutputStore.get(ID)?.sandbox).toBe('write_isolation')

    const before = toolOutputStore.get(ID)
    let notified = 0
    const unsub = toolOutputStore.subscribe((id) => {
      if (id === ID) notified++
    })
    toolOutputStore.setSandbox(ID, 'write_isolation') // 同值
    expect(notified).toBe(0)
    expect(toolOutputStore.get(ID)).toBe(before)

    toolOutputStore.setSandbox(ID, 'readonly') // 变更 → 通知 + 新引用
    expect(notified).toBe(1)
    expect(toolOutputStore.get(ID)).not.toBe(before)
    expect(toolOutputStore.get(ID)?.sandbox).toBe('readonly')
    unsub()
  })

  it('register 替换 entry 时保留已写入的 sandbox', () => {
    toolOutputStore.setSandbox(ID, 'no_sandbox_bypass')
    toolOutputStore.register(ID, {
      toolName: 'execute_command',
      output: '',
      pty: true,
    })
    const entry = toolOutputStore.get(ID)
    expect(entry?.sandbox).toBe('no_sandbox_bypass') // 保留旧 sandbox
    expect(entry?.pty).toBe(true) // register 的新字段生效
  })
})
