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
 * 查找一个 run 中第一个**待执行**（pending / running）的 step 索引，用于断点恢复。
 *
 * ⚠️ `failed` 与 `completed` 一样视为「已结束」：两者都已经产出了结果（失败 / 被取消的 step
 * 同样会写一条 tool 结果）。若把 `failed` 也当作断点，恢复时会把它**重跑一遍** →
 * 同一条 toolCallId 产出第二条 tool 结果 → 服务端 400
 *（`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）。
 * 与 Rust `agent/run_state.rs::find_next_step` 同语义（铁律 1）。
 */
export function findNextStep(run: Run): number {
  const index = run.steps.findIndex(
    (s) => s && (s.status === 'pending' || s.status === 'running'),
  )
  return index === -1 ? run.steps.length : index
}
