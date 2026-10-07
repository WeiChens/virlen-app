# AGENTS.md — Virlen 项目总览（架构地图 · 契约 · 开发约定）

> 本文件是本仓库的**事实来源（source of truth）**，面向 AI 编码代理与人类协作者。
> 定位是「**先给全局，再给重点**」：第 1–5 章先建立项目的大局观与运行时全景，
> 第 6 章起才是目录、铁律、红线、手册、常见坑等**动手前必读**的约束。
> 与 `README.md` 冲突时以本文件 + 代码现状为准（README 存在若干过期描述，见 §11.3）。
>
> **深读入口（细节已下沉，不在本文件展开）**
> - `docs/rust-engine.md` —— 引擎 Rust 化清单与已知差异
> - `docs/pty-research.md` —— Windows ConPTY / 终端交互完整设计
> - `docs/host-abstraction-draft.md` —— 宿主抽象（**方案 A 已实施**）：GUI / CLI 资源与数据目录的唯一接口
> - `docs/config-sink-plan.md` —— 配置下沉（**落 SQLite，与 GUI 共用同一份 `virlen.db`**）+ `js` 沙盒规则内嵌求值
> - `docs/cli-tui-plan.md` —— CLI 交互式 TUI（`virlen-cli chat`）与配置向导、上下文压缩、会话管理（`session`）/ 用量账本（`usage`）的方案 / 实测

---

## 0. 30 秒导读

**Virlen（未霖）**是一个基于 **Tauri v2** 的跨平台 **AI Agent 桌面客户端**——不是聊天壳，而是「**可扩展的 Agent 运行平台**」：多模型接入、可插拔工具、本地视觉/RAG/Skill、多层安全、以及一套 **Rust 实现的 Agent 引擎**（`virlen-core`，GUI 与 CLI 共用；原 TS 引擎已移除）。

理解本项目，抓住四条主线即可：

1. **内核是「Agent 循环」**——LLM 轮次 → 工具执行 → 迭代验证 → 循环，直到收敛（见 §4、§5.1）。
2. **能力靠「工具」扩展**——工具是「定义 + 执行器」分离的注册制，可 JS 实现、也可 Rust 原生化（见 §5.2）。
3. **安全贯穿全文**——路径黑白名单 / 权限三态 / 跨平台沙盒 / 工具风暴防护四道闸（见 §5.4、§8）。
4. **引擎只有一份（Rust）**——聊天循环 / 工具执行 / 上下文压缩 / 标题生成全在 `src-tauri/virlen-core/src/agent/`；GUI 与 CLI 共用同一份。TS 侧只剩「被 Rust 回调的部分」（工具执行器 / Gemini provider / 提示词组装 / 事件契约），它们仍须与 Rust 同语义（见 §5.1、§7 铁律 1）。

---

## 1. 项目是什么

一个「**全能型 AI 智能体桌面客户端**」，核心能力矩阵：

| 能力域 | 说明 |
|---|---|
| **多 Provider** | OpenAI 兼容 / Anthropic / Gemini；支持自定义 Base URL、自定义 Header、`reasoningEffort` |
| **Function Calling** | 文件读写、命令执行、网页抓取、搜索、视觉分析、知识库、长期记忆（检索/召回/写入）、会话消息检索、任务规划共 11 大类 31 个工具 |
| **端侧视觉引擎** | `quasivision` ONNX 纯本地推理：UI 元素检测 / PP-OCR v5 / YOLOE-26n 物体检测 / 图标分类（图片不出本机） |
| **Skill 机制** | `SKILL.md` 领域知识包，注入系统提示词 + 源码目录只读可查 |
| **多层安全** | 路径黑白名单、权限三态、跨平台 Shell 沙盒、工具风暴防护（StormBreaker） |
| **会话与记忆** | 暂停/恢复（Run Snapshot）、LLM 上下文压缩、本地 RAG（turbovec 向量索引）、用量账本、**长期记忆**（`memories` 表 + 建会话注入 `# Memory` 段 + 设置页面板 + `memory_search` / `memory_recall` / `memory_write` 三个原生工具 + **P2 蒸馏**：启动/面板/CLI 触发把前一天各会话摘要提炼成记忆 + **P3 去重合并 / 导出 JSON / 预算告警 / 列表多选批量操作**，详见 `docs/memory-plan.md` / `docs/memory-p0-plan.md` / `docs/memory-p2-plan.md` / `docs/memory-p3-plan.md`） |
| **Agent 引擎** | 仅 Rust（`src-tauri/virlen-core/src/agent/`，GUI 与 CLI 共用）；原 TS 引擎 `src/domain/engine/` 已移除（见 §11.37） |
| **手机控制** | 手机扫码配对后远程操作本机（会话 / 发消息 / 应答工具审批）：电脑侧接口层在 `src/bridge/`，传输用自维护 npm 包 `virlen-remote`（WebRTC + SSE 信令，见 §5.9） |

---

## 2. 技术栈全景

| 层 | 技术 |
|---|---|
| 前端 | React 19、TypeScript（`strict: true` 但 `strictNullChecks: false`）、Vite 7、MobX 6（`mobx` / `mobx-react-lite`）、Sass、react-markdown + remark-gfm、PrismJS、Monaco、turndown + cheerio、JSZip、`@tanstack/react-virtual`、echarts、xterm、virlen-remote（手机控制传输层，自维护 npm 包） |
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
| `src/bridge/` | 手机控制「电脑侧接口层」（装配入口 `startPhoneBridge` + ACL / 审批分级 / 审计 / 配对 / DTO 投影 / store 旁路推送），生产接线在 `ui/store/phoneControlStore.ts`（见 §5.9） | services、domain、infrastructure、ui/store、utils、events、`virlen-remote` |
| `src/skill/` | Skill 加载 / 注册 / 导入 / 广场 | 工具化使用 |
| `src/events/` | EventEmitter 事件总线（menu / settings / comment / toolInteract / update） | utils |
| `src/utils/` | 无业务依赖工具：telemetry、storageState、EventEmitter、diff、mdYamlFrontmatter、pathCanonicealize… | 无 |
| `src/tests/` | Vitest 测试，按 `domain / infrastructure / services / rag / utils / ui` 分目录 | — |
| `src-tauri/src/` | **GUI 壳**（`virlen-app`，**唯一**的 Tauri 侧）：`lib.rs`（窗口 / 托盘 / 插件 / 命令注册）、`commands/{agent,session_db,rag}.rs`（全部 `#[tauri::command]`）、`host/tauri_host.rs`（`TauriHost`）、`telemetry.rs`（Tauri 埋点出口 + panic 拉取命令）、`tray/`、`drag_drop.rs`、`clipboard_files*`、`vision_service.rs`（视觉命令壳）、`common_service.rs`、`deepseek_tokenizer.rs`、`load_env.rs`、`speech_service.rs`、`task_manager.rs` | `virlen-core` + Tauri |
| `src-tauri/virlen-core/` | **核心库**（`virlen-core`，**零 `tauri::`**，GUI 与 CLI 共用）：`agent/`（Agent 引擎本体：循环 / 工具 / 压缩 / 标题 / provider）、`session_db/`（含 `open.rs`）、`sandbox/`、`security/`、`rag/`、`vision/`、`host/{mod,cli_host}.rs`、`file_ops.rs`、`search.rs`、`telemetry.rs`（sink 可插拔）—— **不含任何命令入口** | 第三方 crate（**不得**依赖 tauri / virlen-app） |
| `src-tauri/virlen-cli/` | **headless CLI**（`virlen-cli` package，**命令实现本体**）：lib = `lib.rs`（参数解析 / 分派 / `USAGE` / `EXIT_*`）+ `config.rs` / `list/` / `run/` / `session.rs` / `usage.rs` / `session_rt/` / `tui/`（TUI **已落地**）+ `provider.rs` / `agent.rs` / `wizard.rs` / `settings_edit.rs`（交互式配置向导），`src/main.rs` 仅三行转发（**完整文件图见 §12**）；**只依赖 core** → 二进制里没有 GUI 栈 | `virlen-core` + `tokio` / `serde` / `serde_json` / `chrono` / `uuid` / `dunce` |
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
③ 取引擎    getEngine()  ──►  Rust 引擎适配器（`services/rust-engine.ts`，恒为它；TS 引擎已移除）
   ▼
④ Agent 循环（两侧同构）
   ┌──────────────────────────────────────────────────────────────┐
   │  LLM 轮次  llm-round ──► Provider.chatStream()  ──► 流式事件  │
   │      │                                                        │
   │      ├─ 无 tool_calls ──► 直接产出答案 ──► (可选) 迭代验证     │
   │      └─ 有 tool_calls ──► 工具执行  tool-executor             │
   │                              │                                │
   │         ┌────────────────────┴────────────────────┐          │
   │         ▼ 原生工具（31 个）                          ▼ JS 桥   │
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
⑤ 持久化（Rust 引擎内部直落）
   · Tauri  → Rust 引擎在 `session_db/` 内部直落 SQLite（先落库再 emit）
   · 非 Tauri（vitest）→ chat-service.persistMessagesIfNeeded()（isTauriAvailable() 守卫）
   ▼
⑥ 事件回 UI
   onEvent → chat-service.createEventHandler() → agentStore / sessionStore（MobX）
   ▼
   ui/pages/chat 渲染（消息列表用 @tanstack/react-virtual 动态高度虚拟滚动 + 懒加载）
