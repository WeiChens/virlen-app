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
> - `docs/host-abstraction-draft.md` —— 宿主抽象（**方案 A 已实施**）：GUI / CLI 资源与数据目录的唯一接口
> - `docs/config-sink-plan.md` —— 配置下沉（**落 SQLite，与 GUI 共用同一份 `virlen.db`**）+ D4 `js` 沙盒规则内嵌求值
> - `docs/cli-tui-plan.md` —— CLI 交互式 TUI（`virlen-cli chat`）方案、选型实测与 Windows 终端硬坑

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
| **Function Calling** | 文件读写、命令执行、网页抓取、搜索、视觉分析、知识库、会话消息检索、任务规划共 10 大类 28 个工具 |
| **端侧视觉引擎** | `quasivision` ONNX 纯本地推理：UI 元素检测 / PP-OCR v5 / YOLOE-26n 物体检测 / 图标分类（图片不出本机） |
| **Skill 机制** | `SKILL.md` 领域知识包，注入系统提示词 + 源码目录只读可查 |
| **多层安全** | 路径黑白名单、权限三态、跨平台 Shell 沙盒、工具风暴防护（StormBreaker） |
| **会话与记忆** | 暂停/恢复（Run Snapshot）、LLM 上下文压缩、本地 RAG（turbovec 向量索引）、用量账本 |
| **双 Agent 引擎** | Rust 原生引擎（默认，`src-tauri/virlen-core/src/agent/`）+ TS 引擎（回退，`src/domain/engine/`） |

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
| `src-tauri/src/` | **GUI 壳**（`virlen-app`，**唯一**的 Tauri 侧）：`lib.rs`（窗口 / 托盘 / 插件 / 命令注册）、`commands/{agent,session_db,rag}.rs`（全部 `#[tauri::command]`）、`host/tauri_host.rs`（`TauriHost`）、`telemetry.rs`（Tauri 埋点出口 + panic 拉取命令）、`tray/`、`drag_drop.rs`、`clipboard_files*`、`vision_service.rs`（视觉命令壳）、`common_service.rs`、`deepseek_tokenizer.rs`、`load_env.rs`、`speech_service.rs`、`task_manager.rs` | `virlen-core` + Tauri |
| `src-tauri/virlen-core/` | **核心库**（`virlen-core`，**零 `tauri::`**，GUI 与 CLI 共用）：`agent/`（镜像 TS 引擎）、`session_db/`（含 `open.rs`）、`sandbox/`、`security/`、`rag/`、`vision/`、`host/{mod,cli_host}.rs`、`file_ops.rs`、`search.rs`、`telemetry.rs`（sink 可插拔）—— **不含任何命令入口** | 第三方 crate（**不得**依赖 tauri / virlen-app） |
| `src-tauri/virlen-cli/` | **headless CLI**（`virlen-cli` package，**命令实现本体**）：lib = `lib.rs`（参数解析 / 分派 / `USAGE` / `EXIT_*`）+ `config.rs` / `list.rs` / `run.rs` / `tui/`（TUI **规划中**），`src/main.rs` 仅三行转发；**只依赖 core** → 二进制里没有 GUI 栈 | `virlen-core` + `tokio` / `serde` / `serde_json` / `chrono` / `uuid` / `dunce` |
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
   │         ▼ 原生工具（26 个）                          ▼ JS 桥   │
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
| 入口 | `src/domain/engine/engine.ts` | `src-tauri/virlen-core/src/agent/engine.rs` |
| 触发 | 浏览器 dev / vitest / 用户关闭 Rust 引擎 | **默认开启**（`settings.useRustEngine` + Tauri 可用） |
| 共同接口 | `AgentEnginePort`：`sendMessage / getRunSnapshot / clearRunSnapshot / cancel / compressContext / generateTitle` | 同 |
| 循环编排 | `llm-loop.ts` / `llm-round.ts` / `tool-executor.ts` / `iteration-controller.ts` / `verifier.ts` / `storm-breaker.ts` | `llm_loop.rs` / `llm_round.rs` / `tool_executor.rs` / `iteration.rs` / `verifier.rs` / `storm_breaker.rs` |
| 持久化 | **不碰**：消息经 `onEvent` 抛给 `chat-service` | 引擎内直落 SQLite（`session_db/`，先落库再 emit） |

**Rust 桥协议**（与 `src-tauri/virlen-core/src/agent/bridge.rs` 严格对应）：

| 方向 | 通道 | 说明 |
|---|---|---|
| Rust → JS | `agent:event` | 载荷 `{ sessionId, event }`，`event` 与 TS `AgentEvent` 完全一致，前端直接转发 `onEvent` |
| Rust → JS | `agent:tool-request` | 未原生化工具交 JS 执行，JS 用 `toolRegistry` 跑完回 `agent_tool_response`（`payload.__kind: value \| error \| interaction`；**`error` 也可带 `uiData`** → 失败文案同样是「模型侧英文 + UI 侧结构化」） |
| Rust → JS | `agent:user-interaction-request` | 用户交互（`user_choice` / 终端内确认），走 `chat-service` 注册的 session handler → `agent_user_interaction_response` |
| Rust → JS | `agent:provider-request` | 未原生化的 Provider（目前 Gemini）交 JS，流式用 `agent_provider_stream_event` 逐条回传，结束 `agent_provider_stream_done` |
| Rust → JS | `agent:round-boundary` | **轮次边界注入**：上一批工具已回复、下一次 LLM 请求尚未发出时回问 JS「有没有要注入的消息」（AI 回复期间用户**已应用**的任务清单变更），JS 用 `agent_round_boundary_response` 回 `{ messages }`；Rust 落库后追加进本轮消息列表，模型**这一轮**就能看到（超时 5s 兼底，失败降级为不注入）。TS 引擎同一时机走 `SendMessageOptions.onRoundBoundary`（铁律 1） |
| JS → Rust | `agent_send_message` / `agent_cancel` / `agent_get_run_snapshot` / `agent_clear_run_snapshot` / `agent_dispose` / `agent_kill_command` / `pty_*` | 生命周期、取消、终端交互 |

**未原生化的部分**（委托 TS）：`compressContext`、`generateTitle`、Gemini Provider。
> **28 个工具已全部原生化**（S5 补齐 `web_fetch` / `web_search`）——`is_native_tool` 就是全集，**没有工具再走 JS 桥**。
Rust 只使用前端组装好的 `session.systemPrompt`（为空时回退 `"你是一个有用的 AI 助手。"`）。完整清单见 `docs/rust-engine.md`。

> ⚠️ **改引擎语义（LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销）时，TS 与 Rust 两侧都要改**，否则默认路径与回退路径行为分叉（铁律 1）。

### 5.2 工具系统——能力扩展的唯一入口

- **注册制**：`toolRegistry.register(name, executor, label?)`；不写全局函数表。
- **定义与执行器分离，且定义只有一份（机制 C）**：工具定义在 **Rust 侧权威源** `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`（28 工具 × 三平台变体 `windows`/`macos`/`linux`，键名与 `std::env::consts::OS` 同词表）；前端只注册执行器 + UI 文案（`label` 走 i18n，**不进契约**）。读取一律 `await toolRegistry.listDefinitions()`（**异步**接口），返回「契约 ∩ 已注册执行器」。详见 `docs/rust-engine.md` §12。
- **10 大分类 / 28 个工具**（`src/domain/tools/category.ts` ↔ `src/infrastructure/tools/<分类>/`）：

  | 分类 id | 目录 | 工具数 | 代表工具 |
  |---|---|:--:|---|
  | `file` | `tools/file/` | 8 | read_file / write_file / edit_file / delete_file / copy_move_file / list_files / file_info / mkdir |
  | `search` | `tools/search/` | 2 | search_files_by_name / search_text_in_files |
  | `execute` | `tools/execute/` | 2 | execute_command / execute_script |
  | `knowledge_base` | `tools/knowledge-base/` | 6 | search / list / get / write / delete … |
  | `web` | `tools/web/` | 2 | web_search / web_fetch |
  | `vision` | `tools/vision/` | 1 | vision_analyze（✅ 已原生化） |
  | `skill` | `tools/skill/` | 2 | list_skills / read_skill_source |
  | `system` | `tools/system/` | 2 | get_current_time / user_choice |
  | `plan` | `tools/plan/` | 1 | todo_write（任务清单；用户可在标题栏浮层里直接编辑） |
  | `chat` | `tools/chat/` | 2 | list_messages / read_messages |

- **原生化（28 个 = 全部）**：`file`(8) + `search`(2) + `execute`(2) + `knowledge_base`(6) + `plan`(1：`todo_write`) + `system`(2：`user_choice` / `get_current_time`) + `chat`(2：`list_messages` / `read_messages`) + `skill`(2：`list_skills` / `read_skill_source`) + `vision`(1：`vision_analyze`) + `web`(2：`web_fetch` / `web_search`)，分发在 `src-tauri/virlen-core/src/agent/native_tools/mod.rs::is_native_tool / execute_native_tool`。**无任何工具走 JS 桥**。
  - `web_search` 的搜索源配置由引擎经 `NativeToolCtx::settings` **直读 `app_settings`**（与「忽略沙盒命令」规则同一份来源）→ CLI 同样可用；
  - `web_fetch` 的 HTML→Markdown 用 `htmd`（TS 侧是 `turndown`）——**Markdown 细节两侧不完全一致**（已知差异，见 `docs/rust-engine.md` §3）。
- **原生工具的会话库依赖**：需要读写会话库的工具（消息查询）从 `ctx.repo: &dyn SessionRepo` 取（由引擎注入；`repo.is_available()` 为 false 时如实回「本地存储不可用」）—— 与 `ctx.security` 同一种显式注入。
- **原生工具的技能依赖**：技能工具从 `ctx.skills`（本 agent 启用的技能名）+ `ctx.security.skills_dir` 取数，**自行扫盘解析 SKILL.md**（不依赖前端 localStorage 注册表，CLI 同样可用）。
- **原生工具的宿主依赖**：需要「资源目录 / 数据目录在哪」的工具（`vision_analyze` 的模型文件）从 `ctx.host: &dyn HostEnv` 取。宿主差异只有两份实现 —— GUI `host::TauriHost`（`resource_dir()` / `app_data_dir()`）、CLI `host::CliHost`（环境变量 + exe 位置）；**引擎核心（含 `native_tools/**`）不得出现 `tauri::`**，这是 headless 的前提。详见 `docs/host-abstraction-draft.md`。
- **模型侧文案一律英文（D2-A）**：工具返回给 LLM 的文本（`content`、抛出的错误、引擎迭代 / 验证反馈、系统提示词）固定英文且**不进 i18n** —— 否则默认（Rust）与回退（TS）引擎、中 / 英界面会产出不同文本。界面展示改由**结构化 `uiData`** 按界面语言重建（组件优先渲染 `uiData`，缺失时回退 `content`，如 `tool-call/TerminalBlock.tsx::displayNote`）。因此：改 TS 执行器文案**必须与 Rust 原生实现逐字对齐**（铁律 1），新增返回值务必同时给出语言无关的 `uiData` 字段。
- **跨层单例**：`src/infrastructure/tools/output-store.ts`（UI/services/engine 均引用）不归属任何分类，留在 tools 根目录。
- **UI 渲染**：`src/ui/pages/chat/components/tool-call/<Tool>Message.tsx` 实现 `IToolCallMessage` 并 `register(...)`；未注册自动落 `DefaultMessage`。

### 5.3 持久化与数据

- **会话消息**：Rust 侧 `src-tauri/virlen-core/src/session_db/`（已从单文件拆分为 15 文件目录）。
  分层：`types.rs`（IPC DTO）/ `repo.rs`（trait + Noop）/ `schema.rs`（DDL + 迁移）/ `row.rs`（行映射）/ `message_query.rs`（检索）/ `usage.rs`（用量账本）/ `settings.rs`（应用设置）/ `sqlite.rs`（实现）/ `commands.rs`（20 个 `cmd_*`）/ `tests/`。
  SQLite + WAL + 单写连接 + `spawn_blocking`；**先落库再 emit**。
  ⚠️ 打开库的入口分两层（配置下沉 D3 的前置）：**零 `tauri::`** 的 `commands::open_session_db(host, spawn)`（库路径 = `host.data_dir()/virlen.db`，返回 `SessionDb { repo, settings, maintenance }`，后台任务由宿主传入的 `spawn` 派发）+ GUI 薄壳 `init_session_db(app)`（构造 `TauriHost` + `app.manage(...)`）。
  ⇒ 「会话库 / 配置在哪」只由 `HostEnv::data_dir()` 决定 —— CLI 传 `$VIRLEN_DATA_DIR` 就与 GUI 共用**同一份** `virlen.db`。
