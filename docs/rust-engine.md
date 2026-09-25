# Agent 引擎 Rust 移植 — 技术方案与实施记录

## 一、背景与目标

原 `src/domain/engine/`（约 1800 行 TS）实现 agent 聊天循环：
LLM 调用 → 工具执行 → 结果合并 →（迭代模式）验证反馈。

目标：将聊天循环核心逻辑移植到 Rust（Tauri 后端），
同时保证 **平滑过渡**（行为一致、flag 可切换、可随时回退）。

## 二、架构总览

```
┌────────────────────────── 前端 (TS) ──────────────────────────┐
│ chat-service ── getEngine() ──► agentEngine (TS)             │
│                        └──────► rustEngine (rust-engine.ts)   │
│                                        │ invoke               │
│                                        ▼                      │
│  rust-engine-bridge (rust-engine.ts) ◄──► agent:tool-request  │
│    - 工具执行桥 / 用户交互桥 / Provider 桥                      │
└──────────────┬─────────────────────────────────────────────────┘
               │ Tauri invoke + event
┌──────────────▼─────────────────────────────────────────────────┐
│                      Rust 侧 (src-tauri/src/)                  │
│  AgentEngine (agent/engine.rs)                                  │
│    ├─ execute_llm_round (agent/llm_loop.rs)                    │
│    │    ├─ do_llm_round (agent/llm_round.rs)                   │
│    │    │    └─ Provider trait (agent/provider.rs)             │
│    │    │         ├─ NativeOpenAiProvider  (原生 HTTP + SSE)   │
│    │    │         ├─ NativeAnthropicProvider (原生 HTTP + SSE) │
│    │    │         └─ BridgedProvider       (gemini → JS)       │
│    │    └─ execute_tool_steps (agent/tool_executor.rs)         │
│    │         └─ AgentBridgeState (agent/bridge.rs) → JS 工具   │
│    ├─ run_iteration (agent/iteration.rs) + verify (verifier.rs)│
│    └─ SessionRepo (session_db/) ← SQLite 会话/消息直落         │
└────────────────────────────────────────────────────────────────┘
```

## 三、模块清单

| Rust 模块 | 对应 TS | 说明 |
|---|---|---|
| `types.rs` | `src/types/index.ts` + `engine/types.ts` | serde 数据模型（camelCase 对齐） |
| `storm_breaker.rs` | `storm-breaker.ts` | 工具风暴防护（纯逻辑） |
| `run_state.rs` | `run-state.ts` | Run 快照序列化/重建 |
| `cancellation.rs` | — | `CancellationToken`（AtomicBool + Notify） |
| `provider.rs` | `infrastructure/provider/*` | Provider trait + 原生 OpenAI/Anthropic + 桥接 |
| `event_sink.rs` | `onEvent` 回调 | 事件出口（Tauri `app.emit`） |
| `bridge.rs` | — | 双向桥接状态（工具/交互/Provider 流） |
| `llm_round.rs` | `llm-round.ts` | LLM 轮次（流式/非流式、tool_use 收集） |
| `tool_executor.rs` | `tool-executor.ts` | 工具步骤执行（桥接 JS + 原生优先分发）、用户交互 |
| `native_tools/` | `infrastructure/tools/*`（toolRegistry） | 原生工具执行器（18 个，按分类拆子模块，见第八节） |
| `llm_loop.rs` | `llm-loop.ts` | 「LLM→工具」共享编排 |
| `verifier.rs` | `verifier.ts` | 迭代验证器 |
| `iteration.rs` | `iteration-controller.ts` | 执行→验证→修复循环 |
| `engine.rs` | `engine.ts` | AgentEngine 主类（注入 SessionRepo 持久化） |
| `mod.rs` | — | Tauri 命令注册 + 初始化 |
| `session_db/` | `infrastructure/sessionRepo` | 会话/消息 SQLite 直落（`SessionRepo` trait + SQLite/Noop 实现；按职责拆为 types / repo / schema / row / message_query / usage / sqlite / commands / tests） |

## 四、桥接协议

### 事件（Rust → JS，`agent:event`）
载荷 `{ sessionId, event }`，`event` 与 TS `AgentEvent` 完全一致：
`assistant_message_created/updated`、`tool_result_created`、`tool_call`、
`stream_event`、`stream_end`、`error`、`iteration_*`。

前端 `rust-engine.ts` 监听后直接转发给 `onEvent`，
`chat-service.createEventHandler` **零改动复用**。