```

**关键契约**：`AgentEventType`（`src/types/index.ts`）是 **Rust `event_sink`、`chat-service.createEventHandler`、`rust-engine.ts` 三方共享**的事件契约。当前 18 种：

```
stream_start / stream_event / stream_end · tool_call / user_interaction / error
update_message_id · assistant_message_created / assistant_message_updated · tool_result_created
iteration_start / iteration_verify_start / iteration_verify_end
iteration_verify_pass / iteration_verify_fail / iteration_max_exceeded / iteration_end
```

> 新增事件类型必须**四处一致**：TS 类型 → TS emit → Rust emit → chat-service 处理。否则会「静默失效」（某一侧不认）。

---

## 5. 主要子系统地图（「主要的地方」）

### 5.1 Agent 引擎（**仅 Rust**）——本项目的心脏

聊天循环只有一份实现（原 TS 引擎已移除，见 §11.37）：

| | Rust 引擎 |
|---|---|
| 入口 | `src-tauri/virlen-core/src/agent/engine.rs` |
| 触发 | 恒为它（前端 `services/chat/common.ts::getEngine()` 直接返回 `services/rust-engine.ts` 适配器） |
| 接口 | `AgentEnginePort`：`sendMessage / getRunSnapshot / clearRunSnapshot / cancel / compressContext / generateTitle` |
| 循环编排 | `llm_loop.rs` / `llm_round.rs` / `tool_executor.rs` / `iteration.rs` / `verifier.rs` / `storm_breaker.rs` |
| 压缩 / 标题 | `compress/`（`ai` / `raw`）+ `title.rs` —— GUI 与 CLI 共用（命令 `cmd_compress_context` / `cmd_generate_title`） |
| 持久化 | 引擎内直落 SQLite（`session_db/`，先落库再 emit） |

**Rust 桥协议**（与 `src-tauri/virlen-core/src/agent/bridge.rs` 严格对应）：

| 方向 | 通道 | 说明 |
|---|---|---|
| Rust → JS | `agent:event` | 载荷 `{ sessionId, event }`，`event` 与 TS `AgentEvent` 完全一致，前端直接转发 `onEvent` |
| Rust → JS | `agent:tool-request` | 未原生化工具交 JS 执行，JS 用 `toolRegistry` 跑完回 `agent_tool_response`（`payload.__kind: value \| error \| interaction`；**`error` 也可带 `uiData`** → 失败文案同样是「模型侧英文 + UI 侧结构化」） |
| Rust → JS | `agent:user-interaction-request` | 用户交互（`user_choice` / 终端内确认），走 `chat-service` 注册的 session handler → `agent_user_interaction_response` |
| Rust → JS | `agent:provider-request` | 未原生化的 Provider（目前 Gemini）交 JS，流式用 `agent_provider_stream_event` 逐条回传，结束 `agent_provider_stream_done` |
| Rust → JS | `agent:round-boundary` | **轮次边界注入**：上一批工具已回复、下一次 LLM 请求尚未发出时回问 JS「有没有要注入的消息」（AI 回复期间用户**已应用**的任务清单变更），JS 用 `agent_round_boundary_response` 回 `{ messages }`；Rust 落库后追加进本轮消息列表，模型**这一轮**就能看到（超时 5s 兼底，失败降级为不注入） |
| JS → Rust | `agent_send_message` / `agent_cancel` / `agent_get_run_snapshot` / `agent_clear_run_snapshot` / `agent_dispose` / `agent_kill_command` / `pty_*` | 生命周期、取消、终端交互 |

**未原生化的部分**（仍委托 TS）：Gemini Provider（`agent:provider-request` 桥）。
> **31 个工具已全部原生化**（S5 补齐 `web_fetch` / `web_search`，P1 补齐 `memory_*`）——`is_native_tool` 就是全集，**没有工具再走 JS 桥**。
Rust 只使用前端组装好的 `session.systemPrompt`（为空时回退 `"你是一个有用的 AI 助手。"`）。完整清单见 `docs/rust-engine.md`。

> ⚠️ **改引擎语义（LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销）只需改 Rust**（`virlen-core`）；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装 / 事件契约）仍须与 Rust 同语义（铁律 1）。

### 5.2 工具系统——能力扩展的唯一入口

- **注册制**：`toolRegistry.register(name, executor, label?)`；不写全局函数表。
- **定义与执行器分离，且定义只有一份（机制 C）**：工具定义在 **Rust 侧权威源** `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`（31 工具 × 三平台变体 `windows`/`macos`/`linux`，键名与 `std::env::consts::OS` 同词表）；前端只注册执行器 + UI 文案（`label` 走 i18n，**不进契约**）。读取一律 `await toolRegistry.listDefinitions()`（**异步**接口），返回「契约 ∩ 已注册执行器」。详见 `docs/rust-engine.md` §12。
- **11 大分类 / 31 个工具**（`src/domain/tools/category.ts` ↔ `src/infrastructure/tools/<分类>/`）：

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
  | `memory` | `tools/memory/` | 3 | memory_search / memory_recall / memory_write（长期记忆） |

- **原生化（31 个 = 全部）**：`file`(8) + `search`(2) + `execute`(2) + `knowledge_base`(6) + `plan`(1：`todo_write`) + `system`(2：`user_choice` / `get_current_time`) + `chat`(2：`list_messages` / `read_messages`) + `memory`(3：`memory_search` / `memory_recall` / `memory_write`) + `skill`(2：`list_skills` / `read_skill_source`) + `vision`(1：`vision_analyze`) + `web`(2：`web_fetch` / `web_search`)，分发在 `src-tauri/virlen-core/src/agent/native_tools/mod.rs::is_native_tool / execute_native_tool`。**无任何工具走 JS 桥**。
  - `web_search` 的搜索源配置由引擎经 `NativeToolCtx::settings` **直读 `app_settings`**（与「忽略沙盒命令」规则同一份来源）→ CLI 同样可用；
  - `web_fetch` 的 HTML→Markdown 用 `htmd`（TS 侧是 `turndown`）——**Markdown 细节两侧不完全一致**（已知差异，见 `docs/rust-engine.md` §3）。
  - `memory_*` 的语义实现在 `agent::memory::tools`（**与 GUI 命令 `cmd_memory_*` 共用一份**），详情正文落专用知识库（`记忆详情`，`kb_id` 缓存在保留设置键 `__memoryKbId`）。
- **原生工具的会话库依赖**：需要读写会话库的工具（消息查询）从 `ctx.repo: &dyn SessionRepo` 取（由引擎注入；`repo.is_available()` 为 false 时如实回「本地存储不可用」）—— 与 `ctx.security` 同一种显式注入。
- **原生工具的长期记忆依赖**：`memory_*` 从 `ctx.memory: &dyn MemoryRepo` 取（同样由引擎注入，与会话库**共用同一把连接锁**；`is_available()` 为 false 时如实回「本地存储不可用」）；详情知识库经 `ctx.settings`（`__memoryKbId` 缓存）+ 进程级 RAG 服务，RAG 未初始化时降级为「不落详情 / 读不到详情」，不牵连记忆条目本身。
- **原生工具的技能依赖**：技能工具从 `ctx.skills`（本 agent 启用的技能名）+ `ctx.security.skills_dir` 取数，**自行扫盘解析 SKILL.md**（不依赖前端 localStorage 注册表，CLI 同样可用）。
- **原生工具的宿主依赖**：需要「资源目录 / 数据目录在哪」的工具（`vision_analyze` 的模型文件）从 `ctx.host: &dyn HostEnv` 取。宿主差异只有两份实现 —— GUI `host::TauriHost`（`resource_dir()` / `app_data_dir()`）、CLI `host::CliHost`（环境变量 + exe 位置）；**引擎核心（含 `native_tools/**`）不得出现 `tauri::`**，这是 headless 的前提。详见 `docs/host-abstraction-draft.md`。
- **模型侧文案一律英文（D2-A）**：工具返回给 LLM 的文本（`content`、抛出的错误、引擎迭代 / 验证反馈、系统提示词）固定英文且**不进 i18n** —— 否则 Rust 原生工具与 JS 执行器（Rust 回调）、中 / 英界面会产出不同文本。界面展示改由**结构化 `uiData`** 按界面语言重建（组件优先渲染 `uiData`，缺失时回退 `content`，如 `tool-call/TerminalBlock.tsx::displayNote`）。因此：改 TS 执行器文案**必须与 Rust 原生实现逐字对齐**（铁律 1），新增返回值务必同时给出语言无关的 `uiData` 字段。
- **跨层单例**：`src/infrastructure/tools/output-store.ts`（UI/services/engine 均引用）不归属任何分类，留在 tools 根目录。
- **UI 渲染**：`src/ui/pages/chat/components/tool-call/<Tool>Message.tsx` 实现 `IToolCallMessage` 并 `register(...)`；未注册自动落 `DefaultMessage`。

### 5.3 持久化与数据

- **会话消息**：Rust 侧 `src-tauri/virlen-core/src/session_db/`（已从单文件拆分为 16 文件目录）。
  分层：`types.rs`（IPC DTO）/ `repo.rs`（trait + Noop）/ `schema.rs`（DDL + 迁移）/ `row.rs`（行映射）/ `message_query.rs`（检索 + 蒸馏素材 `day_materials`）/ `usage.rs`（用量账本 + 模型频次）/ `settings.rs`（应用设置）/ `memory.rs`（长期记忆 + `MemoryRepo` + 整理流水）/ `sqlite.rs`（实现）/ `commands.rs`（20 个 `cmd_*`）/ `tests/`。
  SQLite + WAL + 单写连接 + `spawn_blocking`；**先落库再 emit**。
  ⚠️ 打开库的入口分两层（配置下沉 D3 的前置）：**零 `tauri::`** 的 `commands::open_session_db(host, spawn)`（库路径 = `host.data_dir()/virlen.db`，返回 `SessionDb { repo, settings, memory, maintenance }`，后台任务由宿主传入的 `spawn` 派发）+ GUI 薄壳 `init_session_db(app)`（构造 `TauriHost` + `app.manage(...)`）。
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
| **工具风暴防护** | `agent/storm_breaker.rs` | 滑窗（window 6 / threshold 3）检测重复 `(toolName, args)`，命中即中断循环 |

> 唯一「绕过沙盒」的例外：`execute_command` / `execute_script` 传 `sandbox:"off"`（见 §8、§11.2），按脱壳权限决策、`readonly` 直接拒绝，并埋点 `tool.sandbox.bypass`。

> 「忽略沙盒命令」规则（**设置 → 安全 → 忽略沙盒命令**）：命中规则的命令**免除「沙盒脱壳」审批，并以「不使用沙盒」方式执行**
> （AI 不必显式传 `sandbox:"off"`；沙盒已关闭 `off` / 只读 `readonly` 时规则不生效）。
> 该规则也是「区外写入」（如 `npm install` 写 `~/.npm`、pnpm store）的**唯一推荐放行方式**（不要再做沙盒侧自动探测/豁免）。
> **匹配有两份实现（S7 起），由两侧共读的 golden 收敛**（`src/tests/fixtures/sandbox-rules.golden.json`）：
> - **Rust 侧（权威：默认引擎 + CLI）**：`src-tauri/virlen-core/src/security/`（`rules.rs`：`text` / `regex` 原生 + `js` 交内嵌 QuickJS `js_rule.rs`）；
> - **TS 侧（浏览器 dev / 设置页「测试」）**：`domain/security/sandbox-ignore-rules.ts`，经 `securityService.matchSandboxIgnoreRule` 使用。
> **规则来源是 `app_settings` 的 `sandboxIgnoreRules` 键**（配置下沉 D3；`infrastructure/securityRepo` 启动水合 + debounce 回写，退出前 flush）：
> ⚠️ **单一源：localStorage 不保存该字段**（`securityRepo.save()` 只写三个路径配置；Tauri 下 `load()` 只认内存快照）。
> 启动入口是 `securityStore.hydrate()`：表里**有**该键 → 读进内存快照；表里**没有** → 一次性迁移 localStorage 的历史副本进表。
> 两条分支随后都**清掉** localStorage 的规则字段 —— 因此「删掉表里的行」= 真正清空规则（不会被迁回）。
> - **Rust 引擎路径**（默认）在 `native_tools/execute/{execute_command,execute_script}.rs` 里**本地判定**（规则随 `NativeToolSecurity.sandbox_ignore_rules` 下发，零 IPC、零 IO）；
> - **JS 执行器路径**在 `infrastructure/tools/execute/{execute-command,execute-script}.ts` 里定 `bypassSandbox`；
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
- 密钥打码：`utils/telemetry/redact.ts`、`isSensitiveKey()`。事件名沿用 `域.动作`，公共字段由前端补齐。

### 5.9 手机控制（电脑侧 Bridge）

手机扫码配对后**远程操作本机**（看会话 / 发消息 / 应答工具审批）。电脑侧只做「接口层」，传输交给自维护的 npm 包 `virlen-remote`。

- **装配入口（唯一）**：`src/bridge/index.ts::startPhoneBridge(endpoint, opts)` —— 在一条已建立的 `Endpoint` 上装出三件套：`registerHostHandlers(source)`（`host.*` RPC）、`createStoreBridge(emit)`（`host.event.*` 推送）、配对 / ACL / 审计。
- **生产接线**：`src/ui/store/phoneControlStore.ts` 实例化 `PhoneControlService` / `PairingStore` / `AuditLog`；设置页 `ui/pages/Settings/phone-control-settings.tsx` 是 QR、设备列表、审计记录的入口。
- **传输**：WebRTC（`virlen-remote`）+ SSE 信令（`SseSignalingClient`）。信令基址存 `localStorage['virlen.phone.signal']`（默认 `https://virlen.cn/api/rtc/`），自定义 ICE 同样落 `localStorage`（清应用数据即回服务端默认，不丢功能）。
- **落盘**：配对表 / 设备身份 / 审计经 Rust 命令持久化 —— `cmd_phone_{pairing,device,audit}_*`（`src-tauri/src/commands/phone_{pairing,device,audit}.rs`，已在 `lib.rs` 注册）。

| 文件（`src/bridge/`，17 个） | 职责 |
|---|---|
| `index.ts` | 装配入口 + 对外导出面 |
| `phone-control.ts` | 电脑端常驻服务：握手、配对请求、拒签踢链、状态推送 |
| `host-source.ts` | 真实 `HostDataSource`（**会话域**）：把手机 RPC 落到本机 `sessionStore` / `chat-service` |
| `file-source.ts` / `file-tauri.ts` | 工作目录文件（**文件域**）：浏览 / 分块读 / 原子上传；`file-source` 是对接层，`file-tauri` 是 Tauri 版文件端口 |
| `store-bridge.ts` | mobx `reaction` 旁路订阅本机 store，把变化推给手机 |
| `dto.ts` | DTO 投影（**白名单**出参，不整包外发内部结构） |
| `pairing.ts` / `device-identity.ts` | 配对凭证与电脑设备身份（「重新获取还是同一台」） |
| `acl.ts` / `approval-policy.ts` / `audit.ts` | 授权策略（**默认拒绝**）/ 审批分级判定 / 操作留痕 |
| `interaction-registry.ts` / `interaction-source.ts` | 待应答交互注册表（手机应答与本机弹窗同源；**注册表归服务持有、不归链路**，见下） |
| `telemetry.ts` / `subscription.ts` / `link-kind.ts` | 通讯层埋点 / 订阅计数 / 链路类型（P2P 直连或 TURN 中继） |

- **依赖方向**：`src/bridge/` 依赖 `services` / `domain` / `infrastructure` / `ui/store` / `utils` / `events`；而 `ui/store/phoneControlStore.ts` 反过来 import `@/bridge` —— 两者**双向依赖**，改动时留意模块初始化顺序。
- **服务状态机（`phone-control.ts`，设置页那颗胶囊的真相）**：`waiting → verifying → connected`，另加两个否定态（`rejected` 谁被拒了 / `error` 链路故障）。
  ⚠️ **`error`（链路已关闭）不是终点**：`closed` 是终态 —— 那条 PeerConnection 已 `failed`/`closed`，而 host 侧下一次协商会复用它（共享包 `rtc.ts::ensurePC` 的 `if (this.pc)`），于是**手机再也连不回来**。所以 `closed` 后过 `LINK_CLOSED_RECOVER_MS`（3s）仍未真正恢复就自动 `dropLink()` 原地重开（票据不变、回到「等待手机连接…」）。到点复核「链路没换过 / 服务还开着 / 没有拒绝结论 / **本链路仍带着 `linkClosed` 标记**」，而该标记**只有链路真的回到 `open`（会重新握手）才清** —— 「回到 `connecting`」不算恢复，理由见下一条；拒绝结论生效期间不安排（拆链由踢链负责，`phone-link-recover.test.ts` 钉住四条）。
- **「等待手机连接…」可能是一句假话：电脑端必须对账「自己还在不在房间里」**（2026-10 真机缺陷：手机连过一次后断开，此后电脑端一直显示「等待手机连接…」，而手机端显示「电脑不在线」、怎么点连接都连不上 —— 两边都没看错，房间里真的已经没有这台电脑了，错的只是电脑端以为自己只是在等人）。两个成因分别堵在两层：
  1. **迟到的 `connecting` 撤销了自愈**：`closed` 是终态，电脑端据此排好 3 秒后的原地重开；而紧跟其后的 `connecting` 往往只是**拆链的余音**（对端离开的 `peer-left`、被关掉的 DataChannel 的 `close` —— 后者在真实浏览器里是**异步投递**的）。旧实现让它把状态写回「等待手机连接…」，复位到点一看「已经不是 `error` 了」就放弃 → 这条链路再也回不来（只有用户去设置页关一次再开）。现在复位只认 `linkClosed` 标记，且 `connecting` 期间状态保持「出错（链路已关闭）」、不写「等待」。
     共享包侧也修了同一个根（`rtc.ts::teardownPeer`）：**主动拆除一律静默**（先摘监听器再 `close()`），要表达什么状态由调用点显式 `setState` 说明 —— 否则每次「手机主动走开」都会被记成链路故障、白重建一条（三个回归用例在 `virlen-remote/tests/rtc-transport.test.ts`，其中假 WebRTC 的 `close()` 已改为**异步投递**，与浏览器一致）。
  2. **从头到尾没有事件**（SSE 事件流静默死掉：代理超时 / 服务重启 / 换链那一刻网络未就绪）：状态机无从得知「信令服务已经不认识我了」。故服务按 `ROOM_PRESENCE_CHECK_MS`（20s；**只在本机没有已授权的手机连着时**）`POST /status` 反查自己（`verifyRoomPresence`，注入点 `options.probeRoom`；设置页打开那一刻也会对一次账 —— 用户正盯着那颗胶囊）。服务端明确说「不在」→ 如实报「出错（信令连接已断开）」并原地重开；**问不到（`null` / 请求抛错）一律不动作**（宁可漏判也不误拆）。
     配套（共享包 `fetchHostOnlineMap`）：**「问不到」不再被当成「电脑不在线」** —— 旧实现 `?? false` 会让名单上每一台都显示「不在线」，哪怕只是这次查询失败；现在缺键 = 未知，手机端登录页显示「状态未知」。
     回归：`src/tests/bridge/phone-room-presence.test.ts`（含三条「防修过头」：手机主动走开不算故障 / 链路真的回到 `open` 就不白拆 / 有手机连着时自检不动链路）。
- **手机端重连令牌必须是凭证（`grant`），不是一次性票据**：扫码配对成功时 `host.hello` 会回传凭证，手机端必须把它**同时**写进「设备记录」与「重连参数」（`virlen-mobile/src/store/connection.ts` 的 `lastOptions.token`）。
  ⚠️ 只写设备记录、重连参数仍留着那张票 → 票在那次配对里已被电脑端消费（`redeemTicket` 删票），此后每次重连 / 重新授权都拿**作废的票**握手：电脑端 `pairing.authorize` 判 `ticket-expired`（状态进 `rejected`「已拒绝接入（二维码已过期）」），手机端据 `HARD_DENIALS` 退回登录页并提示「重新扫码」——而两边列表里那台手机都还在（配对记录本身是好的）。真机反馈正是这三个看似矛盾的现象同时出现。回归用例 `virlen-mobile/src/tests/pairing-token-refresh.test.ts`。
- **推送是「变化驱动」，不是「状态驱动」（改动时最容易踩的点）**：`store-bridge.ts` 四条通道全部靠 mobx `reaction` 推**变化**，而订阅登记表（`subscription.ts`）是**普通 Set（非 observable）**——**订阅本身不触发任何推送**。所以「订阅那一刻的现值」必须由 `host-source.ts` 的 subscribe / create 路径显式补一次（`storeBridge.pushRuntime`）。
  少了这一帧的后果是「手机看得见进度、却看不见状态」：会话在手机没订阅的那段时间里**出过的错**（`RuntimeDTO.error`）、**被暂存的 run**（`paused`）、甚至 `working` 的初值都不会到达手机——打开那个会话只看到一个没有任何解释的空会话（手机侧 `virlen-mobile/src/store/chat.ts` 的 `sessionError` 就是这条通道的落点）。
- **待应答交互是「电脑侧的事实」，注册表必须跨链路存活**（2026-10 真机缺陷：「AI 调 `user_choice` 时手机端看不到卡片；点一下却提示『该请求已在电脑上处理』，而电脑上根本没人答过；断开重连也没用」）。
  注册表原先在 `startPhoneBridge` 内自建 —— **一条链路一份**，而电脑侧换链路是常态（`closed` 自愈 3s / `open` 后 8s 未握手 / 移除手机 / 改 ICE 四条 `dropLink` 路径）。一换就把排队中的交互连表一起丢掉：手机侧那张卡片成了点不动的僵尸（`host.interaction.list` 已空 → 点一下得 `not-found`），而电脑侧桌面弹窗与引擎仍在等 —— **谁都没答过，问题却被「消费」了**。
  现在：表归**调用方**（设置页 `phoneControlStore.ensureInteractions()`，与配对表 / 审计同一套做法：懒建、跨实例复用）—— 服务的启停与「改 ICE 换服务实例」改的都只是「谁在用这张表」。`PhoneControlService` 只负责**接线**与在建链路时注入（`PhoneBridgeOptions.interactions`）；表不在它手里，所以它被换掉不等于表被丢掉。**接线生命周期 = 启用**：`enable()` 挂、`disable()` 解（`attachInteractions` / `detachInteractions`）—— 关掉手机控制期间不再登记、也不再有 `phone.interaction.*` 埋点（远端根本没人能应答）；但表**不清空**（远端下线 ≠ 交互结束，本机弹窗与引擎还在等，重新启用后手机连上即可应答）。已知且接受的边界：停用**期间**在桌面答掉的交互不会再被收敛（此刻本机观察不到）→ 重新启用后手机可能看到一张点一下就提示「已在电脑上处理」的卡片；刻意如此 —— 清空只能走 `settle()`，而那条会**同步回声**到本机、把桌面正在等的弹窗收掉（引擎随之卡在等回执上）。接线**同时只能有一份**：`wireInteractionSources` 用模块级 `WeakSet` 守卫，对同一张表再接一次**直接抛错**（解绑后可以重接 —— 改 ICE 走的就是这条路）；违反它的后果是**静默**的（每个交互登记两遍、`interactionSettled` 收两遍 → 终态与 `by` 归属错乱），故用运行时约束而不是注释。推送出口是「转发到**当前**服务实例」的 `(t, p) => service?.emitToLink(t, p)` —— 表推事件时手上的实例可能已换（改 ICE），故出口必须是这条间接引用，而不是某个实例的 `bridge`（保留出站闸门与埋点）。
  链路重建 / 服务实例重建后条目仍在，手机连上后靠 `host.interaction.list` 快照补齐。终端的 `toolCallId → interactionId` 查询归**注册表**（`findTerminalByToolCall`）而不是接线层：接线重挂（改 ICE）会把接线级的映射清空，而表跨实例存活；该调用是**热路径**（每次工具输出通知都会走到），故先按 `size` 短路。
  手机侧配套（`virlen-mobile/src/store/chat.ts`）：`resyncAfterReauth()` 是「链路代际更替」的重同步入口 —— `onEndpointReady`（新 Endpoint）与 `connection.ts::reverify`（同一条链路上重新授权成功）都走它；合并快照时用**本机到达时刻**（`interactionArrivedAt`）判新旧，**不拿电脑侧 `createdAt` 与本机 `Date.now()` 比大小**（两端时钟不同源，会把刚推到的卡片当过期删掉）。
  回归用例：`src/tests/bridge/phone-interaction-relink.test.ts`（含「换**服务实例**（改 ICE）后仍在位」与「停用期间不登记 / 重新启用恢复」，注入态的推送出口看 `emitToLink`）、`src/tests/bridge/interaction-settle.test.ts`（含「接线重挂后终端确认仍能收敛」与「同时接两份线直接抛错」）、`virlen-mobile/src/tests/interactions.test.ts`。
  store 层另有两道网（`src/tests/ui/`）：`phone-control-interactions.test.ts`（假服务，钉「store 给服务的表实例是否复用、出口指向当前实例」）与 `phone-control-relink.test.ts`（真服务 + memory transport 的**端到端**：启用 → 手机握手 → 提问 → 改 ICE → grant 重连 → 卡片仍在、能应答、推送落到新链路）。后者靠 store 上那个**仅测试用**的 `createTransport` 注入口（生产不设置）。
- **交互终态必须通知两端**（2026-10，紧接上一条）：`InteractionRegistry.settle()` 过去只 `emit('host.event.interaction.resolved')` —— 那条只到**手机**，于是「谁先应答」决定了另一端的下场，留下两种点不动的僵尸弹窗（手机批完桌面还在弹；手机端取消 / 删除会话后桌面还在弹）。
  现在双向：手机 ← `host.event.interaction.resolved`；桌面 ← `notifyLocalSettled` → `toolInteractEvent.interactionSettled`（`interaction-source.ts` 把共享包的 `expired` 映射成 `reject` —— 本机监听方只看 id，不看 outcome）。
  ⚠️ 同一处还有个**回流次序**陷阱：`InteractionSink` 的落点是本机既有交互事件，而本机 handles 应答成功后又会**同步**广播 `interactionSettled` —— 它会抢在 `answerInner` 之前把条目收掉，终态就被记成「电脑侧处理」（AI 提问：`by` 错成 `host`，手机端把自己刚批的显示成「电脑已处理」；终端内确认更糟：`outcome` 错成 `expired`）。故**凡「本机观察到的终态」一律走 `registry.settleByLocal`**（`answer()` 期间用 `answering` 标记让位），不要直调 `settle`。另有一条同源次序：终端内确认里 `pendingConfirm` 消失与 handles 的终态广播是**同一件事的两个信号**，而前者只能推导出 `expired` —— 所以 handles 必须**先广播、再清**（`command_confirm.ts` 的 `offTermSubmit` / `offTermCancel`），否则被放行的那条在埋点与手机端永远显示成 `expired`。回归用例：`src/tests/bridge/interaction-settle.test.ts`。
- **「运行结束」必须收敛还没被回答的交互**（2026-10，F4）：`cleanup()` 是**唯一**的运行结束钩子（`services/chat/flow.ts` 的 finally），而它一跑各 handles 的监听器就拆了 —— 但「运行结束 ≠ 用户答过了」：桌面点停止 / 手机取消或删除会话 / 引擎放弃这次交互请求，这四条路上交互都还没被回答。所以 `user_choice` / `command_confirm`（弹窗 + 原生终端）的 `cleanup()` 里都有 `endPending()`：**先广播 `interactionSettled(interactionId, 'expired')`**（桌面弹窗与手机侧注册表靠它收 UI），**再 `reject(new InteractionEnded())`**（否则那个 Promise 永不 settle：`handleUserInteractionRequest` 的 await 永远挂着、闭包被一直引用，手机侧卡片也永远不消失）。`expired` 由此成为**本机终态契约的一员**（与共享包 1:1 透传，以前被近似成 `reject` —— 那让本机监听方分不清「用户拒绝」与「没人回答」）；桥接层对 `InteractionEnded` 回 `__kind:'error'`（不是伪装成 `[User cancelled]`）。回归用例：`src/tests/bridge/interaction-settle.test.ts`、`src/tests/infrastructure/command-approval.test.ts`、`src/tests/services/rust-engine-interaction.test.ts`。
- **JS 桥接层不许「静默消费」用户交互**（`services/rust-engine.ts`）：会话没注册处理器时，过去**静静**回 `{__kind:'cancelled'}` —— Rust 侧据此把工具结果写成 `[User cancelled]`，AI 顺势跳过这一步，界面上不留任何痕迹（真相是「没人能应答」，却伪装成「用户取消」，排查时现场全无）。现在：`console.warn` + 埋点 `error.bridge`（`kind:'user-interaction-orphan'`，用现成事件名，不新造 trace 字典项）+ 回 `__kind:'error'`（作工具失败结果，消息流里看得见）。
  同处的 `registerSessionToolHandler` 现在返回**归属令牌**，`unregisterSessionToolHandler(sessionId, token)` 校验通过才注销 —— 否则交错的 run（同会话重发 / 手机端与桌面端几乎同时发 / 暂停恢复）会互相删表，后一个的提问就掉进上面那条分支。回归用例：`src/tests/services/rust-engine-interaction.test.ts`。
- **运行时状态由电脑侧权威**：错误文案来自 `sessionRuntimeState`（电脑侧写入），手机侧只做投影——所以「重新发送时清掉上一条错误」必须在电脑侧做（`host-source.ts::send` 与桌面 `chat-view.handleSend` 同构），否则手机会被补推的快照顶得反复弹同一条红条。
- **Agent 选择（协议 0.6.0）**：新建会话时可指定**归属 Agent**（此前手机建的会话永远归默认 Agent）。
  - 电脑侧：`host.agent.list` 给候选集（白名单：`id` / `name` / `defaultModel` / `defaultWorkspace`，**不含** `systemPrompt` / `allowTools` / `skills` / `params`）；`host.session.create` 的 `CreateSessionParams.agentId` 带归属，未知 id → `E_BAD_REQUEST` 并进审计（`host-source.ts::requireAgent`）；不传 = 默认 Agent（旧行为不变）。
  - 权限位 `session.agent`（常量 `SESSION_AGENT_CAPABILITY`，见 `acl.ts`）：这是**权限**而不是功能标记 —— 选 Agent 就是选 systemPrompt / 工具白名单 / skills，所以 handler 里独立 `assert`，不靠手机端隐藏入口（§7-⑪）。
  - **已有会话的 Agent 不可改**：换 Agent 就是换提示词与工具白名单，历史对话会前后错配（与「工作目录只在新建时确定」同一条理由）。因此只有「新建时指定」，没有 `setAgent`。
  - 手机端（`virlen-mobile`）：`store/chat.ts` 的 `draft.agentId` + `loadAgents()`，面板 `ui/components/NewChatPanel.tsx` + `ui/components/ModelPicker.tsx::AgentPicker`。**换 Agent 会清掉草稿里的模型 / 工作目录**（与桌面 `chat-view` 那条 effect 同语义）；旧电脑端没有该能力 → 选择器不显示，且创建时**不携带** `agentId`（否则会被静默丢掉，用户以为选了却没生效）。
- **工具消息的四个下行字段（白名单投影，`bridge/dto.ts::toMessageDTO`）**：`toolName` / `toolArgs`（折叠态一行）/ `toolArgsFull`（展开区完整入参）/ `text`。
  工具结果消息（`role:'tool'`）**自己只有结果文本**，名字与入参都在**发起此次调用的 assistant 消息**的 `toolCalls[]` 上 —— 靠 `buildToolCallIndex`（`toolCallId` → `{name, input}`，匹配规则与桌面 `resolveJumpAnchorId` 一致）接起来。
  `toolArgs` 是**一行摘要**（`src/store/chat.ts` / `npm run build` / `在 src 中搜索 sessionError`），由共享包的 `summarizeToolArgs` 生成（真实电脑侧与演示宿主 `testing/mock-host.ts` 共用同一份，避免两端漂移）；路径按会话工作目录缩短（`toShortPath`，与桌面卡片同口径）。
  ⚠️ **摘要绝不下行正文**（`write_file.content` / `edit_file.edits[].old_string` 可能是整篇文章）；`toolArgs` **不受传输档位影响**——它只有一行，且正好是工具输出被精简档略掉时用户唯一还看得见的东西。
  拿不到就整个字段缺席（旧电脑端 / 跨页工具调用）→ 手机端只显示工具名，**不要用正文反推**。
- **展开区的完整入参（`toolArgsFull`）与 5000 字符中间省略**（2026-10 第二轮真机反馈：「入参显示不完整」）：
  - 折叠态那一行是**摘出来的**（只挑主参数 + 160 字符上限），用户点开卡片想看的就是剩下的部分 → `formatToolArgs(input, {shortenPath})` 给**入参本身**（两空格缩进的 JSON，与桌面导出同一形态），路径走**同一个** `shortenPath` 回调（折叠 / 展开显示成两个路径会被当成点坏东西）。
  - 纪律与摘要**反了一面**：摘要“只给摘要不给原文”，展开区允许出现正文 —— 前提是**用户主动点开才渲染**（手机端 `ui/components/MessageList.tsx` 的 `.tool-card__args-detail`，超出 **7 行**靠 CSS 内部滚）。
  - 长度统一由 `TOOL_DETAIL_MAX`（5000）+ `elideMiddle`（**中间省略**，标记行写进正文）兜住；**工具输出（`text`）用同一条线**，而 assistant / 用户正文一个字不裁（那是「主要内容」）。
  - 用例：`src/tests/bridge/phone-tool-args.test.ts`（投影）、共享包 `tests/tool-args.test.ts`、手机端 `chat-tool-card.test.ts`（折叠态不进 DOM）。
- **「工具在执行」也要下行**（2026-10 真机反馈：「工具在电脑上有显示（呼吸点卡片），手机上只看到『正在思考』」）：`RuntimeDTO.runningTools?: RunningToolDTO[]`（协议 0.6.1）。
  根因是这段状态**只活在电脑侧的界面推导里**（桌面 `message-bubble.tsx` + `use-virtual-list.ts::toolResultsFor` 把「assistant 的 `toolCalls[]` 减掉已有结果」渲染成 pending 卡片），而工具消息（`role:'tool'`）**只在执行完之后**才作为消息下行；隔壁的 `toolProgress` 又只管**参数累积**期（工具一开跑就被清掉）—— 中间那段静默期手机端无东西可看。
  - 电脑侧：`bridge/dto.ts::runningToolsOf(sessionId)` 做同一个推导（**判据与桌面逐字一致**，否则「电脑上看到几个在跑」与「手机上列几行」会对不上），`toRuntimeDTO` 只在 `working === true` 时带上它（否则崩了 / 被取消 / 重启后残留的悬空 `tool_calls` 会变成一行永远「正在执行」的僵尸）；`args` 走**同一个** `summarizeToolArgs` + `shortenPath`（与已完成卡片的 `toolArgs` 同源、同一条长度上限，**绝不含参数正文**）。
  - 推送：`store-bridge.ts` 的 `runtimeFingerprint` 必须把它算进去，否则**静默不同步**（工具开跑 / 跑完各一帧）。那里直接拿 `toRuntimeDTO(...).runningTools` 当指纹（「推什么就看什么」，新增字段不会漏）—— ⚠️ 所以这个 reaction 现在会读 `s.messages`，而 `runningToolsOf` **只读 `role` / `toolCallId` / `toolCalls`，不读正文**（读正文 = 每个流式 token 都把它唤起来，而结果一个字都不会变）。
  - 手机端：`store/chat.ts` 的 `runningTools` 切片 + `ui/components/MessageList.tsx` 的尾部 `StreamingBubble` 渲染成一行一个呼吸点（`正在执行 read_file · src/store/chat.ts`），与流式正文**并存**（正文在上、工具行在下，与电脑同一次序）；**有它时不再显示「正在思考…」占位**（两个状态打架 = 看起来像卡死）；**暂停态不显示**（暂停时那些调用是「等继续」，不是「正在执行」）；最多列 3 行、多出来的报「等 N 个工具」（少列几条不能不告知）。文案口径在 `lib/messages.ts::runningToolLabel` / `runningToolsView`（纯函数，可单测）。
  - 联调：演示宿主新增 `setRunningTools(sessionId, tools | null)`（与 `setToolProgress` 对称），手机端 `/host.html` 上有「参数累积中 / 开始执行 / 执行完毕」三个按钮。
  - 用例：`src/tests/bridge/phone-running-tools.test.ts`（投影 + 推送 + 订阅门）、共享包 `tests/running-tools.test.ts`（mock 宿主那一帧）、手机端 `chat-running-tool.test.ts`（DOM：行文案 / 与正文先后 / 收工消失 / 暂停不显示）与 `session-config-helpers.test.ts`（文案与截断）。
- **手机端「进入后默认打开哪个会话」（用户拍板，2026-10）**：**正在工作的 → 否则最近更新的**，**置顶不参与**（`virlen-mobile/src/lib/session-entry.ts::pickEntrySession`，纯函数）。
  ⚠️ 以前取的是列表**第一个**，而列表顺序是「置顶优先 → `updatedAt` 倒序」（`sessionStore.listSessions()`）—— 于是**置顶的老会话**把「最近在用的那个」顶掉了，真机表现是「每次打开手机都跑到一个几天没动的会话里」。
  口径细节：多个在工作的取其中**最近更新**的；并列（含时间拿不到）保持列表里**靠前**的那个；**已有当前会话时不切**（链路抖动 / 代际更替后的重新挂载不该把用户正看的会话换掉）；一条会话都没有 → 停在「新对话」。
  ⚠️ `updatedAt` **只由用户发送消息刷新**（`sessionStore.touchSession`）—— 它真的是「最近用过」，不是「最近被改过」（改标题 / 置顶 / 切模型都不刷新它）。
  联调：演示宿主 `?entry=pin` / `?entry=work` 造出这两种只有在真机上才出现的形态；用例 `virlen-mobile/src/tests/session-entry.test.ts`。
- **工作目录文件（§37）**：手机端能浏览 / 预览 / 下载 / **上传**当前会话工作目录里的文件（入口在会话信息面板的「工作目录」那一行：**浏览文件**）。
  ⚠️ 顶栏**早已收到三个图标**（信号 / ＋ / 会话列表）：五个 38px 图标就是 206px，360px 的屏上左侧标题只剩 ~100px（真机反馈「五个按钮和左边叠在一起了」）。文件入口当初也试过放顶栏，已下沉；`设置` 同理（在会话抽屉底栏）。
  - **协议（六个方法）**：`host.file.list`（非递归列目录）/ `host.file.read`（分块读，单次 ≤ `FILE_CHUNK_BYTES` = 256KB）/ `host.file.write.begin|chunk|finish|abort`（分块上传）。能力名三档（**默认全开**）：`file.browse` / `file.download` / `file.upload`（拆三档而不是一个：能看「有哪些文件」与能看「文件里写了什么」是两种强度，写又是第三种）。
  - **为何是 base64 分块而不是整文件 / 二进制帧**：帧层载荷是 UTF-8 JSON 且要**攒齐全部分片**才交付 —— 整文件塞一次会同时炸掉两端的组装缓冲；换二进制帧则要改帧格式与主版本。代价是 33% 的 base64 开销，换来进度可见、可取消、单请求内存上界固定。
    电脑侧读分块走 `open + seek + read`（`file-tauri.ts`）而不是 `plugin-fs.readFile`（**它把整个文件读进内存** —— 手机上点开 500MB 的视频时 webview 先 OOM，而我们只要前 256KB），为此 `src-tauri/capabilities/default.json` 里开了 `fs:allow-open` / `fs:allow-seek`（实际边界仍由 `fs:scope` 与本层传入的**已过安全校验**的绝对路径决定）。
  - ⚠️ **越权防线只有一道，且在电脑侧**：手机传来的路径先被 `normalizeRelPath` 规整（逃出工作目录的 `..` 段就地吃掉），再由 **`securityService.resolveSafePath`**（与桌面文件工具同一个入口）落到绝对路径并过黑白名单。`file-source.ts` 里**不得**自己做路径拼接 —— 两份拼接逻辑就是两个边界。安全拒绝归一成 `E_DENIED`（而不是让它成为一个普通 `Error` → 手机端看到「电脑端内部错误：路径不在…」，用户会去重试、去报修）。
  - ⚠️ **非中继门槛不在 ACL 里**（它是链路质量，不是授权）：口径是共享包的 `fileTransferDeniedReason()`，**只在确认走了 TURN 中继时拒**（`direct` / `unknown` 放行 —— `unknown` 是常态：同源 Broadcast 联调、非 WebRTC 链路、刚打通那几秒；把它判成禁用等于功能在联调里根本进不来）。链路事实只有拿 `RTCPeerConnection` 的那一层知道，故由 `PhoneControlService` 注入 `linkKind: () => kindWatch.kind`（与 `transferTier` 同一做法）。**唯一的例外是 `abort`**：它只删自己的临时文件，链路刚变中继 / 断掉时恰恰最需要能清掉它。
  - ⚠️ **上传是原子的**：`begin` 之后字节只写临时文件（`.virlen-upload-<id>.virlen-part`），`finish` 才 `rename` 到目标名 —— 传输中断 / 用户取消不会在用户项目里留下一个「打开是坏的」半截文件。`finish` 时若目标名被抢（用户同时在电脑上存了同名文件），**按同一条冲突口径再让一次名**并把新名字如实回给手机。同名自动加「 - 副本」（与桌面 `file-transfer-service` 同一条口径）。
  - 两个注入口：`fileSystem`（文件系统端口，不传 = Tauri 真机实现）与 `resolvePath`（安全校验）—— 本层的全部纪律（上限 / 临时文件 / 乱序拒绝）都值得单测，而单测里没有 Tauri（`src/tests/bridge/phone-files.test.ts` 注入内存端口 + 假安全校验）。
  - 手机端（`virlen-mobile`）：`store/files.ts` + `ui/components/FileSheet.tsx`；门槛判定收在 `fileStore.blockReason()`（能力 + 链路合成一句话，UI 只负责置灰与展示）。本端另有一条**本机内存**上限制（`DOWNLOAD_MAX_BYTES` = 64MB）：分块收下来的字节要拼成 Blob 才能交给系统分享，而 Blob 在手机上就是内存。列表区两条布局 / 加载态纪律（面包屑常驻、进目录不清空列表）见 §11.42、§11.43。
  - 联调：演示宿主自带一棵**真**文件树（含一张真 PNG 与一个未知类型的 `build/app.bin`）；`?files=relay` 让所有文件 RPC 一律拒（验证手机端整面板显示同一句理由）。
  - 用例：电脑侧 `src/tests/bridge/phone-files.test.ts`（越权 / 中继 / ACL / 原子落盘 / 乱序与未传完）；共享包 `tests/files.test.ts`（分类 / base64 / 路径 / mock 宿主）；手机端 `files-lib.test.ts`（纯函数）、`files-store.test.ts`（与 mock 宿主经内存链路对跑）、`files-ui.test.ts`（DOM：进目录 / 预览 / 中继置灰 / 两个入口）。
- **压缩上下文可选两种方式（§22）**：`CompressParams.mode`（`'ai'` = AI 摘要 / `'raw'` = 正文压缩）。
  能力名 `session.compress.mode`（常量 `COMPRESS_MODE_CAPABILITY`，见共享包 `protocol/compress.ts`）。
  - ⚠️ **为何要能力名**：`mode` 是普通字段，**旧电脑端会静默忽略它**而按电脑侧设置压缩 ——
    用户侧表现是「我点了『正文压缩』，结果还是 AI 摘要（还花了钱）」，没有任何报错可查。
    所以手机端**只在电脑端声明它时才给两个按钮**，否则只给一个「压缩上下文」（不传 `mode`）。
  - 它是**功能标记**而不是权限：压缩本身的授权仍是 `session.compress`（破坏性、需 `confirm: true`，
    handler 里独立 `assert`）。电脑侧 `host-source.ts::compress` 仍**独立校一遍取值**：
    没传 = 沿用桌面设置里的那一档（与改动前同形的一次调用）；**传了但不认识 → `E_BAD_REQUEST`**
    （落回缺省等于把手机端的一个拼写错误变成一次要花钱的模型调用）；留痕写明 `mode=…` / `mode=host-setting`。
  - 落地：手机端 `store/chat.ts::compressContext(sessionId, mode)` 只在能力允许时才把 `mode` 放进请求；
    UI 是会话信息面板「上下文」块里的**两个按钮**（`AI 摘要压缩` / `正文压缩`，各自二次确认）；
    `sentMode` 只用来决定哪一颗按钮转圈（压缩中的真实进度仍是电脑侧推来的 `compacting`）。
  - 联调：演示宿主（`virlen-remote/testing`）按 `mode` 出不同产物，`lastCompress()` 是观察口；
    手机端 `/host.html` 的说明已注明两个入口。
  - 用例：电脑侧 `src/tests/bridge/phone-compress-wiring.test.ts`（原样下发 / 归一化 / 未知取值拒 / 不传=沿用设置）；
    共享包 `tests/compress.test.ts`（取值域 + mock 真的走出不同产物）；
    手机端 `chat-compress-mode.test.ts`（DOM：两个按钮 / 选了真的走那种 / 取消不发 / 旧电脑端只给一个按钮且不传 `mode`）。
- **手机端界面字号五档（特小 / 小 / 中 / 大 / 特大）**：`--fs` = `0.80 / 0.90 / 1 / 1.12 / 1.26`
  （`virlen-mobile/src/theme.css` 的 `:root[data-size]`，取值域在 `src/lib/prefs.ts::SIZE_PREFS`）。
  - 原有三档的**取值名不动**（`s` / `m` / `l`），所以存储里的 `{"size":"l"}` 不需要迁移；
    新增 `xs` / `xl`，真机反馈是「还想再小一点」——旧「小」（0.92→0.90）在长命令 / 长表格前仍偏大，
    而字号不能靠浏览器缩放解决（`zoom` 会把 `position: fixed` 的抽屉与底部面板一起缩）。
  - 中档恒为 1（默认值 + 其余四档的基准）；面板里的「A」预览与文字**竖向叠放**（五列在 360px 屏上
    放不下横排的 A + 两个字，截断的标签比不显示更糟）。
  - 用例：`ui-prefs.test.ts`（含直接读 `theme.css` 比对取值集合 / 递增性 / 中档为 1 —— 少一条 CSS 规则
    就是「点了没反应」）、`settings-sheet-ui.test.ts`（五档逐一点到 DOM + 标签顺序）。
- **编辑电脑上的文件（§37 覆写保存）**：手机端可改工作目录里的**纯文本 / 代码 / Markdown 源码**。
  协议面 = `host.file.write.begin` 带 `overwrite: true` + `expectMtimeMs` / `expectSize`（归 `file.edit` 档）；
  `host.file.read` / `.finish` 的应答各多一个 `mtimeMs`（打开时的版本凭据 / 覆写后的新版本）。
  - ⚠️ **与上传是两条路**：覆写要求目标**已存在**（不新建）、**不做同名改名**（不产生「 - 副本」）、
    必须带版本（不给 → `E_BAD_REQUEST`，于是「盲写」不存在）；版本不符 → `E_CONFLICT`。
    电脑侧**独立**再校一遍可编辑扩展名（`isEditableFileName`）与编辑上限（`FILE_EDIT_MAX_BYTES` = 256KB）。
  - **落盘前再校验一次版本**（`finish`）：begin 与 finish 之间隔着网络，AI 可能正好在这期间写完那个文件。
  - 手机端那三个「存回去就把文件搞坏」的坑全由共享包兜住：**CRLF**（textarea 只有 LF）、
    **BOM**、**非 UTF-8 拒绝编辑**（`decodeUtf8Strict`；宽容解码的乱码存回去就是毁文件）——见 §11.44。
  - 降级：旧电脑端没有 `file.edit` → 手机端只给只读预览（旧电脑端会静默忽略 `overwrite`，
    一次覆盖保存会退化成「另存为 - 副本」，用户以为改了、原文件其实没动）。
  - 落地：电脑侧 `src/bridge/file-source.ts`（覆写分支 + `requireAuthorizedUpload`：授权按**记录自己的写入方式**算）
    + 端口 `file-tauri.ts`（`statFile` / `replaceFile`）；手机端 `store/files.ts`（编辑态 / 保存 / 冲突 / 重新载入）
    + `ui/components/FileSheet.tsx`（编辑区 + 未保存确认 + 冲突两个按钮）。
  - 用例：电脑侧 `src/tests/bridge/phone-files.test.ts`（两档授权独立 / 冲突的两个窗口 / 不改名 / 中途放弃）；
    共享包 `tests/files-edit.test.ts`（换行往返 / BOM / GBK 拒编 / 覆写链路）；
    手机端 `src/tests/files-edit.test.ts`（字节真落到宿主 / CRLF 保留 / 冲突两条选择 / 取消不发 RPC）。
- **引用电脑上的文件（§37 的延伸）**：手机端把讲题里的文件面板里挑中的文件**挂到要发的那条消息上**（入口：文件面板预览头的「引用」按钮）。
  与桌面输入框的「文件附件」（`FileAttachment`）**同一条口径**：只带**路径 + 展示元数据**，不搬运内容 ——
  真正的读取交给 AI 用 `read_file` 按需完成。
  - 协议面：`SendParams.files?: MessageFileRef[]` + `MessageDTO.files?: MessageFileRef[]`（与 §36 的 `quotes` 并列）；
    能力名 `message.file`（`MESSAGE_FILE_CAPABILITY`，**功能标记**不是权限：引用本身就是 `session.send` 的一个参数）。
    电脑侧 `host-source.ts::send` 把两件结构化输入一起交给 `buildUserContent`（块顺序 quote → text → file），
    于是引擎 / 持久化 / 桌面渲染 / 导出与桌面拖一个文件进输入框**完全一致**。
  - ⚠️ **校验口径只有一份**（共享包 `sanitizeFileRefs`，电脑侧与演示宿主共用）：
    形状非法 / 超条数（`MESSAGE_FILE_MAX` = 20）/ 路径过长（`MESSAGE_FILE_PATH_MAX` = 1024）→
    **拒整条**（`E_BAD_REQUEST`，并留痕 `allowed: false`），**不静默丢掉那一条** —— 丢一条时
    手机上 chip 还在、用户以为附上了，而 AI 从未看到（§36 引用那次踩过的坑，见 §11.45-②）。
    `isDir` / `size` 只是展示元数据（形状不对就丢字段）；路径分隔符归一为 `/`；同一路径去重。
  - ⚠️ **文件引用不进 `text`**（与 `quotes` 同一纪律）：电脑侧投影正文时本就会把文件块展平成
    `[文件] <名字>`（§7-⑦，与图片同一套降级规则），两条路同时走会显示两遍 —— 而那个展平占位符
    **只有名字没有路径**（同一目录下两个 `index.ts` 长得一样）。
  - 降级：旧电脑端没有 `message.file` → 手机端**不给「引用」入口**（它会把 `files` 静默丢掉；
    ⚠️ 与只读两项不同，**不能整面板置灰** —— 浏览 / 预览 / 下载 / 编辑都还能用）。
  - 落地：手机端 `ui/components/FileSheet.tsx`（预览头「引用 / 已引用」开关，点完**不关面板**：
    可以接着引用下一个）、`ui/pages/Chat.tsx`（`pendingFiles` + 输入区 chip + 发送带 `files`）、
    `store/chat.ts::send(text, quotes, files)`、`lib/message-rows.ts::rendersNothing`（只附文件的消息
    也必须占行）、`ui/components/FileIcon.tsx`（面板行 / 输入区 chip / 气泡 chip 共用一张图标表）。
  - 用例：电脑侧 `src/tests/bridge/phone-file-refs.test.ts`（投影 / 端到端落块 / 拒整条 + 审计 / 能力声明）；
    共享包 `tests/message-files.test.ts`（校验与归一）；手机端 `src/tests/files-ref.test.ts`
    （纯函数 + 行模型 + 面板→chip→电脑侧收到 + 旧电脑端不显示入口）。
- **依赖形态（2026-10 起）**：`virlen-remote` 在 `virlen-app` 与 `virlen-mobile` 里都是 **`link:../virlen-remote`**（本地仓库 `C:\code\virlen\virlen-remote`）。
  ⚠️ 改完该仓库的 `src` 必须 **`pnpm build`**（`scripts/build.mjs` 生成 `dist`）—— 两端 import 的是 `dist`，不重建就会「源码改了、行为没变」。改协议（方法表 / DTO / 能力名）时两端要一起对齐。
  发版时：把本地改动推回上游仓库 → 按 `prepublishOnly`（`typecheck && test && build`）发版 → 两端依赖改回版本号。
- 测试：`src/tests/bridge/*`（memory transport）与 `src/tests/ui/phone-control-*`。
- **设计文档未落地**：`src/` 内 16 个文件引用 `docs/phone-control-bridge.md` 的 §号（§16.2 / §25 / §27 / §30 …），但该文件不存在；读到时不要当成已有资料。

---

## 6. 铁律（改代码前必读，违反将导致行为分叉 / 静默失效）

1. **引擎语义只在 Rust，但被回调的 TS 须同语义**：聊天循环 / 工具执行 / 压缩 / 标题全在 `src-tauri/virlen-core/src/agent/*`（TS 引擎已移除）。
   改「LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销语义」只需改 Rust；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装 / `AgentEventType` 契约）仍须与 Rust 逐字对齐。
2. **事件契约不可擅自改名**：`AgentEventType` 是四方共享契约（TS 类型 → TS emit → Rust emit → chat-service 处理），新增必须四处一致。
3. **引擎不碰前端 store**：Rust 引擎由 `SessionRepo` 内部直落 SQLite（先落库再 emit），前端只消费 `onEvent` / `agent:event`。
4. **新增 Tauri 命令必须注册**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]`，否则前端 `invoke` 静默 404；涉及权限还要看 `src-tauri/capabilities/default.json`。
5. **工具是「定义 + 执行器」分离注册制，且定义只有一份**：定义在 Rust 侧权威源 `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`；前端 `toolRegistry.register(name, executor, label?)` 只注册执行器与 i18n 文案，读取走异步 `listDefinitions()`。**不要在任何一侧另写定义体**（`src/tests/contracts/tool-defs-contract.test.ts` 守这条线）。
6. **写操作必须先过安全校验**：JS 侧 `securityService.resolveSafePath/isPathAllowed`，Rust 侧 `native_tools::resolve_safe_path / is_path_allowed`，两侧规则必须等价。禁止绕过。
   路径展开（`~` / `%USERPROFILE%`）与 canonicalize 规则**必须共用同一实现**：`src-tauri/virlen-core/src/sandbox/paths.rs::expand_user_path`（前端经 `canonicalize_path` 命令走同一函数）。禁止在任一侧另写一份展开/规范化逻辑，否则黑名单条目会在默认引擎下静默失效。
7. **业务文案走 i18n**：`t('中文')`（中文即 key），变量模板用 `tpl('已删除 $__count__ 个会话', {count})`；新增 UI 文案必须同步 `src/ui/i18n/lang/en-US.json`。
8. **最小改动**：不改动与任务无关的代码；顺手重构要单独说明。
9. **中文注释是本项目风格**：文件头写职责，关键分支写「为什么」而非「做了什么」；同一要点不在同一文件里重复（重复即合并，保留证据：数字 / 文件名 / § 引用）。
   **风险标记 `⚠️` 按分级保留**，三类之外的说明一律不加标记、并压到 1–3 行：
   - **① 安全 / 权限 / fail-closed**：脱壳门禁、只读拒绝、`deny` 优先、密钥红线、fail-closed 兜底；
   - **② 契约与铁律同步义务**：`AgentEventType` 四方契约、铁律 1「改一边必须同步另一边」、逐字一致约束、隐式的成对 / 顺序契约；
   - **③ 跨实现镜像 / 唯一源**：唯一权威源、两份镜像必须同步、禁止再写一份。
   纯实现细节（`#[allow]` 的理由、`cfg` 门禁取舍、估算 / 计数口径、字段可见性、性能取舍）不加标记；已失效的表述（所描述的实现已被移除）直接删掉，不要留着「当时的理由」。
10. **不用 `git push --force`、不重写历史、不动 `dist/`、不删别人的文件**。

---

## 7. 常用命令与验证基线

```bash
pnpm install                 # 依赖安装（首次 / 依赖变更后必须执行）
pnpm dev                     # 仅前端（Vite，端口 1420，strictPort；⚠️ 浏览器模式没有后端，聊天与压缩不可用）
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
6. **是否原生化**：在 `native_tools/mod.rs` 的 `is_native_tool` + `execute_native_tool` 加分派，对应分类目录新建 `<工具>.rs`（复用 `common.rs`）；需要会话库的工具从 `ctx.repo` 取（先看 `is_available()`），需要长期记忆的从 `ctx.memory` 取（同有 `is_available()`），需要安全配置的从 `ctx.security` 取。⚠️ 新增 `NativeToolCtx` 字段要同步改所有构造点（引擎链：`tool_executor` → `llm_loop` / `iteration` → `engine` → GUI `init_agent_engine` / CLI `run`|`tui`）。
7. **测试**：`src/tests/infrastructure/*.test.ts`（JS）；Rust 加内联单测。契约与执行器的名单一致性由 `src/tests/contracts/tool-defs-contract.test.ts` 守（契约里有定义 → 必须有执行器，反之亦然）。

### 9.2 新增 / 修改 Provider、搜索源、Skill

- **LLM Provider**：实现 `IProvider` → `provider/index.ts::createProviderInstance` 注册 → 模板放 `domain/provider/config.ts`。要 Rust 原生支持需在 `agent/provider.rs` 加实现，否则自动走 `BridgedProvider`。
- **搜索源**：实现 `ISearchProvider` → 放 `infrastructure/search-providers/` → `factory.ts` 注册 → 配置存 `SettingsStore.searchProviders`（已下沉 `app_settings`）。⚠️ **若要被默认引擎（Rust）+ CLI 使用，还要在 `src-tauri/virlen-core/src/agent/native_tools/web/web_search.rs` 里加同名分支**（当前只有 `tavily` / `bocha`）——否则该搜索源只在浏览器 dev / JS 执行器路径生效。
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

> **速查级**：每条只留「现象 → 根因 → 结论 / 改哪里」。专项细节在各自文档里（PTY `docs/pty-research.md`、TUI `docs/cli-tui-plan.md`、托盘 `src-tauri/src/tray/`、Rust 引擎 `docs/rust-engine.md`）；本节被压掉的长篇叙述与实验记录见 git 历史（`git log -p docs/AGENTS.md`）。

**11.1 PowerShell 5.1 按本地代码页（GBK）读文件** —— 看含中文的源码会乱码：读加 `-Encoding UTF8`；写统一用 `write_file` / `edit_file`（UTF-8）。

**11.2 本机沙盒的已知限制（环境行为，不是代码 bug）** —— `vitest` / `vite build` / `jest` / `node-gyp` / `child_process.exec*` 因 `esbuild` 子进程 `spawn EPERM` 跑不了。根因：libuv 给 spawn 的 stdio 建的是**命名管道**（NPFS 内置 SD 无 restricting SID 写 ACE → 受限令牌第二遍检查 `ACCESS_DENIED`）；**匿名管道不受影响**（python `subprocess(capture_output=True)`、`cargo`→`rustc` 均正常）。
退路：`execute_command` / `execute_script` 传 `sandbox:"off"`（按「沙盒脱壳」权限授权，`readonly` 拒绝）；不想每次授权就配「设置 → 安全 → 忽略沙盒命令」（命中即自动无沙盒，见 §5.4）。临时关闭：`VIRLEN_SANDBOX=off|readonly|on`（由 **Virlen 进程**读取，命令里 `set` 无效）。另：`node_modules` 可能不完整，先 `pnpm install` 再判错。

**11.3 版本号分散在 7 个文件 / 10 处，靠手动同步** —— `package.json`、`src-tauri/Cargo.toml`、`virlen-core|virlen-cli/Cargo.toml`、`src-tauri/tauri.conf.json`（**打包与 MSIX 实际读它**）、`Cargo.lock` 的三个本包条目、README ×2。用 `pnpm update`（`scripts/update-version.mjs` 已覆盖全部，`--dry-run` 可预览）。

**11.4 README ×2 需同步维护**（`README.md` / `README-CN.md`）—— 改工具数量、测试目录（`src/tests/`）、技术栈版本时最容易漂移。

**11.5 前端工程四条** —— `vite.config.ts` 的 `optimizeDeps.exclude: ['monaco-editor']` **不可去掉**（否则 monaco 打成多份实例、注册表互相隔离）；Vite 端口固定 1420（`strictPort`），`tauri dev` 会因占用失败；`tsconfig.json` 是 `strict: true` 但 `strictNullChecks: false`、`noUnusedLocals/Parameters: false`（别名 `@/*` → `src/*`，Vitest 另配一份）；Run Snapshot 只存内存、刷新即失效，用户取消**不算错误**（要保留 partial 内容，见 `docs/rust-engine.md`）。

**11.7 Windows `execute_command` 走 ConPTY（伪控制台）** —— stdout / stderr **合并为一条 VT 流**，`uiData.pty = true`（前端用 xterm 渲染，非 PTY 才回落 `<pre>`）；完整背景见 `docs/pty-research.md`。
- 给模型看的文本必须过 `process_terminal_output`（完整吞掉 ECMA-48 转义序列，**Rust / TS 两侧必须同步**）；**不要再假设子进程 stdio 是管道**。
- 交互走 Tauri 命令 `pty_write` / `pty_resize` / `pty_key`（**不经引擎事件总线**）。两条红线：用户输入正文**不回灌**给模型；终端内确认的命令**仍走沙盒 + 同一条执行路径**。
- 缺口：常驻交互 shell（Step 3）未做；Unix PTY 未实现（`runner/pty.rs` 整体 Windows 门禁，见 §11.31）。

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
1. **无前端 = 无 JS 桥** —— 31 个工具全部原生，但 `security` **必须**下发 `Some(..)`（`tool_executor` 靠它决定原生 or 走桥，缺了会去等一个不存在的 JS 宿主而**永久挂起**）；`BridgedProvider`（Gemini 等）在**装配阶段**直接报错。
2. **交互一律 fail-closed** —— `run.rs::ask_user` 只在 stdin 是 TTY 时提示并读一行（`y`/`yes` 放行），否则回 `{__kind:"cancelled"}`（一行命令都不跑）。⚠️ **只重定向 stdout/stderr 时 stdin 仍是终端** → 会按交互模式等输入（看着像卡住）——要么连 stdin 一起重定向，要么把权限改成 allow/deny。
3. **桌面端存 localStorage 的白/黑名单、跳过目录 CLI 读不到**（按空处理）—— 路径安全只由「工作目录 + 沙盒 + 权限三态」兜底；反过来 `permissions` / `sandboxMode` / `sandboxIgnoreRules` 都在 `app_settings`，CLI 与桌面端天然一致。
4. **会话的工作目录创建后不可变更** —— 续跑只认会话记录，`--workspace` 与之不同直接报错；记录为空才按 `--workspace` → `defaultWorkspace` → cwd 回退，且**不写回会话**（`resources.rs::resolve_workspace`，纯函数有单测）。⚠️ 它同时决定工具 cwd / 沙箱可写根 / 提示词里的工作目录 / `AGENTS.md` 注入点 —— 曾经取 cwd 并写回会话 = 模型在另一个项目里读写（真实 bug；「同一目录的两种写法」判定见 §11.31）。

**11.16 配置下沉进度：localStorage 里还剩哪些「业务数据」** —— CLI / headless 的能力天花板就在这张名单上。
已在 `app_settings`（GUI 与 CLI 共用）：`settings` 全量、`sandboxIgnoreRules`、`searchProviders` / `defaultSearchProviderId`、`agents`。
仍在 localStorage：`virlen-security` 的 `whitelist` / `blacklist` / `skipEachDirs`（路径安全少一半，见 §11.15 第 3 条）；`virlen-skills` 的**启用状态**（技能目录固定为 `<data_dir>/skills`、CLI 自行推导 → `list_skills` 可用，但不知道桌面端勾了哪些）；UI 偏好 / 埋点缓冲 / 更新偏好（无需下沉）。
判断标准一句：**headless 侧的功能要不要它** —— 要就照 `securityRepo` / `agentRepo` 的模板下沉（表为权威 + 内存快照 + 首启迁移 + debounce 落库 + 退出前 flush）。

**11.17 CLI 交互式 TUI（`virlen-cli chat`）** —— 形态（ratatui 内联视口）、Windows「改窗口尺寸 → `os error 233`」硬坑、必须内建的四条措施、线程模型、与 `run` 共用 `session_rt`、验证手法两坑，**完整实测与方案见 `docs/cli-tui-plan.md`**（§3.2 根因 / §3.3 四条措施 / §5 架构）。此处只留必读口径：
- 内联两条硬约束：**高度只能在构造期定死**（`Terminal.viewport` 是私有字段）；固化必须**分块**（一次灌 120 行只落地 20 行）。
- 降级三条触发（stdout / stdin 非终端、连续失败 5 s、`--no-tui`）→ 复用 `run::CliEventSink` 的文本渲染，**不写第二份**。
- ⚠️ 未实测：降级第②条（需人为造终端故障）、macOS / Linux 冒烟、「在桌面端自带终端里跑 `chat`」的双层 PTY。
- 验证时**不要用 `… 2>&1 | Out-String` 之类的管道包装**（stdout 变管道 → 界面「看不见」，曾被误判为环境不支持）。

**11.18 大文件怎么拆（CLI / core 瘦身口径）** —— 口径 = **目录模块 + 测试外移 + 纯搬运**：`foo.rs` → `foo/{mod.rs,<职责>.rs,tests.rs}`，`mod.rs` 只放本模块公共词汇（类型 / 入口 / 命令解析），必要时 `pub(crate) use self::<sub>::*;` 再导出 → **搬了文件，没搬调用点**（`crate::foo::X` 一行都不用改）。`tests.rs` 用 `#[cfg(test)] mod tests;`，测试段整体回退 4 空格，**绝不逐条改测试**；一次只动一个文件，搬完立刻跑门禁（`cargo test --workspace` + `cargo check -p <pkg> --all-targets`）。
- ⚠️ 三个搬运陷阱：① `impl Foo { … }` 是整块，切到多文件要各自补 `impl Foo {` 与 `}`（跨文件 `impl` 合法，**子模块能访问父模块私有字段**，不必放宽字段）；② 多行 `use x::{ … }` 必须整块搬；③ 文件以 `}}` 收尾时外移测试要**少留一个 `}`**。
- **代价（如实标注）**：跨文件使用的东西必须放宽可见性（本次 `pub(crate)` 放宽了 `session_rt::Resources` / `list::AgentLite` 字段、`rag::vector_store::IndexState`、`tui::state::UiState` 的私有方法等）—— 不是设计变差，是把「文件内私有」换成显式 `pub(crate)`。
- 本轮范围与行数对照、代价清单见 `docs/cli-tui-plan.md` §7.3；**还没拆的**：`agent/llm_round.rs` 705、`execute/common/runner/tests.rs` 688、`rag/embedding.rs` 649、`agent/tool_executor.rs` 551、`agent/bridge.rs` 531、`rag/rag_service.rs` 502、`execute_command/tests.rs` 794。

**11.19 conhost 屏底行：光标压在状态行上、输入覆盖状态行（已修）** —— 写到某行**最后一格**会让 conhost 留下「待换行」，在屏底兑现即**整屏上滚一行**（ratatui / crossterm 不知道）→ 正文比模型偏上一行、**光标仍按模型落位**。结论：**任何一行都不能碰到屏的最后一格**，而状态行**又必须把尾巴涂满**（否则变短时上一帧残字留下）→ 用「整帧右留 `RIGHT_MARGIN = 2` + 状态行按 `width_cjk` 算宽」（`·` / `—` 这类**歧义宽度**字符在 CJK 字体下由终端按 2 列推进、ratatui 按 1 列）。⚠️ **剩余风险**：正文含歧义宽度字符仍可能轻微错位、排满的行仍可能上滚，**未做人眼观感确认**。见 `docs/cli-tui-plan.md` §3.5。

**11.20 固化正文中文「每字一个空格」（已修）** —— 固化落到 `draw_lines` 时**逐 cell** 输出、不跳宽字符的 continuation cell。修法 `tui/term.rs::strip_wide_continuations`：把它的 symbol 清成**空串**（⚠️ 必须 `set_symbol("")`，`reset()` 会退回 `" "`）。**绕过**上游 bug；见 §3.6。

**11.21 中文「残影」（一行变短后多出的汉字不消失，已修）** —— `ratatui-core` 的 diff 在「宽字符被窄字符替换」时**不重发第 2 列**（注释假设终端自己处理 —— conhost 不成立）。修法：整帧标 `CellDiffOption::AlwaysUpdate`（每帧完整重画；⚠️ **只画 `[0, 宽 - RIGHT_MARGIN)` 列**，右侧保留列画了就触发 §11.19 的上滚）；连带把状态行分隔符改成 ASCII ` | `。同为**绕过**上游 bug；见 §3.7。

**11.22 工具调用处的「正文重复 / 时序错乱」（已修）** —— 引擎事件顺序：正文增量 → `tool_call` → **收尾帧**（`finalize_assistant_message`，在**工具执行之前**）→ 交互 → `tool_result_created` → 下一轮（**新** `messageId`）。UI 侧根因：旧状态机只记「当前块」而 `ToolStart` 把它置 `None` → 收尾帧被当成新消息又插一块（正文重复）、下一轮增量续写同一块（时序错乱）—— **一个 bug，两个症状**。修法：正文块**按 `messageId` 认**（`assistant_blocks` / `assistant_idx`），增量来源改用 `assistant_message_updated.patch.contentDelta`（**与 `stream_event` 同取会双份正文**）。见 §3.8。

**11.23 续连体验（已落地）** —— 退出打印**完整** session id 与 `virlen-cli chat --session <id>`（状态行的 `short_id` 只有前 8 位，不足以续连）；重连先预览**最近 5 条**（`tui/history.rs`，TUI 与顺序输出共用同一份纯函数）。见 §3.9。

**11.24 评审后的四项修复（`6beb531..f6c0681`）**
- **① 授权面板 fail-open（安全红线）** —— 旧实现把**空白输入**当「允许」，且交互期间按键全落到交互上 → 误触 Enter 即**批准危险命令**。改成**显式二选一** `ConfirmChoice { Deny, Allow }`（默认 `Deny`，`Interaction::new()` 唯一构造入口）：←/↑ 拒绝、→/↓ 允许、Enter 确认高亮项、Esc/Ctrl+C 拒绝，**普通字符（含 `y`/`n`/Backspace）一律不参与**；面板不调 `set_cursor_position`。**交互一律 fail-closed**；见 §3.10。
- **② core 的 `println!` 污染 CLI stdout** —— `vision/mod.rs` 的 7 处 `println!` 会插进 `run --json` 的 JSON Lines → 全改 `eprintln!`，模块头写明「进度日志一律走 stderr」。
- **③ 两条渲染路径的事件配对是隐式契约** —— `run/render.rs` 取 `stream_event.delta`、`tui/sink.rs` 取 `assistant_message_updated.patch.contentDelta`（故意忽略前者以免正文双份），两者都由 `llm_round.rs::flush_stream_state` 成对发出却**没有东西钉住** → 只发一个会让那一侧**静默丢正文**。修法：该函数文档写明 + 回归 `delta_patch_and_stream_event_are_emitted_in_pairs`。
- **④ GUI 壳残留 23 项死依赖** —— `virlen-app/Cargo.toml` 声明了 `rusqlite` / `quickjs_runtime` / `reqwest` 等零使用依赖：**同一 crate 被两个成员声明时特性相加**，任一处改动会**静默**改变另一处构建。已整批删除。
- **仍未闭环**：§11.23 的 TUI 续连预览需真终端复验；`list/group.rs` 与桌面端侧边栏的分组口径差异（Workspace 组名 GUI 取 basename / CLI 用全路径；排序 `localeCompare('zh-CN')` vs 码点序）**本次未动**。

**11.25 `assemble.rs` 注释纠错 + 明确写下「CLI 与 GUI 的提示词差异」** —— 原模块头写着「没有生产调用方」，而 CLI 早就是它的生产调用方（会误导读代码的人）；golden 守的是**组装规则**，**守不住「喂进去的片段」**。定论差异：环境信息 GUI 有**每个工具版本**、CLI 只有 `OS` + 架构；**角色 / 身份 / 性格 / 技能 CLI 不注入**（是「没有数据」而非「另一份实现」）。
- ⚠️ **顺带发现的真缺陷（未修，等拍板）**：`resources.rs::read_project_rules` 返回文件原文、直接当 `PromptParts::project_rules` 传入，而该字段契约是「`build_project_rules_prompt` 的产物」→ CLI 会话的模型**看不到**「项目级要求、与通用说明冲突时以它为准」那段说明。修法是**一行**（改调 `build_project_rules_prompt`），因影响模型行为故**未擅自改**。

**11.26 提示词「跨语言文件耦合」解耦** —— 改前 `virlen-core` 用 `include_str!("../../../../../src/domain/agent/prompts/*.md")`（**Rust 的编译依赖前端目录布局**），且 `verify-prompt.md` 两侧**真分叉**（TS 英文 / Rust 中文）。改后**唯一源** = `src-tauri/virlen-core/src/agent/prompts/*.md`（5 份，`include_str!` 就地引用），前端经 `cmd_agent_prompts` + `prompt-source.ts`（浏览器 / vitest 用 `?raw`）取**同一份**；`verify-prompt.md` 以 TS 英文版合并。⚠️ 未水合时**抛错**而不返回空串（空提示词会静默改变模型行为）。**「文本住哪」与「谁来组装」是两件事** —— 组装逻辑未动。

**11.27 CLI 配置向导 `provider` / `agent` + 供应商目录迁入 core** —— 改前只能 `config set providers '[{…完整 JSON…}]'`：**整键覆盖**（漏一个字段就毁掉现有配置）、写错键名**静默无效**（退出码却 0）。前置：模板表 / 推理档位表搬到 `virlen-core/src/agent/provider/provider_catalog.json`（Rust `include_str!` + 前端 `?raw`，**同一份物理文件**）+ 命令 `cmd_provider_catalog`；core 新增 `agent/provider/models.rs`（**不加进 trait**，否则 `BridgedProvider` 也得陪跑）。CLI 新增 `wizard.rs`（问答原语：默认值 / 可重问 / **密文关回显** / 多选；**EOF 一律报错**）、`settings_edit.rs`（数组键按 id 增删改 + **字段级合并** + 回读校验）、`provider.rs` / `agent.rs`（各 10 步向导 + `list` / `test` / `rm`），写入**只动改到的字段**。
- ⚠️ **刻意不做**：`add` / `edit` 不支持命令行开关（脚本逃生口仍是 `config set`）；**stdin 不是终端 → 直接报用法错误（退出码 2）**，绝不半交互挂住。
- **未闭环**：① **不是乐观锁**（桌面端开着时仍可能整组覆盖，回读校验只能把覆盖变成可见错误）；② `config get` 仍**明文输出 `apiKey`**（新命令 `provider list` 已自行打码，无新增泄漏面）；③ 项目规则文件路径校验仍是 TS / Rust **两份**实现（真准入闸在前端）；④ raw-mode 密文输入只能人眼验。详见 `docs/cli-tui-plan.md` §10。

**11.28 clippy 告警清零 + per-push CI 门禁** —— 改前 `cargo clippy --workspace --all-targets` 有 **77 条**告警（`cargo check` 看不到），且三个 `build-*.yml` 的 test job 不含 clippy。口径：`cargo clippy --fix` 修机械项，设计类逐项处理 —— `too_many_arguments` 加带说明的 `#[allow]`；`type_complexity` 抽 `type` 别名（⚠️ **别名里的 trait object 生命周期必须显式**，否则退化成默认 `'static`）；`large_enum_variant` 把非热路径装箱；doc 缩进类补空行 / 模块头改 `/*! … */`。
- ⚠️ **`cargo clippy --fix` 会引入编译错误**（本次把 `#[cfg(test)]` 挪给新插入的 `impl Default` → 非 test 构建 `E0425`）→ 自动修复后**必须** `cargo check`，不能只看 clippy 退出码。
- 门禁 `.github/workflows/ci.yml`：**每次 push / PR** 单平台（ubuntu）跑 `pnpm build` → `cargo clippy --workspace --all-targets -- -D warnings`。⚠️ **只在 ubuntu 跑** → Windows 专属代码必须显式门禁（§11.31）。