- **前端封装**：`src/infrastructure/sessionRepo/`（`cmd_list_sessions / cmd_get_session / cmd_get_messages / cmd_get_message_page / cmd_upsert_session / cmd_delete_session / cmd_replace_session_messages / cmd_append_messages` …）。
  启动只加载会话**元数据**，消息**懒加载**（`sessionStore.ensureMessagesLoaded`）。`utils/db.ts`（IndexedDB）已废弃删除，**不要复活**。
- **用量账本（token 统计）**：账本 DTO / 聚合 / 明细在 `session_db/usage.rs`；前端 `statsRepo/`、`usage-ledger/`、`services/token-stats-service.ts`。
  ⚠️ **Rust 只回 token 数，费用一律前端算**；内置价目表固定存 USD（`src/domain/pricing/index.ts`），切币种时按固定汇率折算。
- **应用配置（配置下沉 D3，见 `docs/config-sink-plan.md`）**：`session_db/settings.rs` 的 `app_settings` 表（一 key 一行，`value` 为 JSON 文本），与会话库**同文件 + 同一把单写连接**（不引入第二个写连接 → 无 `SQLITE_BUSY`；迁移/维护天然覆盖它）。命令 `cmd_settings_get_all` / `cmd_settings_upsert` / `cmd_settings_import`（后者**仅表空时**导入，供首启从 localStorage 迁移）。
  ⚠️ **键名与前端 `SettingsStore` 字段同名同层**（如 `providers` / `permissions` / `sandboxMode`），**不建映射表**；保留键以 `__` 开头（`__schemaVersion` / `__migratedFrom`）。新增设置项时必须两侧一起看（字段漂移风险）。
  前端接入：`infrastructure/settingsRepo/`（Tauri 命令 / 非 Tauri 自动降级空实现）+ `settingStore.hydrateSettings()`（启动水合，`main.ts` 里排最前）+ 变更 debounce 回写（退出前 `flushSettingsPersist()`）。
  ⚠️ **localStorage 已退出（S3 收尾）**：`settingsState` 的 `StorageState` 用只读适配器 —— Tauri 下 `setItem` 丢弃（设置只落表，密钥不再在 localStorage 重复存一份明文）、表就绪后 `removeItem` 历史副本；非 Tauri（浏览器 dev）仍照写。回归项 `src/tests/infrastructure/settings-local-snapshot.test.ts`。
  ⚠️ **下沉范围（S7 后）**：`SettingsStore` 全部字段 + 「忽略沙盒命令」规则的 `sandboxIgnoreRules` 键（前端 `infrastructure/securityRepo/`，启动入口是 **`securityStore.hydrate()`**（`main.ts` 的 `step('securityConfig')`）+ 退出前 `flushSecurityPersist()`）。
  ⚠️ **规则是单一源：localStorage 不保存它**（`securityRepo.save()` 只写 `whitelist`/`blacklist`/`skipEachDirs`）——「读 localStorage 优先」会让 CLI 改过的规则在 GUI 里失效，所以 `load()` 在 Tauri 下只认内存快照（来自表）。
  `whitelist` / `blacklist` / `skipEachDirs` **仍只存 localStorage**（本期未下沉）。

### 5.4 安全体系（四道闸）

| 闸 | 位置 | 要点 |
|---|---|---|
| **路径校验** | `domain/security/index.ts` + `services/security-service.ts` + `utils/pathCanonicealize.ts`；Rust 镜像 `native_tools/common.rs` | 优先级 **黑名单 > 白名单 > 工作目录**；写模式（`mode='w'`）仅允许白名单 + 工作目录，**两侧规则必须等价** |
| **权限三态** | `domain/permission/index.ts` + `settings.permissions`；Rust 镜像 `native_tools/execute/common/classify.rs` | 命令按 `safe/install/dangerous` 映射，脚本走 `script.execute`，沙盒脱壳走 `sandbox.*.execute`；`deny` 永远优先；脱壳与命令权限**取更严格者**（默认 `ask`） |
| **跨平台沙盒** | `infrastructure/sandbox/*` + `src-tauri/virlen-core/src/sandbox/` | Windows：Job Object + 受限令牌 + ACL；Linux：Landlock（默认拒写）；macOS：`sandbox/macos/mod.rs`。**禁止绕过沙盒直接 spawn**。可写根**只来自** workspace + 白名单：**不自动豁免**包管理器缓存（`~/.npm` / pnpm store / `~/.cargo`…）等区外目录——该「环境探测 + ACL 授予」机制已**整体移除**（实测不好用），要放行区外写入请让命令命中下方「忽略沙盒命令」规则 |
| **工具风暴防护** | `domain/engine/storm-breaker.ts` / `agent/storm_breaker.rs` | 滑窗（window 6 / threshold 3）检测重复 `(toolName, args)`，命中即中断循环 |

> 唯一「绕过沙盒」的例外：`execute_command` / `execute_script` 传 `sandbox:"off"`（见 §8、§11.2），按脱壳权限决策、`readonly` 直接拒绝，并埋点 `tool.sandbox.bypass`。

> 「忽略沙盒命令」规则（**设置 → 安全 → 忽略沙盒命令**）：命中规则的命令**免除「沙盒脱壳」审批，并以「不使用沙盒」方式执行**
> （AI 不必显式传 `sandbox:"off"`；沙盒已关闭 `off` / 只读 `readonly` 时规则不生效）。
> 该规则也是「区外写入」（如 `npm install` 写 `~/.npm`、pnpm store）的**唯一推荐放行方式**（不要再做沙盒侧自动探测/豁免）。
> **匹配有两份实现（S7 起），由两侧共读的 golden 收敛**（`src/tests/fixtures/sandbox-rules.golden.json`）：
> - **Rust 侧（权威：默认引擎 + CLI）**：`src-tauri/virlen-core/src/security/`（`rules.rs`：`text` / `regex` 原生 + `js` 交内嵌 QuickJS `js_rule.rs`）；
> - **TS 侧（浏览器 dev / TS 引擎路径 / 设置页「测试」）**：`domain/security/sandbox-ignore-rules.ts`，经 `securityService.matchSandboxIgnoreRule` 使用。
> **规则来源是 `app_settings` 的 `sandboxIgnoreRules` 键**（配置下沉 D3；`infrastructure/securityRepo` 启动水合 + debounce 回写，退出前 flush）：
> ⚠️ **单一源：localStorage 不保存该字段**（`securityRepo.save()` 只写三个路径配置；Tauri 下 `load()` 只认内存快照）。
> 启动入口是 `securityStore.hydrate()`：表里**有**该键 → 读进内存快照；表里**没有** → 一次性迁移 localStorage 的历史副本进表。
> 两条分支随后都**清掉** localStorage 的规则字段 —— 因此「删掉表里的行」= 真正清空规则（不会被迁回）。
> - **Rust 引擎路径**（默认）在 `native_tools/execute/{execute_command,execute_script}.rs` 里**本地判定**（规则随 `NativeToolSecurity.sandbox_ignore_rules` 下发，零 IPC、零 IO）；
> - **TS 引擎路径**在 `infrastructure/tools/execute/{execute-command,execute-script}.ts` 里定 `bypassSandbox`；
> - **CLI** 没有前端，用 `security::load_sandbox_ignore_rules(&db.settings)` 读**同一个键**。
> ⚠️ 原「内部交互 `sandbox_rule_check` 问 JS」已**删除**（它要求存在 JS 宿主，纯 Rust CLI 问不到，只能白等超时后按未命中）。
> `js` 规则的输入是代码编辑器 `ui/components/code-editor/CodeEditor`（可编辑的精简版 Monaco，见 `monaco/setupMonaco.ts`：只有词法高亮，**无语言服务/无诊断**）；
> 默认模板 `SANDBOX_JS_DEFAULT_PATTERN` 是带注释的 `function matchCommand(command){...return false}`（**默认不命中**），
> **切换匹配方式会重置「匹配内容」**（`defaultSandboxRulePattern`）。
> **列表顺序即匹配优先级**（`findMatchingSandboxRule` 取第一条命中的启用规则），设置页里**拖拽左侧把手**排序（`reorderSandboxIgnoreRule` ↔ `securityStore.reorderSandboxRule`，几何计算在 `ui/pages/Settings/sandbox-rules-dnd.ts`；同一把手支持 ↑/↓ 方向键 = `moveSandboxIgnoreRule`）；
> ⚠️ 拖拽用 **pointer 事件**自实现，不能用 HTML5 drag & drop（`dragDropEnabled: true` 与 HTML5 拖拽互斥，见 `chat/.../use-tree-drag.ts` 与 §11.8）；
> 空列表里的「常用规则」来自 `SANDBOX_RULE_PRESETS`（`createSandboxIgnoreRuleFromPreset`）；
> 保存前的校验走 `compileSandboxRule`（**只验证能否编译，不执行规则体** —— 运行期抛错在生产按未命中处理，不该拦住保存）。
> ⚠️ 规则**只**免「沙盒脱壳」：`terminal.*` / `script.execute` 的风险审批照旧（命中规则时弹窗追加 `SANDBOX_RULE_BYPASS_HINT` 说明原因）；
> 「沙盒脱壳」权限设为 `deny` 时 **deny 仍然优先**（`apply_rule_clearance` 只把 `ask` 降为 `allow`）。
>
> ⚠️ **`js` 类规则在无 JS 宿主的 CLI 下**由**内嵌 QuickJS**（`quickjs_runtime`，**必须用 `quickjs-ng` 特性**，默认的 `bellard` 在 Windows MSVC 编译不过）求值 —— 已落地（S7：`src-tauri/virlen-core/src/security/js_rule.rs`）。
> 受限 runtime：**不注入任何 host 函数**、内存 16 MB / 栈 512 KB 上限、单次求值 200 ms 中断超时、每次求值新建 runtime（无跨命令状态）；编译失败 / 抛错 / 超时 / 超内存**一律按未命中**（fail-closed）。
> ⚠️ 它带一个**构建期**硬依赖 `libclang`（bindgen），见 §7。已知差异（均在安全侧）：Rust `regex` 不支持 lookaround → 这类规则在 Rust 侧按未命中。详见 `docs/config-sink-plan.md` §4。

### 5.5 Provider 与搜索源

- **LLM Provider**：实现 `IProvider`（`infrastructure/provider/types.ts`：`listModels / chat / chatStream / buildRequest / validateApiKey`），模板放 `domain/provider/config.ts`。
  TS 侧 3 种全支持；Rust 侧原生 OpenAI / Anthropic，**Gemini 走 `BridgedProvider`**（委托 TS）。
- **搜索源**：实现 `ISearchProvider`（`domain/search/types.ts`），放 `infrastructure/search-providers/`（**实际接入 `tavily` / `bocha`**，`searxng.ts` 存在但未接入），`factory.ts` 注册。配置存 `SettingsStore.searchProviders` + `defaultSearchProviderId` → **已随配置下沉落到 `app_settings`**：原生 `web_search`（`native_tools/web/web_search.rs`）与 CLI 经 `ctx.settings` 读**同一份**，不再依赖前端下发。

### 5.6 视觉 / RAG / Skill

- **视觉**：核心（模型定位 + 懒加载 + 推理）在 `src-tauri/virlen-core/src/vision/`（**零 `tauri::`**，GUI 与原生工具共用）；`src-tauri/src/vision_service.rs` 只是 Tauri 命令壳；前端 `infrastructure/vision/`；模型在 `resources/quasivision_models/`。**图片不出本机**，不要改成上传。
- **RAG 知识库**：`src-tauri/virlen-core/src/rag/`（`document.rs` / `embedding.rs` / `vector_store.rs` / `rag_service.rs`）+ `services/rag-service.ts` + `infrastructure/rag/`。向量索引用 turbovec。
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

1. **双引擎同步**：`src/domain/engine/*`（TS）与 `src-tauri/virlen-core/src/agent/*`（Rust）是同一套语义的两份实现。
   改「LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销语义」时**两边都要改**。
