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
│                      Rust 侧 (src-tauri/src/agent/)            │
│  AgentEngine (engine.rs)                                       │
│    ├─ execute_llm_round (llm_loop.rs)                          │
│    │    ├─ do_llm_round (llm_round.rs)                         │
│    │    │    └─ Provider trait (provider.rs)                   │
│    │    │         ├─ NativeOpenAiProvider  (原生 HTTP + SSE)   │
│    │    │         ├─ NativeAnthropicProvider (原生 HTTP + SSE) │
│    │    │         └─ BridgedProvider       (gemini → JS)       │
│    │    └─ execute_tool_steps (tool_executor.rs)               │
│    │         └─ AgentBridgeState (bridge.rs) → JS 工具执行     │
│    ├─ run_iteration (iteration.rs) + verify (verifier.rs)      │
│    └─ 快照/取消管理 (run_state.rs / cancellation.rs)            │
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
| `engine.rs` | `engine.ts` | AgentEngine 主类 |
| `mod.rs` | — | Tauri 命令注册 + 初始化 |

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

- `settingsState.useRustEngine`（默认 `false`），设置页「通用 → Rust 原生引擎」
- `chat-service.getEngine()` 按 flag 选择 `rustEngine` 或 `agentEngine`
- 非 Tauri 环境（浏览器 dev / vitest）自动回退 TS 引擎
- 两个引擎实现**同一接口** `AgentEnginePort`，前端零侵入

## 七、测试与验证

- Rust：`cargo test` → 83 通过（34 agent + 49 既有 RAG）
  - `engine::tests::normal_loop_tool_then_text`：完整循环（LLM→工具→结果→stream_end）
  - `engine::tests::tool_interaction_routes_session`：交互桥 sessionId 路由
  - `native_tools::tests::test_native_dispatcher_write_read_search`：原生工具分发链路
  - `storm_breaker / run_state / cancellation / verifier / iteration` 单元测试
- TS：`npx tsc --noEmit` 零错误；`npx vitest run` 325 通过

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

## 九、已知限制

1. **Gemini 桥接**：未原生 HTTP，仍走 JS provider（且 TS Gemini 存在 #1 多轮工具 bug，可顺带修复）
2. **compressContext** 仍由 TS 引擎提供（非聊天循环核心）
3. **`maxToolRounds` 迭代模式**：#5 旧问题在 Rust 版 iteration 中同样存在（暂未修）
4. **图片视觉分析优化字段**（`imageVisionAnalyzeOptimize`）原生 OpenAI 请求未注入分析结果
   （JS 桥路径不受影响）
5. **原生 execute_command 无流式输出**：结果在命令结束后一次性返回（JS 桥路径可通过
   `toolOutputStore` 实时刷新终端）。后续可增加 `tool:output` 事件桥
6. **Linux execute_command 未做 unshare 只读保护**（JS 版有 mount namespace 保护技能目录）
7. **`copy_move_file` 跨设备移动**：文件支持 copy+remove 回退；目录跨设备直接报错

## 十、实施记录

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