**11.29 CLI 打包并入三个平台的发版 workflow** —— 不新建 workflow，并进三个 `build-*.yml` 的 `build-*` job（复用同一套工具链 / `rust-cache` / `target`）；产物进 **Artifact + 同一 Release**，形态 = **zip**（2026-09-26 由裸二进制改为 zip）。zip 内容：`virlen-cli[.exe]` + `quasivision_models/`（端侧视觉模型 36.9 MB）+ `README.txt`（文案唯一源 `.github/cli-bundle-README.txt`）+（仅 Windows）`DirectML.dll`。**为什么是 zip**：裸二进制不带模型 → `vision_analyze` 只会得到「models directory not found.」；且裸文件在 Artifact / Release 上**不保留可执行位**。
- CI 传三元组用 **`CARGO_BUILD_TARGET` 环境变量**（**不要** `pnpm run … -- --target`，见 §11.31）。
- ⚠️ **目录布局即契约**：`quasivision_models/` 必须与可执行文件**同级**（命中 `CliHost` 资源候选最后一档 `<exe_dir>`）；挪进子目录就等于没带。
- ⚠️ **平台区分命名**：三个 workflow 传的是**同一个 Release**，故 zip 名为 `virlen-cli-windows-x64.zip` / `virlen-cli-linux-x64.zip` / `virlen-cli-macos-arm64.zip`（**不带版本号**，版本由 tag 承载）；Release `files` 必须**显式列**各自的 `.zip`。
- **打包自检**：stage 步骤断言 zip 内必须有 `virlen-cli[.exe]` / `README.txt` / `quasivision_models/ocr-models/ppocrv5_mobile_det.onnx`，并单独拦「多套一层 `quasivision_models/quasivision_models/`」。
- **边界**：aarch64 的 ad-hoc 签名由链接器自动完成（无需 codesign）；macOS 下载后仍有 quarantine（`xattr -d com.apple.quarantine`）；三个 workflow 并发写同一个 Release 是**既有设计**；Linux / macOS 的 `zip` 步骤**本地无法真跑**（本机无 zip 命令），依据是 Info-ZIP 标准语义 + bsdtar 侧验证。