2. **事件契约不可擅自改名**：`AgentEventType` 是四方共享契约（TS 类型 → TS emit → Rust emit → chat-service 处理），新增必须四处一致。
3. **引擎不碰持久化、不 import store**：TS 引擎经 `onEvent` 交 `chat-service` 落库；Rust 引擎由 `SessionRepo` 内部直落。
4. **新增 Tauri 命令必须注册**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]`，否则前端 `invoke` 静默 404；涉及权限还要看 `src-tauri/capabilities/default.json`。
5. **工具是「定义 + 执行器」分离注册制，且定义只有一份**：定义在 Rust 侧权威源 `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`；前端 `toolRegistry.register(name, executor, label?)` 只注册执行器与 i18n 文案，读取走异步 `listDefinitions()`。**不要在任何一侧另写定义体**（`src/tests/contracts/tool-defs-contract.test.ts` 守这条线）。
6. **写操作必须先过安全校验**：JS 侧 `securityService.resolveSafePath/isPathAllowed`，Rust 侧 `native_tools::resolve_safe_path / is_path_allowed`，两侧规则必须等价。禁止绕过。
   路径展开（`~` / `%USERPROFILE%`）与 canonicalize 规则**必须共用同一实现**：`src-tauri/virlen-core/src/sandbox/paths.rs::expand_user_path`（前端经 `canonicalize_path` 命令走同一函数）。禁止在任一侧另写一份展开/规范化逻辑，否则黑名单条目会在默认引擎下静默失效。
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
npx tsc --noEmit             # 类型检查（静态门禁之一）
cd src-tauri; cargo clippy --workspace --all-targets -- -D warnings   # Rust 静态门禁（须零告警；CI `ci.yml` 每次 push/PR 跑，见 §11.28）
cd src-tauri; cargo test --workspace   # Rust 侧测试（⚠️ 必须 --workspace，见 §7 下注）
pnpm build:msix              # Windows MSIX 打包（scripts/build-msix.ps1）
pnpm build:cli               # 打包 headless CLI（release 二进制；三元组用环境变量 CARGO_BUILD_TARGET，别用 `--target`，见 §11.31）
                             # 产物 src-tauri/target[/<triple>]/release/virlen-cli[.exe]；发版时三个 build-*.yml 会把它
                             # 连同 quasivision_models 打成 **zip** 上传（§11.29）
pnpm cli config get          # headless CLI（= cargo run -p virlen-cli -- …；与 GUI 同一份 app_settings）
pnpm cli run "解释 README"   # 无界面跑一次 agent（stdout=正文 / stderr=工具进度；同一份会话库）
pnpm cli list-session -g agent   # 列出会话（-g agent|workdir 分组；--limit / --json；含「上下文/200k」「条数」两列）
pnpm cli chat                    # 交互式 TUI：状态行显示上下文占用 %；/compress [ai|raw] 压缩上下文
pnpm cli list-agent              # 列出 Agent（读 app_settings.agents，含各自会话数）
pnpm cli provider add            # 交互式配一个供应商（逐步录入 → 验证 → 按 id 合并写入；需真终端）
pnpm cli provider list --json    # 列出供应商（apiKey 已掩码）；另有 provider edit|rm|test
pnpm cli agent add               # 交互式配一个 Agent（逐步录入；需真终端）；另有 agent edit|rm|list
```

- 测试文件实际位于 **`src/tests/**`（不是 `tests/`）**，`vitest.config.ts` include 已固定，setup 文件 `src/tests/setup.ts`（模拟 Tauri API）。
- 基线（README 记录，**本机沙盒未复现**，见 §11.2）：`cargo test --workspace` / `vitest run` 全绿、`tsc --noEmit` 零错误。
- 提交前**至少**自查：`npx tsc --noEmit`（无新增错误）+ 受影响模块的测试。
- ⚠️ 本机沙盒内 `vitest` / `vite build` 会因 `esbuild` 子进程 `spawn EPERM` 失败，须走**沙盒脱壳**（`sandbox:"off"`，见 §11.2）。
- ⚠️ **Rust 构建需要 `libclang`**（`quickjs_runtime` → `hirofa-quickjs-sys` → `bindgen` 的**构建期**依赖）：Windows 装 LLVM 并设 `LIBCLANG_PATH=<LLVM>\bin`，否则 `cargo build` / `cargo check` / `tauri dev` 会在 `hirofa-quickjs-sys` 直接失败（报 `Unable to find libclang`）。
  - `clang-sys` 只探测 `LIBCLANG_PATH` 与 `llvm-config.exe`，**不扫 `PATH`**：LLVM 装在非默认位置、或该发行版不带 `llvm-config.exe`（本机 `C:\config\LLVM` 即是）时**必须**显式设。
  - 必须**持久化**（用户级环境变量）并**重开终端 / IDE**：临时 `$env:LIBCLANG_PATH` 只对当前 shell 生效，而 `pnpm tauri dev` 由 CLI 新起 shell 跑 `cargo run` → 表现为「手动 `cargo build` 能过、`tauri dev` 报 `Unable to find libclang`」。
  - 该 bindgen 调用在 `hirofa-quickjs-sys/build.rs` 里**无条件**执行（无特性开关），**不能**用 feature 绕开。
- ⚠️ `src-tauri/` 是 **cargo workspace 根**，含 **3 个 package** —— 即「**core / cli / tauri**」三个模块：`virlen-app`（GUI 壳，workspace 根 package）、`virlen-core`（零 `tauri::` 的核心库，**不含命令入口**）、`virlen-cli`（headless，只依赖 core，命令实现与规划的 TUI 都在它的 **lib** 里）。`target/` 与 `Cargo.lock` 位置**不变**（仍在 `src-tauri/`）。
  - **GUI 与 CLI 的差异只允许来自「宿主注入」**（`HostEnv` / `EventSink` / `TelemetrySink`），不允许来自「两份实现」—— 这条以前靠注释约定，现在**由编译器强制**（core 连 tauri 依赖都没有）。
  - ⚠️ **`cargo test` 必须带 `--workspace`**：manifest 指向 workspace 根 package 时，裸 `cargo test` **只跑 `virlen-app`**（实测：30 个用例），会**静默漏掉 `virlen-core` 的 354 个与 `virlen-cli` 的 57 个用例**（共 411）。CI 三个 workflow 已同步。
  - 纯 Rust 目标（`cargo build/check/test`，dev profile）**不读** `frontendDist` → **无需**先 `pnpm build`（实测：把 `frontendDist` 指向不存在的目录仍通过）。`tauri build` 自己会跑 `beforeBuildCommand = pnpm build`，也不用手动。
  - `[package] default-run = "virlen-app"` 保留为防御性声明，见 §11.14。

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

1. **先写定义（Rust 侧权威源）**：在 `src-tauri/virlen-core/src/agent/tool_defs/definitions.json` 的**三个平台变体**里都补上该工具（`name` / `description` / `parameters`）；平台无关的工具三份内容相同，平台相关描述参考 `execute_command`。Rust 侧不用改代码（`include_str!` 自动带上），见 `docs/rust-engine.md` §12。

2. **再写执行器**（在所属分类目录新建文件；**不写定义**）：

   ```ts
   toolRegistry.register(
     'my_tool',
     (async (args, ctx: ToolContext) => {
       // ctx: { sessionId, toolCallId, abortSignal, write, skills }
       // 需要用户交互 → return new UserInteractionRequired('my_interaction', {...})
       return '给 LLM 的结果文本' | { content: string, uiData?: Record<string, any> }
     }) as ToolExecutor,
     t('我的工具'), // 可选：UI 文案（i18n），不进契约
   )
   ```

3. **挂进启动注册链**：分类 `index.ts` 加 `import './my-tool'`（新分类还需在 `tools/index.ts::toolsInit()` 加 `await import(...)`，并在 `domain/tools/category.ts` 的 `TOOL_CATEGORIES` 登记）。
4. **公共函数**：同分类 ≥2 工具复用 → 抽到分类 `common.ts`。
5. **UI 渲染**：`tool-call/` 新建 `XxxMessage.tsx` 实现 `IToolCallMessage` 并 `register(...)`（未注册落 `DefaultMessage`）。
6. **是否原生化**：在 `native_tools/mod.rs` 的 `is_native_tool` + `execute_native_tool` 加分派，对应分类目录新建 `<工具>.rs`（复用 `common.rs`）；需要会话库的工具从 `ctx.repo` 取（先看 `is_available()`），需要安全配置的从 `ctx.security` 取。
7. **测试**：`src/tests/infrastructure/*.test.ts`（JS）；Rust 加内联单测。契约与执行器的名单一致性由 `src/tests/contracts/tool-defs-contract.test.ts` 守（契约里有定义 → 必须有执行器，反之亦然）。

### 9.2 新增 / 修改 Provider、搜索源、Skill

- **LLM Provider**：实现 `IProvider` → `provider/index.ts::createProviderInstance` 注册 → 模板放 `domain/provider/config.ts`。要 Rust 原生支持需在 `agent/provider.rs` 加实现，否则自动走 `BridgedProvider`。
- **搜索源**：实现 `ISearchProvider` → 放 `infrastructure/search-providers/` → `factory.ts` 注册 → 配置存 `SettingsStore.searchProviders`（已下沉 `app_settings`）。⚠️ **若要被默认引擎（Rust）+ CLI 使用，还要在 `src-tauri/virlen-core/src/agent/native_tools/web/web_search.rs` 里加同名分支**（当前只有 `tavily` / `bocha`）——否则该搜索源只在浏览器 dev / TS 引擎路径生效。
- **内置 Skill**：`src-tauri/resources/default-skills/<name>/SKILL.md`，frontmatter 至少 `name` / `description`（也兼容纯 Markdown：`# 标题` + `> 描述` + `**Version:** x.y.z`，解析器 `utils/mdYamlFrontmatter.ts`）；目录名应与 `name` 一致；脚本放 `scripts/`。

---

## 10. 前端约定

- **状态**：MobX 单一 store + `StorageState`（`utils/storageState.ts`）。⚠️ **设置类**（`settingsState`，key `_storage_state_virlen-settings`）自 S3 起 **Tauri 下不再写 localStorage**（权威源是 `app_settings` 表，见 §5.3）。新增设置项记得加进 `SettingsStore` 接口 + `defaultSettings` + 设置页 UI（`ui/pages/Settings/`）。
- **会话持久化**：见 §5.3。启动只加载元数据，消息懒加载；`utils/db.ts` 已废弃，不要复活。
- **组件事件**：`src/events/*` 的 EventEmitter；禁止 `window.*` 全局挂载。
- **样式**：组件目录内 `style.scss`，BEM 类名；主题变量在 `ui/styles/theme.css`。
- **窗口**：无边框自绘 + 首帧 `show()`。
- **性能**：消息列表虚拟滚动 + 分页（改 `message-list.tsx` 注意 `measureElement`）。
- **埋点**：`track('域.动作', props)`，默认关闭、关闭时零开销。

---

## 11. 常见坑（踩过的，别再踩）

> **速查级**：每条只留「现象 → 根因 → 结论 / 改哪里」。专项细节在各自文档里（PTY `docs/pty-research.md`、TUI `docs/cli-tui-plan.md`、托盘 `docs/tray-implementation-plan.md`、Rust 引擎 `docs/rust-engine.md`）；本节被压掉的长篇叙述与实验记录见 git 历史（`git log -p docs/AGENTS.md`）。

**11.1 PowerShell 5.1 按本地代码页（GBK）读文件** —— 看含中文的源码会乱码：读加 `-Encoding UTF8`；写统一用 `write_file` / `edit_file`（UTF-8）。

**11.2 本机沙盒的已知限制（环境行为，不是代码 bug）** —— `vitest` / `vite build` / `jest` / `node-gyp` / `child_process.exec*` 因 `esbuild` 子进程 `spawn EPERM` 跑不了。根因：libuv 给 spawn 的 stdio 建的是**命名管道**（NPFS 内置 SD 无 restricting SID 写 ACE → 受限令牌第二遍检查 `ACCESS_DENIED`）；**匿名管道不受影响**（python `subprocess(capture_output=True)`、`cargo`→`rustc` 均正常）。
退路：`execute_command` / `execute_script` 传 `sandbox:"off"`（按「沙盒脱壳」权限授权，`readonly` 拒绝）；不想每次授权就配「设置 → 安全 → 忽略沙盒命令」（命中即自动无沙盒，见 §5.4）。临时关闭：`VIRLEN_SANDBOX=off|readonly|on`（由 **Virlen 进程**读取，命令里 `set` 无效）。另：`node_modules` 可能不完整，先 `pnpm install` 再判错。

