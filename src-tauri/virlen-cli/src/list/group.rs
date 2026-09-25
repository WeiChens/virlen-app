//! 分组（纯函数）—— 按 agent / 工作目录把会话分组，顺序与桌面端侧边栏同口径
//!
//! 纯函数单测覆盖：已知 agent → 未知 agent → 未分组 的顺序、工作目录为空归 `__ungrouped__`。

use std::collections::HashMap;
use virlen_core::agent::types::Session;

use super::*;

// ==================== 分组（纯函数） ====================

/// 一个分组视图
#[derive(Debug)]
pub(crate) struct GroupView {
    pub key: String,
    pub name: String,
    pub sessions: Vec<Session>,
}

/// 按维度分组（**保持输入顺序**；输入应为 `updated_at` 降序）。
///
/// 与前端 `groupSessionsByAgent` / `groupSessionsByWorkspace` 同语义：
/// 组间排序 = 已知组按名称升序 → 未知组 → 「未分组」垫底。
pub(crate) fn group_sessions(
    sessions: Vec<Session>,
    by: GroupBy,
    agents: &[AgentLite],
) -> Vec<GroupView> {
    let mut groups: Vec<GroupView> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for session in sessions {
        let key = match by {
            GroupBy::Agent => session.agent_id.clone(),
            GroupBy::Workspace => session.workspace.clone(),
        }
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| UNGROUPED_KEY.to_string());

        let idx = match index.get(&key) {
            Some(i) => *i,
            None => {
                let name = group_name(by, &key, agents);
                groups.push(GroupView {
                    key: key.clone(),
                    name,
                    sessions: Vec::new(),
                });
                let i = groups.len() - 1;
                index.insert(key, i);
                i
            }
        };
        groups[idx].sessions.push(session);
    }

    groups.sort_by(|a, b| {
        let a_un = a.key == UNGROUPED_KEY;
        let b_un = b.key == UNGROUPED_KEY;
        if a_un != b_un {
            return if a_un { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less };
        }
        // 已知 Agent（表里能找到）优先于未知 id —— 与 GUI 的排序规则一致
        if by == GroupBy::Agent {
            let a_known = agents.iter().any(|g| g.id == a.key);
            let b_known = agents.iter().any(|g| g.id == b.key);
            if a_known != b_known {
                return if a_known { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
        }
        a.name.cmp(&b.name)
    });
    groups
}

/// 组显示名：Agent → 表中名称（找不到写「未知代理」）；工作目录 → 原路径
fn group_name(by: GroupBy, key: &str, agents: &[AgentLite]) -> String {
    if key == UNGROUPED_KEY {
        return "未分组".to_string();
    }
    match by {
        GroupBy::Workspace => key.to_string(),
        GroupBy::Agent => agents
            .iter()
            .find(|a| a.id == key)
            .map(|a| {
                if a.name.trim().is_empty() {
                    a.id.clone()
                } else {
                    a.name.clone()
                }
            })
            .unwrap_or_else(|| "未知代理".to_string()),
    }
}