**11.30 上下文压缩下沉 core（`ai` / `raw`）+ `chat` 显示占用 % + `list-session` 两列** —— 压缩原先**只在 TS 侧**（GUI 走 Rust 引擎时也是回调 TS）→「CLI 能用」＝在 Rust 侧**新写一份**（用户拍板落 `virlen-core`，GUI 后来切过来，见 §11.36）。常量与口径：`CONTEXT_WINDOW_TOKENS = 200_000`（**默认值**，实际值取 `app_settings.contextWindowTokens`）、`COMPRESS_MIN_RATIO = 0.4`、`context_tokens()`（`uiData.contextTokens > 0` 优先，否则 `usage.totalTokens`）。
- **三个数不能混**：`usage.totalTokens` = 那次摘要调用**花了多少**（含压缩前全部历史）；`uiData.contextTokens` = 压缩后下一轮请求**上下文多大**（本地估算）；状态行显示后者 / 上下文窗口。
- 落点：core `agent/compress/`（`mod` 模式 / 常量 / 口径 / 切片 · `raw` 正文压缩渲染 · `ai` 非流式 `Provider::chat` + **`tool_choice=auto`**（⚠️ **不能用 `none`**，见下条）），产物是**一条 `role="summary"` 消息**；CLI 执行链 `session_rt/compress.rs`（TUI 与顺序输出模式**都调它**）。**`/compress` 面板字符键一律不参与**（与授权面板同一条 fail-closed 口径）；占用 < 40% 拦下；`Skipped`（提示级）与 `Failed`（报错）**分开**。
- **⚠️ `ai` 摘要请求的 `tool_choice` 必须是 `auto`（2026-10-04 修订）**：服务端对 `tool_choice=none` 的请求**不渲染 tools 段落** → 压缩请求的 prompt 从系统提示词之后**立刻**与聊天请求分歧，自动前缀缓存（DeepSeek / OpenAI）与 GLM 的 `prompt_tokens_details` 永远接不上。实测（同一会话、相距数十秒）：`none` 时压缩只命中 **54.2%**（而且命中的 512 token ≈ 系统提示词那一小段）、输入体量只有聊天的 ~1/8；改 `auto` 后回到 **98%+**、输入体量与聊天同量级。代价（模型真发起工具调用 / 返回空正文）由 `ai::ContractViolation` 护栏兜住 → 命中即**回退 `raw`**（正文本地渲染，避免空正文把历史清空），但那一次调用**照常记账**（`llm` 非空、`mode` 报 `raw`）；`compress-context.md` 也补了「整条回复就是摘要正文，不得调用工具 / 不得空回复」。
- **落库是追加不是替换**（TS 走整表替换；旧消息留在库里，正是 `list_messages` / `read_messages` 的数据源）；`list-session` 两列来自 `SessionRepo::session_stats()`，`--json` 无数据是 `null`，统计失败**不中断列表**。
- **清单保活**：压缩后模型只看得到**最后一个 summary 之后**的消息 → 若「当前活跃清单」落在压缩区间内就会被忘记。对策：把清单**原文**渲染成文本补在 summary 正文末尾（`compress::todo_recap`，复用 `plan::render_todo_content`）；**不搬运 tool 消息**（`tool` 必须紧跟带 `tool_calls` 的 assistant，否则协议报错）；只在快照落在压缩区间内时补。
- **边界**：① 压缩后占用是**本地粗估**（CJK 0.6 token/字符）；② 截断按**码点**、TS 按 UTF-16 码元 → 阈值附近 ±1；③ AI 摘要在 CLI 里**不可取消**；④ `list-session` 表格约 **139 列宽**，窄终端标题列会折行（机器可读请用 `--json`）；⑤ 选择面板的真终端外观与键位**未人工复验**。详见 `docs/cli-tui-plan.md` §11。