### 命令（JS → Rust）
| 命令 | 用途 |
|---|---|
| `agent_send_message` | 启动聊天循环（异步，事件流式返回） |
| `agent_cancel` / `agent_get_run_snapshot` / `agent_clear_run_snapshot` | 生命周期/快照 |
| `agent_tool_response` | 工具执行回执 |
| `agent_user_interaction_response` | 用户交互回执 |
| `agent_provider_stream_event` / `agent_provider_stream_done` | Provider 流桥 |

### 工具执行（Rust → JS → Rust）
```
agent:tool-request { requestId, sessionId, toolCallId, toolName, args, skills }
  → JS 用 toolRegistry 执行
  → agent_tool_response { requestId, payload: {__kind, ...} }
payload.__kind: value | error | interaction
payload（error）: { __kind: "error", message, uiData? }
  ⚠️ `error` 也可带 `uiData`：失败与成功同一套「模型侧英文 + UI 侧结构化」语义
  （否则中文界面下只能把模型侧英文失败报告直接贴给用户）。
  TS 侧载体：`domain/tools/types.ts::ToolError`（`CmdError extends ToolError`）。
```

### 用户交互（Rust → JS → Rust）
```
agent:user-interaction-request { requestId, sessionId, type, data }
  → JS 用 chat-service 注册的 session handler（user_choice / confirm_command 弹窗）
  → agent_user_interaction_response { requestId, payload }
payload.__kind: value | error | shelved | cancelled
```

### Provider 桥（仅 gemini / 未原生化的类型）
```
agent:provider-request { requestId, providerType, providerId, apiKey, baseUrl, request, stream }
  → JS 用 createProviderInstance + 现有 provider.chat/chatStream
  → 流式：agent_provider_stream_event 逐条回传；结束 agent_provider_stream_done
  → 非流式：agent_provider_stream_done { result: Message }
```

## 五、Provider 支持矩阵

| 类型 | P1 实现 | 说明 |
|---|---|---|
| `openai` | ✅ 原生 HTTP | 覆盖 OpenAI / DeepSeek / Moonshot / Ollama / 自定义 |
| `anthropic` | ✅ 原生 HTTP | Messages API + SSE |
| `gemini` | 🔄 JS 桥 | 复用现有 TS provider（原生化列入 P2） |

## 六、平滑过渡开关

- `settingsState.useRustEngine`（默认 `true`，设置页「通用 → Rust 原生引擎」）
  - P3 起转正：agent 逻辑与持久化均已 Rust 化，新用户默认开启
  - 老用户升级时做**一次性迁移**（`virlen-rust-engine-migrated`），强制切换一次避免消息不落库
- `chat-service.getEngine()` 按 flag 选择 `rustEngine` 或 `agentEngine`
- 非 Tauri 环境（浏览器 dev / vitest）自动回退 TS 引擎
- 两个引擎实现**同一接口** `AgentEnginePort`，前端零侵入

## 七、测试与验证

- Rust：`cargo test` → 101 通过（agent + RAG + session_db + deepseek_tokenizer + provider）
  - `engine::tests::normal_loop_tool_then_text`：完整循环（LLM→工具→结果→stream_end）
  - `engine::tests::tool_interaction_routes_session`：交互桥 sessionId 路由
  - `engine::tests::cancel_is_not_error_and_keeps_partial`：用户取消不当作错误、partial 保留
  - `native_tools::tests::*` / `native_tools::execute::common::tests::*`：原生工具分发链路、命令风险分类、终端输出解码
  - `native_tools::execute::execute_command::tests::*`：终止/超时杀进程树（真实 spawn 的集成测试）
  - `session_db::tests::*`：SQLite 会话/消息读写、幂等、替换、删除、排序（按 sessions / search / migration / message_query / usage 分文件）
  - `deepseek_tokenizer::tests::*`：字节级 BPE 与官方 transformers 输出对齐、字节表、切分
  - `provider::tests::*`：本地图片伪视觉分析（imageVisionAnalyzeOptimize）注入、OpenAI/Anthropic 请求体
  - `storm_breaker / run_state / cancellation / verifier / iteration` 单元测试
- TS：`npx tsc --noEmit` 零错误；`npx vitest run` 346 通过

## 八、P2：高价值工具原生 Rust 化

### 已原生化的工具（`src-tauri/src/agent/native_tools/`，无需 JS 桥往返）

