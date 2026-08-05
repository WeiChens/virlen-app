/**
 * command-approval 审批注册表测试 — 回归 #2
 *
 * 覆盖场景：
 * - 多个待审批命令同时存在时，确认第一个不会消费第二个的监听
 *   （旧实现：全局 once 监听器会被第一个事件即使不匹配也消费掉）
 * - sessionId / toolCallId 不匹配时不应执行
 * - 用户拒绝后注册表被清理，后续确认无效
 * - run 返回 rejected promise 时应原样交给调用方处理
 */
import { describe, it, expect } from 'vitest'
import toolInteractEvent from '@/events/toolInteractEvent'
import { registerPendingApproval } from '@/infrastructure/tools/builtin/command-approval'
import type { ToolExecutorResponse } from '@/domain/tools/types'

describe('command-approval 审批注册表', () => {
  it('多个待审批命令同时存在时，确认第一个不会消费第二个的监听', async () => {
    const approvalA = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => 'result-A',
    })
    const approvalB = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-B',
      run: async () => 'result-B',
    })

    // 用户先确认 A
    const holderA: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalA, 's1', 'tc-A', holderA)
    expect(holderA.result).not.toBeNull()
    expect(await holderA.result).toBe('result-A')

    // 再确认 B — 修复前 B 的监听会被 A 的事件消费掉，导致 command not found
    const holderB: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalB, 's1', 'tc-B', holderB)
    expect(holderB.result).not.toBeNull()
    expect(await holderB.result).toBe('result-B')
  })

  it('sessionId / toolCallId 不匹配时不应执行', async () => {
    const approvalId = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => 'result-A',
    })
    const holder: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalId, 's2', 'tc-A', holder)
    expect(holder.result).toBeNull()
  })

  it('用户拒绝后注册表被清理，后续确认无效', async () => {
    const approvalId = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => 'result-A',
    })
    toolInteractEvent.emit('userCmdRejected', approvalId, 's1', 'tc-A')

    const holder: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalId, 's1', 'tc-A', holder)
    expect(holder.result).toBeNull()
  })

  it('run 抛错时应把 rejected promise 原样交给调用方（由上层处理）', async () => {
    const approvalId = registerPendingApproval({
      sessionId: 's1',
      toolCallId: 'tc-A',
      run: async () => {
        throw new Error('boom')
      },
    })
    const holder: { result: Promise<ToolExecutorResponse> | null } = {
      result: null,
    }
    toolInteractEvent.emit('userAllowCmd', approvalId, 's1', 'tc-A', holder)
    expect(holder.result).not.toBeNull()
    await expect(holder.result).rejects.toThrow('boom')
  })
})