**11.31 CI 首次运行暴露的三类失败** —— 上一轮 push 后 `ci.yml` 与三个 `build-*.yml` **首次真正编译 Linux / macOS 目标**。
- **① clippy 在 Ubuntu 上 11 条 `dead-code`**：全是**只在 Windows 才被调用**的 ConPTY 代码（`runner/mod.rs` 的 `PAGER_DISABLED` / `TICK` / `PTY_HOLD_MAX` / `pty_hold_max` / `HOLD_MAX_OVERRIDE_SECS`；`pty_session.rs` 的 `new` / `is_held` / `interventions` / `close_input` / `register` / `unregister` / `CLIENT_SIZE_WAIT` / `initial_size`；`test_util.rs` 的 `is_process_alive`）。修法：前 5 项（连同只服务它们的 `use std::time::Duration`）**逐项 `#[cfg(target_os = "windows")]`**；`pty_session.rs` 用**文件级** `#![cfg_attr(not(target_os = "windows"), allow(dead_code))]`（逐项门禁会连锁到结构体字段 → 新告警）；`is_process_alive` 用平台 `cfg_attr(allow)`。**⚠️ 教训：本地（Windows）clippy 全绿不代表门禁通过**；属性坑：文档列表项后不补空行会触发 `doc_lazy_continuation`。
- **② macOS / Windows 各 1 例测试失败（真 bug）**：`same_path()` 只比字符串，而 `resolve_workspace` 两侧来源不同（`--workspace` 已 canonicalize、会话记录**原样**）→「同一个目录的两种写法」被判成换目录、续跑被无辜拦下（CI 上两种写法恰好都出现：macOS `/var` vs `/private/var`、Windows 8.3 短名 `RUNNER~1` vs 长名）。修法：**两侧各自 `dunce::canonicalize`（失败退回原字符串）**后再比 + 2 条单测。
- **③ Linux 构建 job 的 CLI 步骤直接报错**：`pnpm run build:cli -- --target <triple>` 在 CI 上被 pnpm **连 `--` 一起透传**（cargo 报 `unexpected argument '--target'`），而本机 pnpm 11.2.2 会把 `--` 剥掉 → **同一份 workflow 在本机与 CI 行为不同**。修法：改 `env: CARGO_BUILD_TARGET=<triple>` + `pnpm run build:cli`（语义等价，产物同样落 `target/<triple>/release/`）。
- **④ 续修（同一轮第二次 push）**：core 修完后 ubuntu clippy 才轮到 `virlen-app`，又露出 **3 条同类告警**（全在 `tray/notify.rs`：`show_notification` 的 `session_id` 只在 Windows 分支用；`PACKAGE_APP_ID` 与 `toast_app_id` 的调用方都是 Windows 专属）→ 改成 `#[cfg(target_os = "windows")]`。判据：报错行的 `due to N previous errors` 就是该 target 的**全部**告警数。**教训同①：平台专属项一律显式门禁，两侧都得能编译。**
- **边界**：非 Windows 的编译**本地无法复现**（依据是「clippy 已证明这些项在 Linux 上零引用 → 门禁掉不可能破坏编译」+ 逐项引用点 grep 审计）；`virlen-app` 的 Linux 专属分支（约 7 处）**从未被 clippy 检查过**。