| 工具 | 说明 |
|---|---|
| `execute_command` | 风险分类 → 审批 → 原生 spawn + 超时/取消杀进程树 + 终端输出处理 |
| `read_file` / `edit_file` / `write_file` | 复用 `file_ops.rs`（编码检测、hash 冲突检测、父目录创建） |
| `list_files` / `delete_file` / `file_info` / `copy_move_file` | 目录树渲染、回收站、元信息、复制/移动 |
| `search_files_by_name` / `search_text_in_files` | 复用 `search.rs`（ripgrep 内核），支持 glob/正则 |
| `search_knowledge_base` / `list_knowledge_bases` / `list_knowledge_base_documents` | 直接调 `rag::get_service()` |
| `get_knowledge_base_document` / `delete_knowledge_base_document` / `write_to_knowledge_base` | 知识库读写 |
| `todo_write` | 任务清单全量替换（无状态；`plan/common.rs` 与 TS `domain/todo/state.ts` 逐字对齐） |
| `user_choice` | 交互请求（`NativeToolOutcome::Interaction` → 同一条用户交互通道，无执行逻辑） |
| `list_messages` / `read_messages` | 消息查询（经 `ctx.repo` 直读 SQLite；`repo.is_available() == false` 时回与 JS 一致的「本地存储不可用」） |
| `list_skills` / `read_skill_source` | 技能列表与源码（扫 `security.skills_dir` + 解析 SKILL.md；不依赖前端 localStorage 注册表 → CLI 可用） |
| `get_current_time` | 当前时间（`chrono-tz` 内置 IANA 库；uiData 只下发 `{ timestamp, timezone }` —— 模型侧英文格式与 `Intl` `en-US` 逐字对齐） |
| `vision_analyze` | 端侧视觉分析（功能三层：`crate::vision` 无 `tauri::` 的核心 + `vision_service.rs` 命令壳 + `native_tools/vision/`；模型目录经 `ctx.host` 定位 —— GUI 与 CLI 共用同一段推理实现） |

目录与 JS `src/infrastructure/tools/` 一一对应：`file/`（8）、`search/`（2）、`execute/`（2）、
`knowledge_base/`（6）、`plan/`（1）、`system/`（2：`user_choice` / `get_current_time`）、
`chat/`（2）、`skill/`（2）、`vision/`（1）；
每个分类一个 `common.rs`（分类内公共）+ 一个工具一个 `.rs`。
`mod.rs` 负责 `is_native_tool` / `execute_native_tool` 分发与 `NativeToolOutcome` / `NativeToolCtx` 定义，
根 `common.rs` 放跨分类公共（`arg_*` 参数取值 + `resolve_safe_path` / `is_path_allowed`）。

### 安全配置传递（JS → Rust）

`rust-engine.ts` 在 `agent_send_message` 时解析 `resolveSecurityConfig(session)`：
workspace / permissions / skipDirs / blacklist / whitelist / skillsDir。
（`permissions` 为权限三态表，取代旧的单一 `approvalMode`；`approvalMode` 字段仍保留用于兼容回退）
Rust 侧 `NativeToolSecurity` 由 `native_tools/common.rs` 的 `resolve_safe_path` / `is_path_allowed`
执行与前端 `securityService.resolveSafePath` 完全一致的路径校验。
解析失败 → `security=None` → 工具自动回退 JS 桥。

### 宿主注入（`NativeToolCtx.host`）

需要「资源目录 / 数据目录在哪」的工具（`vision_analyze` 的模型文件）从 `ctx.host: &dyn HostEnv` 取。

- trait 在 `src-tauri/src/agent/host.rs`（引擎核心内，**零 `tauri::`**），只有两个方法：
  `resource_candidates()`（只读资源的候选根，按优先级）与 `data_dir()`（可写数据根）；
- 实现只有两份：GUI `host::TauriHost`（`resource_dir()` / `app_data_dir()`）、
  CLI `host::CliHost`（`$VIRLEN_RESOURCE_DIR` / `$VIRLEN_DATA_DIR` + exe 位置，
  默认数据根 = `<平台数据根>/JianWeichen.virlen`，**与 GUI 同一个 `virlen.db`**）；
- 注入链：`AgentEngine.host`（构造期） → `ExecuteLlmRoundParams.host` / `RunIterationParams.host`
  → `execute_tool_steps` → `execute_single_step` → `NativeToolCtx.host`；
- 没有注入点的边缘路径（TS 引擎的 `pty_run_command`）回落到 `host::default_host()`；
- 视觉的三层分工：`crate::vision`（定位 / 懒加载 / 推理，**零 `tauri::`**）+
  `vision_service.rs`（Tauri 命令壳）+ `native_tools/vision/`（工具层）——
  共用同一段实现，不会出现两份模型探测逻辑。

