import { Run, RunSnapshot } from './types'

/**
 * 序列化一个 run 到可持久化的 snapshot
 */
export function runToSnapshot(run: Run): RunSnapshot {
  return {
    assistantMessageId: run.assistantMessageId,
    steps: run.steps,
    round: run.round,
    createdAt: run.createdAt,
    paused: run.paused,
  }
}

/**
 * 从 snapshot 重建 run 元数据
 */
export function snapshotToRun(snapshot: RunSnapshot, sessionId: string): Run {
  return {
    id: `run_${snapshot.assistantMessageId}`,
    sessionId,
    assistantMessageId: snapshot.assistantMessageId,
    steps: snapshot.steps,
    round: snapshot.round,
    createdAt: snapshot.createdAt,
    paused: snapshot.paused,
  }
}

/**
 * 查找一个 run 中第一个未 completed 的 step 索引
 * 用于断点恢复
 */
export function findNextStep(run: Run): number {
  const index = run.steps.findIndex((s) => s && s.status !== 'completed')
  return index === -1 ? run.steps.length : index
}
