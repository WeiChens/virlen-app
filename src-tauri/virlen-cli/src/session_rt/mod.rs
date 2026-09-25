//! 会话运行时 —— `run` 与 `chat` **共用**的「配置装配 + 会话装载」链路，以及一次运行的入参。
//!
//! ## 为什么单独一个模块
//!
//! `run`（无界面跑一次）与 `chat`（交互式 TUI）需要**完全相同**的装配与装载步骤；
//! 复制第二份就会出现"两条路径行为分叉"（本项目铁律 1 的同类问题）。
//! 因此这里只放**与界面无关**的部分：读配置 → 解析 Provider/模型 → 定工作目录 →
//! 组装安全策略与系统提示词 → 取/建会话。
//!
//! ## 顺序即契约（这里踩过真实 bug）
//!
//! **必须「先读会话记录的工作目录，再装配资源」**：反过来的话 cwd 会顶掉会话记录，
//! 于是模型在另一个项目里读写文件，而且该值还会被写回会话（桌面端看到的工作目录也跟着变）。
//! 见 [`resolve_workspace`]。
//!
//! ## 边界
//!
//! - 这里**不碰终端、不渲染**：事件如何呈现（文本 / 状态机）由调用方决定。
//! - 这里**不重实现**安全判定：路径/权限/沙盒规则仍由 `virlen_core::security` 与原生工具负责。


pub(crate) mod resources;
pub(crate) mod session;

// 再导出：调用方（`run.rs` 的 `use crate::session_rt::*;`、`tui` 的具名导入）与
// `run/tests.rs` 的 `use super::*` 都靠它 —— 搬了文件，**调用点一行都没改**。
pub(crate) use self::resources::*;
pub(crate) use self::session::*;

use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use virlen_core::agent::host::HostEnv;
use virlen_core::session_db::{open_session_db, SessionDb};
use virlen_core::agent::types::{
    Message, SendMessageOptions, Session,
};

// ==================== 一次运行的入参 ====================

/// `run` 的选项
#[derive(Debug, PartialEq, Eq, Default)]
pub(crate) struct RunOptions {
    /// 用户输入（位置参数以空格连接）
    pub prompt: String,
    pub session_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub workspace: Option<String>,
    pub append_system_prompt: Option<String>,
    pub max_rounds: Option<i64>,
    pub no_tools: bool,
    pub json: bool,
}

// ==================== 会话运行时 ====================

/// 读一条会话记录的**工作目录** —— 装配与切会话的**第一步**（它是权威值）。
///
/// 单独抽出来只为一个目的：`bootstrap` 与 `activate` 必须走**同一句**错误文案与同一套
/// 失败语义（会话不存在 / 库读失败），否则两条路径对同一种病给两种说法。
async fn recorded_workspace(db: &SessionDb, session_id: &str) -> Result<Option<String>, String> {
    match db.repo.get_session(session_id).await {
        Ok(Some(s)) => Ok(s.workspace),
        Ok(None) => Err(format!(
            "会话不存在: {}（用 `virlen-cli run` 不带 --session 新建一条）",
            session_id
        )),
        Err(e) => Err(format!("读取会话失败: {}", e)),
    }
}

/// 一次会话运行所需的**全部**状态（`run` 与 `chat` 共用）。
///
/// 它把「打开库 → 读配置 → **先读会话记录的工作目录** → 装配资源 → 取/建会话」
/// 这套**顺序敏感**的链路收进一处：调用方只需 `bootstrap`，不必（也不该）自己重排步骤。
///
/// 长驻的 `chat` 额外用 [`Self::activate`] 切会话、[`Self::turn_messages`] 取每回合消息 ——
/// 它们把「重算工作目录与安全策略」这件事也收进了同一处，不给第二次机会写错顺序。
pub(crate) struct SessionRuntime {
    pub(crate) host: Arc<dyn HostEnv>,
    pub(crate) db: SessionDb,
    pub(crate) settings: Map<String, Value>,
    /// 本次运行的输入（会话 id / provider / 模型 / 工作目录 / 系统提示词追加 / 轮数）
    pub(crate) opts: RunOptions,
    pub(crate) cwd: PathBuf,
    pub(crate) resources: Resources,
    pub(crate) session: Session,
    /// 本次交给引擎的消息（续用会话时 = 历史 + 本次用户消息）
    pub(crate) messages: Vec<Message>,
    /// 会话记录里**没有**工作目录（本次用了推出的值、且**未写回会话**）→ 调用方据此提示用户
    pub(crate) workspace_inferred: bool,
}

