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
import { registerPendingApproval } from '@/infrastructure/tools/execute/common'
import { createNativeCommandConfirmHandles } from '@/services/tool-service/command_confirm'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
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

/**
 * 终端内确认（Step 2 ①）—— 原生审批 handles 的分支：
 * `presentation:"terminal"` 时**不弹 modal**，改写入 toolOutputStore.pendingConfirm；
 * 提交回传改后命令（JSON），取消则 reject `cancelled`；无 presentation 时行为不变。
 */
describe('createNativeCommandConfirmHandles 终端内确认（Step 2 ①）', () => {
  it('presentation=terminal：不弹 modal、写入 pendingConfirm；提交回传改后命令', async () => {
    const handles = createNativeCommandConfirmHandles('s1')
    const shows: any[] = []
    const off = toolInteractEvent.on('showCommandConfirm', (...args) => {
      shows.push(args)
    })

    const p = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      command: 'npm login',
      risk: 'install',
      label: '安装命令',
      hint: 'h',
      tips: 't',
      toolCallId: 'tc-T',
    })

    // 不弹 modal；改在终端块里渲染可编辑命令行
    expect(shows.length).toBe(0)
    expect(toolOutputStore.get('tc-T')?.pendingConfirm?.command).toBe('npm login')

    toolInteractEvent.emit(
      'terminalConfirmSubmit',
      'tc-T',
      'npm login --registry https://x',
    )
    await expect(p).resolves.toBe(
      JSON.stringify({ approved: true, command: 'npm login --registry https://x' }),
    )
    expect(toolOutputStore.get('tc-T')?.pendingConfirm).toBeUndefined()

    off()
    handles.cleanup()
    toolOutputStore.remove('tc-T')
  })

  it('presentation=terminal：取消 → reject cancelled 并清空 pendingConfirm', async () => {
    const handles = createNativeCommandConfirmHandles('s2')
    const p = handles.handler('confirm_command_native', {
      presentation: 'terminal',
      command: 'gh auth login',
      toolCallId: 'tc-C',
    })
    expect(toolOutputStore.get('tc-C')?.pendingConfirm).toBeTruthy()

    toolInteractEvent.emit('terminalConfirmCancel', 'tc-C')
    await expect(p).rejects.toBe('cancelled')
    expect(toolOutputStore.get('tc-C')?.pendingConfirm).toBeUndefined()

    handles.cleanup()
    toolOutputStore.remove('tc-C')
  })

  it('无 presentation：仍走弹窗（showCommandConfirm），行为不变', async () => {
    const handles = createNativeCommandConfirmHandles('s3')
    const shows: any[] = []
    const off = toolInteractEvent.on('showCommandConfirm', (...args) => {
      shows.push(args)
    })
    const p = handles.handler('confirm_command_native', {
      command: 'ls',
      risk: 'safe',
      label: 'L',
      hint: 'h',
      tips: 't',
      toolCallId: 'tc-M',
    })
    expect(shows.length).toBe(1)
    expect(toolOutputStore.get('tc-M')?.pendingConfirm).toBeUndefined()

    // 收尾：模拟用户关闭弹窗，避免 promise 悬挂
    toolInteractEvent.emit('commandReject', 'cancelled')
    await expect(p).rejects.toBeTruthy()

    off()
    handles.cleanup()
  })
})