**11.3 版本号分散在 7 个文件 / 10 处，靠手动同步** —— `package.json`、`src-tauri/Cargo.toml`、`virlen-core|virlen-cli/Cargo.toml`、`src-tauri/tauri.conf.json`（**打包与 MSIX 实际读它**）、`Cargo.lock` 的三个本包条目、README ×2。用 `pnpm update`（`scripts/update-version.mjs` 已覆盖全部，`--dry-run` 可预览）。

**11.4 README ×2 需同步维护**（`README.md` / `README-CN.md`）—— 改工具数量、测试目录（`src/tests/`）、技术栈版本时最容易漂移。

**11.5 前端工程四条** —— `vite.config.ts` 的 `optimizeDeps.exclude: ['monaco-editor']` **不可去掉**（否则 monaco 打成多份实例、注册表互相隔离）；Vite 端口固定 1420（`strictPort`），`tauri dev` 会因占用失败；`tsconfig.json` 是 `strict: true` 但 `strictNullChecks: false`、`noUnusedLocals/Parameters: false`（别名 `@/*` → `src/*`，Vitest 另配一份）；Run Snapshot 只存内存、刷新即失效，用户取消**不算错误**（要保留 partial 内容，见 `docs/rust-engine.md`）。

**11.7 Windows `execute_command` 走 ConPTY（伪控制台）** —— stdout / stderr **合并为一条 VT 流**，`uiData.pty = true`（前端用 xterm 渲染，非 PTY 才回落 `<pre>`）；完整背景见 `docs/pty-research.md`。
- 给模型看的文本必须过 `process_terminal_output`（完整吞掉 ECMA-48 转义序列，**Rust / TS 两侧必须同步**）；**不要再假设子进程 stdio 是管道**。
- 交互走 Tauri 命令 `pty_write` / `pty_resize` / `pty_key`（**不经引擎事件总线**）。两条红线：用户输入正文**不回灌**给模型；终端内确认的命令**仍走沙盒 + 同一条执行路径**。
- 缺口：TS 引擎路径未 PTY 化；常驻交互 shell（Step 3）未做；Unix PTY 未实现（`runner/pty.rs` 整体 Windows 门禁，见 §11.31）。

**11.8 拖拽取文件路径：`dragDropEnabled` 只能为 `true`（与 HTML5 拖拽互斥）** —— 原生拖放能拿真实路径（`onDragDropEvent().payload.paths`），但页面收不到 HTML5 `drop`。实现见 `ui/pages/chat/components/input/index.tsx`（监听 + 命中判断）+ `input/hooks.ts`（同类说明散见于 `use-tree-drag.ts` / `sandbox-rules-dnd.ts` 的文件头）。
附件：`MessageContent` 的 `file` 块**只存路径**，各 Provider 统一降级为文本（TS `fileBlockToText` ↔ Rust `provider.rs`，**两侧文案必须一致**；`ATTACHED_FILE_LABEL` / `ATTACHED_DIR_LABEL` 用英文、不进 i18n）。

**11.9 粘贴文件：路径只能问原生剪贴板**（页面 `DataTransfer` 里没有）—— `read_clipboard_file_paths`（`src-tauri/src/clipboard_files.rs` = `CF_HDROP`）；读不到一律返回 `[]`，**不报错、不打断粘贴**。前端在 `input/index.tsx` 汇到 `acceptPaths`，含 Ctrl+V 原生兜底（WebView2 对「复制的文件」可能连 `paste` 事件都不触发）。

**11.10 输入框高度模型：固定高度只落在 textarea 上**（否则附件把工具条顶出盒子）—— 两个必须对齐的常量：`index.tsx` 的 `INPUT_CHROME_HEIGHT = 58` ↔ `style.scss` 的 `.input-wrapper` 静止高度 125 / `textarea { min-height: 67px }`；`.has-fixed-height textarea` 必须 `flex: 0 0 auto`。

**11.11 Windows 上 `cargo test` 可能连启动都启动不了（comctl32 v6 清单）** —— 报 `0xc0000139` 且无任何 Rust 输出，而 `cargo build` / `check` 正常。根因：托盘**菜单**（muda）链进 comctl32 **v6 专属**导出 `TaskDialogIndirect`，而带 RT_MANIFEST 的 `resource.lib` 只经 `rustc-link-arg-bins` 给了 **bin** → 测试二进制在**加载阶段**就失败。修法在 `src-tauri/build.rs`：全局 `/MANIFEST:EMBED` + `/MANIFESTINPUT:windows/common-controls.manifest`，同时给 bin 加 `/MANIFEST:NO`（否则 `CVT1100 duplicate resource`）。定位手法可复用：解析两个 exe 的 PE 导入表做差分。

**11.12 单实例：`tauri-plugin-single-instance` 必须第一个注册，且它自己会 `process::exit`**
- **顺序**：插件 `setup` 按注册顺序执行、都在 `App::build()` 内（`initialize_plugins`），**早于** `.setup()` 回调与窗口创建 → 不在链上第一个的话，第二实例会先建好窗口 / 托盘 / SQLite 再被杀。
- **清理**：第二实例的退出**绕过** `tray::destroy()`（不发 `NIM_DELETE` → 幽灵图标）。当前无事（那时还没建托盘），但**别**在 `tauri.conf.json` 加 `app.trayIcon` —— 那个默认托盘在 `initialize_plugins` **之前**就建好了。
- **dev 下不注册**：`lib.rs::run()` 用 `if !tauri::is_dev()` 包住，否则没关干净的 dev 实例（关窗只隐藏到托盘）会把新起的 `pnpm tauri dev` 顶掉，表现为「跑完什么都没出现」。判定信 `tauri::is_dev()`（= `DEP_TAURI_DEV`），**别**自己写 `cfg!(feature = "custom-protocol")`（本包没声明该 feature，恒 true = 永远算 dev）。
- 窗口唤起统一走 `tray::activate_main_window(app, reason)`（**不清未读**）。

**11.13 切会话有唯一入口 `chat-view.tsx::handleSelectSession()`** —— 外部只改 `chatState.currentSessionId` 会「跳过去但消息列表是空的」（它还要 SQLite 懒加载、`setMessages` 镜像、中断残留修复、用户消息索引、埋点、清红点）。
外部入口（托盘唤起等）拿不到组件函数 → `chat-view` 有「外部入口兜底 effect」（`handledSessionRef`）接住：**新增外部切会话入口只改 store**；组件内自己切（如 `doSend` 新建会话）必须登记 `handledSessionRef`，否则兜底 effect 会按旧内容覆盖刚加的消息。另：`message-list` 的 `hide`（`opacity: 0`）在 `messages` 为空时也必须解除（见 `use-scroll-controller.ts`）。

**11.14 workspace 拆包（`virlen-app` / `virlen-core` / `virlen-cli`）后的四条硬约束**
1. **`cargo test` 必须 `--workspace`** —— 裸跑只跑当前 package，core / cli 的用例**静默不跑**（同一坑也适用于 `cargo check` / `build`，但那里是「想要的」：Tauri CLI 就靠默认目标）。
2. **`virlen-core` 不得出现 `tauri::`** —— `#[tauri::command]` 一律放 `virlen-app/src/commands/`；宿主差异走 `HostEnv` / `EventSink` / `TelemetrySink` 注入；测试 fixture 与资源根用 `CARGO_MANIFEST_DIR` + 多一级 `..`。
3. **CLI 的 bin 目标不能加 `windows_subsystem = "windows"`**（它要 stdout / stderr）；**CLI 逻辑一律放 lib** —— bin 目标不被单测引用，写在 bin 里就测不到。
4. **命令入口不得回到 core** —— core 为 CLI 新开的 `pub` 出口只有 `security::{parse_rules, SandboxIgnoreRule, load_sandbox_ignore_rules}`（其余仍 `pub(crate)`）；搬 `pub(crate)` 项目出 crate 会立刻编译不过，这是有意的护栏。
自检：`cargo tree -p virlen-cli` 不含 tauri / wry / tao（实测 CLI 少 94 个依赖 crate，但二进制只小约 5% —— linker 本来就会死代码消除）；`[package] default-run = "virlen-app"` 是防御性声明（缺它曾报 `failed to find main binary`）。

**11.15 headless CLI `run` 的四条边界（都是有意设计，不是缺陷）**
1. **无前端 = 无 JS 桥** —— 28 个工具全部原生，但 `security` **必须**下发 `Some(..)`（`tool_executor` 靠它决定原生 or 走桥，缺了会去等一个不存在的 JS 宿主而**永久挂起**）；`BridgedProvider`（Gemini 等）在**装配阶段**直接报错。
2. **交互一律 fail-closed** —— `run.rs::ask_user` 只在 stdin 是 TTY 时提示并读一行（`y`/`yes` 放行），否则回 `{__kind:"cancelled"}`（一行命令都不跑）。⚠️ **只重定向 stdout/stderr 时 stdin 仍是终端** → 会按交互模式等输入（看着像卡住）——要么连 stdin 一起重定向，要么把权限改成 allow/deny。
3. **桌面端存 localStorage 的白/黑名单、跳过目录 CLI 读不到**（按空处理）—— 路径安全只由「工作目录 + 沙盒 + 权限三态」兜底；反过来 `permissions` / `sandboxMode` / `sandboxIgnoreRules` 都在 `app_settings`，CLI 与桌面端天然一致。
4. **会话的工作目录创建后不可变更** —— 续跑只认会话记录，`--workspace` 与之不同直接报错；记录为空才按 `--workspace` → `defaultWorkspace` → cwd 回退，且**不写回会话**（`resources.rs::resolve_workspace`，纯函数有单测）。⚠️ 它同时决定工具 cwd / 沙箱可写根 / 提示词里的工作目录 / `AGENTS.md` 注入点 —— 曾经取 cwd 并写回会话 = 模型在另一个项目里读写（真实 bug；「同一目录的两种写法」判定见 §11.31）。

**11.16 配置下沉进度：localStorage 里还剩哪些「业务数据」** —— CLI / headless 的能力天花板就在这张名单上。
已在 `app_settings`（GUI 与 CLI 共用）：`settings` 全量、`sandboxIgnoreRules`、`searchProviders` / `defaultSearchProviderId`、`agents`。
仍在 localStorage：`virlen-security` 的 `whitelist` / `blacklist` / `skipEachDirs`（路径安全少一半，见 §11.15 第 3 条）；`virlen-skills` 的**启用状态**（技能目录固定为 `<data_dir>/skills`、CLI 自行推导 → `list_skills` 可用，但不知道桌面端勾了哪些）；UI 偏好 / 埋点缓冲 / 更新偏好（无需下沉）。
判断标准一句：**headless 侧的功能要不要它** —— 要就照 `securityRepo` / `agentRepo` 的模板下沉（表为权威 + 内存快照 + 首启迁移 + debounce 落库 + 退出前 flush）。