/// `chat` 的新会话在首次提交前没有标题 —— `/status` 里显示它比显示空白强
pub(crate) const UNTITLED: &str = "(未命名)";

impl SessionRuntime {
    /// 装配一次运行（`run` / `chat` 共用）。
    ///
    /// 返回的 `Err(String)` 已是**可直接展示给用户**的中文句子（含库路径等上下文），
    /// 调用方只需加自己的前缀（CLI 侧统一是 `错误: `）。
    pub(crate) async fn bootstrap(
        host: &Arc<dyn HostEnv>,
        opts: RunOptions,
    ) -> Result<Self, String> {
        let cwd = std::env::current_dir().map_err(|e| format!("无法获取当前目录: {}", e))?;

        // 与 `config` 子命令**同一条**库路径推导链
        let db_path = host.data_dir().join("virlen.db");
        let db = open_session_db(host.as_ref(), &|fut| {
            tokio::spawn(fut);
        })
        .map_err(|e| format!("打开数据库失败 ({}): {}", db_path.display(), e))?;

        let settings = db
            .settings
            .get_all()
            .await
            .map_err(|e| format!("读取配置失败: {}", e))?;

        // ⚠️ 顺序即契约：先读会话记录里的工作目录（它是权威），再装配资源
        let session_workspace: Option<String> = match opts.session_id.as_deref() {
            Some(id) => recorded_workspace(&db, id).await?,
            None => None,
        };

        // 「忽略沙盒命令」规则经 `security` 的统一入口读取（键名 / 解析 / 降级只有一份）
        let sandbox_ignore_rules =
            virlen_core::security::load_sandbox_ignore_rules(db.settings.as_ref()).await;
        let mut resources = build_resources(
            &settings,
            sandbox_ignore_rules,
            &opts,
            &cwd,
            session_workspace.as_deref(),
        )?;

        // 技能目录（推导规则与前端 `skillStore` 一致）—— 不补会让技能相关工具**静默**失效
        resources.security.skills_dir = existing_skills_dir(host);

        let workspace_inferred = opts.session_id.is_some()
            && session_workspace
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty();

        let (session, messages) = load_or_create_session(&db, &resources, &opts).await?;

        Ok(Self {
            host: host.clone(),
            db,
            settings,
            opts,
            cwd,
            resources,
            session,
            messages,
            workspace_inferred,
        })
    }

    /// `chat` 的装配：与 [`Self::bootstrap`] **同一条链**，但只留「历史」。
    ///
    /// 为什么需要它：`bootstrap` 的语义是「一次性运行」—— 它会把 `opts.prompt` 当成
    /// **本次用户消息**塞进 `messages`。`chat` 是长驻的，用户消息在**每回合**由
    /// [`Self::turn_messages`] 现算（且每回合重读库），所以这里把 `bootstrap` 留下的
    /// 「本次用户消息」（此时 prompt 是空串）归一化掉 —— 否则库里会多出一条空用户消息、
    /// 消息计数也会多 1。
    ///
    /// 归一化用**重读库**而不是「清空」：续用 `--session` 时必须拿到真实历史。
    pub(crate) async fn bootstrap_chat(
        host: &Arc<dyn HostEnv>,
        opts: RunOptions,
    ) -> Result<Self, String> {
        let mut rt = Self::bootstrap(host, opts).await?;
        rt.messages = match rt.opts.session_id.as_deref() {
            Some(id) => rt
                .db
                .repo
                .get_messages(id)
                .await
                .map_err(|e| format!("读取会话消息失败: {}", e))?,
            // 新会话：还没有任何已落库的消息
            None => Vec::new(),
        };
        Ok(rt)
    }

