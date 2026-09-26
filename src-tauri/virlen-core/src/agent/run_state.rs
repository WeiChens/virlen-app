//! Run 状态管理 — 快照序列化 / 重建 / 断点查找
//!
//! 移植自 `src/domain/engine/run-state.ts`。

use super::types::{Run, RunSnapshot, ToolStepStatus};

/// 序列化一个 run 到可持久化的 snapshot
pub fn run_to_snapshot(run: &Run) -> RunSnapshot {
    RunSnapshot {
        assistant_message_id: run.assistant_message_id.clone(),
        steps: run.steps.clone(),
        round: run.round,
        created_at: run.created_at,
        paused: run.paused,
    }
}

/// 从 snapshot 重建 run 元数据
pub fn snapshot_to_run(snapshot: &RunSnapshot, session_id: &str) -> Run {
    Run {
        id: format!("run_{}", snapshot.assistant_message_id),
        session_id: session_id.to_string(),
        assistant_message_id: snapshot.assistant_message_id.clone(),
        steps: snapshot.steps.clone(),
        round: snapshot.round,
        created_at: snapshot.created_at,
        paused: snapshot.paused,
    }
}

/// 查找一个 run 中第一个**待执行**（pending / running）的 step 索引（用于断点恢复）
///
/// ⚠️ `failed` 与 `completed` 一样视为「已结束」：两者都已经产出了结果（见 `tool_executor`，
/// 失败 / 被取消的 step 同样会写一条 tool 结果并落库）。若把 `failed` 也当作断点，
/// 恢复时会把它**重跑一遍** → 同一条 tool_call_id 产出第二条 tool 结果 → 服务端 400。
pub fn find_next_step(run: &Run) -> usize {
    run.steps
        .iter()
        .position(|s| {
            matches!(
                s.status,
                ToolStepStatus::Pending | ToolStepStatus::Running
            )
        })
        .unwrap_or(run.steps.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::ToolStep;
    use serde_json::Value;

    fn make_step(status: ToolStepStatus) -> ToolStep {
        ToolStep {
            tool_call_id: format!("tc_{:?}", status),
            tool_name: "tool".into(),
            input: Value::Null,
            status,
            result: None,
            error: None,
            started_at: None,
            ui_data: None,
        }
    }

    fn make_run() -> Run {
        Run {
            id: "run_1".into(),
            session_id: "s1".into(),
            assistant_message_id: "am1".into(),
            steps: vec![
                make_step(ToolStepStatus::Completed),
                make_step(ToolStepStatus::Pending),
                make_step(ToolStepStatus::Pending),
            ],
            created_at: 0,
            paused: false,
            round: 1,
        }
    }

    #[test]
    fn find_next_step_skips_completed() {
        let run = make_run();
        assert_eq!(find_next_step(&run), 1);
    }

    /// `failed` 同样视为「已结束」（已经产出过 tool 结果），不能再当断点重生。
    #[test]
    fn find_next_step_skips_failed_too() {
        let run = Run {
            steps: vec![
                make_step(ToolStepStatus::Completed),
                make_step(ToolStepStatus::Failed),
                make_step(ToolStepStatus::Running),
            ],
            ..make_run()
        };
        assert_eq!(find_next_step(&run), 2);
    }

    #[test]
    fn find_next_step_none_pending_returns_len() {
        let run = Run {
            steps: vec![
                make_step(ToolStepStatus::Completed),
                make_step(ToolStepStatus::Failed),
            ],
            ..make_run()
        };
        assert_eq!(find_next_step(&run), 2);
    }

    #[test]
    fn find_next_step_all_completed() {
        let run = Run {
            steps: vec![
                make_step(ToolStepStatus::Completed),
                make_step(ToolStepStatus::Completed),
            ],
            ..make_run()
        };
        assert_eq!(find_next_step(&run), 2);
    }

    #[test]
    fn snapshot_roundtrip() {
        let run = make_run();
        let snap = run_to_snapshot(&run);
        let rebuilt = snapshot_to_run(&snap, "s1");
        assert_eq!(rebuilt.id, "run_am1");
        assert_eq!(rebuilt.session_id, "s1");
        assert_eq!(rebuilt.steps.len(), 3);
        assert_eq!(rebuilt.round, 1);
    }
}