### 会话库注入（`NativeToolCtx.repo`）

消息查询工具需要读会话库，因此 `NativeToolCtx` 与 `security` 一样显式注入 `repo: &dyn SessionRepo`：

- Agent 引擎路径：`execute_tool_steps(..., repo)` → `execute_single_step(..., repo)` → ctx（生产为 `SqliteSessionRepo`，SQLite 不可用时为 `NoopSessionRepo`）；
- TS 引擎路径（`run_command_for_ts_engine`）与单测：`native_tools::noop_repo()`（进程级单例）；
- `SessionRepo::is_available()` 是「有无真实持久化后端」的探针（`Noop` 覆写为 `false`），
  消息查询工具据此给出与 JS 路径（`invoke` 报错 → `null`）**逐字一致**的「本地存储不可用」文案。

> 库**在哪**不再由 `tauri::AppHandle` 决定：入口是**零 `tauri::`** 的
> `session_db::commands::open_session_db(host, spawn)`（= `host.data_dir()/virlen.db`，返回
> `SessionDb { repo, settings, maintenance }`）。GUI 薄壳 `init_session_db(app)` 只负责把 `TauriHost`
> 传进去并 `app.manage(...)`；CLI 用 `CliHost` ⇒ 与 GUI 读写**同一份** `virlen.db`（同一份会话 + 同一份配置）。
> 后台任务（历史迁移 / 孤儿消息回收）用宿主传入的 `spawn` 派发，不假设调用方处于 tokio 运行时
> （GUI 的 `.setup()` 里没有 tokio reactor 上下文）。详见 `docs/config-sink-plan.md` §5 S4。

### 原生命令审批协议

```
execute_command 需审批
  → Rust 发 agent:user-interaction-request { type: "confirm_command_native", data: {command, risk, label, hint} }
  → JS createNativeCommandConfirmHandles（复用确认弹窗，不注册 approvalId）
  → 用户「允许」→ 回 {__kind: value, value: "approved"} → Rust 原生执行命令
  → 用户「拒绝」→ cancelled → "[User cancelled]"
  → 用户「暂存」→ shelved → __SHELVED__（暂停，快照保留）
```

「需审批」由**权限三态**决定（`classify.rs::command_decision` + `resolve_decision`）：
`permissions[name]`（`allow`/`ask`/`deny`）优先，缺失回退 legacy `approval_mode`；
`deny` 永远优先；`sandbox:"off"` / `confirm:"terminal"` 强制至少 `ask`。
`deny` 直接报错（`Operation denied by the permission settings: <权限 name>`，模型侧固定英文，
与 TS 执行器逐字对齐），不弹窗；`execute_script` 走独立的 `script.execute`。

### 取消语义改进

原生工具直接持有 `CancellationToken`：
- `execute_command`：取消 → `kill_process_tree(pid)` 立即杀进程树
- 搜索/目录遍历：取消 → 设置 cancel_flag，阻塞任务快速退出
- 知识库写入/查询：spawn_blocking 内检查

**用户取消不当作错误**（P3 修复）：
- `do_llm_round` 捕获 Provider 的 `Err("cancelled")`，保留已收集的部分内容
  → finalize（`streaming:false` 通知前端）→ 正常返回（不向 JS 抛 error）
- 引擎收到 `ctx: None`（取消的部分回复）→ **先落库 partial 消息** → emit `stream_end`
- `execute_tool_loop` 兜底：`cancel.is_cancelled()` 时任何 Err 都正常返回
- 前端 `rust-engine.ts` catch 双保险：`cancelled` 消息不 emit error 事件（不弹 error-banner）
- 工具执行阶段取消：已完成的 tool 结果随本轮落库（execute_tool_steps 返回非 Err）

## 九、会话持久化 SQLite 直落（P3）

### 目标

原持久化链路 `JS 事件 → chat-service → IndexedDB` 绕了 JS 一手：
**即使 JS 卡住/崩溃，也要保证引擎产生的会话/消息由 Rust 侧直接落库。**

### 数据流对比

```
改造前：Rust 引擎 → agent:event → JS 渲染 + sessionRepo → IndexedDB（依赖 JS 存活）
改造后：Rust 引擎 → SessionRepo → SQLite（不依赖 JS）
                        └→ agent:event → JS 仅渲染
```

### 写库点（引擎内部，先落库再 emit）

