# AGENTS.md — Virlen 项目开发约定（供 AI 编码代理与人类协作者使用）

> 本文件是本仓库的「事实来源（source of truth）」。动手改代码前先读这里，
> 尤其是 **§5 铁律**、**§9 安全红线**、**§11 常见坑**。
> 与 `README.md` 冲突时以本文件 + 代码现状为准（README 存在若干过期描述，见 §11.4）。

---

## 1. 项目是什么

**Virlen（未霖）** 是一个基于 **Tauri v2** 的跨平台 AI Agent 桌面客户端。
不只是聊天客户端，而是一个可扩展的 Agent 平台，核心能力：

- 多 Provider（OpenAI 兼容 / Anthropic / Gemini，支持自定义 Base URL、自定义 Header、`reasoningEffort`）
- Function Calling：文件读写、命令执行、网页抓取、搜索、视觉分析、知识库
- 端侧视觉引擎（`quasivision` ONNX）：UI 元素检测 / PP-OCR v5 / YOLOE-26n 物体检测 / 图标分类，纯本地推理
- Skill 机制：`SKILL.md` 描述的领域知识包，注入系统提示词 + 源码目录只读可查
- 多层安全：路径黑白名单、命令审批、跨平台 Shell 沙盒（Windows Job Object+ACL / macOS / Linux Landlock）、工具风暴防护 StormBreaker
- 暂停/恢复（Run Snapshot 模型）、LLM 上下文压缩、本地 RAG（turbovec 向量索引）、诊断埋点
- **Agent 引擎双实现**：Rust 原生引擎（默认开启，`src-tauri/src/agent/`）+ TS 引擎（回退，`src/domain/engine/`）

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19、TypeScript（`strict: true` 但 `strictNullChecks: false`）、Vite 7、MobX 6（`mobx` / `mobx-react-lite`）、Sass、react-markdown + remark-gfm、PrismJS、Monaco、turndown + cheerio、JSZip、`@tanstack/react-virtual` |
| 测试 | Vitest 4（jsdom，全局 `vi`），Rust 内联 `#[cfg(test)]` |
| 后端 | Tauri 2、Tokio、Serde、rusqlite（bundled, WAL）、reqwest（原生 SSE）、turbovec + text-splitter（RAG）、grep/walkdir/ignore（文件搜索）、sha2、trash、quasivision、image、pdf-extract |
| 包管理 | pnpm（`pnpm-workspace.yaml` 需 `allowBuilds: esbuild/@parcel/watcher`） |

平台相关依赖按 `[target.'cfg(...)']` 划分：Windows（webview2-com / windows-sys Job Object）、macOS（speech 0.5.0 锁版本）、Linux（landlock）。

---

## 3. 常用命令

```bash
pnpm install                 # 依赖安装（首次/依赖变更后必须执行）
pnpm dev                     # 仅前端（Vite，端口 1420，strictPort；浏览器模式自动回退 TS 能力）
pnpm tauri dev               # 桌面端开发（前端 + Rust）
pnpm build                   # tsc && rimraf dist && vite build
pnpm tauri build             # 桌面端安装包（nsis/dmg/...）
pnpm test                    # vitest run（配置见 vitest.config.ts）
pnpm test:watch / test:ui
npx tsc --noEmit             # 类型检查（唯一「静态门禁」）
cd src-tauri; cargo test     # Rust 侧测试（各模块内联 #[cfg(test)] mod tests）
pnpm build:msix              # Windows MSIX 打包（scripts/build-msix.ps1，需 Windows SDK 的 MakeAppx/SignTool）
```

基线（README 记录，**本机沙盒未复现**，见 §11.2）：`cargo test` 101 passed、`vitest run` 346 passed、`tsc --noEmit` 零错误。
提交前请自行至少跑 `npx tsc --noEmit` + 受影响模块的测试。

---

## 4. 目录结构与依赖方向

**架构：六边形（Ports & Adapters）**，依赖方向只能是「外层 → 内层」：

```
ui/  →  services/  →  domain/  ←  infrastructure/
                        ↑
                    ports/（接口在此定义）
```

