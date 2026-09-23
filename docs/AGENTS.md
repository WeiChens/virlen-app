# AGENTS.md — Virlen 项目总览（架构地图 · 契约 · 开发约定）

> 本文件是本仓库的**事实来源（source of truth）**，面向 AI 编码代理与人类协作者。
> 定位是「**先给全局，再给重点**」：第 1–5 章先建立项目的大局观与运行时全景，
> 第 6 章起才是目录、铁律、红线、手册、常见坑等**动手前必读**的约束。
> 与 `README.md` 冲突时以本文件 + 代码现状为准（README 存在若干过期描述，见 §11.3）。
>
> **深读入口（细节已下沉，不在本文件展开）**
> - `docs/rust-engine.md` —— 引擎未 Rust 化清单与双引擎差异
> - `docs/pty-research.md` —— Windows ConPTY / 终端交互完整设计
> - `docs/sandbox-implementation-plan.md` —— 跨平台沙盒实现
> - `docs/埋点上报数据设计.md` —— 埋点事件与字段规范

---

## 0. 30 秒导读

**Virlen（未霖）**是一个基于 **Tauri v2** 的跨平台 **AI Agent 桌面客户端**——不是聊天壳，而是「**可扩展的 Agent 运行平台**」：多模型接入、可插拔工具、本地视觉/RAG/Skill、多层安全、以及一套 **TS + Rust 双实现的 Agent 引擎**。

理解本项目，抓住四条主线即可：

1. **内核是「Agent 循环」**——LLM 轮次 → 工具执行 → 迭代验证 → 循环，直到收敛（见 §4、§5.1）。
2. **能力靠「工具」扩展**——工具是「定义 + 执行器」分离的注册制，可 JS 实现、也可 Rust 原生化（见 §5.2）。
3. **安全贯穿全文**——路径黑白名单 / 权限三态 / 跨平台沙盒 / 工具风暴防护四道闸（见 §5.4、§8）。
4. **双引擎是最大与众不同点**——同一套语义有两份实现，改语义必须两侧同步（见 §5.1、§7 铁律 1）。

---

## 1. 项目是什么

一个「**全能型 AI 智能体桌面客户端**」，核心能力矩阵：

| 能力域 | 说明 |
|---|---|
| **多 Provider** | OpenAI 兼容 / Anthropic / Gemini；支持自定义 Base URL、自定义 Header、`reasoningEffort` |
| **Function Calling** | 文件读写、命令执行、网页抓取、搜索、视觉分析、知识库、会话消息检索共 9 大类 27 个工具 |
| **端侧视觉引擎** | `quasivision` ONNX 纯本地推理：UI 元素检测 / PP-OCR v5 / YOLOE-26n 物体检测 / 图标分类（图片不出本机） |
| **Skill 机制** | `SKILL.md` 领域知识包，注入系统提示词 + 源码目录只读可查 |
| **多层安全** | 路径黑白名单、权限三态、跨平台 Shell 沙盒、工具风暴防护（StormBreaker） |
| **会话与记忆** | 暂停/恢复（Run Snapshot）、LLM 上下文压缩、本地 RAG（turbovec 向量索引）、用量账本 |
| **双 Agent 引擎** | Rust 原生引擎（默认，`src-tauri/src/agent/`）+ TS 引擎（回退，`src/domain/engine/`） |

---

## 2. 技术栈全景

| 层 | 技术 |
|---|---|
| 前端 | React 19、TypeScript（`strict: true` 但 `strictNullChecks: false`）、Vite 7、MobX 6（`mobx` / `mobx-react-lite`）、Sass、react-markdown + remark-gfm、PrismJS、Monaco、turndown + cheerio、JSZip、`@tanstack/react-virtual`、echarts、xterm |
| 测试 | Vitest 4（jsdom，全局 `vi`）；Rust 内联 `#[cfg(test)] mod tests` |
| 后端 | Tauri 2、Tokio、Serde、rusqlite（bundled, WAL）、reqwest（原生 SSE）、turbovec + text-splitter（RAG）、grep/walkdir/ignore（文件搜索）、sha2、trash、quasivision、image、pdf-extract |
| 包管理 | pnpm（`pnpm-workspace.yaml` 需 `allowBuilds: esbuild/@parcel/watcher`） |

**平台相关依赖**按 `[target.'cfg(...)']` 划分：

- **Windows**：`webview2-com` / `windows-sys`（Job Object 进程树、受限令牌沙盒、自定义 OLE 拖放、剪贴板 `CF_HDROP`/`CF_UNICODETEXT`、ConPTY 伪控制台）
- **macOS**：`speech = "=0.5.0"`（锁版本：0.8.x 依赖 macOS 26 SDK 的 API，旧 Xcode 编译失败）
- **Linux**：`landlock`（无特权文件系统写隔离）

---

## 3. 系统分层（六边形架构 / Ports & Adapters）

依赖方向**只能「外层 → 内层」**；内层不知道外层的存在，跨层靠 `ports/` 里的接口通信。

```
        ┌──────────────────────────────────────────────┐
        │                    ui/                        │  React + MobX（唯一能碰 DOM 的层）
        └───────────────────────┬──────────────────────┘
                                ▼
        ┌──────────────────────────────────────────────┐
        │                  services/                     │  应用编排（chat / agent / rust-engine …）
        └───────────────────────┬──────────────────────┘
                                ▼
        ┌──────────────────────────────────────────────┐
        │                   domain/                      │  纯业务逻辑（引擎 / 工具注册中心 / 安全策略 / 领域模型）
        │        ports/ ◄── 接口在此定义                  │
        └───────────────────────▲──────────────────────┘
                                │ 实现
        ┌───────────────────────┴──────────────────────┐
        │              infrastructure/                   │  端口实现（Provider / 工具实现 / 沙盒 / 各 Repo）
        └──────────────────────────────────────────────┘

横切：events/（事件总线）· utils/（无业务依赖工具）· skill/（技能加载）· types/（共享类型）
```