**11.17 CLI 交互式 TUI（`virlen-cli chat`）与 Windows 上的一条硬坑** —— 完整方案与实测见 `docs/cli-tui-plan.md`。
- **形态已定**：ratatui **内联视口**（`Viewport::Inline`）—— 已完成内容固化进终端**原生滚动区**，输入框 + 状态行钉在底部。内联两条硬约束：**高度只能在构造期定死**（`Terminal.viewport` 是私有字段）；固化必须**分块**（否则一次灌 120 行只落地 20 行）。
- **⚠️ 硬坑**：Windows 上「改变窗口大小」后 `crossterm::terminal::size()` 会持续失败于 `os error 233`，约 0.25–5 s 后自愈 —— 排除法已确认**不是** ratatui 逻辑 / 事件源 / `insert_before` / 内联独有，触发条件是「**启用 VT 输出 + 绘制**」，属 conhost 环境行为。**真正让用户看到「崩溃」的是写法**：失败被当致命错误 → 退出时 `println!` 又失败 → std panic → `abort`，且 ratatui 的 restore 钩子把 panic 文本冲掉（「崩了但什么都没留下」）。
- **任何 TUI 必须内建四条**：① **resize 去抖**（`Event::Resize` 后 300ms 内不碰终端；⚠️ **读事件要排在绘制之前**）；② **重试退避**（失败 → 记日志 + 退避 250ms）；③ **I/O 失败路径禁止 `println!`**（一律 `writeln!` + 忽略错误，并自装 panic 钩子先落盘 `Backtrace::force_capture()`）；④ **降级**（连续失败超 5 s → 顺序输出模式）。
- **两条路径一条语义**：默认内联视口 TUI；stdout / stdin 非终端（管道 / 重定向 / CI）、`--no-tui`、或连续失败超 5 s → 切**顺序输出模式**（复用 `run::CliEventSink` 的文本渲染 + 行读入，不写第二份渲染）。落点 `virlen-cli/src/tui/`：`mod`（参数 + 终端能力判定 + 降级）/ `app`（线程编排）/ `plain`（顺序输出）/ `sink`（`UiEventSink`）/ `state/{mod,line,event,key}`（状态机与按键）/ `view`（纯渲染，`TestBackend` 可断言）/ `commands`（斜杠命令解析）/ `input` / `term`（独占终端，四条措施都在这）/ `tests.rs`。
- **线程模型**：TUI 跑在**独立 `std::thread`**（终端只在它手里，自己 `poll(60ms)` 读键）；引擎回合 `tokio::spawn` 出去，主任务只在 `select!` 里等「用户动作」与「回合结果」。`run` 的同步 `ask_user` 会和输入框抢同一个 stdin → TUI 改成「事件出口送进 UI → 按键产生 `Action::Reply` → 主任务回执」，**排队**且**未知类型也答**。
- **`chat` 与 `run` 共用 `session_rt`**：切会话 / 新建必须走 `SessionRuntime::{bootstrap_chat, activate, turn_messages}`（重读会话记录 → 重算工作目录与安全配置 → 重取会话）；**每回合重读库**拿历史（库里那份才是权威）。
- **验证与两个手法坑**：真终端压测 30 次改尺寸（含比视口还矮的 `48x5`）+ 极小窗口，全程存活、0 panic。往**独立控制台**注入按键要 `FindWindow` → `ShowWindow(SW_RESTORE)` → **`SetForegroundWindow`** → `SendKeys`（`AppActivate` 不可靠）；`TestBackend` 断言**必须跳过宽字符后面的填充格**（否则中文断言假失败）。⚠️ 未实测：降级第②条（要人为造终端故障）、macOS / Linux 冒烟、「在桌面端自带终端里跑 `chat`」的双层 PTY。验证时**不要用 `… 2>&1 | Out-String` 之类的管道包装**（stdout 变管道 = 界面「看不见」，曾被误判为环境不支持）。

**11.18 大文件怎么拆（CLI / core 瘦身口径）** —— `run.rs` 1474 行、`tui/mod.rs` 1506 行这类「什么都往里塞」的文件已难审阅（`execute_command.rs` 更极端：1075 行里 794 行是测试）。
- **口径：目录模块 + 测试外移 + 纯搬运** —— `foo.rs` → `foo/{mod.rs,<职责>.rs,tests.rs}`；`mod.rs` 只放本模块的公共词汇（类型 / 入口 / 命令解析），子模块只放实现 → `crate::foo::X` 路径**一行都不用改**；必要时 `pub(crate) use self::<sub>::*;` **再导出**（`tui/mod.rs`、`run/mod.rs` 正是这么做的：**搬了文件，没搬调用点**）。
- **`tests.rs` 是惯用做法**：`#[cfg(test)] mod tests;` + 兄弟文件；测试段整体回退 4 空格缩进，**绝不逐条改测试**。一次只动一个文件，搬完立刻跑门禁（`cargo test --workspace` + `cargo check -p <pkg> --all-targets`）—— 纯搬运的好处是「失败必是搬错了位置」。
- **⚠️ 三个搬运陷阱**：① `impl Foo { … }` 是整块，切到多文件要各自补 `impl Foo {` 与 `}`（跨文件 `impl` 合法，且**子模块能访问父模块的私有字段**，不必放宽字段）；② 多行 `use x::{ … }` 必须整块搬；③ 文件以 `}}` 收尾时（`fn` 与 `mod tests` 同行关闭）外移测试要**少留一个 `}`**。
- **代价（如实标注）**：跨文件使用的东西必须放宽可见性 —— 本次 `pub(crate)` 放宽了 `session_rt::Resources` 字段、`list::AgentLite` 字段、`rag::vector_store::IndexState`、`tui::state::UiState` 的私有方法等。**不是设计变差**，是把「文件内私有可见性」换成显式 `pub(crate)`。
- **还没拆的（下次按同一口径继续）**：`agent/llm_round.rs` 705、`execute/common/runner/tests.rs` 688、`rag/embedding.rs` 649、`agent/tool_executor.rs` 551、`agent/bridge.rs` 531、`rag/rag_service.rs` 502、`execute_command/tests.rs` 794（可按场景再分文件）。

**11.19 conhost 屏底行：光标压在状态行上、输入覆盖状态行（已修）** —— 现象：`>` 后面输入的字**盖在状态行上**。根因（逐帧实测）：**写到某一行的最后一格**会让 conhost 留下「待换行」，一旦在屏底兑现就**整屏上滚一行**，而 ratatui / crossterm 不知道 → 视口正文比 ratatui 模型偏上一行，**光标仍按模型落位**。
- 结论：**任何一行都不能碰到屏的最后一格**，而状态行**又必须把自己的尾巴涂满**（否则状态行变短时上一帧的残字会留下）→ 靠「**整帧右侧留白 `RIGHT_MARGIN = 2` + 状态行用 `width_cjk` 算宽度**」同时满足。
- 为什么用 `width_cjk`：实测 `·`(U+00B7) / `—` 这类**歧义宽度**字符在 CJK 字体下由**终端**按 2 列推进，而 ratatui 按 1 列排版（`unicode-width` 的 `*_cjk` 与实测一致）。
- 修法（`tui/view.rs`）：① 整帧往右收 2 列；② 状态行的颜色只落 `Span`，**不再用 `Paragraph` 级样式**（否则整行空格被涂色 → 逐格画到行尾）；③ 状态行按 `width_cjk` 截断后**用空格补满到 `区宽 - 2`**（文本与补白同一上限 → 残字无处藏身）。测试固化在 `tui/view::tests`（断言涂满到 `宽 - 2*RIGHT_MARGIN` 且最后两列零样式）。
- **⚠️ 剩余风险**：正文里出现歧义宽度字符仍可能**轻微错位**；某行若被排满并溢出到最后一格仍可能上滚（`RIGHT_MARGIN=2` 只缓了一部分）。彻底解要等 ratatui 支持按 CJK 口径排版，或 TUI 自带宽度测量后自行折行。本次只取屏 / 注入按键验证，没做人眼观感确认。

**11.20 固化正文中文「每字一个空格」：`insert_before` 的 continuation bug（已修）** —— 根因：buffer 里宽字符后面有一个 continuation cell；视口内 `draw → diff_iter` **会跳过**它，而 Windows 上 `scrolling-regions` feature 不可用 → 固化落到 `insert_before_no_scrolling_regions → draw_lines`，它**逐 cell 输出、不跳过** → 每个宽字符后多一个空格。修法（`tui/term.rs::strip_wide_continuations`）：把 continuation cell 的 symbol 清成**空串**（⚠️ 必须 `set_symbol("")`，`reset()` 会退回 `" "`）。这是**绕过**上游 bug，ratatui 修了可删。

**11.21 中文「残影」：一行变短后多出来的汉字不消失（已修）** —— 根因（ratatui 源码级）：`ratatui-core/buffer/diff.rs` 在「**宽字符被窄字符替换**」时**不重发**宽字符的第 2 列（注释假设终端会自己处理 —— conhost 不成立），而我们无 bg 样式的正文正好落进那个「什么都不做」的分支。修法（`tui/view.rs`）：整帧渲染后把视口所有 cell 标 `CellDiffOption::AlwaysUpdate`（绕开 diff → 每帧完整重画）；**⚠️ 只画 `[0, 宽 - RIGHT_MARGIN)` 列**（右侧保留列绝不能画，否则触发 §11.19 的整屏上滚）。
- 连带修：整行连续重写暴露了状态行里 `·` 的宽度错位 → **状态行分隔符由 ` · ` 改为 ASCII ` | `**。代价是视口每帧全量重画（10×118，交互式 TUI 可忽略）。同为**绕过**上游 bug。

**11.22 工具调用处的「正文重复 / 时序错乱」：助手正文块必须按 `messageId` 认（已修）** —— 引擎的事件顺序（源码确证）：正文增量 → `tool_call` → **收尾帧**（`finalize_assistant_message`，在**工具执行之前**）→ 交互请求 / 应答 → `tool_result_created` → 下一轮 LLM（**新的** `messageId`）→「工具结果先于下一轮正文」是引擎侧保证的。
- UI 侧根因：状态机只记「当前正在追加的那一块」，而 `ToolStart` 把它置 `None` → 收尾帧找不到原块、被当成**新消息**又插一块（**正文整段重复**）；下一轮的增量又写进那一块 → 屏幕上看着就是「工具输出跑到下一轮回复后面」。**一个 bug，两个症状。**
- 修法：正文块改**按 `messageId` 认**（`state/mod.rs::assistant_blocks` + `state/event.rs` 的 `assistant_idx` / `append_assistant` / `set_assistant`）；增量来源从 `stream_event` 换成 `assistant_message_updated.patch.contentDelta`（多带 `messageId`；**两者都取会双份正文**）。
- 取证手法（仓库外探针 `%TEMP%\ratatui-inline-spike` 的 `console_probe`）：`typecn`（注入中文提问）/ `type1` / `typehelp` / `typeexit`；**`scrollback <pid> [n]`** 读「窗口底往上 n 行」的缓冲区 —— `dump` 只读窗口内 30 行，而固化进的是**原生滚动区**，核验行序只能这样读。

**11.23 续连体验：退出打印 session id + 续连命令，重连先预览最近 5 条（已落地）** —— 起因：退出只留一句「已保存」，而状态行里是**截断到前 8 位**的 `short_id`，不足以续连。
- 口径：「top 5」按**最近 5 条**（`SessionRepo::get_messages` 是 `ORDER BY rowid ASC` → 取尾部 `len-5..`），续连时有用的是「上次说到哪」。落点 `virlen-cli/src/tui/history.rs`（`HISTORY_PREVIEW` / `history_preview` / `resume_hint`），TUI 与顺序输出模式**各调一次同一份**。
- 展示通道：新增 `UiEvent::History(Vec<OutLine>)` → 整批进 `inflight` 并置 `commit_pending` → **立刻固化**（预览不属于任何回合，留在动态区会被第一个回合挤掉）；顺序输出模式直接打到 **stdout**。纯工具调用的助手消息退化为 `[AI] （调用工具 xxx）`；新会话无历史 → 连表头都不打。

**11.24 评审后的四项修复（`6beb531..f6c0681`）**
- **① 授权面板 fail-open（最严重，安全红线）** —— 旧实现是「行输入 + 回车放行」：**空白输入**被当成「允许」（界面却写 `[y/N]`），且交互期间按键**全部**落到交互上 → 「用户正在打下一句、误触 Enter」＝**直接批准危险命令**。修法：改成**显式二选一** `ConfirmChoice { Deny, Allow }`（默认 `Deny`）+ `Interaction::new()`（唯一构造入口）；←/↑ 拒绝、→/↓ 允许、Enter 确认高亮项、Esc/Ctrl+C 拒绝，**普通字符（含 `y`/`n`/Backspace）一律不参与**；回显按**实际发出的载荷**判「✔ 已允许 / ✘ 已拒绝」；授权面板**不调 `set_cursor_position`**（否则 ratatui 隐藏光标 —— 光标停在选择行正是旧实现被误触的暗示）。**交互一律 fail-closed。**
- **② core 的 `println!` 污染 CLI stdout** —— `virlen-core/src/vision/mod.rs` 有 7 处 `println!`（搬进 core 后 CLI 也在用同一份），插进 `run --json` 的 JSON Lines 就会让下游解析失败、而 CLI **无从改道**。修法：全改 `eprintln!`，并在模块头写明「本模块进度日志一律走 stderr」。
- **③ 两条渲染路径的事件配对是隐式契约** —— `run/render.rs` 取 `stream_event.delta`、`tui/sink.rs` 取 `assistant_message_updated.patch.contentDelta`（**故意忽略**前者以免正文双份），两者都在 `llm_round.rs::flush_stream_state` 发出，但**没有任何东西钉住** → 将来只发一个不会报错，只会让那一侧**静默丢正文**。修法：该函数文档写明「必须成对发出」+ 回归 `delta_patch_and_stream_event_are_emitted_in_pairs`。
- **④ GUI 壳残留 23 项死依赖** —— `virlen-app/Cargo.toml` 仍声明 `rusqlite` / `quickjs_runtime` / `reqwest` / `quasivision` 等（`src-tauri/src/**` 里使用次数均为 0）。代价不只是白编译：**同一 crate 被两个成员声明时特性相加**，任一处改动都会**静默**改变另一处构建（`quickjs_runtime` 的 `quickjs-ng` 正是「必须写对」的项）。已整批删除，保留项逐个 grep 确认在用；HTMD「与 TS turndown 同源非同实现」的注释补回 core。
- **仍未闭环**：§11.23 的 TUI 续连预览需真终端复验；`list/group.rs` 与桌面端侧边栏的分组口径差异（Workspace 组名 GUI 取 basename / CLI 用全路径；排序 `localeCompare('zh-CN')` vs 码点序）**本次未动**。

