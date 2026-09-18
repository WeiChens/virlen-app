/**
 * PTY 空闲提示（Step 2 ④）—— `shouldHintIdle` 边界 + `toolOutputStore` 时间戳维护。
 *
 * 为什么要有这组用例：命令长时间无输出（`Read-Host` / 密码提示 / REPL）是 PTY 场景下
 * 最需要提示用户的形态；判定逻辑抽成纯函数是为了能脱离 DOM 直接断言边界
 * （见 docs/pty-research.md §8 Step 2 ④ / 2.5）。
 */
import { describe, it, expect } from 'vitest'
import {
  IDLE_HINT_MS,
  shouldHintIdle,
  toolOutputStore,
} from '@/infrastructure/tools/output-store'

describe('shouldHintIdle（疑似等待输入判定）', () => {
  const now = 1_000_000

  it('未运行 → false（命令结束即无开销）', () => {
    expect(shouldHintIdle(now, now - IDLE_HINT_MS * 10, false)).toBe(false)
  })

  it('无输出记录（lastOutputAt 缺失）→ false', () => {
    expect(shouldHintIdle(now, undefined, true)).toBe(false)
  })

  it('未到阈值（15s - 1ms）→ false', () => {
    expect(shouldHintIdle(now, now - (IDLE_HINT_MS - 1), true)).toBe(false)
  })

  it('恰好到阈值（15s）→ true', () => {
    expect(shouldHintIdle(now, now - IDLE_HINT_MS, true)).toBe(true)
  })

  it('超过阈值（30s）→ true', () => {
    expect(shouldHintIdle(now, now - IDLE_HINT_MS * 2, true)).toBe(true)
  })
})

describe('toolOutputStore.lastOutputAt 维护', () => {
  it('register 与 append 都会打时间戳', () => {
    const id = 't-idle-store'
    toolOutputStore.register(id, { toolName: 'execute_command', output: '' })
    const registered = toolOutputStore.get(id)!.lastOutputAt
    expect(typeof registered).toBe('number')

    toolOutputStore.append(id, 'x')
    const appended = toolOutputStore.get(id)!.lastOutputAt
    expect(typeof appended).toBe('number')
    expect(appended! >= registered!).toBe(true)

    toolOutputStore.remove(id)
    expect(toolOutputStore.get(id)).toBeUndefined()
  })
})

/**
 * Step 2 ①：`pendingConfirm` 必须**替换对象**（而非就地改字段）。
 *
 * UI 侧 `useToolLiveOutput` 靠引用变化触发重渲染；若就地改字段，同一引用 →
 * React 不重渲染 →「待确认命令行」永远不出现。这里把这条契约钉住。
 */
describe('toolOutputStore.pendingConfirm（终端内确认）', () => {
  it('setPendingConfirm / clearPendingConfirm 都替换为新对象并保留其余字段', () => {
    const id = 't-pc'
    toolOutputStore.register(id, {
      toolName: 'execute_command',
      output: '',
      pty: true,
    })
    const before = toolOutputStore.get(id)

    toolOutputStore.setPendingConfirm(id, { command: 'npm login', risk: 'install' })
    const after = toolOutputStore.get(id)
    expect(after).not.toBe(before) // 引用变化 → 触发重渲染
    expect(after!.pendingConfirm?.command).toBe('npm login')
    expect(after!.pty).toBe(true) // 其余字段保留

    toolOutputStore.clearPendingConfirm(id)
    const cleared = toolOutputStore.get(id)
    expect(cleared).not.toBe(after)
    expect(cleared!.pendingConfirm).toBeUndefined()

    toolOutputStore.remove(id)
  })

  it('未注册的 toolCallId 也能写入（自行建档）', () => {
    const id = 't-pc-new'
    toolOutputStore.setPendingConfirm(id, { command: 'ls' })
    expect(toolOutputStore.get(id)?.pendingConfirm?.command).toBe('ls')
    toolOutputStore.remove(id)
  })
})