**各层允许依赖**：

| 目录 | 职责 | 允许依赖 |
|---|---|---|
| `src/domain/` | 纯业务逻辑：引擎、工具注册中心、Provider/搜索领域模型、安全策略、端口接口 | 仅 `@/types`、`@/utils` |
| `src/infrastructure/` | 端口实现：Provider、工具实现、沙盒、sessionRepo、search-providers、vision、RAG 存储、usage-ledger | domain、types、utils |
| `src/services/` | 应用编排：chat-service（最大）、agent-service（提示词组装）、rust-engine（Rust 桥）、security/rag/export/update/token-stats 等 | domain、infrastructure、ui/store（读设置） |
| `src/ui/` | React + MobX：pages（chat / Settings / setupFlow）、components、store、i18n、layout、hooks | 全部下层 |
| `src/skill/` | Skill 加载 / 注册 / 导入 / 广场 | 工具化使用 |
| `src/events/` | EventEmitter 事件总线（menu / settings / comment / toolInteract / update） | utils |
| `src/utils/` | 无业务依赖工具：telemetry、storageState、EventEmitter、diff、mdYamlFrontmatter、pathCanonicealize… | 无 |
| `src/tests/` | Vitest 测试，按 `domain / infrastructure / services / rag / utils / ui` 分目录 | — |
| `src-tauri/src/` | Rust：`agent/`（镜像 TS 引擎）、`rag/`、`sandbox/`、`session_db/`、`file_ops.rs`、`search.rs`、`vision_service.rs`、`telemetry.rs`、`lib.rs` | — |
| `src-tauri/resources/` | 打包资源：`default-skills/`、`quasivision_models/`、`deepseek_tokenizer/`、`sandbox/`（`tauri.conf.json > bundle.resources` 必须同步） | — |

> 端口清单（`src/domain/ports/`）：`AgentEnginePort`、`ProviderPort`、`SearchProviderPort`、`KnowledgeBasePort`、`SandboxPort`、`SecurityPort`、`ToolRegistry`。
> 仓库层：`src/infrastructure/repo.ts` 的 `SimpleRepo<T>`（全量加载/保存的配置类）；领域仓储另有语义化方法的接口（见 `sessionRepo/`）。

---

## 4. 运行时全景：一次对话的完整生命周期

这是理解全项目最有效的路径。一次用户发送，数据是这样流动的：

```
① 用户输入
   ui/pages/chat/components/input  ──►  chat-service.sendMessage()
                                            │
② 组装上下文                                 │  agent-service.assembleAgentPrompt()
   ┌───────────────────────────────────────┘  · session + 历史消息 + SKILL.md 领域知识
   │                                            · 工具定义（toolRegistry.listDefinitions()）
   ▼
③ 选择引擎  getEngine()  ── isRustEngineEnabled() && Tauri 可用 ──►  Rust 引擎（默认）
                          └── 否则（浏览器 dev / vitest / 用户关闭）─►  TS 引擎（回退）
   ▼
④ Agent 循环（两侧同构）
   ┌──────────────────────────────────────────────────────────────┐
   │  LLM 轮次  llm-round ──► Provider.chatStream()  ──► 流式事件  │
   │      │                                                        │
   │      ├─ 无 tool_calls ──► 直接产出答案 ──► (可选) 迭代验证     │
   │      └─ 有 tool_calls ──► 工具执行  tool-executor             │
   │                              │                                │
   │         ┌────────────────────┴────────────────────┐          │
   │         ▼ 原生工具（18 个）                          ▼ JS 桥   │
   │ Rust 直接执行                              Rust→JS→Rust 往返    │
   │ （先过安全校验）                            toolRegistry 执行    │
   │         └────────────────────┬────────────────────┘          │
   │                              ▼                                │
   │              工具结果 → tool_result_created 事件              │
   │                              ▼                                │
   │              verifier 验证是否达标（未达标注入反馈继续循环）   │
   │                              ▼                                │
   │                   StormBreaker 防重复工具风暴                 │
   └──────────────────────────────┬───────────────────────────────┘
   ▼
⑤ 持久化（两条路径，互斥）
   · TS 引擎  → chat-service.persistMessagesIfNeeded()（!isRustEngineEnabled() 守卫）
   · Rust 引擎 → session_db/ 的 SessionRepo 在引擎内部直落 SQLite（先落库再 emit）
   ▼
⑥ 事件回 UI
   onEvent → chat-service.createEventHandler() → agentStore / sessionStore（MobX）
   ▼
   ui/pages/chat 渲染（消息列表用 @tanstack/react-virtual 动态高度虚拟滚动 + 懒加载）
```

**关键契约**：`AgentEventType`（`src/types/index.ts`）是 **TS 引擎、Rust `event_sink`、`chat-service.createEventHandler`、`rust-engine.ts` 四方共享**的事件契约。当前 18 种：

```
stream_start / stream_event / stream_end · tool_call / user_interaction / error
update_message_id · assistant_message_created / assistant_message_updated · tool_result_created
iteration_start / iteration_verify_start / iteration_verify_end
iteration_verify_pass / iteration_verify_fail / iteration_max_exceeded / iteration_end
```

> 新增事件类型必须**四处一致**：TS 类型 → TS emit → Rust emit → chat-service 处理。否则会「静默失效」（某一侧不认）。

---

## 5. 主要子系统地图（「主要的地方」）

### 5.1 Agent 引擎（双实现）——本项目的心脏

两份实现，同一套语义：