| 时机 | 内容 |
|---|---|
| `sendMessage` 入口 | upsert 会话元数据 + 用户消息（发送即写） |
| 每轮 `execute_llm_round` 完成 | assistant 消息 + tool 结果消息（消息完成时写一次） |
| 无 tool calls 的最终纯文本回复 | 单独落库（先落库再结束循环） |
| `resume_run`（断点恢复） | 恢复执行产生的 tool 结果 |

流式中间态（`stream_event` / `assistant_message_updated`）仍只用于 UI 渲染，
不在流式过程中落库；消息 finalized 后一次性写入。

### 表结构（`app_data_dir/virlen.db`）

- `sessions`：会话元数据（params / tags / allowed_tools 等 JSON 列）
- `messages`：消息（content / tool_calls / ui_data / usage 等 JSON 列，rowid 排序）
- WAL 模式 + `Mutex<Connection>` 单写连接 + `spawn_blocking`

### SessionRepo 抽象

```rust
pub trait SessionRepo: Send + Sync {
    async fn upsert_session(&self, session: &Session) -> Result<(), String>;
    async fn append_messages(&self, session_id, messages) -> ...;
    async fn replace_messages(&self, session_id, messages) -> ...; // 前端压缩等全量替换
    async fn list_sessions(&self) -> ...;
    async fn get_session(&self, session_id) -> ...;
    async fn get_messages(&self, session_id) -> ...;
    async fn delete_session(&self, session_id) -> ...;
}
```

- ⚠️ **会话时间（`sessions.updated_at`）只由 `upsert_session` 写入**：前端在「用户点击发送」
  的那一瞬间调 `sessionStore.touchSession()` 刷新内存值，随后随会话元数据 upsert 落库。
  `append_messages` / `replace_messages` 刻意**不**刷新它 —— AI 回复、工具结果、迭代反馈、
  上下文压缩都不是用户发言（否则侧边栏显示的时间与列表排序会被 AI 的活动顶掉）。

- 生产：`SqliteSessionRepo`（rusqlite bundled）
- 测试/兜底：`NoopSessionRepo`（不持久化）
- `AgentEngine::with_deps` 注入；`init_agent_engine` 启动时创建 SQLite repo 并 `app.manage`

### Tauri 命令（JS → Rust）

| 命令 | 用途 |
|---|---|
| `cmd_list_sessions` | 启动加载会话列表（不含 messages） |
| `cmd_get_session` / `cmd_get_messages` | 单会话元数据 / 消息 |
| `cmd_upsert_session` | 创建/改名/pin/参数变更 |
| `cmd_delete_session` | 删除会话及其消息 |
| `cmd_replace_session_messages` | 前端上下文压缩后整批替换消息 |

### 前端改造

- `src/infrastructure/sessionRepo/index.ts`：IndexedDB → Rust 命令；`loadAll` 只加载会话元数据（**消息懒加载**，启动不再 N+1 全量拉消息）
- `src/ui/store/sessionStore.ts`：`ensureMessagesLoaded(sessionId)` 懒加载；`loadedMessageIds` 去重；新建会话标记已加载（内存即真相）
- `src/ui/pages/chat/chat-view.tsx`：`handleSelectSession` 会话激活时懒加载消息并刷新 UI
- `src/services/chat-service.ts`：
  - Rust 引擎路径：引擎内部直落，JS 跳过
  - **TS 引擎路径**：`persistMessagesIfNeeded()`（`!isRustEngineEnabled()` 守卫）在
    `addSessionMessage`（用户/assistant/tool 消息）和 `stream_end`（兜底整批）落库
  - `compressContext` 压缩后调 `cmd_replace_session_messages` 落库
- `src/utils/db.ts`：IndexedDB 封装已废弃删除
- 前端只负责渲染 + 会话元数据管理 + TS 引擎路径消息落库；Rust 引擎路径消息落库完全在引擎内部

## 十、已知限制

1. **Gemini 桥接**：未原生 HTTP，仍走 JS provider（且 TS Gemini 存在 #1 多轮工具 bug，可顺带修复）
2. **compressContext** 仍由 TS 引擎提供（非聊天循环核心）；usage 的 token 估算已 Rust 化：
   调用 `deepseek_tokenizer::cmd_count_tokens`（DeepSeek V3 字节级 BPE 精确计数，
   资源 `resources/deepseek_tokenizer/tokenizer.json`，启动后台预热），非 Tauri 环境回退「字符数/4」
