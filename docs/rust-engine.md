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
│    └─ SessionRepo (session_db.rs) ← SQLite 会话/消息直落       │
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
| `tool_executor.rs` | `tool-executor.ts` | 工具步骤执行（桥接 JS）、用户交互 |
| `llm_loop.rs` | `llm-loop.ts` | 「LLM→工具」共享编排 |
| `verifier.rs` | `verifier.ts` | 迭代验证器 |
| `iteration.rs` | `iteration-controller.ts` | 执行→验证→修复循环 |
| `engine.rs` | `engine.ts` | AgentEngine 主类（注入 SessionRepo 持久化） |
| `mod.rs` | — | Tauri 命令注册 + 初始化 |
| `session_db.rs` | `infrastructure/sessionRepo` | 会话/消息 SQLite 直落（SessionRepo trait + SQLite/Noop 实现） |

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
  - `native_tools::tests::test_native_dispatcher_write_read_search`：原生工具分发链路
  - `session_db::tests::*`：SQLite 会话/消息读写、幂等、替换、删除、排序
  - `deepseek_tokenizer::tests::*`：字节级 BPE 与官方 transformers 输出对齐、字节表、切分
  - `provider::tests::*`：本地图片伪视觉分析（imageVisionAnalyzeOptimize）注入、OpenAI/Anthropic 请求体
  - `storm_breaker / run_state / cancellation / verifier / iteration` 单元测试
- TS：`npx tsc --noEmit` 零错误；`npx vitest run` 346 通过

## 八、P2：高价值工具原生 Rust 化

### 已原生化的工具（`native_tools.rs`，无需 JS 桥往返）

| 工具 | 说明 |
|---|---|
| `execute_command` | 风险分类 → 审批 → 原生 spawn + 超时/取消杀进程树 + 终端输出处理 |
| `read_file` / `edit_file` / `write_file` | 复用 `file_ops.rs`（编码检测、hash 冲突检测、父目录创建） |
| `list_files` / `delete_file` / `file_info` / `copy_move_file` | 目录树渲染、回收站、元信息、复制/移动 |
| `search_files_by_name` / `search_text_in_files` | 复用 `search.rs`（ripgrep 内核），支持 glob/正则 |
| `search_knowledge_base` / `list_knowledge_bases` / `list_knowledge_base_documents` | 直接调 `rag::get_service()` |
| `get_knowledge_base_document` / `delete_knowledge_base_document` / `write_to_knowledge_base` | 知识库读写 |

### 安全配置传递（JS → Rust）

`rust-engine.ts` 在 `agent_send_message` 时解析 `resolveSecurityConfig(session)`：
workspace / approvalMode / skipDirs / blacklist / whitelist / skillsDir。
Rust 侧 `NativeToolSecurity` 由 `native_tools::resolve_safe_path` / `is_path_allowed`
执行与前端 `securityService.resolveSafePath` 完全一致的路径校验。
解析失败 → `security=None` → 工具自动回退 JS 桥。

### 原生命令审批协议

```
execute_command 需审批
  → Rust 发 agent:user-interaction-request { type: "confirm_command_native", data: {command, risk, label, hint} }
  → JS createNativeCommandConfirmHandles（复用确认弹窗，不注册 approvalId）
  → 用户「允许」→ 回 {__kind: value, value: "approved"} → Rust 原生执行命令
  → 用户「拒绝」→ cancelled → "[User cancelled]"
  → 用户「暂存」→ shelved → __SHELVED__（暂停，快照保留）
```

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
    async fn append_messages(&self, session_id, messages, updated_at) -> ...;
    async fn replace_messages(&self, session_id, messages, updated_at) -> ...; // 前端压缩等全量替换
    async fn list_sessions(&self) -> ...;
    async fn get_session(&self, session_id) -> ...;
    async fn get_messages(&self, session_id) -> ...;
    async fn delete_session(&self, session_id) -> ...;
}
```

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
| `get_current_time` | `infrastructure/tools/builtin/index.ts` | 简单工具，适合首批原生化 |
| `user_choice` | `infrastructure/tools/builtin/index.ts` | 需用户交互（`UserInteractionRequired` 信号）；`NativeToolOutcome` 已保留交互变体 |
| `web_fetch` | `infrastructure/tools/builtin/web-fetch.ts` | 需处理重定向/超时/HTML→MD |
| `web_search` | `builtin/web-search.ts` + `search-providers/`（tavily/searxng/bocha） | 多搜索提供商适配 |
| `list_skills` | `infrastructure/tools/skill-tools/index.ts` | 技能扫描 |
| `read_skill_source` | `infrastructure/tools/skill-tools/index.ts` | 读取技能源码目录 |
| `vision_analyze`（工具分发） | `infrastructure/tools/vision/index.ts` | 分发走 JS 桥；底层 `vision_service` 已是 Rust Tauri 命令 |

### 4. 系统提示词组装

| 功能 | TS 实现 | Rust 现状 |
|---|---|---|
| `assembleAgentPrompt`（tool-call-spec + core-principles + 环境提示 + 角色/性格 + 技能注入） | `services/agent-service.ts` + `domain/agent/prompts/*.md` | 无；Rust 仅使用前端组装好的 `session.systemPrompt`，为空时回退 `"你是一个有用的 AI 助手。"` |

### 5. 前端职责（天然 JS，无需 Rust 化）

UI 渲染 / 设置管理 / i18n、`export-service` Markdown 导出、`download-service`、
`update-service` 自动更新、`toolOutputStore` 终端输出流、`command-approval` 审批 UI、
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
- `src-tauri/src/agent/native_tools.rs`：新增（约 1500 行，16 个原生工具 + 测试）
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