| | TS 引擎 | Rust 引擎 |
|---|---|---|
| 入口 | `src/domain/engine/engine.ts` | `src-tauri/src/agent/engine.rs` |
| 触发 | 浏览器 dev / vitest / 用户关闭 Rust 引擎 | **默认开启**（`settings.useRustEngine` + Tauri 可用） |
| 共同接口 | `AgentEnginePort`：`sendMessage / getRunSnapshot / clearRunSnapshot / cancel / compressContext / generateTitle` | 同 |
| 循环编排 | `llm-loop.ts` / `llm-round.ts` / `tool-executor.ts` / `iteration-controller.ts` / `verifier.ts` / `storm-breaker.ts` | `llm_loop.rs` / `llm_round.rs` / `tool_executor.rs` / `iteration.rs` / `verifier.rs` / `storm_breaker.rs` |
| 持久化 | **不碰**：消息经 `onEvent` 抛给 `chat-service` | 引擎内直落 SQLite（`session_db/`，先落库再 emit） |

**Rust 桥协议**（与 `src-tauri/src/agent/bridge.rs` 严格对应）：

| 方向 | 通道 | 说明 |
|---|---|---|
| Rust → JS | `agent:event` | 载荷 `{ sessionId, event }`，`event` 与 TS `AgentEvent` 完全一致，前端直接转发 `onEvent` |
| Rust → JS | `agent:tool-request` | 未原生化工具交 JS 执行，JS 用 `toolRegistry` 跑完回 `agent_tool_response`（`payload.__kind: value \| error \| interaction`） |
| Rust → JS | `agent:user-interaction-request` | 用户交互（`user_choice` / 终端内确认）与**内部查询**（`sandbox_rule_check`，无 UI：命令是否命中「忽略沙盒命令」规则，见 §5.4），走 `chat-service` 注册的 session handler → `agent_user_interaction_response` |
| Rust → JS | `agent:provider-request` | 未原生化的 Provider（目前 Gemini）交 JS，流式用 `agent_provider_stream_event` 逐条回传，结束 `agent_provider_stream_done` |
| JS → Rust | `agent_send_message` / `agent_cancel` / `agent_get_run_snapshot` / `agent_clear_run_snapshot` / `agent_dispose` / `agent_kill_command` / `pty_*` | 生命周期、取消、终端交互 |

**未原生化的部分**（委托 TS）：`compressContext`、`generateTitle`、Gemini Provider，以及 web/vision/skill/system/chat 类工具。
Rust 只使用前端组装好的 `session.systemPrompt`（为空时回退 `"你是一个有用的 AI 助手。"`）。完整清单见 `docs/rust-engine.md`。

> ⚠️ **改引擎语义（LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销）时，TS 与 Rust 两侧都要改**，否则默认路径与回退路径行为分叉（铁律 1）。

### 5.2 工具系统——能力扩展的唯一入口

- **注册制**：一律 `toolRegistry.register(definition, executor)`；不写全局函数表。
- **定义与执行器分离**；`definition.description` 可为**惰性函数**（序列化给 LLM 时才求值，用于平台相关的动态描述，如 `execute_command` 的平台缓存）。
- **9 大分类 / 27 个工具**（`src/domain/tools/category.ts` ↔ `src/infrastructure/tools/<分类>/`）：

  | 分类 id | 目录 | 工具数 | 代表工具 |
  |---|---|:--:|---|
  | `file` | `tools/file/` | 8 | read_file / write_file / edit_file / delete_file / copy_move_file / list_files / file_info / mkdir |
  | `search` | `tools/search/` | 2 | search_files_by_name / search_text_in_files |
  | `execute` | `tools/execute/` | 2 | execute_command / execute_script |
  | `knowledge_base` | `tools/knowledge-base/` | 6 | search / list / get / write / delete … |
  | `web` | `tools/web/` | 2 | web_search / web_fetch |
  | `vision` | `tools/vision/` | 1 | vision_analyze |
  | `skill` | `tools/skill/` | 2 | list_skills / read_skill_source |
  | `system` | `tools/system/` | 2 | get_current_time / user_choice |
  | `chat` | `tools/chat/` | 2 | list_messages / read_messages |

- **原生化（18 个）**：`file`(8) + `search`(2) + `execute`(2) + `knowledge_base`(6)，分发在 `src-tauri/src/agent/native_tools/mod.rs::is_native_tool / execute_native_tool`。其余自动走 JS 桥。
- **跨层单例**：`src/infrastructure/tools/output-store.ts`（UI/services/engine 均引用）不归属任何分类，留在 tools 根目录。
- **UI 渲染**：`src/ui/pages/chat/components/tool-call/<Tool>Message.tsx` 实现 `IToolCallMessage` 并 `register(...)`；未注册自动落 `DefaultMessage`。

### 5.3 持久化与数据

- **会话消息**：Rust 侧 `src-tauri/src/session_db/`（已从单文件拆分为 15 文件目录）。
  分层：`types.rs`（IPC DTO）/ `repo.rs`（trait + Noop）/ `schema.rs`（DDL + 迁移）/ `row.rs`（行映射）/ `message_query.rs`（检索）/ `usage.rs`（用量账本）/ `sqlite.rs`（实现）/ `commands.rs`（17 个 `cmd_*`）/ `tests/`。
  SQLite + WAL + 单写连接 + `spawn_blocking`；**先落库再 emit**。
- **前端封装**：`src/infrastructure/sessionRepo/`（`cmd_list_sessions / cmd_get_session / cmd_get_messages / cmd_get_message_page / cmd_upsert_session / cmd_delete_session / cmd_replace_session_messages / cmd_append_messages` …）。
  启动只加载会话**元数据**，消息**懒加载**（`sessionStore.ensureMessagesLoaded`）。`utils/db.ts`（IndexedDB）已废弃删除，**不要复活**。
- **用量账本（token 统计）**：账本 DTO / 聚合 / 明细在 `session_db/usage.rs`；前端 `statsRepo/`、`usage-ledger/`、`services/token-stats-service.ts`。
  ⚠️ **Rust 只回 token 数，费用一律前端算**；内置价目表固定存 USD（`src/domain/pricing/index.ts`），切币种时按固定汇率折算。

### 5.4 安全体系（四道闸）