3. **`generateTitle` 会话标题生成**：仍由 TS 引擎提供（非聊天循环核心；失败自动回退用户消息截取；
   `thinking: false` 禁用思考，避免 maxTokens 被 reasoning 消耗导致标题为空）
4. **`maxToolRounds` 迭代模式**：#5 旧问题在 Rust 版 iteration 中同样存在（暂未修）
5. **原生 execute_command 无流式输出**：结果在命令结束后一次性返回（JS 桥路径可通过
   `toolOutputStore` 实时刷新终端）。后续可增加 `tool:output` 事件桥
6. **Linux execute_command 未做 unshare 只读保护**（JS 版有 mount namespace 保护技能目录）
7. **`copy_move_file` 跨设备移动**：文件支持 copy+remove 回退；目录跨设备直接报错

### 会话持久化（P3）相关限制

8. **历史 IndexedDB 数据已废弃**：升级后旧会话不迁移（Q2=C 决策），从空库开始
9. **部分前端手动消息操作不落库**：`repairSessionIfNeeded` / `deleteSessionMessage` /
   `clearSessionMessages` 只改内存态，DB 中旧消息可能残留（Rust 引擎路径与 TS 引擎路径的
   `addSessionMessage`/`stream_end` 落库不受影响）
10. **非 Tauri / SQLite 初始化失败**：回退 `NoopSessionRepo`，会话不持久化（聊天功能不受影响）

## 附：JS 端有但 Rust 暂不处理的功能清单

> 以下功能目前由 JS 提供（Rust 引擎通过双向桥 / 直接委托回 JS），
> 作为后续 Rust 化的候选清单。已 Rust 化的功能不在此列。

### 1. Provider 层

| 功能 | TS 实现 | Rust 现状 |
|---|---|---|
| Gemini 原生 HTTP | `infrastructure/provider/gemini.ts` | 无原生，走 JS 桥（`BridgedProvider`） |
| provider `listModels` / `validateApiKey` | 各 TS provider | 无原生（配置 UI 用，非聊天核心） |

### 2. 引擎层

| 功能 | TS 实现 | Rust 现状 |
|---|---|---|
| `compressContext` 上下文压缩 | `domain/engine/compress-context.ts` | 无（TS 提供；usage token 计数已 Rust 化：`cmd_count_tokens`） |
| `generateTitle` 标题生成 | `domain/engine/generate-title.ts` | 无（TS 提供；`thinking:false` 禁用思考） |

### 3. 工具层（`is_native_tool` 未覆盖 → 走 JS 桥）

| 工具 | TS 实现 | 说明 |
|---|---|---|
| `get_current_time` | `infrastructure/tools/system/get-current-time.ts` | ✅ **已原生化**（`native_tools/system/get_current_time.rs`，依赖 `chrono-tz`）：模型侧格式与 `Intl` `en-US` 实测输出逐字对齐；非法时区两侧同一文案 + 结构化 `uiData`（`errorKind`） |
| `user_choice` | `infrastructure/tools/system/user-choice.ts` | ✅ **已原生化**（`native_tools/system/user_choice.rs`）：返回 `NativeToolOutcome::Interaction`，复用同一条用户交互通道 |
| `web_fetch` | `infrastructure/tools/web/web-fetch.ts` | 需处理重定向/超时/HTML→MD |
| `web_search` | `infrastructure/tools/web/web-search.ts` + `search-providers/`（tavily/searxng/bocha） | 多搜索提供商适配 |
| `list_skills` | `infrastructure/tools/skill/list-skills.ts` | ✅ **已原生化**（`native_tools/skill/`）：Rust 直接扫 `security.skills_dir` + 解析 SKILL.md（CLI 无 localStorage）；与 `src/skill/*` + `utils/mdYamlFrontmatter.ts` 逐字镜像（铁律 1） |
| `read_skill_source` | `infrastructure/tools/skill/read-skill-source.ts` | ✅ **已原生化**（`native_tools/skill/`）：目录树 + SKILL.md 全文；路径来自扫盘结果（`skills_dir/<folder>`），不经用户输入拼路径 |
| `todo_write` | `infrastructure/tools/plan/todo-write.ts` | ✅ **已原生化**（`native_tools/plan/`）：无 IO / 无副作用，状态随 `tool_result` 消息的 `content`（给模型）+ `uiData`（给 UI）落库；`common.rs` 与 TS `domain/todo/state.ts` 逐字镜像（铁律 1） |
| `vision_analyze` | `infrastructure/tools/vision/vision-analyze.ts` | ✅ **已原生化**（`native_tools/vision/`）：经 `ctx.host` 定位模型目录后调 `crate::vision`（与 GUI 命令壳**同一段推理实现**）；三条分支与 TS 逐字对齐 —— 缺参 `Err` / 路径不存在 `Value("Error: source path does not exist — …")` / 推理失败 `Error("Vision Error: …")`；已由待办 #22-② 解决（`docs/host-abstraction-draft.md`） |
| `list_messages` / `read_messages`（消息查询） | `infrastructure/tools/chat/*.ts` | ✅ **已原生化**（`native_tools/chat/`）：经 `ctx.repo` 直读 SQLite，不经 JS 桥；文本格式化 / 上限 / 预算与 `tools/chat/common.ts` 逐字镜像（铁律 1） |