    /// 切会话（`None` = 新建一条空会话）——**切会话的唯一入口**。
    ///
    /// `chat` 是长驻的，它可以在会话之间来回跳；而「跳到另一个会话」需要的**不只**是换一个 id：
    /// 工作目录、安全配置（可写根 / 权限三态 / 沙盒规则）、工具定义、系统提示词、
    /// 会话的 Provider 与模型 —— 全都与工作目录挂钩。少做一步就会出现「跳过去了，
    /// 但工作目录还是上一个会话的」这类**静默**错误（桌面端同款教训）。
    /// 因此这里按与 [`Self::bootstrap`] **完全相同**的一条链重算：读记录 → 重算资源 → 重取会话。
    ///
    /// 与 `bootstrap` 的唯一区别：本路径**不带用户消息**（那是每回合现算的，见
    /// [`Self::turn_messages`]），新会话标题也为空（首次提交时补齐）。
    pub(crate) async fn activate(&mut self, session_id: Option<&str>) -> Result<(), String> {
        self.opts.session_id = session_id.map(str::to_string);

        // ① 会话记录的工作目录（续用的权威值；新建时无记录）
        let recorded = match session_id {
            Some(id) => recorded_workspace(&self.db, id).await?,
            None => None,
        };

        // ② 重算资源（工作目录 / 权限 / 沙盒规则 / 工具定义 / 系统提示词都在这一步被重建）
        let rules =
            virlen_core::security::load_sandbox_ignore_rules(self.db.settings.as_ref()).await;
        let mut resources = build_resources(
            &self.settings,
            rules,
            &self.opts,
            &self.cwd,
            recorded.as_deref(),
        )?;
        resources.security.skills_dir = existing_skills_dir(&self.host);
        self.resources = resources;

        self.workspace_inferred = session_id.is_some()
            && recorded.as_deref().map(str::trim).unwrap_or("").is_empty();

        // ③ 取/建会话本体
        match session_id {
            Some(id) => {
                let session = self
                    .db
                    .repo
                    .get_session(id)
                    .await
                    .map_err(|e| format!("读取会话失败: {}", e))?
                    .ok_or_else(|| {
                        format!(
                            "会话不存在: {}（用 `virlen-cli run` 不带 --session 新建一条）",
                            id
                        )
                    })?;
                let history = self
                    .db
                    .repo
                    .get_messages(id)
                    .await
                    .map_err(|e| format!("读取会话消息失败: {}", e))?;
                self.session = session;
                self.messages = history;
            }
            None => {
                self.session = new_session(&self.resources, "");
                self.messages = Vec::new();
            }
        }
        Ok(())
    }

    /// 取本次回合交给引擎的消息：**从库里现读历史** + 本次用户消息。
    ///
    /// 为什么不沿用 `self.messages` 累加：消息是**引擎**先落库再 emit 的
    /// （`engine.rs::send_message_inner`），因此「库里那份」才是唯一权威的历史 ——
    /// 每回合重读一次，天然覆盖「上一回合落库了什么、手工/别的进程改过库」这些情况，
    /// 也不用在 CLI 侧再维护一份可能与库不一致的副本（铁律 1 的同类问题）。
    /// 代价是每回合一次全量查询：本地 SQLite、量级可忽略。
    ///
    /// 首次提交时补齐标题（新会话在 [`Self::activate`] 里是空标题，与桌面端
    /// 「截取首条用户消息」同口径）。
    pub(crate) async fn turn_messages(&mut self, prompt: &str) -> Result<Vec<Message>, String> {
        let now = virlen_core::telemetry::now_ms();
        if self.session.title.trim().is_empty() {
            self.session.title = title_from_prompt(prompt);
        }
        self.session.updated_at = now;

        let mut messages = self
            .db
            .repo
            .get_messages(&self.session.id)
            .await
            .map_err(|e| format!("读取会话消息失败: {}", e))?;
        messages.push(Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: "user".to_string(),
            content: Value::String(prompt.to_string()),
            timestamp: now,
            ..Default::default()
        });
        // 顺手把快照同步到「历史 + 本次用户消息」，与 `bootstrap` 的语义保持一致
        // （`chat` 不直接用它发请求，但 `/status` 的消息计数、以及将来可能的消费方都看它）
        self.messages = messages.clone();
        Ok(messages)
    }

    /// 把当前状态映射成一次 `send_message` 的入参。
    ///
    /// 字段映射**只有这一份**（含 `security: Some(..)` 这条硬要求：缺了它引擎会去等
    /// 一个不存在的 JS 宿主而永久挂起，见 `run.rs` 文件头）。
    pub(crate) fn send_options(&self, messages: Vec<Message>) -> SendMessageOptions {
        SendMessageOptions {
            session: self.session.clone(),
            messages,
            provider: Some(self.resources.provider.clone()),
            tool_defs: self.resources.tool_defs.clone(),
            enable_tools: self.resources.enable_tools,
            max_tokens: Some(self.resources.max_tokens),
            resume_from_snapshot: None,
            reasoning_effort: None,
            max_tool_rounds: self.resources.max_tool_rounds,
            iteration_goal: None,
            max_iterations: self.resources.max_iterations,
            session_id: self.session.id.clone(),
            security: Some(self.resources.security.clone()),
            trace_id: None,
        }
    }
}