| 闸 | 位置 | 要点 |
|---|---|---|
| **路径校验** | `domain/security/index.ts` + `services/security-service.ts` + `utils/pathCanonicealize.ts`；Rust 镜像 `native_tools/common.rs` | 优先级 **黑名单 > 白名单 > 工作目录**；写模式（`mode='w'`）仅允许白名单 + 工作目录，**两侧规则必须等价** |
| **权限三态** | `domain/permission/index.ts` + `settings.permissions`；Rust 镜像 `native_tools/execute/common/classify.rs` | 命令按 `safe/install/dangerous` 映射，脚本走 `script.execute`，沙盒脱壳走 `sandbox.*.execute`；`deny` 永远优先；脱壳与命令权限**取更严格者**（默认 `ask`） |
| **跨平台沙盒** | `infrastructure/sandbox/*` + `src-tauri/src/sandbox/` | Windows：Job Object + 受限令牌 + ACL；Linux：Landlock（默认拒写）；macOS：`sandbox/macos/mod.rs`。**禁止绕过沙盒直接 spawn**。可写根**只来自** workspace + 白名单：**不自动豁免**包管理器缓存（`~/.npm` / pnpm store / `~/.cargo`…）等区外目录——该「环境探测 + ACL 授予」机制已**整体移除**（实测不好用），要放行区外写入请让命令命中下方「忽略沙盒命令」规则 |
| **工具风暴防护** | `domain/engine/storm-breaker.ts` / `agent/storm_breaker.rs` | 滑窗（window 6 / threshold 3）检测重复 `(toolName, args)`，命中即中断循环 |

> 唯一「绕过沙盒」的例外：`execute_command` / `execute_script` 传 `sandbox:"off"`（见 §8、§11.2），按脱壳权限决策、`readonly` 直接拒绝，并埋点 `tool.sandbox.bypass`。

> 「忽略沙盒命令」规则（**设置 → 安全 → 忽略沙盒命令**）：命中规则的命令**免除「沙盒脱壳」审批，并以「不使用沙盒」方式执行**
> （AI 不必显式传 `sandbox:"off"`；沙盒已关闭 `off` / 只读 `readonly` 时规则不生效）。
> 该规则也是「区外写入」（如 `npm install` 写 `~/.npm`、pnpm store）的**唯一推荐放行方式**（不要再做沙盒侧自动探测/豁免）。
> 匹配器只有一份：`domain/security/sandbox-ignore-rules.ts`（`text`（完全/前缀/后缀）/ `regex` / `js` 三种），经 `securityService.matchSandboxIgnoreRule` 使用；
> **TS 引擎路径**在 `infrastructure/tools/execute/{execute-command,execute-script}.ts` 里定 `bypassSandbox`；
> **Rust 引擎路径**（默认）在 `native_tools/execute/{execute_command,execute_script}.rs` 里经**内部交互** `sandbox_rule_check`（无 UI）问 JS 同一个匹配器
> —— Rust 不重实现匹配（规则含用户自写的 `js` 函数），`security.hasSandboxIgnoreRules` 只是性能开关（false 时零 IPC）。
> `js` 规则的输入是代码编辑器 `ui/components/code-editor/CodeEditor`（可编辑的精简版 Monaco，见 `monaco/setupMonaco.ts`：只有词法高亮，**无语言服务/无诊断**）；
> 默认模板 `SANDBOX_JS_DEFAULT_PATTERN` 是带注释的 `function matchCommand(command){...return false}`（**默认不命中**），
> **切换匹配方式会重置「匹配内容」**（`defaultSandboxRulePattern`）。
> **列表顺序即匹配优先级**（`findMatchingSandboxRule` 取第一条命中的启用规则），设置页里**拖拽左侧把手**排序（`reorderSandboxIgnoreRule` ↔ `securityStore.reorderSandboxRule`，几何计算在 `ui/pages/Settings/sandbox-rules-dnd.ts`；同一把手支持 ↑/↓ 方向键 = `moveSandboxIgnoreRule`）；
> ⚠️ 拖拽用 **pointer 事件**自实现，不能用 HTML5 drag & drop（`dragDropEnabled: true` 与 HTML5 拖拽互斥，见 `chat/.../use-tree-drag.ts` 与 §11.8）；
> 空列表里的「常用规则」来自 `SANDBOX_RULE_PRESETS`（`createSandboxIgnoreRuleFromPreset`）；
> 保存前的校验走 `compileSandboxRule`（**只验证能否编译，不执行规则体** —— 运行期抛错在生产按未命中处理，不该拦住保存）。
> ⚠️ 规则**只**免「沙盒脱壳」：`terminal.*` / `script.execute` 的风险审批照旧（命中规则时弹窗追加 `SANDBOX_RULE_BYPASS_HINT` 说明原因）；
> 「沙盒脱壳」权限设为 `deny` 时 **deny 仍然优先**（`apply_rule_clearance` 只把 `ask` 降为 `allow`）。

### 5.5 Provider 与搜索源

- **LLM Provider**：实现 `IProvider`（`infrastructure/provider/types.ts`：`listModels / chat / chatStream / buildRequest / validateApiKey`），模板放 `domain/provider/config.ts`。
  TS 侧 3 种全支持；Rust 侧原生 OpenAI / Anthropic，**Gemini 走 `BridgedProvider`**（委托 TS）。
- **搜索源**：实现 `ISearchProvider`（`domain/search/types.ts`），放 `infrastructure/search-providers/`，`factory.ts` 注册，配置由 `search-provider-service.ts` 管理（localStorage）。

### 5.6 视觉 / RAG / Skill

- **视觉**：`src-tauri/src/vision_service.rs` + `infrastructure/vision/` + `resources/quasivision_models/`。**图片不出本机**，不要改成上传。
- **RAG 知识库**：`src-tauri/src/rag/`（`document.rs` / `embedding.rs` / `vector_store.rs` / `rag_service.rs`）+ `services/rag-service.ts` + `infrastructure/rag/`。向量索引用 turbovec。
- **Skill**：`src/skill/`（加载 / 注册 / 导入 / 广场）+ 内置包在 `src-tauri/resources/default-skills/<name>/SKILL.md`。

