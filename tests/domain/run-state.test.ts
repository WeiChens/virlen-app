/**
 * Run State 测试 — Run 生命周期管理
 *
 * 覆盖场景：
 * - runToSnapshot / snapshotToRun 往返一致性
 * - findNextStep 在各种状态下的正确行为
 * - 空步骤列表
 * - 全部已完成
 * - 部分完成
 * - 中间有 failed 状态
 */
import { describe, it, expect } from 'vitest'
import {
  runToSnapshot,
  snapshotToRun,
  findNextStep,
} from '@/domain/engine/run-state'
import type { Run, ToolStep } from '@/domain/engine/types'

function makeStep(overrides: Partial<ToolStep> = {}): ToolStep {
  return {
    toolCallId: 'tc-1',
    toolName: 'test_tool',
    input: {},
    status: 'pending',
    ...overrides,
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    assistantMessageId: 'msg-1',
    steps: [],
    createdAt: 1000,
    paused: false,
    round: 0,
    ...overrides,
  }
}

describe('runToSnapshot / snapshotToRun', () => {
  it('应该能往返转换 Run ↔ RunSnapshot', () => {
    const run = makeRun({
      steps: [
        makeStep({ toolCallId: 'a', status: 'completed', result: 'ok' }),
        makeStep({ toolCallId: 'b', status: 'pending' }),
      ],
      round: 2,
    })

    const snapshot = runToSnapshot(run)
    const restored = snapshotToRun(snapshot, 'session-1')

    expect(restored.id).toBe(`run_${run.assistantMessageId}`)
    expect(restored.sessionId).toBe('session-1')
    expect(restored.assistantMessageId).toBe('msg-1')
    expect(restored.round).toBe(2)
    expect(restored.steps).toHaveLength(2)
    expect(restored.steps[0].status).toBe('completed')
    expect(restored.steps[1].status).toBe('pending')
    expect(restored.paused).toBe(false)
  })

  it('空步骤列表的 run 应正确转换', () => {
    const run = makeRun({ steps: [] })
    const snapshot = runToSnapshot(run)
    const restored = snapshotToRun(snapshot, 'session-x')

    expect(restored.steps).toHaveLength(0)
    expect(restored.sessionId).toBe('session-x')
  })

  it('paused 状态应保留', () => {
    const run = makeRun({ paused: true })
    const snapshot = runToSnapshot(run)
    expect(snapshot.paused).toBe(true)

    const restored = snapshotToRun(snapshot, 's1')
    expect(restored.paused).toBe(true)
  })
})

describe('findNextStep', () => {
  it('空步骤列表应返回 0', () => {
    const run = makeRun({ steps: [] })
    expect(findNextStep(run)).toBe(0)
  })

  it('全部 pending 应返回第一个索引', () => {
    const run = makeRun({
      steps: [makeStep({ status: 'pending' }), makeStep({ status: 'pending' })],
    })
    expect(findNextStep(run)).toBe(0)
  })

  it('全部 completed 应返回 steps.length', () => {
    const run = makeRun({
      steps: [
        makeStep({ status: 'completed' }),
        makeStep({ status: 'completed' }),
      ],
    })
    expect(findNextStep(run)).toBe(2)
  })

  it('部分完成时应返回第一个未完成的索引', () => {
    const run = makeRun({
      steps: [
        makeStep({ toolCallId: 'a', status: 'completed' }),
        makeStep({ toolCallId: 'b', status: 'completed' }),
        makeStep({ toolCallId: 'c', status: 'pending' }),
        makeStep({ toolCallId: 'd', status: 'pending' }),
      ],
    })
    expect(findNextStep(run)).toBe(2)
  })

  it('中间有 failed 且其后的 step 为 pending 应返回 failed', () => {
    const run = makeRun({
      steps: [
        makeStep({ toolCallId: 'a', status: 'completed' }),
        makeStep({ toolCallId: 'b', status: 'failed' }), // failed 也算未完成
        makeStep({ toolCallId: 'c', status: 'pending' }),
      ],
    })
    expect(findNextStep(run)).toBe(1) // 返回 failed 的索引
  })

  it('running 状态也应视为未完成', () => {
    const run = makeRun({
      steps: [
        makeStep({ toolCallId: 'a', status: 'completed' }),
        makeStep({ toolCallId: 'b', status: 'running' }),
      ],
    })
    expect(findNextStep(run)).toBe(1)
  })

  it('空 step 对象应跳过（防御性）', () => {
    const run = makeRun({
      steps: [null as any, makeStep({ status: 'completed' }), undefined as any],
    })
    // null/undefined 的 s && s.status 为 falsy → findIndex 跳过
    // completed 的 s.status !== 'completed' 为 false → findIndex 跳过
    // 所有元素都不匹配 → findIndex 返回 -1 → 函数返回 steps.length = 3
    expect(findNextStep(run)).toBe(3)
  })
})
