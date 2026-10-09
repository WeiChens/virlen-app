# 项目总览（§0–§4）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

## 0. 30 秒导读

**Virlen（未霖）**是一个基于 **Tauri v2** 的跨平台 **AI Agent 桌面客户端**——不是聊天壳，而是「**可扩展的 Agent 运行平台**」：多模型接入、可插拔工具、本地视觉/RAG/Skill、多层安全、以及一套 **Rust 实现的 Agent 引擎**（`virlen-core`，GUI 与 CLI 共用；原 TS 引擎已移除）。

理解本项目，抓住四条主线即可：

1. **内核是「Agent 循环」**——LLM 轮次 → 工具执行 → 迭代验证 → 循环，直到收敛（见 §4、§5.1）。
2. **能力靠「工具」扩展**——工具是「定义 + 执行器」分离的注册制，可 JS 实现、也可 Rust 原生化（见 §5.2）。
3. **安全贯穿全文**——路径黑白名单 / 权限三态 / 跨平台沙盒 / 工具风暴防护四道闸（见 §5.4、§8）。
4. **引擎只有一份（Rust）**——聊天循环 / 工具执行 / 上下文压缩 / 标题生成全在 `src-tauri/virlen-core/src/agent/`；GUI 与 CLI 共用同一份。TS 侧只剩「被 Rust 回调的部分」（工具执行器 / Gemini provider / 提示词组装 / 事件契约），它们仍须与 Rust 同语义（见 §5.1、§7 铁律 1）。


## 1. 项目是什么

一个「**全能型 AI 智能体桌面客户端**」，核心能力矩阵：

| 能力域 | 说明 |
|---|---|
| **多 Provider** | OpenAI 兼容 / Anthropic / Gemini；支持自定义 Base URL、自定义 Header、`reasoningEffort` |
| **Function Calling** | 文件读写、**文档解析**（PDF / Word / Excel / PowerPoint / CSV）、命令执行、**后台服务**（常驻进程：起/看/杀/列）、网页抓取、搜索、视觉分析、知识库、长期记忆（检索/召回/写入）、会话消息检索、任务规划共 12 大类 36 个工具 |
| **端侧视觉引擎** | `quasivision` ONNX 纯本地推理：UI 元素检测 / PP-OCR v5 / YOLOE-26n 物体检测 / 图标分类（图片不出本机） |
| **Skill 机制** | `SKILL.md` 领域知识包，注入系统提示词 + 源码目录只读可查 |
| **多层安全** | 路径黑白名单、权限三态、跨平台 Shell 沙盒、工具风暴防护（StormBreaker） |
| **会话与记忆** | 暂停/恢复（Run Snapshot）、LLM 上下文压缩、本地 RAG（turbovec 向量索引）、用量账本、**长期记忆**（`memories` 表 + 建会话注入 `# Memory` 段 + 设置页面板 + `memory_search` / `memory_recall` / `memory_write` 三个原生工具 + **P2 蒸馏**：启动/面板/CLI 触发把前一天各会话摘要提炼成记忆 + **P3 去重合并 / 导出 JSON / 预算告警 / 列表多选批量操作**，详见 `docs/memory-plan.md` / `docs/memory-p0-plan.md` / `docs/memory-p2-plan.md` / `docs/memory-p3-plan.md`） |
| **Agent 引擎** | 仅 Rust（`src-tauri/virlen-core/src/agent/`，GUI 与 CLI 共用）；原 TS 引擎 `src/domain/engine/` 已移除（见 §11.37） |
| **手机控制** | 手机扫码配对后远程操作本机（会话 / 发消息 / 应答工具审批）：电脑侧接口层在 `src/bridge/`，传输用自维护 npm 包 `virlen-remote`（WebRTC + SSE 信令，见 §5.9） |


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
   │         ▼ 原生工具（36 个）                          ▼ JS 桥   │
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