**11.32 启动即崩：UI 模块在模块顶层读了「启动水合」的快照（用户报回 → 已修）** —— 现象：启动报 `Uncaught Error: 供应商目录尚未水合…`，且窗口根本不显示（不是白屏，是压根没 `show()`）。根因：`setupFlow/index.tsx` 模块顶层写了 `providerService.getDefaultProviderList()`，而水合在 `main.ts` 的 `init()` 里，`main.ts` 又**静态导入** `App.tsx` → `App.tsx` 静态导入 `SetupFlow` ⇒ ES 模块求值**先于** `main()`，那一刻快照还是 `null` → fail-fast 抛错 → 整张依赖图求值失败 → 窗口（`visible: false`，只在 `requestAnimationFrame` 里 `show()`）永不显示。
- **为何测试没拦住**：`src/tests/setup.ts` 全局调了 `setProviderCatalog(...)`，把这一刻盖住了（`setPromptTexts` / `setToolDefinitionsLoader` 同理）。
- **判断标准**：`providerCatalog()` / `providerTemplates()` / `reasoningEffortUnion()` / `defaultReasoningEffortList()` / `sortReasoningEfforts()` / `promptText()` / `providerService.getDefaultProviderList()` —— 一律只在函数 / 组件 / 事件回调里调用，**模块顶层 == 未水合**。
- 回归用例 `src/tests/contracts/provider-catalog-contract.test.ts`（用 `vi.resetModules()` 拿一份从未水合过的全新模块图，先断言确实未水合、再导入 UI 模块）；全仓 ts/tsx 扫描确认该 bug 类只此一处。

**11.33 大历史下「暂停 → 继续」要等好几秒（用户报回 → 已修）** —— 根因：一次发送本就带 O(历史) 开销（前端把**整份历史**经 IPC 传给 Rust，Rust 入口又整份 upsert 回 SQLite）；正常发送时这段被「等 LLM」掩盖，而**恢复会跳过 LLM**，于是第一次暴露。改法（两侧配对）：① Rust `send_message_inner` 在 `resume_from_snapshot.is_some()` 时**不再整表回写**；② 恢复时消息**以本地库为权威**读回（`SessionRepo::get_messages`，读失败 / Noop / 为空时回退前端 `messages`），前端 `resumePausedRun` 改传空数组 —— 省掉「序列化整份历史 → IPC → 反序列化」。回归用例 `agent/engine/tests.rs::resume_reads_messages_from_repo`。

**11.34 「暂存 → 继续 → 取消」后残留「已暂停」+ 再次继续 400（用户报回 → 已修）** —— 根因（两处）：① `resume_run` 跑完快照里所有待办步骤后**没有清快照**（`execute_llm_round` 里那次 `clear_snapshot` 只覆盖**普通轮次**）→ 残留快照让 UI 误显示「已暂停」；② `find_next_step` 把 `failed` 也当「未完成」，而 `failed`（被取消 / 出错 / StormBreaker）**已写过一条 tool 结果并落库** → 下次「继续」按残留快照重跑该步骤 → 同一 `tool_call_id` 产出第二条 tool 结果 → 服务端 400。改法：① `resume_run` 在 `completed` 后 `clear_snapshot`；② `find_next_step` 只把 `pending | running` 当作断点。回归用例 `resume_completing_steps_clears_snapshot` / `find_next_step_skips_failed*`。

**11.35 恢复读回「上下文」而非整份历史** —— 承接 §11.33：恢复改由引擎读库后，仍把**整份历史**读进内存，而请求组装（`provider::blocks::slice_messages`）本就**丢掉最后一个 `summary` 之前的全部消息**。改法：新增 `SessionRepo::get_context_messages` —— 一条查询 `rowid >= IFNULL((SELECT MAX(rowid) … role='summary'), 0)` 取「最后一个 `summary` 及其之后」，`engine.rs` 恢复路径改用它。**不要踩**：旧消息**仍留在库里**（供 `list_messages` / `read_messages` 检索「已压缩区间」），本改动只影响「回读进内存的上下文」，语义不变；本轮**仅覆盖 Rust 恢复路径**（前端发送路径 / CLI 由 §11.36 补齐）。回归用例 `context_messages_*` / `resume_reads_context_from_last_summary`。

**11.36 「只加载到最后一个 summary」贯通：前端发送路径 + GUI 压缩切 Rust**
- **① 前端发送路径也只读「最后 summary 之后」**：`sessionStore.ensureContextLoaded` 从尾部连续加载、**一旦加载窗口里出现 summary 就停**（无 summary 时退化为全量加载）；`prepareMessagesForSend` 只把 `messages.slice(最后一条 summary 的下标)` 交给引擎。**修复回写改为「后缀替换」**：新增命令 `cmd_replace_session_messages_from`（`SessionRepo::replace_messages_from`：DELETE `rowid >= 目标` + 重写后缀，**同一事务**），原 `pendingRepairFlush` **删除** —— 内存消息列表**恒为连续后缀**，按 `messages[0].id` 做后缀替换永远安全。
  - ⚠️ 不要踩：`append_messages` 是 upsert（不删行），**不能**用它在后缀里补占位 tool 消息 —— 它把新行追加到 rowid 末尾，破坏「tool 紧跟 assistant(tool_calls)」的协议顺序；必须用 `replace_messages_from`（或全量 `replace_messages`）。
- **② GUI 上下文压缩切到 Rust（与 CLI 统一成一份）**：新增命令 `cmd_compress_context`（内部调 `virlen_core::agent::compress`，与 CLI `session_rt/compress.rs` **同一份实现**）；`ai` 模式用 `DefaultProviderFactory`（GUI 有 JS 宿主，gemini 走桥），`raw` 无需 provider；**记账在 Rust**（`agent::usage::record_usage`，kind=`compress`）、**落库仍在前端**（`cmd_replace_session_messages`）。
  - ⚠️ **摘要请求的 `max_tokens` 必须钳上限**：GUI 会话的 `params.maxTokens` 默认是 `2000000`（语义「不限制输出」），Rust 摘要若原样写进请求体会被模型以 `Invalid max_tokens value`（400）拒掉 → `compress::ai::summary_max_tokens` 把会话值钳到 `(0, DEFAULT_SUMMARY_MAX_TOKENS]`。回归 `summary_max_tokens_caps_absurd_session_values`。

**11.37 移除 TS 引擎：引擎统一为 Rust** —— 背景：CLI 把大量原在前端的逻辑搬进 `virlen-core` 后，「双引擎」（`src/domain/engine/*` ↔ `virlen-core/src/agent/*`）变成纯负担 —— 同一套语义两份实现，改一边就得同步另一边。
- **改动**：① core 新增 `agent/title.rs`（AI 标题生成，逐字对齐原 TS `generate-title.ts`）；② `ChatRequest` 增加 `thinking: Option<bool>`（openai / anthropic / bridged 三处落请求体）；③ 删 `src/domain/engine/**`（14 文件）与 9 个只测 TS 引擎内部的 vitest 文件；④ 共享契约类型迁到 `src/domain/ports/engine.ts`；⑤ `getEngine()` / `getCompressEngine()` 恒返回 `services/rust-engine.ts`；⑥ 删 `useRustEngine` 设置项 / UI 开关 / 埋点分支。
- **仍然保留的 TS 部分**（Rust 会回调，必须与 Rust 同语义）：工具执行器（`agent:tool-request`）、Gemini provider（`agent:provider-request`）、系统提示词组装、`AgentEventType` 契约、各类水合适配器。
- **不要踩**：① 非 Tauri（浏览器 `pnpm dev` / vitest）**没有可用的聊天引擎**（引擎行为一律以 Rust 侧测试为准）；② 删 TS 引擎时**必须同时删引用它的测试**（`tsc` 覆盖 `src/tests`）；③ 原 TS 版「标题禁用思考」的能力**不能丢**（否则推理模型上 40 token 被 reasoning 吃掉、标题只能回退首行）—— 这正是 `thinking` 字段存在的原因。
- 回归用例：Rust `agent::title`（8 例）、`agent::provider::tests::{openai,anthropic}_thinking_*`。

**11.38 输入框右键菜单：受控控件的值必须走「原生 setter + input 事件」** —— 自绘窗口全局禁用了浏览器原生右键菜单（`WindowLayout`），而输入框的原生菜单里恰好全是常用操作（剪切/复制/粘贴/全选）→ 只能自补：菜单项工厂 `ui/components/shared/ContextMenu/editable.ts::editableMenuItems`，目前接线在聊天输入框 `input/index.tsx`。
- **值怎么改**：项目输入框全是 React 受控，直接 `el.value = next` 会被下次渲染写回旧值。正确姿势 = 用**原型上的**原生 setter 改值（React 会在节点实例上包一层 value 存取器做变更追踪，原型 setter 恰好绕过它）+ 派发 `input` 事件让 `onChange` 收到 → state 与 DOM 一起前进。⚠️ **不要**用 `document.execCommand('insertText')`（jsdom 里不存在，新老 WebView2 行为也不一）。光标要在派发事件**之前**摆好 —— 受控组件的 `onChange` 常顺手记 `selectionStart`。
- **焦点与选区**：菜单项是 `<button>`，mousedown 就把输入框的焦点抢走了 → 每个动作都先按「打开菜单那一刻的选区」复原（`focusWithSelection`；顺序必须是先 `focus()` 再 `setSelectionRange()`，反了会被浏览器自己的选区记忆覆盖）。
- **边界**：右键「粘贴」只处理文本（读剪贴板走 `read_clipboard_text`，与 §11.9 的文件路径读取同一套原生链路）；剪贴板里是图片 / 文件时**静默不动** —— 那两种仍走 Ctrl+V 的专属链路（`input/use-input-handlers.ts::handlePaste`）。**不做「撤销」**：`replaceValue` 会截断原生撤销栈，做了也是假的，真撤销请用 Ctrl+Z。
- 回归用例：`src/tests/ui/input-context-menu.test.tsx`（工厂 / 接线 / 受控同步）、`src/tests/utils/clipboard.test.ts` 的 `readClipboardText`。

**11.39 CLI 补齐会话管理 / 用量账本 / `chat` 选项对齐（2026-09-30）** —— 起因：体检发现 CLI 的**能力缺口** —— core 已有、CLI 一个入口都没接线的：`session_db` 的 `delete_session` / `purge_orphan_messages` / `search_messages`，账本的 `usage_stats` / `usage_records`；另 `chat` 比 `run` 少 `--model` / `--provider` / `--no-tools`，TUI 里换模型只能退出重来。
- **新增 `session <show|search|rm|purge>`**（`src-tauri/virlen-cli/src/session.rs` + 同目录 `tests.rs`）：`show <id> [--messages N] [--json]` 出会话元信息（**从未拿到用量数据时上下文列显示 `-（从未拿到用量数据）`，不是 0%**）/ `search <关键词> [--session <id>] [--limit N] [--json]` 检索**消息正文**（默认只 user / assistant，与桌面端检索一致）/ `rm <id> [--yes]` / `purge [--yes]`。
- ⚠️ **「筛列表」与「检索正文」是两条路**：`list-session -s|--search` 只筛**会话元数据**（标题 / 工作目录 / Agent / id），正文检索走 `session search` —— 两处帮助文本都写死这条分工（否则用户会以为 `--search` 能搜消息内容）。
- **fail-closed 红线**：`rm` / `purge` 在 **stdin 不是终端**且没给 `--yes` 时直接 `EXIT_USAGE`（2），**不读 stdin 干等**；判定抽成纯函数 `needs_yes_gate(yes, interactive)` —— 真路径要读 stdin，会挂住单测。
- **`purge` 的诚实口径**：`open_session_db` 本身就会 spawn 一次后台回收，故「确有孤儿可回收」在真端到端里**造不出确定性场景**（会 flaky）→ 测试只断言「正常情况下恒为 0 条」，非 0 分支靠纯函数 `purge_line(n)` 覆盖；`purge` 命令显式 **await** 那次回收（短命进程里后台任务可能来不及跑完）。
- **新增 `usage`**（`src-tauri/virlen-cli/src/usage.rs` + `tests.rs`）：`--session/--model/--kind/--since/--until/--group-by/--records/--limit/--json`；`--since/--until` 收 `YYYY-MM-DD`（本地时区，`--until` 取当日 `23:59:59.999`）或毫秒时间戳；`--group-by` / `--kind` 走**白名单** —— core 的 `usage_group_expr` 对认不出的维度**静默退回 day**，不挡就会让用户看着「按模型」的表得出按天分桶的结论。
- ⚠️ **只报 token，不报钱**（既有约定：价目表在前端 TS，见 §5.3）：CLI **不抄**第二份价格表，stderr 指路「费用请在桌面端看」，JSON 带 `"costIncluded": false`。
- **`chat` 对齐 `run` + TUI `/model`**：`ChatOptions` 增 `--provider <id>` / `--model <id>` / `--no-tools`（复用 `RunOptions` 装配链）；新增斜杠命令 `/model [<id>]` —— 不带参数列「当前（打 `*`）+ 可选」清单，带参数走 `session_rt::switch_model`（**校验 → 改内存 → `upsert_session` 落库**；模型不在该 Provider 的列表里就**报错并给出可选清单，绝不静默换**；重复设同一模型幂等）。TUI 与顺序输出模式两条路径都接（⚠️ 避免在 match scrutinee 里 await —— 会延长临时变量生命周期，先把结果取出再 match）。
- **顺带去重**：`tui/sink.rs` 的 `text_of` 改为 `session_rt::message_text` 的**再导出别名**（`pub(crate) use`），消除同 crate 两份实现，调用点与既有测试不动。
- 门禁：`cargo test -p virlen-cli` **200 → 232 passed**、`cargo clippy -p virlen-cli --all-targets -- -D warnings` = 0；真二进制冒烟（临时 `VIRLEN_DATA_DIR`，不碰真实库）逐项过 —— `/model` 清单与切换、`session show/search/rm/purge`、`usage` 空态 / 日期过滤 / `--group-by minute` 被白名单挡成 exit=2。

**11.40 提示词缓存（2026-10-04）：压缩请求的 `tool_choice` + Anthropic 显式断点** —— 起因：体检发现「AI 压缩不吃缓存」（同一会话：chat 命中 98.7%、`compress` 仅 3.0%）。
- **根因 ①（OpenAI 兼容协议）**：`ai` 压缩请求用 `tool_choice: "none"` 表达「禁止模型调工具」，而服务端对 `none` 的请求**不渲染 tools 段落** → 压缩请求的 prompt 从**系统提示词之后立刻**与聊天请求分歧，自动前缀缓存（DeepSeek / OpenAI）与 GLM 的 `prompt_tokens_details` 永远接不上。改法：与聊天请求**同构**（`tool_choice: "auto"` + 照常下发 `tools`），代价用 `ai::ContractViolation` 护栏兜（工具调用 / 空正文 → **回退 `raw`**，但那一次调用**照常记账**，`llm` 非空而 `mode` 报 `raw`）。实测：压缩命中 54.2% → **98%+**。详见 §11.30。
- **根因 ②（Anthropic）**：其前缀缓存**不自动生效** —— 不显式打断点，`cache_read_input_tokens` **恒为 0**（`provider/anthropic.rs` 过去只**读**该字段、从不写；全仓库 + 全 git 历史 `cache_control` 出现 **0** 次）。改法：`provider/anthropic.rs::build_request` 打 3 个显式断点（官方上限 4 个）—— ① 最后一个工具定义（纯静态，跨会话只要工具集相同就能复用）② `system` 改成**带断点的文本块数组**（覆盖「工具 + 系统提示词」这整段静态头部）③ 最后一条消息的最后一个**可缓存块**（对话前缀随轮次前移，即官方顶级 `cache_control` 自动缓存的手动等价实现）。
- ⚠️ **块类型白名单**（`CACHEABLE_BLOCK_TYPES` = `text` / `image` / `tool_use` / `tool_result` / `document`）：类型不对会被服务端**直接 400 掉整个请求** —— 「顺手省钱的优化」绝不能变成「聊天打不开」；`thinking` 不在白名单，**空 / 全空白文本块也不挂**（块类型对但内容为空时本就在接受边缘）。找不到可缓存块就**少打一个断点**，不是错误。
- ⚠️ **未达标不报错**：前缀不足最小长度（多数模型 1024 token，部分 Haiku/Opus 型号更高）时服务端**静默跳过**，所以可以无脑打；写入按段**增量**计费（1.25x），命中 0.1x，5 分钟 TTL。
- **只改 Rust、不同步 TS**：`src/infrastructure/provider/anthropic.ts` 的 `buildRequest` 已**不在对话路径上**（anthropic 恒为原生 Provider，见 `DefaultProviderFactory`），只在 vitest 里跑；两边都实现等于把「断点位置策略」变成两份要同步的状态（与 §11.37 同一口径）。
- **测试**：`provider/tests.rs` 的 `anthropic_marks_three_cache_breakpoints`（三处落点 + 只有末尾工具 / 末尾块带 + 总数 3 ≤ 4）、`anthropic_breakpoints_degrade_when_parts_are_missing`（缺工具 / 缺 system / 末尾不可缓存）、`mark_tail_block_only_touches_whitelisted_non_empty_blocks`（白名单 + 空文本 + 空数组不 panic）。
- ⚠️ **记账口径的缺口（缓存写入 1.25x 被当 0.1x 计价）已修** —— 见 §11.41。

**11.41 账本把「缓存写入」独立成列（2026-10-04，承接 §11.40 ②）** —— 起因：Anthropic 的 cache **读**按 0.1x 输入价、**写**按 1.25x，而账本只有一个 `cached_tokens` 列 → 写入被按命中价计，**该桶低估约 12.5 倍**（只有在缓存真打上断点之后才会踩到）。
- **Rust**：`types::TokenUsage` 增 `cache_write_tokens: Option<i64>`（`anthropic.rs` 的 `parse_response` 与流式 `message_delta` 把 `cache_read` / `cache_creation` **分别**入列，不再相加）；`agent/usage.rs::ledger_tokens` 增 `LedgerTokens.cache_write_tokens` —— 不变式改为 `prompt + cached + cache_write + completion === total`，且「缓存含在 prompt 里」的 provider（OpenAI 兼容 / Gemini）把读 + 写**一起**从 prompt 扣掉，推导分支也要扣掉已回报的写入量；`session_db/usage.rs` 的 `UsageEntry` / `UsageBucket` / `UsageRecord` + 写入与两处聚合 SQL + 明细 SELECT 全部加该列。
- **迁移**：新库由 DDL 直接建出；老库走 `schema.rs::ensure_usage_cache_write_column`（与 `duration_ms` 同策略：**元数据级 ALTER**，带默认值、不重写表，放在 `init_schema` 快速路径，**不占 `SCHEMA_VERSION`**）。⚠️ 旧流水补出来恒为 0 —— 历史数据已经分不开读 / 写，只能不计写入费（略偏低，但不会算错）。
- **TS**：`types::TokenUsage` / `domain/usage`（`ledgerTokensOf` 镜像）/ `statsRepo` / `token-stats-service`（明细 + 聚合 + CSV）全部加 `cacheWriteTokens`；`domain/pricing` 的 `ModelPrice` 加 `cacheWrite`（**缺省回退输入价**：宁可高估 20%，也不能按命中价低估 92%）、`BillableTokens` / `TokenCost` / `computeCost` 同步；7 条 Anthropic 内置价按官方规则填 `cacheWrite = 1.25 × input`。
- **UI**：token-stats 的堆叠柱 / 折线加第 4 个系列（不画的话堆叠高度会小于「合计」）、tooltip、饼图的「按 Token 类型」、卡片、明细列（`CacheW`）与汇总条；中英双语文案「缓存写入 / Cache write」。
- **CLI**：`usage` 的聚合表加 `cacheW` 列（四段之和才等于 `total`；明细仍靠 `--json` 看全字段）。
- ⚠️ **仍未覆盖**：OpenAI 系（GPT-5.6+）官方对缓存写入也收 1.25x，但**用量接口不回报写入 token 数**（含在 `prompt_tokens` 里）→ 没量可乘，这类模型费用略偏低（写入那段少算 25%）；Anthropic 的 1 小时 TTL 写入价是 2x，本项目只打 5 分钟断点、也只填 1.25x。详见 `docs/token-usage-stats.md` §10。
- **测试**：`agent::usage` 3 条（读 / 写拆分、推导分支扣写入、非 Anthropic 恒 0）、`session_db::tests::usage` 1 条（分列落库 + 分列聚合 + 不变式）、`pricing.test.ts` 4 条（写入价 / 缺省回退 / 12.5 倍关系 / 内置价 = 1.25×input）、`usage-ledger.test.ts` 2 条（Anthropic 读 / 写分列、推导扣写入）。