### 5.7 前端 UI 与状态

- **MobX 单一 store + `StorageState`**（`utils/storageState.ts`，localStorage，key 前缀 `_storage_state_`）。
  核心 store（`src/ui/store/`）：`settingStore`（全部设置 + 一次性迁移）、`sessionStore`（会话 CRUD + 消息懒加载）、`agentStore`、`securityStore`、`sessionRuntimeStore`（working / pendingContent / traceId）。
- **页面**：`ui/pages/chat`（chat-view 31 KB）、`ui/pages/Settings`、`ui/pages/setupFlow`。
- **窗口**：无边框自绘（`ui/layout/WindowLayout`），默认 `visible: false`，首帧后 `getCurrentWindow().show()`。
- **性能**：消息列表 `@tanstack/react-virtual` 动态高度虚拟滚动 + 分页（改 `message-list.tsx` 注意 `measureElement`）。
- **组件事件**：跨层通信用 `src/events/*` 的 EventEmitter（**禁止 `window.*` 全局挂载**）。
- **样式**：组件目录内 `style.scss`（或 `style.module.scss`），跟随 BEM 类名；主题变量在 `ui/styles/theme.css`。
- **通用控件**：开关用 `ui/components/shared/Toggle`（`size: sm/md/lg` 三档，`virlen-toggle` 命名空间；`md` 与老 `.toggle` 视觉一致）。
  ⚠️ 老页面那套 `<label class="toggle"> + .toggle-slider` 是**全局约定类**，在 general / editor / provider / security 的 scss 里各拄了一份，尚未迁移；新代码请用组件，**别再用 `.toggle` 命名新样式**（会被 `.settings-panel .toggle ...` 这类跨层选择器意外命中）。

### 5.8 埋点与诊断

- `track('domain.action', props)` / `trackPerf` / `startSpan`（`utils/telemetry`）。命名 `域.动作`（如 `chat.message.send`、`engine.iteration.verify`、`session.create`）。
- **默认关闭**（`telemetryEnabled`），必须保持「关闭时零开销」。
- Rust 侧 `src-tauri/src/telemetry.rs` 做 panic 桥（落盘 + 前端就绪后拉取）。
- 密钥打码：`utils/telemetry/redact.ts`、`isSensitiveKey()`。规范见 `docs/埋点上报数据设计.md`。

---

## 6. 铁律（改代码前必读，违反将导致行为分叉 / 静默失效）

1. **双引擎同步**：`src/domain/engine/*`（TS）与 `src-tauri/src/agent/*`（Rust）是同一套语义的两份实现。
   改「LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销语义」时**两边都要改**。