### 4. 系统提示词组装

| 功能 | TS 实现 | Rust 现状 |
|---|---|---|
| `assembleAgentPrompt`（tool-call-spec + core-principles + 环境提示 + 角色/性格 + 技能注入） | `services/agent-service.ts` + `domain/agent/compose-prompt.ts` + `domain/agent/prompts/*.md` | **已有 Rust 版组装**（`agent/prompts/assemble.rs`，静态 md 用 `include_str!` 直接引用 TS 侧同一文件，两侧输出由 golden 测试锁定），但**尚未接入引擎 / CLI**——引擎仍只使用前端组装好的 `session.systemPrompt`，为空时回退 `"你是一个有用的 AI 助手。"` |

### 5. 前端职责（天然 JS，无需 Rust 化）

UI 渲染 / 设置管理 / i18n、`export-service` Markdown 导出、`download-service`、
`update-service` 自动更新、`toolOutputStore` 终端输出流、`tools/execute/common.ts` 的审批注册表与终端输出处理、
`search-provider-service` 搜索配置等。

## 十一、实施记录

### P1（引擎循环移植）

- `Cargo.toml`：新增 `reqwest stream` feature、`async-trait`
- `src-tauri/src/agent/`：14 个新模块（约 2000 行 Rust + 测试）
- `src-tauri/src/lib.rs`：注册 agent 模块 + 9 个 Tauri 命令
- `src/services/rust-engine.ts`：适配器 + 双向桥（约 350 行）
- `src/services/chat-service.ts`：`getEngine()` 选择器
- `src/ui/store/settingStore.ts`：`useRustEngine` 开关
- `src/ui/pages/Settings/general-settings.tsx`：设置项 UI

### P2（高价值工具原生化）

- `Cargo.toml`：tokio 增加 `process` / `io-util` / `time`
- `src-tauri/src/agent/native_tools/`：新增（按分类拆分的 18 个原生工具 + 分类 `common.rs` + 测试）
- `src-tauri/src/agent/tool_executor.rs`：原生分发优先 + `NativeToolOutcome` 统一处理
- `src-tauri/src/agent/types.rs`：`NativeToolSecurity` + `SendMessageOptions.security`
- `src-tauri/src/agent/llm_loop.rs` / `iteration.rs` / `engine.rs`：安全配置透传
- `src-tauri/src/file_ops.rs`：新增 `write_file`
- `src-tauri/src/rag/mod.rs`：暴露 `pub fn get_service()`
- `src-tauri/src/search.rs`：`DirEntryType` 派生 `Clone/Copy`
- `src/services/rust-engine.ts`：`resolveSecurityConfig()` 解析安全配置
- `src/services/tool-service/`：新增 `confirm_command_native` 原生审批 handles

### P3（会话持久化 SQLite 直落）

- `Cargo.toml`：新增 `rusqlite = { version = "0.32", features = ["bundled"] }`
- `src-tauri/src/session_db.rs`：新增（SessionRepo trait + Sqlite/Noop 实现 + 7 个测试）
- `src-tauri/src/agent/engine.rs`：注入 `SessionRepo`；3 个写库点（入口用户消息 / 每轮结果 / resume）
- `src-tauri/src/agent/mod.rs`：`init_agent_engine` 创建 SQLite repo + `app.manage`
- `src-tauri/src/lib.rs`：注册 `session_db` 模块 + 6 个命令
- `src/infrastructure/sessionRepo/index.ts`：IndexedDB → Rust 命令
- `src/services/chat-service.ts`：`compressContext` 压缩后落库
- `src/utils/db.ts`：IndexedDB 封装已删除

---

## 十二、「单一权威源」收敛（机制 C，进行中）