| 目录 | 职责 | 允许依赖 |
|---|---|---|
| `src/domain/` | 纯业务逻辑：引擎、工具注册中心、Provider 领域模型、搜索领域模型、安全策略、端口接口 | `@/types`、`@/utils`（不依赖 ui / services / infrastructure） |
| `src/infrastructure/` | 端口实现：Provider（openai/anthropic/gemini）、工具实现、沙盒、sessionRepo、search-providers、vision、RAG 存储 | domain、types、utils |
| `src/services/` | 应用编排：chat-service（最大，1087 行）、agent-service（提示词组装）、rust-engine（Rust 桥）、security/rag/export/update 等服务 | domain、infrastructure、ui/store（读设置） |
| `src/ui/` | React + MobX：pages（chat / Settings / setupFlow）、components、store、i18n、layout、hooks | 全部下层 |
| `src/skill/` | Skill 加载/注册/导入/广场 | services 之下工具化使用 |
| `src/events/` | EventEmitter 事件总线（menu / settings / comment / toolInteract / update） | utils |
| `src/utils/` | 无业务依赖的工具：telemetry、storageState、EventEmitter、diff、mdYamlFrontmatter、pathCanonicealize… | 无（telemetry/common 等底层模块不 import ui/domain） |
| `src/tests/` | Vitest 测试，按 `domain / infrastructure / services / rag / utils` 分目录 | — |
| `src-tauri/src/` | Rust 侧：`agent/`（镜像 TS 引擎）、`rag/`、`sandbox/`、`session_db.rs`、`file_ops.rs`、`search.rs`、`vision_service.rs`、`telemetry.rs`、`lib.rs`（命令注册） | — |
| `src-tauri/resources/` | 打包资源：`default-skills/`、`quasivision_models/`、`deepseek_tokenizer/`（`tauri.conf.json > bundle.resources` 必须同步） | — |

---

## 5. 铁律（改代码前必读）

1. **双引擎同步**：`src/domain/engine/*`（TS）与 `src-tauri/src/agent/*`（Rust）是同一套语义的两份实现。
   改动「LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销语义」时，**两边都要改**，
   否则 `useRustEngine=true`（默认）与 `false` 行为分叉。
2. **事件契约不可擅自改名**：`AgentEventType`（`src/types/index.ts`）是 TS 引擎、Rust `event_sink`、
   `chat-service.createEventHandler`、`rust-engine.ts` 四方共享的契约。
   新增事件类型必须四处一致（TS 类型 → TS emit → Rust emit → chat-service 处理）。
3. **引擎不碰持久化，也不 import store**：
   - TS 引擎：消息创建/更新一律通过 `onEvent` 抛给 `chat-service`；落库由 `chat-service.persistMessagesIfNeeded()`（`!isRustEngineEnabled()` 守卫）负责。
   - Rust 引擎：由 `SessionRepo` 在引擎内部直落 SQLite（先落库再 emit）。
4. **新增 Tauri 命令必须注册**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]`，
   否则前端 `invoke` 静默 404。
5. **工具是「定义 + 执行器」分离注册制**：一律通过 `toolRegistry.register(definition, executor)`，
   不要写全局函数表；`definition.description` 可以是**惰性函数**（真正序列化给 LLM 时才求值，
   用于平台相关的动态描述），对外返回时由 `resolveDefinition()` 求值为纯字符串。
6. **写操作必须先过安全校验**：JS 侧 `securityService.resolveSafePath/isPathAllowed`，
   Rust 侧 `native_tools::resolve_safe_path / is_path_allowed`，两侧规则必须等价。禁止绕过。
7. **业务文案走 i18n**：`t('中文')`（中文即 key），变量模板用 `tpl('已删除 $__count__ 个会话', {count})`。
   新增 UI 文案必须同步在 `src/ui/i18n/lang/en-US.json` 补 key。
8. **不改动与任务无关的代码**：本项目遵循「最小改动」原则；顺手重构要单独说明。
9. **中文注释是本项目风格**：文件头写职责说明，关键分支写「为什么」而非「做了什么」。
   保留 `??`/`⚠️` 这类强调标记的既有写法。
10. **不用 `git push --force`、不重写历史、不动 `dist/`、不删别人的文件**。

---

## 6. 双引擎架构详解

```
chat-service.sendMessage()
  └─ getEngine()  ── settings.useRustEngine && Tauri 可用 ──▶ rustEngine (services/rust-engine.ts)
                 └─ 否则（浏览器 dev / vitest / 用户关闭）────▶ agentEngine (domain/engine/engine.ts)
                        两者共同实现 AgentEnginePort（sendMessage / getRunSnapshot / clearRunSnapshot
                        / cancel / compressContext / generateTitle）