**11.25 `assemble.rs` 注释纠错 + 显式写下「CLI 与 GUI 的提示词差异」** —— 原模块头写着「没有生产调用方（CLI 尚未接入）」并压着 `#![allow(dead_code)]`，而 CLI 早就是它的生产调用方（照注释读代码的人会以为改它没人受影响）；golden 守的是**组装规则**，**守不住「喂进去的片段」**。
- 差异（定论）：环境信息 GUI 有**每个工具版本**、CLI 只有 `std::env::consts::OS` + 架构；**角色 / 身份 / 性格 / 技能 CLI 不注入**（是「没有数据」而非「另一份实现」）。
- **⚠️ 顺带发现的真缺陷（未修，等拍板）**：`resources.rs::read_project_rules` 返回文件原文、直接当 `PromptParts::project_rules` 传入，而该字段的契约是「`build_project_rules_prompt` 的产物」→ CLI 会话的模型**看不到**「这是项目级要求、与通用说明冲突时以它为准」那段取舍说明。修法是**一行**（改调 `build_project_rules_prompt`），因涉及提示词内容（会影响模型行为）故**未擅自改**。

**11.26 提示词「跨语言文件耦合」解耦** —— 改前 `virlen-core` 用 `include_str!("../../../../../src/domain/agent/prompts/*.md")`（**Rust 的编译依赖前端目录布局**），且 `verify-prompt.md` 两侧**真分叉**（TS 英文 / Rust 中文）。
- 改后：**唯一源**在 `src-tauri/virlen-core/src/agent/prompts/*.md`（5 份），Rust `include_str!` **就地**引用；新增 `PromptTexts` + `all_prompt_texts()` + 命令 `cmd_agent_prompts`（一次全量约 4 KB）；前端 `prompt-source.ts`（Tauri 走命令、浏览器 / vitest 用 `?raw`，**同一份 md**）+ `prompt-texts.ts`（`setPromptTexts()` 启动水合一次 + `promptText()` 同步读 —— `baseSystemPrompt()` 是同步函数，改 async 会传染整条组装链与所有调用方）。⚠️ 未水合时**抛错**而不是返回空串：空提示词会**静默**改变模型行为。
- `verify-prompt.md` 以 TS 英文版为准合并（Rust 中文副本删除），`verifier.rs` / `verifier.ts` 从此读同一份。**「文本住哪」与「谁来组装」是两件事** —— 组装逻辑本次未动。

**11.27 CLI 配置向导 `provider` / `agent` + 供应商目录迁入 core** —— 改前只能 `config set providers '[{…完整 JSON…}]'`：**整键覆盖**（漏一个字段就毁掉现有配置）、写错键名**静默无效**（退出码却是 0）、与桌面端 debounce 落库冲突窗口大。完整设计见 `docs/cli-tui-plan.md` §10。
- 两件前置：① 供应商模板表 / 推理档位表原只在 TS → 搬到 `virlen-core/src/agent/provider/provider_catalog.json`（Rust `include_str!` + 前端 `?raw`，**同一份物理文件**）+ 命令 `cmd_provider_catalog`，删掉 `src/domain/provider/config.ts`；② 原生 `Provider` trait **没有 `list_models`** → core 新增 `agent/provider/models.rs`，**不加进 trait**（否则 `BridgedProvider` 也得陪跑）；`reqwest` 本就在 core → **CLI 的依赖表一个都没加**。
- CLI 新增：`wizard.rs`（问答原语：默认值 / 可重问 / **密文关回显** / 多选；**EOF 一律报错**，不进「空输入 → 重问」死循环）、`settings_edit.rs`（数组键按 id 增删改 + **字段级合并** + 回读校验）、`provider.rs` / `agent.rs`（各 10 步向导 + `list` / `test` / `rm`）。写入**只动改到的字段**（`enabled` / `createdAt` / 桌面端以后新增的字段都不会被抹掉）。
- **⚠️ 刻意不做**：`add` / `edit` 不支持命令行开关（向导的价值就是逐步录入 + 当场校验；脚本逃生口仍是 `config set`）；**stdin 不是终端 → 直接报用法错误（退出码 2）**，绝不半交互挂住。
- **未闭环**：① **不是乐观锁** —— 桌面端开着时仍可能整组覆盖（回读校验只能把覆盖变成可见错误）；② `config get` 仍**明文输出 `apiKey`**（评审项 N1，未勾选 → 未动；新命令 `provider list` 已自行打码，没有新增泄漏面）；③ 项目规则文件路径校验有 TS / Rust **两份**实现（真准入闸仍在前端）；④ raw-mode 密文输入只能人眼验。

**11.28 clippy 告警清零 + 新增 per-push CI 门禁** —— 改前三个 `build-*.yml` 的 `test` job 只在打 tag / 手动时跑，**不含 clippy**；`cargo clippy --workspace --all-targets` 有 **77 条**告警（`cargo check` 看不到）。
- 口径：先用 `cargo clippy --fix` 修**机械项**，再处理设计类 —— `too_many_arguments`（8 处，装配链 / 桥协议函数）加带说明的 `#[allow]`；`type_complexity` 抽 `type` 别名（⚠️ **别名里的 trait object 生命周期必须显式**：写在别名里会退化成默认 `'static` → `BoxedPersistSnapshotFn<'a>` 要写 `+ 'a`）；`large_enum_variant` 把 `ProviderBridgeMsg::Done.result` **装箱**（`Event(Value)` 是流式热路径）；doc 缩进类补空行 / 模块头 `/** … */` → `/*! … */`。
- **⚠️ `cargo clippy --fix` 会引入编译错误**（本次它把 `#[cfg(test)]` 挪给新插入的 `impl Default` → 非 test 构建 `E0425`）→ 自动修复后**必须** `cargo check`，不能只看 clippy 退出码。
- 门禁 `.github/workflows/ci.yml`：**每次 push / PR** 单平台（ubuntu）跑 `pnpm build`（= TS 类型检查 + 产出 `dist`）→ `cargo clippy --workspace --all-targets -- -D warnings`。**新代码不得再引入 clippy 告警**；⚠️ 只在 ubuntu 跑 → Windows 专属代码必须显式门禁（见 §11.31）。

**11.29 CLI 打包并入三个平台的发版 workflow** —— 不新建 workflow，并进三个 `build-*.yml` 的 `build-*` job（复用同一套工具链 / `rust-cache` / `target`）；产物进 **Artifact + 同一个 Release**，形态 = **zip 包**（2026-09-26 由裸二进制改为 zip）。
- `package.json` 的 `build:cli` = `cargo build --manifest-path src-tauri/Cargo.toml -p virlen-cli --release`；CI 传三元组用 **`CARGO_BUILD_TARGET` 环境变量**（**不要** `pnpm run … -- --target`，见 §11.31）。每 job 三步：`Build CLI` → `Stage CLI bundle` → `Upload CLI bundle`（`if-no-files-found: error`），放在 `cargo install tauri-cli` **之前**（CLI 出问题即早退）。
- **zip 内容**：`virlen-cli[.exe]` + `quasivision_models/`（端侧视觉模型，36.9 MB）+ `README.txt`（文案唯一源 `.github/cli-bundle-README.txt`）+（仅 Windows）`DirectML.dll`。**为什么是 zip**：裸二进制不带模型 → 用户跑 `vision_analyze` 只会得到「quasivision models directory not found.」；且裸文件在 Artifact / Release 上**不保留可执行位**（Unix 要用户自己 `chmod +x`），zip 能保留。
- **⚠️ 目录布局即契约**：`quasivision_models/` 必须与可执行文件**同级** → 命中 `CliHost` 资源候选最后一档 `<exe_dir>`（`virlen-core/src/host/cli_host.rs`）；挪进子目录就等于没带。
- **⚠️ 平台区分命名**：三个 workflow 传的是**同一个 Release**，故 zip 名为 `virlen-cli-windows-x64.zip` / `virlen-cli-linux-x64.zip` / `virlen-cli-macos-arm64.zip`（**不带版本号**，版本由 tag 承载）。Release `files` 必须**显式列**各自的 `.zip`（`**/*.exe` / `**/*.dmg` 等命中不到）。
- **打包自检**（发坏包前就失败）：stage 步骤断言 zip 内必须有 `virlen-cli[.exe]` / `README.txt` / `quasivision_models/ocr-models/ppocrv5_mobile_det.onnx`（= `vision::models_dir` 的就位判据），并单独拦「多套一层 `quasivision_models/quasivision_models/`」。
- **边界**：aarch64 的 ad-hoc 签名由链接器自动完成、**无需** codesign；macOS 下载后仍有 quarantine（`xattr -d com.apple.quarantine virlen-cli`）；三个 workflow 并发写同一个 Release 是**既有设计**；Linux / macOS 的 `zip` 步骤**本地无法真跑**（本机无 zip 命令）—— 依据是 Info-ZIP 标准语义 + bsdtar 侧验证「条目名用 `/`、mode 可保留」。

**11.30 上下文压缩下沉 core（`ai` / `raw` 两种模式）+ `chat` 显示占用 % + `list-session` 两列** —— 前提：压缩原先**只在 TS 侧**（Rust 只有提示词），连 GUI 走 Rust 引擎时也是回调 TS → 「CLI 能用」＝在 Rust 侧**新写一份**（用户拍板落 `virlen-core`，将来 GUI 可切过来只留一份）。
- 常量与口径（与 TS 逐条对齐）：`CONTEXT_WINDOW_TOKENS = 200_000`（**用户要求先写死**，将来改「按模型下发」只改这一处）、`COMPRESS_MIN_RATIO = 0.4`、`context_tokens()`（`uiData.contextTokens > 0` 优先，否则 `usage.totalTokens`，从最后一条往前命中即止）。
- **三个数不能混**：`usage.totalTokens` = 那次摘要调用**花了多少**（含压缩前全部历史）；`uiData.contextTokens` = 压缩后下一轮请求**上下文多大**（本地估算）；状态行显示的是后者 / 200k。
- 落点：core `agent/compress/`（`mod` 模式/常量/口径/切片 · `raw` 正文压缩渲染，端口自 `compress-raw.ts` · `ai` 非流式 `Provider::chat` + `tool_choice=none`），产物是**一条 `role="summary"` 消息**；CLI `session_rt/compress.rs`（TUI 与顺序输出模式**都调它**，不给两条路径分叉的机会）。
- 交互：`/compress` 弹**显式选择面板**（↑↓/←→ 移动 + Enter + Esc；**字符键一律不参与** —— 与授权面板同一条 fail-closed 口径）；`/compress ai|raw` 直接指定；认不出的方式名**不静默退化**；占用 < 40% 按桌面端同口径拦下，`Skipped`（提示级反馈）与 `Failed`（报错）**分开**；顺序输出模式读设置里的 `contextCompressMode`，读不到就**要求写明方式**（不猜）。
- 落库是**追加**不是替换（TS 走整表替换，`append_messages(&[summary])` 等效；旧消息留在库里，正是检索工具 `list_messages` / `read_messages` 的数据源）；`list-session` 两列来自 `SessionRepo::session_stats()`（两条聚合查询），`--json` 无数据是 `null` 而非 0，统计失败**不中断列表**（stderr 告警）。
- **边界**：① 压缩后占用是**本地粗估**（CJK 0.6 token/字符）；② 截断按**码点**、TS 按 UTF-16 码元 → 阈值附近 ±1；③ AI 摘要在 CLI 里**不可取消**；④ `list-session` 表格约 **139 列宽**，窄终端标题列会折行（机器可读请用 `--json`）；⑤ TS 与 Rust **两份压缩实现暂时并存**（GUI 仍走 TS）；⑥ 选择面板的真终端外观与键位未人工复验。三个决策点、界面示意与完整验证见 `docs/cli-tui-plan.md` §11。