**11.42 手机端文件面板：条目一多，面包屑被挤成一条缝（用户报回 → 已修）** —— 现象：目录里条目多了之后，面板顶部的面包屑只剩「一点点」（文字被截去大半），想回上一级得先滚回顶部。
- 根因：面包屑是 `.sheet__body`（`flex` 列 + `overflow-y: auto`）的子项，而它自己写了 `overflow-x: auto` —— 这会让 `overflow-y` **也算成 `auto`**，于是它是一个**滚动容器**；**滚动容器的自动最小高度是 0**，所以内容装不下时，收缩量（`flex-shrink`）几乎全落到它头上（其余子项 `overflow` 可见，最小高度 = 内容高度，压不动）。
- 结论：**flex 列里凡自带滚动的子项（`overflow: auto/hidden/scroll`），都必须自己声明 `flex: none`（或 `flex-shrink: 0`）**；判断时别只看有没有写 `overflow-y` —— 写了 `overflow-x: auto` 就已经是滚动容器了。
- 顺带改成 `position: sticky; top: 0` 常驻面板顶部。⚠️ sticky 的代价：**必须自己铺一层与 `.sheet` 同色的背景**（否则列表行从它背后滚过时直接「叠字」），再用 `padding-bottom: 14px` + `margin-bottom: -12px` 盖住 `.sheet__body` 的 12px 间距而不改视觉间距。
- 落地与守卫：`virlen-mobile/src/ui/components/FileSheet.css`；**`jsdom` 不做布局，这类缺陷在 DOM 断言里根本看不见**（元素在、文案在、click 也照旧触发），所以守卫用例直接读样式表 —— `files-ui.test.ts` 的「文件面板的布局契约」（钉 `flex: none`，并比对面包屑底色与 `.sheet` 底色**同色**）。

**11.43 手机端文件面板：进目录时把列表换成一行提示 = 高度先塌再撑的「闪一下」（用户报回 → 已修）** —— 现象：点进一个子目录，界面明显闪动一下。
- 根因：`fileStore.load()` **并没有**清 `entries`（上一份列表还在 state 里），是**渲染**把它换成了单行提示（`loading ? hint : list`）；面板高度是内容撑的，于是「塌 → 撑」两下。
- 结论：**加载中保留上一份内容，等应答回来直接替换**；加载提示放在**既不占高度、也不随内容滚**的地方（这里是标题栏下方的绝对定位胶囊，定位父级 `.sheet__head` 因此加了 `position: relative`）。首屏（还没有上一份列表）保持原样给一行提示。
- 顺带一条：在途时旧行本来就是 `disabled`（`isBusy()` 含 `loading`），所以「旧列表点不动」**不用额外做** —— 但**新增行内交互时得自己走 `busy`**，否则就是拿旧目录的条目发新请求。
- 守卫（`files-ui.test.ts`）：把电脑侧的列目录**拖慢 40ms**，点进去后**不等应答**就地断言「行数不变 + 出现加载提示」，再等应答验「整体替换」。不拖慢是测不到的 —— 内存链路会在同一次 `act` 里就答完。

**11.44 手机端编辑电脑上的文件：三个「存回去就把文件搞坏」的坑（§37 覆写保存）** ——
1. **换行**：`<textarea>` 的 value 只有 LF（HTML 规范），而 Windows 源码大多 CRLF ——
   照 LF 存回去 = 在「只改三个字符」的改动里混进一次**全文行尾改写**（diff 满屏红）。修法：
   先 `detectEolStyle` 记住原风格（按多数判），保存时 `encodeEditedText` 还原；而且必须
   **先拉平再铺**（`applyEolStyle`），只做 `\n → \r\n` 会把已有的 CRLF 变成 `\r\r\n`
   = 「保存一次多出一堆空行」。
2. **编码**：宽容解码（GBK 中文注释）看着能用，**存回去就是毁文件**（原本在电脑上还能正常看，
   之后连电脑上也读不回来了）→ `decodeUtf8Strict` 返回 `null` 就不给编辑入口，只说「请在电脑上改」。
3. **并发**：从手机上打开到按保存之间，电脑上的 AI / 用户 / 编辑器都可能写过它 → 必须带
   `expectMtimeMs` 校验（且 `finish` 落盘前**再来一次**），否则那些改动被**静默吞掉**且用户毫无察觉。
   「强制覆盖」= 先取一次当前版本再写，**不是盲写**。

**11.45 共享包契约的四个坑（文件引用 §37 落地时踩到的，前两条是跨仓通用的）**：
1. **`strictNullChecks: false` 会让布尔字面量的判别联合彻底无法收窄** —— `virlen-app` 的 tsconfig 是
   `strict: true` 但 **`strictNullChecks: false`**，于是共享包里写成
   `type R = { ok: true; files } | { ok: false; reason }` 之后，电脑侧那句
   `if (!r.ok) { …r.reason… }` 直接 **TS2339：`reason` 不存在于 `R`**（两边的分支都收窄不了，
   连 `return r.reason` 也不给过）。**契约放在共享包里就不能只在一边成立** → 改成
   `{ ok: boolean; files; reason: string }`（不变式：`ok === (reason === '')`），消费方不需要收窄。
   证据：临时探针文件在 `virlen-app` 里跑 `tsc --noEmit` 复现（见 `message-files.ts` 的 `FileRefSanitizeResult`）。
2. **「静默丢掉一条」比报错难查得多（假绿灯）** —— 手机端的 chip 由**手机端自己**渲染，电脑侧把
   非法条目删掉之后**一切照旧成功**：用户看到 chip 在、消息里也有，而 AI 从未看到那个文件。
   所以形状非法一律**拒整条**（`E_BAD_REQUEST`）+ 审计留痕。同一条纪律在 §36 引用、
   §22 压缩方式上都出现过：**宁可不让发，也不要发一个「看起来成了」的**。
3. **`[文件] …` 展平占位符丢了路径** —— `dto.ts::projectContentToText` 原本把文件块投影成
   `[文件] ${block.name ?? block.path}`：**只有名字**（同一目录下两个 `index.ts` 手机上分不出）、
   没有体积、也无法回显。所以拿了 §36 的同一条做法（结构化下行 + `skipQuotes` / `skipFiles`
   两个开关），⚠️ 但**两个开关都必须默认关**：`store-bridge` 的消息指纹故意不跳，
   否则「换了个附件」不会触发任何下行更新（手机端停在旧 chip 上）。
4. **「只附文件不写话」是一条完全正常的消息** —— 行模型 `rendersNothing` 只看正文的话会把它
   当成「什么都渲染不出来」而**不占行**（用户亲眼看自己发的那条不见了）。判据必须与 `MessageRow`
   的 `return null` 分支一致，且**每次新增一类结构化附件（引用 / 文件 / 以后还会有）都要回去改它**。

**11.46 手机端「默认打开第一个会话」= 默认打开【置顶】的那个（用户报回 → 已修）** ——
现象：每次打开（刷新 / 重连后重进）手机端都跑到一个**几天没动**的会话里，而最近在用的那个要手工去抽屉里选。
根因不在「默认打开第一个」这句，而在**那个「第一个」是谁**：电脑侧的会话列表是
`sessionStore.listSessions()` 排的「**置顶优先** → `updatedAt` 倒序」，所以 `sessions[0]` 是**置顶**项，
而不是最近用过的项（`virlen-mobile/src/ui/pages/Chat.tsx` 挂载 effect 里那句 `snap.sessions[0].id`）。
口径（用户拍板）：**正在工作的会话优先**（`SessionSummaryDTO.working === true`，电脑侧权威；多个则取其中
`updatedAt` 最大的），**否则取 `updatedAt` 最大的**；**置顶不参与这个选择** —— 置顶的意思是「别让它被淹没」，
不是「每次进来都回到它」。实现收在纯函数 `lib/session-entry.ts::pickEntrySession`（可单测）。
连带三条（都会踩）：
1. **列表顺序不能动**（手机端不得重排）：抽屉 / 分组 / 「组内顺序 = 电脑侧给的顺序」全靠它
   （`lib/session-groups.ts`）—— 要改「默认进哪个」只能在**这个纯函数里**自己比 `updatedAt`，不要顺手 sort 全表。
2. **必须保留「已有当前会话就不切」的守卫**：这个挂载 effect 不只跑在首屏，链路抖动 / 代际更替后重新挂载
   （`App.tsx` 在 `status !== 'online'` 时把整页换成 `Login`）也会跑它 —— 少了守卫，用户正看着的会话会被
   自己顶掉；那条路上真正该做的只是重拉（`chatStore.resync`）。
3. **`working` 是电脑侧给的快照事实**（`toSessionSummaryDTO` 取 `sessionRuntimeState`），所以「工作中优先」
   在**进入那一刻**就成立，不需要额外 RPC；但它也只是那一刻的事实 —— **不做轮询、不做自动跳转**
   （「某个会话开始工作了就自动切过去」会把用户正在读的内容换掉，且用户没有任何办法关掉它）。
回归：`virlen-mobile/src/tests/session-entry.test.ts`（纯函数 8 例 + DOM 端到端 4 例；后者在改回
`sessions[0]` 的实现下会红 —— 已实测）。演示宿主 `?entry=pin` / `?entry=work`（`src/dev/host-harness.ts`）
把「置顶但更旧」与「另一个会话正在工作」这两种真机形态造出来，真机/联调都能一眼看到标题换没换。