2. **事件契约不可擅自改名**：`AgentEventType` 是四方共享契约（TS 类型 → TS emit → Rust emit → chat-service 处理），新增必须四处一致。
3. **引擎不碰持久化、不 import store**：TS 引擎经 `onEvent` 交 `chat-service` 落库；Rust 引擎由 `SessionRepo` 内部直落。
4. **新增 Tauri 命令必须注册**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]`，否则前端 `invoke` 静默 404；涉及权限还要看 `src-tauri/capabilities/default.json`。
5. **工具是「定义 + 执行器」分离注册制**：一律 `toolRegistry.register(definition, executor)`；`description` 可为惰性函数。
6. **写操作必须先过安全校验**：JS 侧 `securityService.resolveSafePath/isPathAllowed`，Rust 侧 `native_tools::resolve_safe_path / is_path_allowed`，两侧规则必须等价。禁止绕过。
   路径展开（`~` / `%USERPROFILE%`）与 canonicalize 规则**必须共用同一实现**：`src-tauri/src/sandbox/paths.rs::expand_user_path`（前端经 `canonicalize_path` 命令走同一函数）。禁止在任一侧另写一份展开/规范化逻辑，否则黑名单条目会在默认引擎下静默失效。
7. **业务文案走 i18n**：`t('中文')`（中文即 key），变量模板用 `tpl('已删除 $__count__ 个会话', {count})`；新增 UI 文案必须同步 `src/ui/i18n/lang/en-US.json`。
8. **最小改动**：不改动与任务无关的代码；顺手重构要单独说明。
9. **中文注释是本项目风格**：文件头写职责，关键分支写「为什么」而非「做了什么」；保留 `??` / `⚠️` 等既有强调标记。
10. **不用 `git push --force`、不重写历史、不动 `dist/`、不删别人的文件**。

---

## 7. 常用命令与验证基线

```bash
pnpm install                 # 依赖安装（首次 / 依赖变更后必须执行）
pnpm dev                     # 仅前端（Vite，端口 1420，strictPort；浏览器模式自动回退 TS 引擎）
pnpm tauri dev               # 桌面端开发（前端 + Rust）
pnpm build                   # tsc && rimraf dist && vite build
pnpm tauri build             # 桌面端安装包
pnpm test                    # vitest run（配置见 vitest.config.ts）
pnpm test:watch / test:ui
npx tsc --noEmit             # 类型检查（唯一「静态门禁」）
cd src-tauri; cargo test     # Rust 侧测试（各模块内联 #[cfg(test)] mod tests）
pnpm build:msix              # Windows MSIX 打包（scripts/build-msix.ps1）
```

- 测试文件实际位于 **`src/tests/**`（不是 `tests/`）**，`vitest.config.ts` include 已固定，setup 文件 `src/tests/setup.ts`（模拟 Tauri API）。
- 基线（README 记录，**本机沙盒未复现**，见 §11.2）：`cargo test` / `vitest run` 全绿、`tsc --noEmit` 零错误。
- 提交前**至少**自查：`npx tsc --noEmit`（无新增错误）+ 受影响模块的测试。
- ⚠️ 本机沙盒内 `vitest` / `vite build` 会因 `esbuild` 子进程 `spawn EPERM` 失败，须走**沙盒脱壳**（`sandbox:"off"`，见 §11.2）。

---

## 8. 安全红线（写涉及文件 / 命令 / 网络的代码前必读）

- **路径**：优先级 **黑名单 > 白名单 > 工作目录**；写模式仅允许白名单 + 工作目录；黑名单按平台给默认值。
- **沙盒**：`settings.sandboxMode`（`on`/`off`/`readonly`）。**禁止绕过沙盒直接 spawn**；唯一例外是 `execute_command` / `execute_script` 的 `sandbox:"off"`（须按「沙盒脱壳」权限决策、`readonly` 直接拒绝、埋点 `tool.sandbox.bypass`）。
  另：命中「忽略沙盒命令」规则（§5.4）的命令**免脱壳审批并强制无沙盒执行**（AI 未申请也生效，埋点 `status: auto_rule`）；`off` / `readonly` 下规则不生效，`deny` 优先。
- **权限三态**：命令 / 脚本 / 沙盒脱壳（`allow`/`ask`/`deny`）；`deny` 永远优先；脱壳与命令/脚本权限**取更严格者**。UI 在「设置 → 安全 → 权限管理」。
- **工具风暴**：滑窗检测重复 `(toolName, args)`，命中即中断。
- **密钥**：埋点/日志**不得**输出 apiKey、token、密钥文件内容；`providers` / `searchProviders` 只上报数量。
- **端侧视觉**：图片不出本机，**不要**改成上传。

**AI 代理自我约束**：

- 不读取 `.env`、`*.key`、`~/.ssh/` 等敏感文件；
- 文件写入限制在工作区；
- 删除文件用**回收站语义**（`trash`）而非硬删；
- 破坏性操作（删库、清空会话、批量重命名）先向用户确认。

---

## 9. 手册速查（细节见对应章节 / 文档）

### 9.1 新增一个工具

1. **定义 + 执行器**（在所属分类目录新建文件）：

   ```ts
   toolRegistry.register(
     { name: 'my_tool', label: t('我的工具'), description: 'English description for the LLM.',
       parameters: { type: 'object', properties: {...}, required: [...] } },
     (async (args, ctx: ToolContext) => {
       // ctx: { sessionId, toolCallId, abortSignal, write, skills }
       // 需要用户交互 → return new UserInteractionRequired('my_interaction', {...})
       return '给 LLM 的结果文本' | { content: string, uiData?: Record<string, any> }
     }) as ToolExecutor,
   )
   ```

2. **挂进启动注册链**：分类 `index.ts` 加 `import './my-tool'`（新分类还需在 `tools/index.ts::toolsInit()` 加 `await import(...)`，并在 `domain/tools/category.ts` 的 `TOOL_CATEGORIES` 登记）。
3. **公共函数**：同分类 ≥2 工具复用 → 抽到分类 `common.ts`。
4. **UI 渲染**：`tool-call/` 新建 `XxxMessage.tsx` 实现 `IToolCallMessage` 并 `register(...)`（未注册落 `DefaultMessage`）。
5. **是否原生化**：在 `native_tools/mod.rs` 的 `is_native_tool` + `execute_native_tool` 加分派，对应分类目录新建 `<工具>.rs`（复用 `common.rs`）。
6. **测试**：`src/tests/infrastructure/*.test.ts`（JS）；Rust 加内联单测。
7. 平台相关信息建议用惰性描述（参考 `tools/execute/common.ts::platformSnapshot()`）。

### 9.2 新增 / 修改 Provider、搜索源、Skill

- **LLM Provider**：实现 `IProvider` → `provider/index.ts::createProviderInstance` 注册 → 模板放 `domain/provider/config.ts`。要 Rust 原生支持需在 `agent/provider.rs` 加实现，否则自动走 `BridgedProvider`。
- **搜索源**：实现 `ISearchProvider` → 放 `infrastructure/search-providers/` → `factory.ts` 注册 → 配置由 `search-provider-service.ts` 管理。
- **内置 Skill**：`src-tauri/resources/default-skills/<name>/SKILL.md`，frontmatter 至少 `name` / `description`（也兼容纯 Markdown：`# 标题` + `> 描述` + `**Version:** x.y.z`，解析器 `utils/mdYamlFrontmatter.ts`）；目录名应与 `name` 一致；脚本放 `scripts/`。

---

## 10. 前端约定

- **状态**：MobX 单一 store + `StorageState`（localStorage）。新增设置项记得加进 `SettingsStore` 接口 + `defaultSettings` + 设置页 UI（`ui/pages/Settings/`）。
- **会话持久化**：见 §5.3。启动只加载元数据，消息懒加载；`utils/db.ts` 已废弃，不要复活。
- **组件事件**：`src/events/*` 的 EventEmitter；禁止 `window.*` 全局挂载。
- **样式**：组件目录内 `style.scss`，BEM 类名；主题变量在 `ui/styles/theme.css`。
- **窗口**：无边框自绘 + 首帧 `show()`。
- **性能**：消息列表虚拟滚动 + 分页（改 `message-list.tsx` 注意 `measureElement`）。
- **埋点**：`track('域.动作', props)`，默认关闭、关闭时零开销。

---

## 11. 常见坑（踩过的，别再踩）

> 本节已精简为**速查级**；涉及 PTY / 剪贴板 / 拖放 / 输入框布局的完整细节，正文在各自专项文档中。

**11.1 Windows PowerShell 5.1 默认按本地代码页（GBK）读取文件** —— 查看含中文源码会乱码。
查看/比对加 `-Encoding UTF8`；写文件用 `write_file`/`edit_file`（UTF-8）。

**11.2 本机沙盒的已知限制（非代码问题）** —— `vitest` / `vite build` / `jest` / `node-gyp` / `child_process.exec*` 等因 `esbuild` 子进程 `spawn EPERM` 在沙盒内跑不了。
**根因**（2026-09 实测定位，非测试代码问题）：libuv 给 spawn 的 stdio 建的是**命名管道**（NPFS 内置 SD 里没有 restricting SID 的写 ACE），沙盒受限令牌的写类访问要过两遍检查 → 第二遍 `ACCESS_DENIED`。
**匿名管道不受影响**（python `subprocess(capture_output=True)`、`cargo`→`rustc`、.NET `Process.Start` 均正常）。
**受控退路**：`execute_command` / `execute_script` 传 `sandbox:"off"`（按「沙盒脱壳」权限授权，`readonly` 拒绝）；不想每次都授权时用「设置 → 安全 → 忽略沙盒命令」配一条规则（命中的命令自动无沙盒执行，见 §5.4）。
**临时关闭**：`VIRLEN_SANDBOX=off|readonly|on`（由 **Virlen 进程**读取，在命令里 `set` 无效）。
另：`node_modules` 可能不完整（如缺 `@tanstack/react-virtual`），先 `pnpm install` 再判断是否为真错误。

**11.3 版本号分散在 3 处且当前不一致**：`package.json`（0.1.2）、`src-tauri/Cargo.toml`（1.0.1）、`src-tauri/tauri.conf.json`（1.1.34，**打包与 MSIX 实际读这个**）。改版本至少同步 `package.json` + `tauri.conf.json`。

**11.4 README 已过期处**（改到相关部分时顺手校正，别照抄）：测试目录写作 `tests/` 实际 `src/tests/`；技术栈写 TS 5.8 实际 `typescript ~7.0.2`；工具表未含 `mkdir` / 知识库系列 / `chat` 分类。`README-CN.md` 需与 `README.md` 一起维护。

- `vite.config.ts` 中 `optimizeDeps.exclude: ['monaco-editor']` **不可去掉**（否则 monaco 打成多份实例、注册表互相隔离）。
- Vite 端口固定 1420（`strictPort`），`tauri dev` 会因端口占用失败。
- `tsconfig.json`：`strict: true` 但 `strictNullChecks: false`、`noUnusedLocals/Parameters: false`——别按纯严格模式假设；别名 `@/*` → `src/*`（Vitest 另配一份）。
- Run Snapshot 只存内存，刷新即失效；用户取消**不算错误**，要保留 partial 内容（详见 `docs/rust-engine.md`）。
- 消息 id 与内容分离：`chat-service` 负责用户/assistant/tool 消息创建与事件广播，UI 只渲染。

**11.7 Windows `execute_command` 已改用 ConPTY（伪控制台）** —— 完整背景见 `docs/pty-research.md`。
要点：命令跑在伪控制台里，stdout/stderr **合并为一条 VT 流**，`uiData.pty = true`，前端用 xterm 渲染（非 PTY 才回落 `<pre>`）。
**不要再假设子进程 stdio 是管道**；给模型看的文本必须过 `process_terminal_output`（按 ECMA-48 完整吞掉转义序列，**Rust / TS 两侧必须同步**）。
交互走 Tauri 命令 `pty_write` / `pty_resize` / `pty_key`（**不经引擎事件总线**）。**两条红线**：用户输入正文**不回灌**给模型；终端内确认的命令**仍走沙盒 + 同一条执行路径**。
已知缺口：TS 引擎路径未 PTY 化；常驻交互 shell（Step 3）未做。

**11.8 拖拽取文件路径：`dragDropEnabled` 只能为 `true`（与 HTML5 拖拽互斥）**。
原生拖放能拿到真实路径（`onDragDropEvent().payload.paths`），但页面收不到 HTML5 `drop`；跨应用拖「文本」不再自动插入。
实现：`ui/pages/chat/components/input/index.tsx`（监听 + 命中判断）、`input/hooks.ts`。
附件数据模型：`MessageContent` 的 `file` 块**只存路径**；各 Provider 统一降级为文本（TS `fileBlockToText` ↔ Rust `provider.rs`，**两侧文案必须一致**，标签常量 `ATTACHED_FILE_LABEL`/`ATTACHED_DIR_LABEL` 用英文、不进 i18n）。

**11.9 粘贴文件：路径只能问原生剪贴板**（页面 `DataTransfer` 里没有）。
`read_clipboard_file_paths`（`src-tauri/src/clipboard_files.rs` = `CF_HDROP`）；读不到一律返回 `[]`，**不报错、不打断粘贴**。
前端在 `input/index.tsx` 汇到 `acceptPaths`，含 Ctrl+V 原生兜底（WebView2 对「复制的文件」可能连 `paste` 事件都不触发）。

**11.10 输入框高度模型：固定高度只落在 textarea 上**（否则附件会把工具条顶出盒子）。
两个必须对齐的常量（改一个就要改另一个）：`index.tsx` 的 `INPUT_CHROME_HEIGHT = 58` ↔ `style.scss` 的 `.input-wrapper` 静止高度 125 / `textarea { min-height: 67px }`。
坑：`.has-fixed-height textarea` 必须 `flex: 0 0 auto`。

---

## 12. 快速定位表

| 我要做的事 | 去哪里 |
|---|---|
| 改聊天循环 / 工具循环 / 暂停恢复 | `src/domain/engine/*` **和** `src-tauri/src/agent/{engine,llm_round,tool_executor,llm_loop}.rs` |
| 改系统提示词 | `src/domain/agent/prompts/*.md` + `src/services/agent-service.ts`（组装顺序在此） |
| 改上下文压缩 / 标题生成 | `src/domain/engine/compress-context.ts`（模式分派：`ai` LLM 摘要 / `raw` 正文压缩）+ `compress-raw.ts`（正文压缩的本地渲染）/ `generate-title.ts`（Rust 侧委托 TS）；产物在消息列表里的呈现：`ui/pages/chat/components/message/summary-message.tsx`（提示条 + 摘要弹窗） |
| 改会话持久化 | `src-tauri/src/session_db/`（`sqlite.rs` / `schema.rs` / `commands.rs`）+ `src/infrastructure/sessionRepo/` + `src/ui/store/sessionStore.ts` |
| 加 / 改工具 | `src/infrastructure/tools/<分类>/<工具>.ts`（+ 分类 `common.ts`、分类 `index.ts`）、`src/domain/tools/category.ts`、`src-tauri/src/agent/native_tools/<分类>/<工具>.rs`（+ `mod.rs` 分发）、`src/ui/pages/chat/components/tool-call/` |
| 改原生工具路径校验 / 参数取值 | `src-tauri/src/agent/native_tools/common.rs`（`resolve_safe_path` / `is_path_allowed` / `arg_*`）；路径展开共用 `src-tauri/src/sandbox/paths.rs::expand_user_path` |
| 改文件读写底层 | `src-tauri/src/file_ops.rs` + `src/utils/diff.ts` |
| 改搜索 | `src-tauri/src/search.rs`（文件搜索）、`src/domain/search/*` + `src/infrastructure/search-providers/*`（网络搜索） |
| 改命令执行 / 风险分类 / 权限审批 | `src/domain/permission/index.ts`（+ Rust 镜像 `native_tools/execute/common/classify.rs`）；工具 `tools/execute/common.ts` + `execute-command.ts`/`execute-script.ts`；Rust 原生 `native_tools/execute/`。PTY 相关另见 `sandbox/windows/conpty.rs`、`native_tools/execute/pty_session.rs`、`tool-call/XtermTerminal.tsx`、`tool-call/TerminalConfirmBlock.tsx` |
| 改终端输出处理（`\r`、ANSI） | `tools/execute/common.ts::processTerminalOutput`（UI 侧 `tool-call/Execute*Message.tsx` 复用）；Rust 侧 `native_tools/execute/common.rs::process_terminal_output`。两份**逐条对齐** |
| 改工具授权确认弹窗 / 交互 | `ui/pages/chat/components/modals/authorization.tsx`；事件 `events/toolInteractEvent.ts::showAuthorization`；调度 `services/tool-service/command_confirm.ts`；Rust 侧下发同样字段 `native_tools/execute/{execute_command,execute_script}.rs` |
| 改沙盒 / 权限 | `src-tauri/src/sandbox/**`、`src/infrastructure/sandbox/*`、`src/domain/security/index.ts` |
| 改「忽略沙盒命令」规则（命中即免脱壳审批 + 强制无沙盒执行） | 匹配器 `src/domain/security/sandbox-ignore-rules.ts`（含 `js` 默认模板 `SANDBOX_JS_DEFAULT_PATTERN` / `defaultSandboxRulePattern` / 排序 `moveSandboxIgnoreRule`+`reorderSandboxIgnoreRule` / 预设 `SANDBOX_RULE_PRESETS` / 编译校验 `compileSandboxRule`）；服务入口 `src/services/security-service.ts::matchSandboxIgnoreRule`；存储 `src/infrastructure/securityRepo/`（`sandboxIgnoreRules`）+ `src/ui/store/securityStore.ts`（`upsert/remove/setEnabled/move/reorder`）；UI `src/ui/pages/Settings/security-sandbox-rules.tsx`（拖拽几何 `./sandbox-rules-dnd.ts`；JS 输入用 `src/ui/components/code-editor/CodeEditor.tsx`；行内开关 `src/ui/components/shared/Toggle`）；**TS 路径决策** `src/infrastructure/tools/execute/{execute-command,execute-script}.ts`；**Rust 路径决策** `src-tauri/src/agent/native_tools/execute/{execute_command,execute_script}.rs` + `.../execute/common/rules.rs`（经内部交互 `sandbox_rule_check` 问 JS）+ `src/services/tool-service/index.ts`（回答该交互）+ `src/services/rust-engine.ts::resolveSecurityConfig`（`hasSandboxIgnoreRules`） |
| 改视觉 | `src-tauri/src/vision_service.rs`、`src/infrastructure/vision/`、`src-tauri/resources/quasivision_models/` |
| 改设置项 | `src/ui/store/settingStore.ts` + `src/ui/pages/Settings/*` + `src/ui/i18n/lang/en-US.json` |
| 改埋点 | `src/utils/telemetry/**`（+ `src-tauri/src/telemetry.rs` 的 panic 桥） |
| 改 RAG / 知识库 | `src-tauri/src/rag/**`、`src/services/rag-service.ts`、`src/infrastructure/rag/` |
| 改用量统计 / 费用 | `src-tauri/src/session_db/usage.rs`、`src/domain/pricing/index.ts`、`src/services/token-stats-service.ts`、`src/ui/pages/chat/components/token-stats/` |
| 发版 / 打包 | `src-tauri/tauri.conf.json` + `package.json` + `scripts/build-msix.ps1`、`scripts/msix/AppxManifest.xml.template` |

---

## 13. 提交与协作约定

- 提交信息风格：`feat: ...` / `fix: ...` / `update Version` / `update`（中英混用，保持一致即可）；
  涉及引擎/持久化的改动请在正文写清「TS / Rust 两侧都改了什么」。
- 一次提交只做一件事；格式化 / 重命名等噪音改动不要混进功能提交。
- **提交前自查清单**：
  1. `npx tsc --noEmit` 无新增错误；
  2. 受影响模块的 `vitest` 通过；动了 `src-tauri/` 则 `cargo test` 通过；
  3. 若改了引擎语义 → TS 与 Rust 两侧是否都已同步？事件契约是否四方一致？
  4. 若新增工具 → 注册链、UI 组件、Rust 白名单、i18n 文案是否齐备？
  5. 若新增 Tauri 命令 → `lib.rs` 是否已注册？`capabilities/default.json` 是否需补权限？
  6. 是否引入无关改动、是否触碰 §8 安全红线？