```

### Rust 引擎桥协议（与 `src-tauri/src/agent/bridge.rs` 严格对应）

| 方向 | 通道 | 说明 |
|---|---|---|
| Rust → JS | 事件 `agent:event` | 载荷 `{ sessionId, event }`，`event` 与 TS `AgentEvent` 完全一致；前端直接转发给 `onEvent` |
| Rust → JS | `agent:tool-request` | 未原生化工具交 JS 执行，JS 用 `toolRegistry` 跑完回 `agent_tool_response`（`payload.__kind: value \| error \| interaction`） |
| Rust → JS | `agent:user-interaction-request` | 用户交互（`user_choice` / `confirm_command_native`），走 `chat-service` 注册的 session handler → 弹窗 → `agent_user_interaction_response`（`value \| error \| shelved \| cancelled`） |
| Rust → JS | `agent:provider-request` | 未原生化的 Provider（目前 Gemini）交 JS，流式用 `agent_provider_stream_event` 逐条回传，结束 `agent_provider_stream_done` |
| JS → Rust | `agent_send_message` / `agent_cancel` / `agent_get_run_snapshot` / `agent_clear_run_snapshot` / `agent_dispose` / `agent_kill_command` | 生命周期与取消 |

### Rust 已原生化的工具（`src-tauri/src/agent/native_tools/`，`mod.rs::is_native_tool`）

Rust 侧目录与 JS `src/infrastructure/tools/` 一一对应（一个工具一个 `.rs` + 分类 `common.rs`）：

| 分类目录 | category id | 工具 |
|---|---|---|
| `native_tools/file/` | `file` | read_file / write_file / edit_file / delete_file / copy_move_file / list_files / file_info / mkdir |
| `native_tools/search/` | `search` | search_files_by_name / search_text_in_files |
| `native_tools/execute/` | `execute` | execute_command / execute_script |
| `native_tools/knowledge_base/` | `knowledge_base` | 6 个知识库工具 |

- `native_tools/mod.rs`：`NativeToolOutcome`（统一结果）/ `NativeToolCtx`（执行上下文）/ `is_native_tool` / `execute_native_tool` 分发。
- `native_tools/common.rs`：跨分类公共（`arg_str`/`arg_i64`/`arg_bool`/`arg_str_array` + `resolve_safe_path` / `is_path_allowed`）。
- web / vision / skill / system 分类**未原生化**，全部走 JS 桥。

原生化工具（18 个）：
`execute_command`、`execute_script`、`read_file`、`edit_file`、`write_file`、`list_files`、`delete_file`、
`file_info`、`copy_move_file`、`mkdir`、`search_files_by_name`、`search_text_in_files`、
`search_knowledge_base`、`list_knowledge_bases`、`list_knowledge_base_documents`、
`get_knowledge_base_document`、`delete_knowledge_base_document`、`write_to_knowledge_base`。

**其余工具自动走 JS 桥**（`get_current_time`、`user_choice`、`web_fetch`、`web_search`、
`list_skills`、`read_skill_source`、`vision_analyze` 分发等）。
Rust 只使用前端组装好的 `session.systemPrompt`（为空时回退 `"你是一个有用的 AI 助手。"`）。

### 职责边界速查

| 能力 | TS | Rust |
|---|---|---|
| Agent 循环 / 工具执行 / 迭代验证 | ✅（回退路径） | ✅（默认） |
| 会话消息持久化 | `chat-service`（仅 TS 引擎路径） | `session_db.rs`（SQLite + WAL + 单写连接 + `spawn_blocking`） |
| Provider HTTP | 3 种全支持 | OpenAI / Anthropic 原生；Gemini 桥 |
| `compressContext` / `generateTitle` | ✅ | ❌ 委托 TS |
| 提示词组装（`assembleAgentPrompt`） | ✅（`services/agent-service.ts` + `domain/agent/prompts/*.md`） | ❌ 用前端结果 |
| token 计数 | 字符数/4 兜底 | `deepseek_tokenizer::cmd_count_tokens`（字节级 BPE） |
| 前端职责 | UI / 设置 / i18n / 导出 / 更新 / 终端输出流 | — |

> 未 Rust 化清单与已知限制见 `docs/rust-engine.md`（第十节 + 附录），改动引擎前建议通读。

---

## 7. 手册 A：新增一个工具

工具目录按 `src/domain/tools/category.ts` 的分类一一对应：
`src/infrastructure/tools/<分类>/<工具>.ts`（工具名 snake_case ↔ 文件名 kebab-case）+ 该分类的 `common.ts`（分类内公共函数）。

| 分类目录 | category id | 工具 |
|---|---|---|
| `tools/file/` | `file` | read_file / write_file / edit_file / delete_file / copy_move_file / list_files / file_info / mkdir |
| `tools/search/` | `search` | search_files_by_name / search_text_in_files |
| `tools/execute/` | `execute` | execute_command / execute_script |
| `tools/knowledge-base/` | `knowledge_base` | 6 个知识库工具 |
| `tools/web/` | `web` | web_search / web_fetch |
| `tools/vision/` | `vision` | vision_analyze |
| `tools/skill/` | `skill` | list_skills / read_skill_source |
| `tools/system/` | `system` | get_current_time / user_choice |

`tools/output-store.ts`（跨层单例，UI/services/engine 均引用）不归属任何分类，保留在 tools 根目录。

1. **定义 + 执行器**（在新工具所属分类目录下新建一个文件）：
   ```ts
   toolRegistry.register(
     {
       name: 'my_tool',                 // 唯一、snake_case、与 LLM 约定的名字
       label: t('我的工具'),            // 中文，UI 展示（走 i18n）
       description: 'English description for the LLM.',  // 或 () => string 惰性描述
       parameters: { type: 'object', properties: {...}, required: [...] },
     },
     (async (args, ctx: ToolContext) => {
       // ctx: { sessionId, toolCallId, abortSignal, write, skills }
       // 需要用户交互 → return new UserInteractionRequired('my_interaction', {...})
       return '给 LLM 的结果文本' | { content: string, uiData?: Record<string, any> }
     }) as ToolExecutor,
   )
   ```
2. **挂进启动注册链**：在该分类的 `index.ts` 里加 `import './my-tool'`（新分类还需在 `tools/index.ts` 的 `toolsInit()` 加 `await import('@/infrastructure/tools/<分类>')`，
   并在 `domain/tools/category.ts` 的 `TOOL_CATEGORIES` 里登记工具名）。
3. **公共函数**：被同分类 ≥2 个工具复用（或与具体工具执行无关的通用纯函数/常量）→ 抽到该分类 `common.ts`；
   单工具内部实现细节留在自己的文件里（如 `read-file.ts` 的 `readSingleFile`、`web-fetch.ts` 的 `ensureHtmlDeps`）。
4. **UI 渲染**：在 `src/ui/pages/chat/components/tool-call/` 新建 `XxxMessage.tsx` 实现 `IToolCallMessage`
   （`getToolName / getToolLabel / getShortText / getExpandView / diyWrapper`），
   并在同目录 `IToolCallMessage.ts` 里 `register(...)`（多个工具可 `registerMulti([...])` 共用组件；未注册自动落到 `DefaultMessage`）。
5. **是否原生化**：需要 Rust 原生执行时，在 `src-tauri/src/agent/native_tools/mod.rs` 的 `is_native_tool` + `execute_native_tool` 增加分支，
   并在对应分类目录下新建 `<工具>.rs`（复用 `native_tools/common.rs` 的 `arg_*` / `resolve_safe_path` 与分类 `common.rs`）；否则保持 JS 桥即可。
6. **需要新的用户交互类型**：扩展 `src/events/toolInteractEvent.ts` 的事件定义 +
   `src/ui/pages/chat/components/tool-ui.tsx`（新增弹窗与 resolve/reject 回调），
   Rust 侧对应 `confirm_command_native` 之类的 `BridgeInteractionResult` 处理。
7. **测试**：`src/tests/infrastructure/*.test.ts`（JS 路径），Rust 加内联单测。
8. **描述里的平台信息**建议用惰性函数（见 `tools/execute/common.ts` 的 `platformSnapshot()` 缓存模式）。

## 8. 手册 B：新增/修改 Provider、搜索源、Skill

- **LLM Provider**：实现 `IProvider`（`src/infrastructure/provider/types.ts`：`listModels / chat / chatStream / buildRequest / validateApiKey`），
  在 `provider/index.ts::createProviderInstance` 注册，模板放 `src/domain/provider/config.ts`（含 `baseUrl`、`allowReasoningEffortList`）。
  若要在 Rust 侧原生支持，需在 `src-tauri/src/agent/provider.rs` 增加 `Provider` trait 实现（原生 HTTP+SSE），否则自动走 `BridgedProvider`。
- **搜索源**：实现 `ISearchProvider`（`src/domain/search/types.ts`），放 `src/infrastructure/search-providers/`，
  在 `factory.ts` 注册，配置由 `search-provider-service.ts` 管理（持久化在 localStorage）。
- **内置 Skill**：在 `src-tauri/resources/default-skills/<name>/` 新建 `SKILL.md`，frontmatter 至少 `name` / `description`
  （也可纯 Markdown：`# 标题` + `> 描述` + `**Version:** x.y.z`，解析器 `utils/mdYamlFrontmatter.ts` 两种都兼容）。
  目录名应与 `name` 一致（不一致时会告警并以 `name` 为准）。`SKILL.md` 是可执行知识入口，脚本放 `scripts/`。

---

## 9. 安全红线（写任何涉及文件/命令/网络的代码前必读）

| 机制 | 位置 | 要点 |
|---|---|---|
| 路径校验 | `domain/security/index.ts`（策略）、`services/security-service.ts`（服务）、`utils/pathCanonicealize.ts` | 优先级 **黑名单 > 白名单 > 工作目录**；写模式（`mode='w'`）仅允许白名单 + 工作目录；黑名单按平台给默认值 |
| 沙盒模式 | `settings.sandboxMode` (`on`/`off`/`readonly`)；实现 `infrastructure/sandbox/plugin-shell-sandbox.ts` + `src-tauri/src/sandbox/` | Windows：Job Object + 受限令牌 + ACL（`windows/`）；Linux：Landlock（5.13+，默认拒写、白名单授予可写根，`readonly` 时全部拒写）；macOS：见 `sandbox/macos/mod.rs`。**禁止绕过沙盒直接 spawn** |
| 命令审批 | `settings.commandApprovalMode` (`all`/`risky`/`install`/`none`) + `tools/execute/common.ts::classifyCommand`（`safe`/`install`/`dangerous`） | 危险命令集合与安装器集合在此维护；新增高危命令要补进集合 |
| 工具风暴防护 | `declaration` → `domain/engine/storm-breaker.ts` / `agent/storm_breaker.rs` | 滑窗（window 6 / threshold 3）检测重复 `(toolName, args)`，命中即中断循环 |
| 密钥打码 | `utils/telemetry/redact.ts`、`isSensitiveKey()` | 埋点/日志**不得**输出 apiKey、token、密钥文件内容；`providers`/`searchProviders` 只上报数量 |
| 端侧视觉 | `vision_service.rs` + `resources/quasivision_models/` | 图片不出本机，不要在实现里改成上传 |

**AI 代理自我约束**：不读取 `.env`、`*.key`、`~/.ssh/` 等敏感文件；文件写入限制在工作区（当前沙盒可写根 `C:/code/virlen-app`）；
删除文件用回收站语义（`trash`）而非硬删；破坏性操作（删库、清空会话、批量重命名）先向用户确认。

---

## 10. 前端约定

- **状态**：MobX 单一 store + `StorageState`（`utils/storageState.ts`，localStorage 持久化，key 前缀 `_storage_state_`）。
  - `ui/store/settingStore.ts`（全部设置项 + 一次性迁移逻辑）、`sessionStore.ts`（会话 CRUD + 消息懒加载 `ensureMessagesLoaded`）、
    `agentStore.ts`、`securityStore.ts`、`sessionRuntimeStore.ts`（working / pendingContent / traceId）。
  - 设置项变更会触发 `settings.change` 埋点；新增设置项记得加进 `SettingsStore` 接口 + `defaultSettings` + 设置页 UI（`ui/pages/Settings/`）。
- **会话消息持久化**：Rust 命令 `cmd_list_sessions / cmd_get_session / cmd_get_messages / cmd_get_message_page /
  cmd_upsert_session / cmd_delete_session / cmd_replace_session_messages / cmd_append_messages`（封装在 `infrastructure/sessionRepo/`）。
  启动只加载会话元数据，消息**懒加载**。`utils/db.ts`（IndexedDB）已废弃删除，不要复活。
- **组件事件**：跨层通信用 `src/events/*` 的 EventEmitter（禁止 `window.*` 全局挂载）。
- **样式**：每个组件目录内 `style.scss`（或 `style.module.scss`），跟随组件的 BEM 类名；主题变量在 `ui/styles/theme.css`。
- **窗口**：无边框自绘（`ui/layout/WindowLayout`），窗口默认 `visible: false`，首帧后 `getCurrentWindow().show()`。
- **性能**：消息列表用 `@tanstack/react-virtual` 动态高度虚拟滚动 + 分页加载（改 `message-list.tsx` 时注意 `measureElement`）。
- **埋点**：`track('domain.action', props)`、`trackPerf`、`startSpan`（`utils/telemetry`）。
  命名为 `域.动作`（如 `chat.message.send`、`engine.iteration.verify`、`session.create`）；默认关闭（`telemetryEnabled`），
  必须保持「关闭时零开销」。

---

## 11. 常见坑（踩过的坑，别再踩）

**11.1 Windows PowerShell 5.1 默认按本地代码页（GBK）读取文件** —— 用 `Get-Content` 看含中文的源码会乱码。
查看/比对中文内容请加 `-Encoding UTF8`；写文件用工具（`write_file`/`edit_file`，UTF-8）。

**11.2 本机沙盒的已知限制（非代码问题）**：
- `vitest` 可能因 `esbuild` 子进程 `spawn EPERM` 启动失败 → 测试无法在本沙盒运行，需在常规终端执行。
- `node_modules` 可能不完整（例如缺 `@tanstack/react-virtual`），此时 `tsc --noEmit` 会报
  `message-list.tsx` 的「找不到模块 + 隐式 any」两个错。先 `pnpm install` 再判断是否为真错误。

**11.3 版本号分散在 3 处**（当前并不一致，属历史遗留）：
`package.json`（0.1.2）、`src-tauri/Cargo.toml`（1.0.1）、`src-tauri/tauri.conf.json`（1.1.26，
**打包与 MSIX 脚本实际读取这个**）。改版本时至少同步 `package.json` + `tauri.conf.json`。

**11.4 README 已过期的地方**（改到相关部分时顺手校正，别照抄）：
- 测试目录写作 `tests/`，实际是 `src/tests/`；
- 前台技术栈写 TypeScript 5.8，实际 `typescript ~7.0.2`；
- 工具表未包含 `mkdir` / 知识库系列工具；`README-CN.md` 为同内容的英文/中文对照版，需一起维护。

**11.5 `docs/` 被 `.gitignore` 忽略**（根 `.gitignore` 末尾有 `docs/`）。
本文件与 `plan.md` / `rust-engine.md` 默认**不会进入 git**；需要提交请 `git add -f docs/AGENTS.md`。

**11.6 其他易错点**：
- `vite.config.ts` 中 `optimizeDeps.exclude: ['monaco-editor']` 不可去掉：monaco 必须按子模块入口引入，
  否则会打成多份实例、注册表互相隔离（`setupMonaco.ts` 有详细说明）。
- Vite 端口固定 1420（`strictPort`），`tauri dev` 会失败于端口被占用。
- `tsconfig.json`：`strict: true` 但 `strictNullChecks: false`、`noUnusedLocals/Parameters: false`——
  别按纯严格模式假设；别名 `@/*` 指向 `src/*`（Vitest 也单独配置了一份）。
- Run Snapshot 只存内存，页面刷新即失效（工具断点恢复仅同页面内有效）；用户取消**不算错误**，要保留 partial 内容（详见 `docs/rust-engine.md` 第八节）。
- 消息 id 与消息内容分离：`chat-service` 负责用户/assistant/tool 消息的创建与事件广播，UI 只渲染。

---

## 12. 提交与协作约定

- 提交信息风格：`feat: ...` / `fix: ...` / `update Version` / `update`，中英混用（历史如此，保持一致即可）；
  涉及引擎/持久化的改动请在正文写清「TS / Rust 两侧都改了什么」。
- 一次提交只做一件事；格式化/重命名等噪音改动不要混进功能提交。
- 提交前自查清单：
  1. `npx tsc --noEmit` 无新增错误；
  2. 受影响模块的 `vitest` 用例通过；动了 `src-tauri/` 则 `cargo test` 通过；
  3. 若改了引擎语义 → TS 与 Rust 两侧是否都已同步？事件契约是否四方一致？
  4. 若新增工具 → 注册链、UI 组件、Rust 白名单、i18n 文案是否齐备？
  5. 若新增 Tauri 命令 → `lib.rs` 是否已注册？capabilities 是否需要补权限（`src-tauri/capabilities/default.json`）？
  6. 是否引入了无关改动、是否触碰了 §9 安全红线？

---

## 13. 快速定位表

| 我要做的事 | 去哪里 |
|---|---|
| 改聊天循环 / 工具循环 / 暂停恢复 | `src/domain/engine/*` **和** `src-tauri/src/agent/{engine,llm_round,tool_executor,llm_loop}.rs` |
| 改系统提示词 | `src/domain/agent/prompts/*.md` + `src/services/agent-service.ts`（组装顺序在此） |
| 改上下文压缩 / 标题生成 | `src/domain/engine/compress-context.ts` / `generate-title.ts`（Rust 侧委托 TS） |
| 改会话持久化 | `src-tauri/src/session_db.rs` + `src/infrastructure/sessionRepo/` + `src/ui/store/sessionStore.ts` |
| 加/改工具 | `src/infrastructure/tools/<分类>/<工具>.ts`（+ 分类 `common.ts`、分类 `index.ts`）、`src/domain/tools/category.ts`、`src-tauri/src/agent/native_tools/<分类>/<工具>.rs`（+ `mod.rs` 分发）、`src/ui/pages/chat/components/tool-call/` |
| 改原生工具路径校验 / 参数取值 | `src-tauri/src/agent/native_tools/common.rs`（`resolve_safe_path` / `is_path_allowed` / `arg_*`） |
| 改文件读写底层 | `src-tauri/src/file_ops.rs`（读/写/多段编辑）+ `src/utils/diff.ts` |
| 改搜索 | `src-tauri/src/search.rs`（文件搜索）、`src/domain/search/*` + `src/infrastructure/search-providers/*`（网络搜索） |
| 改命令执行 / 风险分类 / 审批 | `src/infrastructure/tools/execute/common.ts`（+ `execute-command.ts` / `execute-script.ts`）；Rust 原生侧 `src-tauri/src/agent/native_tools/execute/common.rs`（+ `execute_command.rs` / `execute_script.rs`） |
| 改终端输出处理（`\r`、ANSI） | `src/infrastructure/tools/execute/common.ts::processTerminalOutput`（UI 侧 `tool-call/Execute*Message.tsx` 复用同一函数）；Rust 侧 `native_tools/execute/common.rs::process_terminal_output` |
| 改沙盒/权限 | `src-tauri/src/sandbox/**`、`src/infrastructure/sandbox/*`、`src/domain/security/index.ts` |
| 改视觉 | `src-tauri/src/vision_service.rs`、`src/infrastructure/vision/`、`src-tauri/resources/quasivision_models/` |
| 改设置项 | `src/ui/store/settingStore.ts` + `src/ui/pages/Settings/*` + `src/ui/i18n/lang/en-US.json` |
| 改埋点 | `src/utils/telemetry/**`（+ `src-tauri/src/telemetry.rs` 的 panic 桥） |
| 改 RAG / 知识库 | `src-tauri/src/rag/**`、`src/services/rag-service.ts`、`src/infrastructure/rag/` |
| 发版 / 打包 | `src-tauri/tauri.conf.json` + `package.json` + `scripts/build-msix.ps1`、`scripts/msix/AppxManifest.xml.template` |