**11.47 「user_choice 过一会再回答」报 400（`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）（用户报回 → 已修）** —— 复现路径：**工具弹窗 → 点「暂存」→ 过一会点「继续」→ 再回答**。
根因：**同一份 Run Snapshot 被并发恢复两次，导致同一步重跑、同一 `tool_call_id` 产出两条 tool 结果**（正是 §11.34 记的那个 400，但那条堵的是「残留快照重跑」，这条是**并发重入**）。两道缺口：
1. 前端 `services/chat/flow.ts::resumePausedRun` 的忙判据非原子 —— `isSessionActivelyWorking()` 检查后，中间隔了 `await getEngine().getRunSnapshot()` 才设 `working:true`；桌面 + 手机（或重复触发）会**都**通过检查、各拿同一份快照跑一次。
2. 引擎 `Engine::send_message` 对同一 `session_id` **没有并发闸** —— `active_cancels.insert` 是覆盖而非拒绝（`engine/tests.rs::concurrent_resume_of_same_snapshot_duplicates_tool_result` 实测：并发双恢复产出 `tc1` 两条 tool 结果）。
改法（两侧配对）：① 引擎侧原子 check-and-set（`Mutex` 内 `contains_key` → 拒绝，文案同前端 `MSG_SESSION_BUSY`），任何来源（桌面 / 手机 / 托盘 / CLI）都经这里，是**权威闸**；② 前端 `resumePausedRun` 拆成「同步防重入薄封装（`resumingSessions` Set）+ `resumePausedRunImpl`」—— 防重入必须在**任何 await 之前**同步生效（顺带避免第二次 `createToolHandles` 顶替第一次的交互 handler，令其 `user_choice` 掉进「无处理器」分支）。
⚠️ 不要踩：前端那把锁只是第一道防线（有 await 窗口），**不能**只修前端 —— 引擎侧必须也有闸；反之引擎侧有闸后，前端重复调用只会拿到「该会话正在回复中」，不会污染会话数据。
回归：`virlen-core` 的 `concurrent_resume_of_same_snapshot_duplicates_tool_result` / `resume_request_messages_are_well_formed` / `resume_after_shelve_then_answer_writes_single_tool_result`；前端 `src/tests/services/chat-concurrency.test.ts`（并发两次「继续」只一次进入）。

**托盘 / 关闭不退出 / 后台工作**：实现见 `src-tauri/src/tray/`（模块头即设计说明），无独立文档。

---

## 12. 快速定位表

| 我要做的事 | 去哪里 |
|---|---|
| 改聊天循环 / 工具循环 / 暂停恢复 | `src-tauri/virlen-core/src/agent/{engine,llm_round,tool_executor,llm_loop}.rs`（TS 引擎已移除，见 §11.37） |
| 改系统提示词 | **文本**：`src-tauri/virlen-core/src/agent/prompts/*.md`（唯一源；前端经 `cmd_agent_prompts` 取）；**组装顺序**：`src/services/agent-service.ts`（GUI）+ `src-tauri/virlen-core/src/agent/prompts/assemble.rs`（Rust / CLI） |
| 改上下文压缩 / 标题生成 | **压缩（权威、CLI 在用）** `src-tauri/virlen-core/src/agent/compress/`（`mod` 模式/常量/口径/切片 · `raw` 正文压缩渲染 · `ai` 非流式摘要）+ CLI 执行链 `src-tauri/virlen-cli/src/session_rt/compress.rs`（落库/记账/快照）+ TUI 入口 `src-tauri/virlen-cli/src/tui/{commands,state,view,app}.rs`（`/compress` 面板与状态行百分比）+ `list-session` 两列 `src-tauri/virlen-cli/src/list/{render,sessions}.rs` + `SessionRepo::session_stats`；**GUI（Tauri）也走 Rust**（命令 `cmd_compress_context` → 同一份 `agent/compress`，见 §11.36）；**标题生成** `src-tauri/virlen-core/src/agent/title.rs`（命令 `cmd_generate_title`；CLI 在 `chat` 首回合后调用，失败回退 `title_from_prompt` 首行截取）；产物在消息列表里的呈现：`ui/pages/chat/components/message/summary-message.tsx` |
| 改会话持久化 | `src-tauri/virlen-core/src/session_db/`（`sqlite.rs` / `schema.rs` / `open.rs`）+ 命令壳 `src-tauri/src/commands/session_db.rs` + `src/infrastructure/sessionRepo/` + `src/ui/store/sessionStore.ts` |
| 改长期记忆（memory） | **方案**：`docs/memory-plan.md`（P0：`docs/memory-p0-plan.md`；P2 蒸馏：`docs/memory-p2-plan.md`；P3 去重合并/导出/预算告警：`docs/memory-p3-plan.md`）；**纯逻辑（选取/渲染/近重复判定，唯一实现）**：`src-tauri/virlen-core/src/agent/memory/mod.rs`；**取数编排**：同目录 `prompt.rs`；**三工具语义（与 GUI 命令共用）**：同目录 `tools.rs`（`memory_search` / `memory_recall` / `memory_write`）+ **详情知识库胶水** `kb.rs`（`记忆详情`、`__memoryKbId`）；**P2 蒸馏**：同目录 `distill.rs`（提示词组装 / JSON 解析 / 一次调用）+ `models.rs`（候选排序：`memoryModel` → 压缩频次 → 默认模型，上限 3）+ `store.rs`（两道去重 / 落库 / 详情入 KB / 按天清理 / **删条目连带删详情** `forget_memory`）+ `consolidate.rs`（逐日编排 / 抢锁 / 降级链 / 记账）；**P3 导出**：同目录 `export.rs`（版本化信封 + 全序排序）；**提示词**：`agent/prompts/memory-distill.md`（占位符 `{{existing}}` / `{{material}}`）；**原生工具壳**：`agent/native_tools/memory/`；**存取**：`session_db/memory.rs`（`memories` / `memory_runs` + `MemoryRepo`：`list`/`get`/`search`/`upsert`/`delete`/`set_level`/`set_disabled`/`touch`/`get_run`/`list_runs`/`last_done_day`/`claim_run`/`finish_run`/`delete_distilled_day`，DDL 走 `init_schema` 快速路径、**不占 `SCHEMA_VERSION`**；老库补 `memory_runs.merged` 列走 `schema.rs::ensure_memory_run_merged_column`）；**命令**：`src-tauri/src/commands/memory.rs`（含 `cmd_memory_consolidate` / `cmd_memory_runs` / `cmd_memory_export`，⤳ 铁律 4 注册）；**触发点**：`src/main.ts`（启动非阻塞）+ `ui/pages/Settings/memory-settings.tsx`（「立即整理昨天」/「导出 JSON」）+ `src-tauri/virlen-cli/src/memory.rs`（`memory list` / `memory consolidate` / `memory export`）；**注入接线**：`src/services/agent-service.ts` + `src/domain/agent/compose-prompt.ts` ↔ `agent/prompts/assemble.rs`（golden 守）；**前端**：`src/infrastructure/memoryRepo/` + `src/domain/memory/` + `src/infrastructure/tools/memory/` + `ui/pages/Settings/memory-settings.{tsx,scss}`（列表：行内操作**悬停 / 聚焦才显形** + 每行复选框多选 + 吸顶批量栏；样式契约由 `tests/ui/memory-settings-style-contract.test.ts` 守） + `tool-call/MemoryMessage.tsx` |
| 加 / 改工具 | **定义**：`src-tauri/virlen-core/src/agent/tool_defs/definitions.json`（权威源，三平台变体）；**执行器**：`src/infrastructure/tools/<分类>/<工具>.ts`（+ 分类 `common.ts`、分类 `index.ts`）；契约/注册中心：`src/domain/tools/{definitions,index,types}.ts` + `src/domain/ports/ToolRegistry.ts`；`src/domain/tools/category.ts`、`src-tauri/virlen-core/src/agent/native_tools/<分类>/<工具>.rs`（+ `mod.rs` 分发）、`src/ui/pages/chat/components/tool-call/` |
| 改工具返回给模型的文案 / 增删 `uiData` | TS 执行器 `src/infrastructure/tools/<分类>/<工具>.ts` ↔ Rust 原生 `src-tauri/virlen-core/src/agent/native_tools/<分类>/<工具>.rs`（**逐字对齐**，模型侧固定英文）；界面侧只读 `uiData`，在 `src/ui/pages/chat/components/tool-call/<Tool>Message.tsx` / `TerminalBlock.tsx` 按界面语言重建 |
| 改任务清单 / todo_write | `src/domain/todo/*`（纯函数）、`src/infrastructure/tools/plan/todo-write.ts`、`src/services/todo-service.ts`（落地，用户清单逐字生效）、`src/ui/store/todoDraftStore.ts`（回复期间的本地草稿；**关浮层丢弃未应用的草稿**）、`src/ui/pages/chat/components/todo/*`（标题栏入口 + 浮层；编辑期间 AI 又写清单 → 「放弃编辑并同步 / 覆盖更新」二选一） |
| 改原生工具路径校验 / 参数取值 | `src-tauri/virlen-core/src/agent/native_tools/common.rs`（`resolve_safe_path` / `is_path_allowed` / `arg_*`）；路径展开共用 `src-tauri/virlen-core/src/sandbox/paths.rs::expand_user_path` |
| 改文件读写底层 | `src-tauri/virlen-core/src/file_ops.rs` + `src/utils/diff.ts` |
| 改文件搜索 | `src-tauri/virlen-core/src/search.rs`（`search_files_by_name` / `search_text_in_files` 原生） |
| 改网络搜索 / 网页抓取（`web_search` / `web_fetch`） | **Rust 原生（权威）** `src-tauri/virlen-core/src/agent/native_tools/web/{web_search,web_fetch,common}.rs`（`web_search` 经 `ctx.settings` 直读 `app_settings` 的 `searchProviders` / `defaultSearchProviderId`）；**JS 执行器（浏览器 dev）** `src/infrastructure/tools/web/*.ts` + `src/infrastructure/search-providers/{factory,tavily,bocha}.ts`；**两侧结果文本契约** `src/tests/fixtures/web-search-format.golden.json`；搜索源配置 `src/services/search-provider-service.ts` + `src/domain/search/*`；已知差异（HTML→Markdown 细节）见 `docs/rust-engine.md` §3 |
| 改命令执行 / 风险分类 / 权限审批 | `src/domain/permission/index.ts`（+ Rust 镜像 `native_tools/execute/common/classify.rs`）；工具 `tools/execute/common.ts` + `execute-command.ts`/`execute-script.ts`；Rust 原生 `native_tools/execute/`。PTY 相关另见 `sandbox/windows/conpty.rs`、`native_tools/execute/pty_session.rs`、`tool-call/XtermTerminal.tsx`、`tool-call/TerminalConfirmBlock.tsx` |
| 改终端输出处理（`\r`、ANSI） | `tools/execute/common.ts::processTerminalOutput`（UI 侧 `tool-call/Execute*Message.tsx` 复用）；Rust 侧 `native_tools/execute/common.rs::process_terminal_output`。两份**逐条对齐** |
| 加 / 改输入框右键菜单（剪切 / 复制 / 粘贴 / 全选） | 菜单项工厂 `src/ui/components/shared/ContextMenu/editable.ts`（`editableMenuItems`，按选区 / 只读状态现算禁用态）；接线 `src/ui/pages/chat/components/input/index.tsx`（`useContextMenu` + `onContextMenu`）；剪贴板读写 `src/utils/clipboard.ts`（`copyText` / `readClipboardText`，与终端右键菜单共用）；受控控件改值的坑见 §11.38 |
| 改工具授权确认弹窗 / 交互 | `ui/pages/chat/components/modals/authorization.tsx`；事件 `events/toolInteractEvent.ts::showAuthorization`；调度 `services/tool-service/command_confirm.ts`；Rust 侧下发同样字段 `native_tools/execute/{execute_command,execute_script}.rs` |
| 改沙盒 / 权限 | `src-tauri/virlen-core/src/sandbox/**`、`src/infrastructure/sandbox/*`、`src/domain/security/index.ts` |
| 改 `js` 类沙盒规则的求值 | ✅ **已落地**（S7）：`src-tauri/virlen-core/src/security/js_rule.rs`（受限 QuickJS：**无 host 函数**、16MB 内存 / 512KB 栈 / 200ms 中断，异常与超时一律按未命中），由 `native_tools/execute/common/rules.rs` 调用；设计与依赖代价见 `docs/config-sink-plan.md` §4 |
| 改「忽略沙盒命令」规则（命中即免脱壳审批 + 强制无沙盒执行） | **Rust 判定（权威：默认引擎 + CLI）** `src-tauri/virlen-core/src/security/{rules,js_rule}.rs`（text/regex 原生 + js 内嵌 QuickJS）+ `agent/native_tools/execute/common/rules.rs`（判定入口与提示文案）+ `.../execute/{execute_command,execute_script}.rs`；**规则来源** `app_settings` 的 `sandboxIgnoreRules` 键（Rust 侧 `session_db/settings.rs` + `security::load_sandbox_ignore_rules`；前端 `infrastructure/securityRepo/`（`hydrateSecurity` / `flushSecurityPersist`）+ `ui/store/securityStore.ts` + `main.ts` 的 `step('securityConfig')`）；**TS 侧实现（浏览器 dev / 设置页「测试」）** `domain/security/sandbox-ignore-rules.ts`（`SANDBOX_JS_DEFAULT_PATTERN` / `defaultSandboxRulePattern` / 排序 / 预设 / `compileSandboxRule`）+ `services/security-service.ts::matchSandboxIgnoreRule` + `infrastructure/tools/execute/{execute-command,execute-script}.ts`；**两侧契约** `src/tests/fixtures/sandbox-rules.golden.json`（TS `tests/domain/sandbox-rules-golden.test.ts` ↔ Rust `security/rules.rs` 的 golden 用例）；UI `ui/pages/Settings/security-sandbox-rules.tsx`（拖拽几何 `./sandbox-rules-dnd.ts`；JS 输入用 `ui/components/code-editor/CodeEditor.tsx`；行内开关 `ui/components/shared/Toggle`）；下发字段 `services/rust-engine.ts::resolveSecurityConfig`（`sandboxIgnoreRules`） |
| 改视觉 | 核心 `src-tauri/virlen-core/src/vision/`（模型定位 / 懒加载 / 推理，零 `tauri::`）、命令壳 `src-tauri/src/vision_service.rs`、原生工具 `src-tauri/virlen-core/src/agent/native_tools/vision/`、前端 `src/infrastructure/vision/`、模型 `src-tauri/resources/quasivision_models/` |
| 改宿主抽象 / CLI 资源与数据目录 | trait `src-tauri/virlen-core/src/agent/host.rs`（`resource_candidates` / `data_dir`）＋ CLI 实现 `src-tauri/virlen-core/src/host/cli_host.rs` ＋ GUI 实现 `src-tauri/src/host/tauri_host.rs`；注入链 `AgentEngine.host` → `ExecuteLlmRoundParams.host` / `RunIterationParams.host` → `execute_tool_steps` → `NativeToolCtx.host` |
| 跑 / 扩展 headless CLI（`virlen-cli`） | 实现全在 **`src-tauri/virlen-cli/src/`**（本 crate 的 **lib**；core **不含命令入口**），**上下文压缩**的执行链在 `session_rt/compress.rs`（`compress_session` / `current_context_tokens` / `report_line`；TUI 与顺序输出模式共用）；`lib.rs`（参数解析 / 分派 / `USAGE` / `EXIT_*`）+ `config.rs`（配置读写）+ `session.rs`（`session show|search|rm|purge`：会话详情（含上下文占用）/ **正文检索** / 删会话 / 回收孤儿消息；非终端下 `rm` / `purge` **必须** `--yes`，见 §11.39）+ `memory.rs`（`memory list|consolidate|export`：长期记忆列表 / **蒸馏整理** / **导出 JSON**（与 GUI 同一份 core 实现；headless 只支持 openai 兼容 / anthropic 协议））+ `usage.rs`（`usage` 用量账本：token 聚合 + 可选明细；维度白名单与 core `usage_group_expr` 逐字一致；**只报 token 不报钱**）+ `run/`（无界面跑一次 agent：`mod` 参数解析 + `run()` 驱动 / `render` 事件→文本纯函数与 `Rendered`/`flush_rendered` / `ask` 交互应答 / `sink` `CliEventSink` / `tests`）+ `session_rt/`（**`run` 与 `chat` 共用**：`mod` `RunOptions` / `Resources` / `SessionRuntime::{bootstrap, bootstrap_chat, activate, turn_messages, send_options}` + `resources` 装配链（`resolve_workspace` / `build_resources` / `build_system_prompt` / `read_project_rules`） + `session` 会话装载（`load_or_create_session` / `new_session` / `title_from_prompt`））+ `list/`（`list-session [-g agent\|workdir] [-s\|--search <关键词>]` / `list-agent`：`mod` 参数解析与执行入口 / `group` 分组纯函数 / `render` 按**显示列宽**对齐 / `sessions` / `agents`）+ `provider.rs` / `agent.rs`（**交互式配置向导**，见 §11.27）+ `wizard.rs` / `settings_edit.rs`（向导原语 / 数组键按 id 增删改）+ `tui/`（**交互式 TUI，已落地**：`mod` 入口与降级策略 / `app` 线程编排 / `plain` 顺序输出模式 / `sink` 结构化事件出口 / `state/`（`line` 行模型与 ANSI 清洗 + `event` 事件解释 + `key` 按键）/ `view` 纯渲染 / `commands` / `input` / `term`；**各目录配 `tests.rs`** —— 切分口径与代价见 §11.18）；`src/main.rs` 仅三行转发（**bin 目标不被单测引用**）；数据 / 资源目录 `src-tauri/virlen-core/src/host/cli_host.rs`（`$VIRLEN_DATA_DIR` 覆盖）；库入口 `virlen_core::session_db::open_session_db`（与 GUI **同一条**路径链 → 同一份 `virlen.db`）；「忽略沙盒命令」规则走 `security::load_sandbox_ignore_rules`（同一份 `app_settings`）；技能目录推导 `run/session_rt` 侧 `existing_skills_dir`（= `<data_dir>/skills`，与前端 `skillStore` 规则一致）；便捷脚本 `pnpm cli …`；连带要求见 §11.14、三条边界见 §11.15、剩余 localStorage 数据见 §11.16 |
| 做 / 改 CLI 交互式 TUI（`virlen-cli chat`，**已落地**） | 方案与实测结论 `docs/cli-tui-plan.md`（**上下文占用百分比 / 压缩面板见 §11**）；实现 `src-tauri/virlen-cli/src/tui/`（纯逻辑 `state/`（`line`/`event`/`key`，含**本地选择面板** `Picker`）+ `view`/`commands`，终端只在 `term`，编排在 `app`/`mod`，降级形态在 `plain`）+ 会话装配/切会话 `src-tauri/virlen-cli/src/session_rt/`（`mod` 的 `bootstrap_chat` / `activate` / `turn_messages` + `resources` / `session`（含 `/model` 的 `models_text` / `switch_model` 与 `message_text`；`tui/sink.rs` 的 `text_of` 是后者的再导出别名） / `compress`）+ 入口 `src-tauri/virlen-cli/src/lib.rs`；实测脚手架（**仓库外**、一次性）`%TEMP%\ratatui-inline-spike`（`tools\repro-case.ps1` 压测「改窗口尺寸」，**必须用 `start` 起独立控制台，不能用 `Start-Process`**，否则验的是调用方的环境；向控制台注入按键需 `SetForegroundWindow` + `SendKeys`，`AppActivate` 不可靠） |
| 改 Agent 配置（agents）的持久化 / 与 CLI 共享 | 权威源 = `app_settings` 的 `agents` 键；前端 `src/infrastructure/agentRepo/index.ts`（**内存快照 + debounce 落库 + 首启迁移**，与 `securityRepo` 同款）+ `src/ui/store/agentStore.ts` + `src/main.ts` 的 `agents` 水合步骤（⚠️ **必须在 `initDefaultAgent()` / `agentStore.reload()` 之前**，否则默认 Agent 的补全会读到空列表并**覆盖**表里已有的 Agent）；CLI 侧 `src-tauri/virlen-cli/src/list/`（`agents.rs` 的 `list-agent` / `sessions.rs` + `group.rs` 的 `list-session -g agent`）；契约测试 `src/tests/infrastructure/agent-repo-settings.test.ts` |
| 用 CLI **交互式**配一个供应商 / Agent（`virlen-cli provider|agent add`，**已落地**） | 方案与实测 `docs/cli-tui-plan.md` §10，连带约束见 §11.27；命令实现在 `src-tauri/virlen-cli/src/{provider,agent}.rs`（+ 各自 `tests.rs`）；共用设施 `src-tauri/virlen-cli/src/wizard.rs`（问答原语 / 密文输入）+ `settings_edit.rs`（数组键按 id 增删改 + 字段级合并 + 回读校验）；**供应商模板表 / 推理档位表** 唯一源 `src-tauri/virlen-core/src/agent/provider/provider_catalog.json`（+ `catalog.rs` / 命令 `cmd_provider_catalog` / 前端 `domain/provider/catalog.ts` + `infrastructure/provider/catalog-source.ts`）；**模型列表与连通性验证** `src-tauri/virlen-core/src/agent/provider/models.rs`（`list_models` / `verify_connection`） |
| 改设置项 | `src/ui/store/settingStore.ts` + `src/ui/pages/Settings/*` + `src/ui/i18n/lang/en-US.json` |
| 改手机控制 / 配对 / 审计（电脑侧） | 装配 `src/bridge/index.ts::startPhoneBridge` → 服务 `phone-control.ts` → 真实数据源 `host-source.ts`；策略与留痕 `acl.ts` / `approval-policy.ts` / `audit.ts` / `pairing.ts` / `dto.ts` / `store-bridge.ts` / `interaction-*.ts`；接线 `src/ui/store/phoneControlStore.ts` + 设置页 `src/ui/pages/Settings/phone-control-settings.tsx`；落盘命令 `src-tauri/src/commands/phone_{pairing,device,audit}.rs`；传输共享包 `virlen-remote`（信令 / ICE 存 `localStorage`）；测试 `src/tests/bridge/*`、`src/tests/ui/phone-control-*`；设计文档 `docs/phone-control-bridge.md` **尚未落地**（16 个文件引用其 §号） |
| 改手机端的文件浏览 / 预览 / 编辑（§37） | 电脑侧 `src/bridge/file-source.ts`（纪律：越权只有 `resolvePath` / 非中继 / 分块 / 临时文件 / **覆写与两道冲突校验**）+ 端口 `file-tauri.ts`（`statFile` / `replaceFile`）；共享包 `virlen-remote/src/protocol/files.ts`（分类 / 限额 / base64 / 路径 / **编辑往返：EOL·BOM·严格 UTF-8**）；手机端 `store/files.ts` + `ui/components/FileSheet.{tsx,css}`；坑与用例清单见 §5.9 那一节与 §11.44 |
| 改「把电脑上的文件引用到对话」（§37 的延伸） | 契约 `virlen-remote/src/protocol/message-files.ts`（`MessageFileRef` / `MESSAGE_FILE_CAPABILITY` / 限额 / **`sanitizeFileRefs` = 两端唯一校验口径**）+ `protocol/api.ts`（`SendParams.files` / `MessageDTO.files`）；电脑侧 `src/bridge/host-source.ts::send`（校验 + 并入 `buildUserContent` + 审计 `files=N`）+ `dto.ts`（`collectFiles` / `projectContentToText` 的 `skipFiles`）；手机端 `ui/components/FileSheet.tsx`（「引用」开关）+ `ui/pages/Chat.tsx`（`pendingFiles` / chip）+ `lib/message-rows.ts`（`rendersNothing` 要算上 files）；坑见 §5.9 与 §11.45 |
| 改手机端**进入时默认打开哪个会话** | 纯函数 `virlen-mobile/src/lib/session-entry.ts::pickEntrySession`（**正在工作的优先 → 否则 `updatedAt` 最大；置顶不参与**）+ 挂载 effect `ui/pages/Chat.tsx`（已有当前会话则不切）；列表顺序仍是电脑侧权威（`sessionStore.listSessions()`：置顶优先 → 倒序），手机端**不得重排**；联调 `?entry=pin\|work`（`src/dev/host-harness.ts`）；用例 `virlen-mobile/src/tests/session-entry.test.ts`；坑见 §11.46 |
| 改配置下沉 / 设置落库 | Rust `src-tauri/virlen-core/src/session_db/settings.rs`（`app_settings` 表 + `SettingsRepo`）+ 命令壳 `src-tauri/src/commands/session_db.rs::cmd_settings_*`；前端 `src/infrastructure/settingsRepo/` + `settingStore.hydrateSettings()/flushSettingsPersist()` + `src/main.ts` 的 `step('settings')`；计划见 `docs/config-sink-plan.md` |
| 改埋点 | `src/utils/telemetry/**`（前端）；Rust 侧分两半：**出口** `src-tauri/src/telemetry.rs`（`TauriTelemetrySink` → `agent:telemetry` 事件 + `telemetry_drain_panics` 命令）、**其余**（`track` / `hash_id` / `now_ms` / 会话 trace / panic 钩子与落盘）在 `src-tauri/virlen-core/src/telemetry.rs`（sink 可插拔） |
| 改 RAG / 知识库 | `src-tauri/virlen-core/src/rag/**`、`src/services/rag-service.ts`、`src/infrastructure/rag/` |
| 改用量统计 / 费用 | `src-tauri/virlen-core/src/session_db/usage.rs`、`src/domain/pricing/index.ts`、`src/services/token-stats-service.ts`、`src/ui/pages/chat/components/token-stats/` |
| 改提示词缓存 / 追查「命中率掉了」 | OpenAI 兼容：`provider/openai.rs::build_request`（`tool_choice` 决定服务端**是否渲染 tools 段落** —— 压缩踩过的坑见 §11.30）；Anthropic：`provider/anthropic.rs::build_request` 的三处显式断点（§11.40）；命中 / 写入量看账本 `usage_ledger.cached_tokens` 与 `cache_write_tokens`（§11.41；界面 `token-stats`） |
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
  3. 若改了引擎语义 → **只需改 Rust**（TS 引擎已移除，见 §11.37）；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装）与**事件契约**是否已同步？
  4. 若新增工具 → 注册链、UI 组件、Rust 白名单、i18n 文案是否齐备？
  5. 若新增 Tauri 命令 → `lib.rs` 是否已注册？`capabilities/default.json` 是否需补权限？
  6. 是否引入无关改动、是否触碰 §8 安全红线？
  7. 若改了 workflow / 打包流程 → 产物路径与 `upload-artifact` 的 `path`、Release 的 `files` glob 是否对齐？（CLI 发布物是 **zip**（含视觉模型）：命名约束 / zip 内布局 / 打包自检见 §11.29；**CLI 构建步骤的三元组用 `CARGO_BUILD_TARGET` 环境变量**，不要走 `pnpm run … -- --target`，见 §11.31）；
  8. 新增/修改了**平台专属代码**（`#[cfg(target_os = …)]`）→ 反向平台能不能编译？（CI 的 clippy 只在 ubuntu 跑，Windows 专属的常量 / 函数在 Linux 上就是 `dead-code`，必须显式门禁，见 §11.31）
  9. 有没有在**模块顶层**读「启动水合」的快照（`providerCatalog()` / `promptText()` / `providerService.getDefaultProviderList()` …）？那等于在 `main.ts` 水合之前读 —— 整个应用会**启动即崩、窗口都不显示**，见 §11.32；