**动机**：CLI / headless 需要在**没有 WebView、没有前端**的环境里组装 `tool_defs` 与系统提示词。
若两侧各存一份定义，就会出现本项目最忌讳的「静默分叉」。因此约定：**Rust 侧是权威源，前端从它取值。**

### 12.1 工具定义

| 项 | 位置 | 说明 |
|---|---|---|
| **权威源** | `src-tauri/src/agent/tool_defs/definitions.json` | 28 个工具 × 三平台变体；平台键 `windows`/`macos`/`linux` 与 `std::env::consts::OS`、TS `platformSnapshot()` **同词表**（无需映射表）|
| Rust 读取 | `agent::tool_defs`（`include_str!` + `once_cell` 懒解析）| `list_tool_definitions()` / `list_tool_definitions_for(platform)` / `tool_names()` |
| 前端读取 | Tauri：`cmd_list_tool_definitions`；浏览器 dev / vitest：**直读同一份 JSON** | ✅ 同一份文件 → 不存在「快照漂移」，无需差异检查 |
| 过渡期护栏 | `src/tests/contracts/tool-defs-contract.test.ts` | ④ 之前：TS 定义与权威源逐字比对（`EXPORT_TOOL_DEFS=1` 写回）；④ 之后：换成「**契约 ↔ 执行器一一对应**」|

平台变体的唯一来源是两个工具的描述（`execute_command` / `execute_script` 的“当前终端是 …”那句话）；
其余 26 个工具三平台完全相同。

**进度（① → ④ 已完成）**

- ✅ ① 权威源落盘（从 TS 注册中心一次性导出，随后剔除 `label`）+ ② `cmd_list_tool_definitions`（已在 `lib.rs::generate_handler!` 注册，铁律 4）
- ✅ ③ 前端接入：`infrastructure/tools/definitions-source.ts`（Tauri 走命令；命令失败或非 Tauri 环境降级读**同一份内嵌 JSON**，零漂移）+ `main.ts` 组合根接线；`ToolRegistry` 接口**全异步**（`init()` / `register(name, executor, label?)` / `listDefinitions()`）
- ✅ ④ 28 个工具文件的定义体已摘除（迁移脚本 `scripts/migrate-tool-defs.mjs`，可复现）；`label` 留在 TS（i18n 走 `t()`，Rust 不翻译）；定义专用常量/平台描述函数一并清理
- ✅ 守卫换成「契约 ↔ 执行器一一对应」（契约里有定义→必须有执行器，反之亦然）
- ✅ `AGENTS.md` §5.2 / 铁律 5 / §9.1 / §12 已同步

**改定义的唯一两个入口**

| 要改什么 | 改哪里 |
|---|---|
| 工具的 `description` / 参数 schema | `src-tauri/src/agent/tool_defs/definitions.json`（**三个平台变体都要改**）|
| 执行逻辑 | `src/infrastructure/tools/<分类>/<工具>.ts`（**不写定义**，只 `register(name, executor, label?)`）|

> ⚠️ `toolRegistry.listDefinitions()` 已是**异步**：调用方必须 `await`（引擎、`rust-engine.ts::resolveToolDefs`、`agent-service` 均已改）。

### 12.2 系统提示词

| 项 | 位置 | 说明 |
|---|---|---|
| 静态文本 | `src/domain/agent/prompts/*.md` | **单份**；Rust 用 `include_str!` 直接引用同一路径，**不复制副本** |
| TS 组装 | `src/domain/agent/compose-prompt.ts`（纯函数，无 I/O）| 由 `services/agent-service.ts` 取数后调用 |
| Rust 组装 | `src-tauri/src/agent/prompts/assemble.rs` | `compose_system_prompt()` / `build_project_rules_prompt()` |
| 契约文件 | `src/tests/fixtures/system-prompt.golden.txt` | 两侧共读；TS 用 Vite `?raw`、Rust 运行时按相对路径读 |
| 护栏 | `src/tests/domain/compose-prompt-golden.test.ts` ↔ `prompts::assemble::tests::golden_system_prompt_matches_fixture` | 同一组固定输入下**逐字节相等**；改任一侧都会让另一边失败 |

重组/更新契约：`UPDATE_GOLDEN=1 cargo test --lib golden_system_prompt`（在 `src-tauri` 下）。

⚠️ **行尾**：md 在工作区是 CRLF、Linux CI 是 LF（仓库无 `.gitattributes`），
因此两侧比对先归一化成 LF。若要追求构建产物的字节确定性，
应单独一个提交加 `.gitattributes`（`*.md text eol=lf`）——**不要与功能改动混在一起**。