**11.31 CI 首次运行暴露的三类失败** —— 上一轮 push 后 `ci.yml` 与三个 `build-*.yml` **首次真正编译 Linux / macOS 目标**。
- **① clippy 在 Ubuntu 上 11 条 `dead-code`**：全是**只在 Windows 才被调用**的 ConPTY 代码（`runner/mod.rs` 的 `PAGER_DISABLED` / `TICK` / `PTY_HOLD_MAX` / `pty_hold_max` / `HOLD_MAX_OVERRIDE_SECS`；`pty_session.rs` 的 `new` / `is_held` / `interventions` / `close_input` / `register` / `unregister` / `CLIENT_SIZE_WAIT` / `initial_size`；`test_util.rs` 的 `is_process_alive`）。修法：前 5 项（连同只服务它们的 `use std::time::Duration`）**逐项 `#[cfg(target_os = "windows")]`**；`pty_session.rs` 用**文件级** `#![cfg_attr(not(target_os = "windows"), allow(dead_code))]`（逐项门禁会连锁到结构体字段 → 「只写不读」的新告警；`Duration` / `Instant` 也会变成未使用导入）；`is_process_alive` 用平台 `cfg_attr(allow)`（非 Windows 的 `kill -0` 分支留给今后 Linux 用例）。
  **⚠️ 教训**：本地（Windows）clippy 全绿**不代表**门禁通过。属性坑：文档列表项后不补空行会触发 `doc_lazy_continuation`。
- **② macOS / Windows 各 1 例测试失败（真 bug）**：`same_path()` 只比字符串，而 `resolve_workspace` 两侧来源不同（`--workspace` 已 canonicalize、会话记录**原样**）→「同一个目录的两种写法」被判成换目录、续跑被无辜拦下。CI 上两种写法恰好都出现：macOS `/var` vs `/private/var`（符号链接）、Windows 8.3 短名 `RUNNER~1` vs 长名 `runneradmin`（Actions 的 `TEMP` 就是短名）。修法：**两侧各自 `dunce::canonicalize`（失败退回原字符串）**后再比；补 2 条单测（unix 软链 + 目录缺失兜底）。
- **③ Linux 构建 job 的 CLI 步骤直接报错**：`pnpm run build:cli -- --target <triple>` 在 CI 上被 pnpm **连 `--` 一起透传**（cargo 报 `unexpected argument '--target'`）；本机 pnpm 11.2.2 会把 `--` 剥掉 → **同一份 workflow 在本机与 CI 行为不同**。修法：改 `env: CARGO_BUILD_TARGET=<triple>` + `pnpm run build:cli`（不经过任何参数转发，语义与 `--target` 等价，产物同样落 `target/<triple>/release/`）。
- **边界**：非 Windows 的编译**本地无法复现**（依据是「clippy 已证明这些项在 Linux 上零引用 → 门禁掉不可能破坏编译」+ 逐项引用点 grep 审计）；`virlen-app` 的 Linux 专属分支（`#[cfg(target_os = "linux")]` 等约 7 处）**从未被 clippy 检查过**。
- **④ 续修（同一轮第二次 push）**：core 修完后 ubuntu clippy 才轮到 `virlen-app`，又露出 **3 条同类告警**（全在 `tray/notify.rs`）—— `show_notification` 的 `session_id` 只在 Windows 分支用（补 `#[cfg(not(target_os = "windows"))] let _ = session_id;`）；`PACKAGE_APP_ID`（原 `cfg(any(windows, test))`，那个 `test` 兜底已无使用者）与 `toast_app_id`（调用方 `show_owned` / `init_app_identity` 都是 Windows 专属，同 `is_packaged()`）改成 `#[cfg(target_os = "windows")]`。判据：报错行的 `due to N previous errors` 就是该 target 的**全部**告警数，所以这批是完整的；剩下的未验证单元只有 `virlen-app` 的 bin（`main.rs`，3 行转发）。**教训同上：平台专属项一律显式门禁，两侧都得能编译。**

**11.32 启动即崩：UI 模块在模块顶层读了「启动水合」的快照（2026-09-26 用户报回 → 已修）** —— 现象：启动报 `Uncaught Error: 供应商目录尚未水合…`，且窗口根本不显示（不是白屏，是压根没 `show()`）。
- **根因**：`setupFlow/index.tsx` 模块顶层写了 `const defaultProviderList = providerService.getDefaultProviderList()`。快照是「启动水合 + 同步读」：水合在 `main.ts` 的 `init()` 里，而 `main.ts` **静态导入** `App.tsx` → `App.tsx` 静态导入 `SetupFlow` —— ES 模块求值**先于** `main()`，那一刻快照还是 `null` → `providerCatalog()` fail-fast 抛错 → 整张依赖图求值失败 → `main()` 不执行 → 窗口（`visible: false`，只在 `requestAnimationFrame` 里 `show()`）永不显示。
- **为何测试没拦住**：`src/tests/setup.ts` 全局调了 `setProviderCatalog(...)`，把这一刻盖住了（`setPromptTexts` / `setToolDefinitionsLoader` 同理）。
- **结论 / 改哪里**：把读取移进组件体内（渲染期读）。判断标准：`providerCatalog()` / `providerTemplates()` / `reasoningEffortUnion()` / `defaultReasoningEffortList()` / `sortReasoningEfforts()` / `promptText()`、以及 `providerService.getDefaultProviderList()` —— 一律只在函数 / 组件 / 事件回调里调用，**模块顶层 == 未水合**。
- 回归用例：`src/tests/contracts/provider-catalog-contract.test.ts`（用 `vi.resetModules()` 拿一份从未水合过的全新模块图，先断言它确实未水合、再导入 UI 模块）；全仓 407 个 ts/tsx 扫描确认该 bug 类只此一处。

**踩坑前必读：`docs/tray-implementation-plan.md`**（托盘 / 关闭不退出 / 后台工作的完整方案与实现记录）。

---

## 12. 快速定位表

| 我要做的事 | 去哪里 |
|---|---|
| 改聊天循环 / 工具循环 / 暂停恢复 | `src/domain/engine/*` **和** `src-tauri/virlen-core/src/agent/{engine,llm_round,tool_executor,llm_loop}.rs` |
| 改系统提示词 | **文本**：`src-tauri/virlen-core/src/agent/prompts/*.md`（唯一源；前端经 `cmd_agent_prompts` 取）；**组装顺序**：`src/services/agent-service.ts`（GUI）+ `src-tauri/virlen-core/src/agent/prompts/assemble.rs`（Rust / CLI） |
| 改上下文压缩 / 标题生成 | **压缩（权威、CLI 在用）** `src-tauri/virlen-core/src/agent/compress/`（`mod` 模式/常量/口径/切片 · `raw` 正文压缩渲染 · `ai` 非流式摘要）+ CLI 执行链 `src-tauri/virlen-cli/src/session_rt/compress.rs`（落库/记账/快照）+ TUI 入口 `src-tauri/virlen-cli/src/tui/{commands,state,view,app}.rs`（`/compress` 面板与状态行百分比）+ `list-session` 两列 `src-tauri/virlen-cli/src/list/{render,sessions}.rs` + `SessionRepo::session_stats`；**GUI 仍走 TS**：`src/domain/engine/compress-context.ts`（`ai` LLM 摘要 / `raw` 正文压缩分派）+ `compress-raw.ts`（本地渲染）/ `generate-title.ts`（Rust 侧委托 TS）；产物在消息列表里的呈现：`ui/pages/chat/components/message/summary-message.tsx` |
| 改会话持久化 | `src-tauri/virlen-core/src/session_db/`（`sqlite.rs` / `schema.rs` / `open.rs`）+ 命令壳 `src-tauri/src/commands/session_db.rs` + `src/infrastructure/sessionRepo/` + `src/ui/store/sessionStore.ts` |
| 加 / 改工具 | **定义**：`src-tauri/virlen-core/src/agent/tool_defs/definitions.json`（权威源，三平台变体）；**执行器**：`src/infrastructure/tools/<分类>/<工具>.ts`（+ 分类 `common.ts`、分类 `index.ts`）；契约/注册中心：`src/domain/tools/{definitions,index,types}.ts` + `src/domain/ports/ToolRegistry.ts`；`src/domain/tools/category.ts`、`src-tauri/virlen-core/src/agent/native_tools/<分类>/<工具>.rs`（+ `mod.rs` 分发）、`src/ui/pages/chat/components/tool-call/` |
| 改工具返回给模型的文案 / 增删 `uiData` | TS 执行器 `src/infrastructure/tools/<分类>/<工具>.ts` ↔ Rust 原生 `src-tauri/virlen-core/src/agent/native_tools/<分类>/<工具>.rs`（**逐字对齐**，模型侧固定英文）；界面侧只读 `uiData`，在 `src/ui/pages/chat/components/tool-call/<Tool>Message.tsx` / `TerminalBlock.tsx` 按界面语言重建 |
| 改任务清单 / todo_write | `src/domain/todo/*`（纯函数）、`src/infrastructure/tools/plan/todo-write.ts`、`src/services/todo-service.ts`（落地，用户清单逐字生效）、`src/ui/store/todoDraftStore.ts`（回复期间的本地草稿；**关浮层丢弃未应用的草稿**）、`src/ui/pages/chat/components/todo/*`（标题栏入口 + 浮层；编辑期间 AI 又写清单 → 「放弃编辑并同步 / 覆盖更新」二选一） |
| 改原生工具路径校验 / 参数取值 | `src-tauri/virlen-core/src/agent/native_tools/common.rs`（`resolve_safe_path` / `is_path_allowed` / `arg_*`）；路径展开共用 `src-tauri/virlen-core/src/sandbox/paths.rs::expand_user_path` |
| 改文件读写底层 | `src-tauri/virlen-core/src/file_ops.rs` + `src/utils/diff.ts` |
| 改文件搜索 | `src-tauri/virlen-core/src/search.rs`（`search_files_by_name` / `search_text_in_files` 原生） |
| 改网络搜索 / 网页抓取（`web_search` / `web_fetch`） | **Rust 原生（权威）** `src-tauri/virlen-core/src/agent/native_tools/web/{web_search,web_fetch,common}.rs`（`web_search` 经 `ctx.settings` 直读 `app_settings` 的 `searchProviders` / `defaultSearchProviderId`）；**TS 侧（浏览器 dev / TS 引擎路径）** `src/infrastructure/tools/web/*.ts` + `src/infrastructure/search-providers/{factory,tavily,bocha}.ts`；**两侧结果文本契约** `src/tests/fixtures/web-search-format.golden.json`；搜索源配置 `src/services/search-provider-service.ts` + `src/domain/search/*`；已知差异（HTML→Markdown 细节）见 `docs/rust-engine.md` §3 |
| 改命令执行 / 风险分类 / 权限审批 | `src/domain/permission/index.ts`（+ Rust 镜像 `native_tools/execute/common/classify.rs`）；工具 `tools/execute/common.ts` + `execute-command.ts`/`execute-script.ts`；Rust 原生 `native_tools/execute/`。PTY 相关另见 `sandbox/windows/conpty.rs`、`native_tools/execute/pty_session.rs`、`tool-call/XtermTerminal.tsx`、`tool-call/TerminalConfirmBlock.tsx` |
| 改终端输出处理（`\r`、ANSI） | `tools/execute/common.ts::processTerminalOutput`（UI 侧 `tool-call/Execute*Message.tsx` 复用）；Rust 侧 `native_tools/execute/common.rs::process_terminal_output`。两份**逐条对齐** |
| 改工具授权确认弹窗 / 交互 | `ui/pages/chat/components/modals/authorization.tsx`；事件 `events/toolInteractEvent.ts::showAuthorization`；调度 `services/tool-service/command_confirm.ts`；Rust 侧下发同样字段 `native_tools/execute/{execute_command,execute_script}.rs` |
| 改沙盒 / 权限 | `src-tauri/virlen-core/src/sandbox/**`、`src/infrastructure/sandbox/*`、`src/domain/security/index.ts` |
| 改 `js` 类沙盒规则的求值 | ✅ **已落地**（S7）：`src-tauri/virlen-core/src/security/js_rule.rs`（受限 QuickJS：**无 host 函数**、16MB 内存 / 512KB 栈 / 200ms 中断，异常与超时一律按未命中），由 `native_tools/execute/common/rules.rs` 调用；设计与依赖代价见 `docs/config-sink-plan.md` §4 |
| 改「忽略沙盒命令」规则（命中即免脱壳审批 + 强制无沙盒执行） | **Rust 判定（权威：默认引擎 + CLI）** `src-tauri/virlen-core/src/security/{rules,js_rule}.rs`（text/regex 原生 + js 内嵌 QuickJS）+ `agent/native_tools/execute/common/rules.rs`（判定入口与提示文案）+ `.../execute/{execute_command,execute_script}.rs`；**规则来源** `app_settings` 的 `sandboxIgnoreRules` 键（Rust 侧 `session_db/settings.rs` + `security::load_sandbox_ignore_rules`；前端 `infrastructure/securityRepo/`（`hydrateSecurity` / `flushSecurityPersist`）+ `ui/store/securityStore.ts` + `main.ts` 的 `step('securityConfig')`）；**TS 侧实现（浏览器 dev / TS 引擎 / 设置页测试）** `domain/security/sandbox-ignore-rules.ts`（`SANDBOX_JS_DEFAULT_PATTERN` / `defaultSandboxRulePattern` / 排序 / 预设 / `compileSandboxRule`）+ `services/security-service.ts::matchSandboxIgnoreRule` + `infrastructure/tools/execute/{execute-command,execute-script}.ts`；**两侧契约** `src/tests/fixtures/sandbox-rules.golden.json`（TS `tests/domain/sandbox-rules-golden.test.ts` ↔ Rust `security/rules.rs` 的 golden 用例）；UI `ui/pages/Settings/security-sandbox-rules.tsx`（拖拽几何 `./sandbox-rules-dnd.ts`；JS 输入用 `ui/components/code-editor/CodeEditor.tsx`；行内开关 `ui/components/shared/Toggle`）；下发字段 `services/rust-engine.ts::resolveSecurityConfig`（`sandboxIgnoreRules`） |
| 改视觉 | 核心 `src-tauri/virlen-core/src/vision/`（模型定位 / 懒加载 / 推理，零 `tauri::`）、命令壳 `src-tauri/src/vision_service.rs`、原生工具 `src-tauri/virlen-core/src/agent/native_tools/vision/`、前端 `src/infrastructure/vision/`、模型 `src-tauri/resources/quasivision_models/` |
| 改宿主抽象 / CLI 资源与数据目录 | trait `src-tauri/virlen-core/src/agent/host.rs`（`resource_candidates` / `data_dir`）＋ CLI 实现 `src-tauri/virlen-core/src/host/cli_host.rs` ＋ GUI 实现 `src-tauri/src/host/tauri_host.rs`；注入链 `AgentEngine.host` → `ExecuteLlmRoundParams.host` / `RunIterationParams.host` → `execute_tool_steps` → `NativeToolCtx.host` |
| 跑 / 扩展 headless CLI（`virlen-cli`） | 实现全在 **`src-tauri/virlen-cli/src/`**（本 crate 的 **lib**；core **不含命令入口**），**上下文压缩**的执行链在 `session_rt/compress.rs`（`compress_session` / `current_context_tokens` / `report_line`；TUI 与顺序输出模式共用）；`lib.rs`（参数解析 / 分派 / `USAGE` / `EXIT_*`）+ `config.rs`（配置读写）+ `run/`（无界面跑一次 agent：`mod` 参数解析 + `run()` 驱动 / `render` 事件→文本纯函数与 `Rendered`/`flush_rendered` / `ask` 交互应答 / `sink` `CliEventSink` / `tests`）+ `session_rt/`（**`run` 与 `chat` 共用**：`mod` `RunOptions` / `Resources` / `SessionRuntime::{bootstrap, bootstrap_chat, activate, turn_messages, send_options}` + `resources` 装配链（`resolve_workspace` / `build_resources` / `build_system_prompt` / `read_project_rules`） + `session` 会话装载（`load_or_create_session` / `new_session` / `title_from_prompt`））+ `list/`（`list-session [-g agent\|workdir]` / `list-agent`：`mod` 参数解析与执行入口 / `group` 分组纯函数 / `render` 按**显示列宽**对齐 / `sessions` / `agents`）+ `provider.rs` / `agent.rs`（**交互式配置向导**，见 §11.27）+ `wizard.rs` / `settings_edit.rs`（向导原语 / 数组键按 id 增删改）+ `tui/`（**交互式 TUI，已落地**：`mod` 入口与降级策略 / `app` 线程编排 / `plain` 顺序输出模式 / `sink` 结构化事件出口 / `state/`（`line` 行模型与 ANSI 清洗 + `event` 事件解释 + `key` 按键）/ `view` 纯渲染 / `commands` / `input` / `term`；**各目录配 `tests.rs`** —— 切分口径与代价见 §11.18）；`src/main.rs` 仅三行转发（**bin 目标不被单测引用**）；数据 / 资源目录 `src-tauri/virlen-core/src/host/cli_host.rs`（`$VIRLEN_DATA_DIR` 覆盖）；库入口 `virlen_core::session_db::open_session_db`（与 GUI **同一条**路径链 → 同一份 `virlen.db`）；「忽略沙盒命令」规则走 `security::load_sandbox_ignore_rules`（同一份 `app_settings`）；技能目录推导 `run/session_rt` 侧 `existing_skills_dir`（= `<data_dir>/skills`，与前端 `skillStore` 规则一致）；便捷脚本 `pnpm cli …`；连带要求见 §11.14、三条边界见 §11.15、剩余 localStorage 数据见 §11.16 |
| 做 / 改 CLI 交互式 TUI（`virlen-cli chat`，**已落地**） | 方案与实测结论 `docs/cli-tui-plan.md`（**上下文占用百分比 / 压缩面板见 §11**）；实现 `src-tauri/virlen-cli/src/tui/`（纯逻辑 `state/`（`line`/`event`/`key`，含**本地选择面板** `Picker`）+ `view`/`commands`，终端只在 `term`，编排在 `app`/`mod`，降级形态在 `plain`）+ 会话装配/切会话 `src-tauri/virlen-cli/src/session_rt/`（`mod` 的 `bootstrap_chat` / `activate` / `turn_messages` + `resources` / `session` / `compress`）+ 入口 `src-tauri/virlen-cli/src/lib.rs`；实测脚手架（**仓库外**、一次性）`%TEMP%\ratatui-inline-spike`（`tools\repro-case.ps1` 压测「改窗口尺寸」，**必须用 `start` 起独立控制台，不能用 `Start-Process`**，否则验的是调用方的环境；向控制台注入按键需 `SetForegroundWindow` + `SendKeys`，`AppActivate` 不可靠） |
| 改 Agent 配置（agents）的持久化 / 与 CLI 共享 | 权威源 = `app_settings` 的 `agents` 键；前端 `src/infrastructure/agentRepo/index.ts`（**内存快照 + debounce 落库 + 首启迁移**，与 `securityRepo` 同款）+ `src/ui/store/agentStore.ts` + `src/main.ts` 的 `agents` 水合步骤（⚠️ **必须在 `initDefaultAgent()` / `agentStore.reload()` 之前**，否则默认 Agent 的补全会读到空列表并**覆盖**表里已有的 Agent）；CLI 侧 `src-tauri/virlen-cli/src/list/`（`agents.rs` 的 `list-agent` / `sessions.rs` + `group.rs` 的 `list-session -g agent`）；契约测试 `src/tests/infrastructure/agent-repo-settings.test.ts` |
| 用 CLI **交互式**配一个供应商 / Agent（`virlen-cli provider|agent add`，**已落地**） | 方案与实测 `docs/cli-tui-plan.md` §10，连带约束见 §11.27；命令实现在 `src-tauri/virlen-cli/src/{provider,agent}.rs`（+ 各自 `tests.rs`）；共用设施 `src-tauri/virlen-cli/src/wizard.rs`（问答原语 / 密文输入）+ `settings_edit.rs`（数组键按 id 增删改 + 字段级合并 + 回读校验）；**供应商模板表 / 推理档位表** 唯一源 `src-tauri/virlen-core/src/agent/provider/provider_catalog.json`（+ `catalog.rs` / 命令 `cmd_provider_catalog` / 前端 `domain/provider/catalog.ts` + `infrastructure/provider/catalog-source.ts`）；**模型列表与连通性验证** `src-tauri/virlen-core/src/agent/provider/models.rs`（`list_models` / `verify_connection`） |
| 改设置项 | `src/ui/store/settingStore.ts` + `src/ui/pages/Settings/*` + `src/ui/i18n/lang/en-US.json` |
| 改配置下沉 / 设置落库 | Rust `src-tauri/virlen-core/src/session_db/settings.rs`（`app_settings` 表 + `SettingsRepo`）+ 命令壳 `src-tauri/src/commands/session_db.rs::cmd_settings_*`；前端 `src/infrastructure/settingsRepo/` + `settingStore.hydrateSettings()/flushSettingsPersist()` + `src/main.ts` 的 `step('settings')`；计划见 `docs/config-sink-plan.md` |
| 改埋点 | `src/utils/telemetry/**`（前端）；Rust 侧分两半：**出口** `src-tauri/src/telemetry.rs`（`TauriTelemetrySink` → `agent:telemetry` 事件 + `telemetry_drain_panics` 命令）、**其余**（`track` / `hash_id` / `now_ms` / 会话 trace / panic 钩子与落盘）在 `src-tauri/virlen-core/src/telemetry.rs`（sink 可插拔） |
| 改 RAG / 知识库 | `src-tauri/virlen-core/src/rag/**`、`src/services/rag-service.ts`、`src/infrastructure/rag/` |
| 改用量统计 / 费用 | `src-tauri/virlen-core/src/session_db/usage.rs`、`src/domain/pricing/index.ts`、`src/services/token-stats-service.ts`、`src/ui/pages/chat/components/token-stats/` |
| 不让重复启动两个进程（第二实例 → 聚焦已有窗口） | `src-tauri/src/lib.rs` 的 `.plugin(tauri_plugin_single_instance::init(...))`（**必须第一个注册**）+ `src-tauri/src/tray/mod.rs::activate_main_window`；macOS「重新打开」=`RunEvent::Reopen` |
| 发版 / 打包 | `src-tauri/tauri.conf.json` + `package.json` + `scripts/build-msix.ps1`、`scripts/msix/AppxManifest.xml.template`；**headless CLI 打包** = 本地 `pnpm build:cli`（只出二进制），CI 在三个 `build-*.yml` 的 `build-*` job 里打成 **zip**（`Build CLI` → `Stage CLI bundle` → `Upload CLI bundle`，内含 `quasivision_models` + `README.txt`，Windows 另带 `DirectML.dll`）→ Artifact + 同一 Release 资产；zip 内布局 / 命名 / 自检口径见 §11.29 |

---

## 13. 提交与协作约定

- 提交信息风格：`feat: ...` / `fix: ...` / `update Version` / `update`（中英混用，保持一致即可）；
  涉及引擎/持久化的改动请在正文写清「TS / Rust 两侧都改了什么」。
- 一次提交只做一件事；格式化 / 重命名等噪音改动不要混进功能提交。
- **提交前自查清单**：
  1. `npx tsc --noEmit` 无新增错误；动了 `src-tauri/` 则 `cargo clippy --workspace --all-targets -- -D warnings` **零告警**（CI 门禁，见 §11.28）；
  2. 受影响模块的 `vitest` 通过；动了 `src-tauri/` 则 `cargo test --workspace` 通过（**拆包后必须带 `--workspace`**，见 §7/§11.14）；
  3. 若改了引擎语义 → TS 与 Rust 两侧是否都已同步？事件契约是否四方一致？
  4. 若新增工具 → 注册链、UI 组件、Rust 白名单、i18n 文案是否齐备？
  5. 若新增 Tauri 命令 → `lib.rs` 是否已注册？`capabilities/default.json` 是否需补权限？
  6. 是否引入无关改动、是否触碰 §8 安全红线？
  7. 若改了 workflow / 打包流程 → 产物路径与 `upload-artifact` 的 `path`、Release 的 `files` glob 是否对齐？（CLI 发布物是 **zip**（含视觉模型）：命名约束 / zip 内布局 / 打包自检见 §11.29；**CLI 构建步骤的三元组用 `CARGO_BUILD_TARGET` 环境变量**，不要走 `pnpm run … -- --target`，见 §11.31）；
  8. 新增/修改了**平台专属代码**（`#[cfg(target_os = …)]`）→ 反向平台能不能编译？（CI 的 clippy 只在 ubuntu 跑，Windows 专属的常量 / 函数在 Linux 上就是 `dead-code`，必须显式门禁，见 §11.31）
  9. 有没有在**模块顶层**读「启动水合」的快照（`providerCatalog()` / `promptText()` / `providerService.getDefaultProviderList()` …）？那等于在 `main.ts` 水合之前读 —— 整个应用会**启动即崩、窗口都不显示**，见 §11.32；
