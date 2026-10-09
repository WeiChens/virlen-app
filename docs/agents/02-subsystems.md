# 主要子系统地图（§5.1–§5.8）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

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
> **35 个工具已全部原生化**（S5 补齐 `web_fetch` / `web_search`，P1 补齐 `memory_*`，后台服务补齐 `service` 四件套）——`is_native_tool` 就是全集，**没有工具再走 JS 桥**。
Rust 只使用前端组装好的 `session.systemPrompt`（为空时回退 `"你是一个有用的 AI 助手。"`）。完整清单见 `docs/rust-engine.md`。

> ⚠️ **改引擎语义（LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销）只需改 Rust**（`virlen-core`）；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装 / 事件契约）仍须与 Rust 同语义（铁律 1）。

### 5.2 工具系统——能力扩展的唯一入口

- **注册制**：`toolRegistry.register(name, executor, label?)`；不写全局函数表。
- **定义与执行器分离，且定义只有一份（机制 C）**：工具定义在 **Rust 侧权威源** `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`（35 工具 × 三平台变体 `windows`/`macos`/`linux`，键名与 `std::env::consts::OS` 同词表）；前端只注册执行器 + UI 文案（`label` 走 i18n，**不进契约**）。读取一律 `await toolRegistry.listDefinitions()`（**异步**接口），返回「契约 ∩ 已注册执行器」。详见 `docs/rust-engine.md` §12。
- **12 大分类 / 35 个工具**（`src/domain/tools/category.ts` ↔ `src/infrastructure/tools/<分类>/`）：

  | 分类 id | 目录 | 工具数 | 代表工具 |
  |---|---|:--:|---|
  | `file` | `tools/file/` | 8 | read_file / write_file / edit_file / delete_file / copy_move_file / list_files / file_info / mkdir |
  | `search` | `tools/search/` | 2 | search_files_by_name / search_text_in_files |
  | `execute` | `tools/execute/` | 2 | execute_command / execute_script |
  | `service` | `tools/service/` | 4 | start_background_service / get_background_service / kill_background_service / list_background_services（后台服务：**工具返回后进程继续活着**，见 §11.47） |
  | `knowledge_base` | `tools/knowledge-base/` | 6 | search / list / get / write / delete … |
  | `web` | `tools/web/` | 2 | web_search / web_fetch |
  | `vision` | `tools/vision/` | 1 | vision_analyze（✅ 已原生化） |
  | `skill` | `tools/skill/` | 2 | list_skills / read_skill_source |
  | `system` | `tools/system/` | 2 | get_current_time / user_choice |
  | `plan` | `tools/plan/` | 1 | todo_write（任务清单；用户可在标题栏浮层里直接编辑） |
  | `chat` | `tools/chat/` | 2 | list_messages / read_messages |
  | `memory` | `tools/memory/` | 3 | memory_search / memory_recall / memory_write（长期记忆） |

- **原生化（35 个 = 全部）**：`file`(8) + `search`(2) + `execute`(2) + `service`(4) + `knowledge_base`(6) + `plan`(1：`todo_write`) + `system`(2：`user_choice` / `get_current_time`) + `chat`(2：`list_messages` / `read_messages`) + `memory`(3：`memory_search` / `memory_recall` / `memory_write`) + `skill`(2：`list_skills` / `read_skill_source`) + `vision`(1：`vision_analyze`) + `web`(2：`web_fetch` / `web_search`)，分发在 `src-tauri/virlen-core/src/agent/native_tools/mod.rs::is_native_tool / execute_native_tool`。**无任何工具走 JS 桥**。
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
- **工具调用折叠**：行模型 `message-list/rows.ts` —— 连续工具调用合成一组；`tail` = **尾部段**（后面再没有可见气泡的那组）**默认展开**（agent 还在干活时折起来就看不到进展），用户点过则以用户的选择为准（`use-message-list` 的 `openGroups` 只存用户表态）。
  ⚠️ `tail` 判定只认**可见气泡**（`messageHasVisibleContent`）：`tool` 结果与空壳 assistant 不算（否则工具调用之间会闪折叠），而组的**段首正文**对**前面**的行算（否则中段正文切开的两段会双双误判成尾段）。
- **待应答交互并发**（AI 提问 + 授权确认同时挂起）：队列与展示焦点在 `modals/pending-interactions.ts`（纯函数），弹窗调度 `components/tool-ui.tsx`，导航条 `modals/pending-switcher.tsx` —— **一次只展示一个弹窗**，新到的**不抢焦点**（只挂未读点），点条或 `Alt+←/→` 切换（先去答别的、再切回来接着答）。
  ⚠️ 队列里**每一项都常驻挂载**（只有当前项 `visible`），且 `useToolUI` 返回的是**元素**而不是 `useCallback` 内联组件 —— 后者每次渲染都换组件类型，React 会把弹窗整体卸载重挂，草稿（已勾选选项 / 自定义输入）与输入焦点一起丢。
  ⚠️ 服务侧 `services/tool-service/{user_choice,command_confirm}.ts` 的待应答槽位是**多槽 Map（`pendings`，按 interactionId）**而不是单槽：AI 并行发两次提问 / 并行跑两条命令时，单槽会让上一条的 resolve/reject 被后到的顶掉（用户回答它时「弹窗关了、引擎没收到」）。别再改回单槽；回归在 `tests/infrastructure/command-approval.test.ts`。
  ⚠️ **暂存 → 恢复的草稿**：`modals/choice-drafts.ts`（键 `sessionId|toolCallId`）—— 暂存（shelve）保留草稿、恢复时预填（勾选 / 自定义输入 / 展开态）；应答 / 取消 / 收敛一律清掉。**别用 interactionId 当键**（每次都换，恢复后找不到），也别用 visible 重置表单（切走再切回也要保留）。
- **组件事件**：跨层通信用 `src/events/*` 的 EventEmitter（**禁止 `window.*` 全局挂载**）。
- **样式**：组件目录内 `style.scss`（或 `style.module.scss`），跟随 BEM 类名；主题变量在 `ui/styles/theme.css`。
- **通用控件**：开关用 `ui/components/shared/Toggle`（`size: sm/md/lg` 三档，`virlen-toggle` 命名空间；`md` 与老 `.toggle` 视觉一致）。
  ⚠️ 老页面那套 `<label class="toggle"> + .toggle-slider` 是**全局约定类**，在 general / editor / provider / security 的 scss 里各拄了一份，尚未迁移；新代码请用组件，**别再用 `.toggle` 命名新样式**（会被 `.settings-panel .toggle ...` 这类跨层选择器意外命中）。

### 5.8 埋点与诊断

- `track('domain.action', props)` / `trackPerf` / `startSpan`（`utils/telemetry`）。命名 `域.动作`（如 `chat.message.send`、`engine.iteration.verify`、`session.create`）。
- **默认关闭**（`telemetryEnabled`），必须保持「关闭时零开销」。
- Rust 侧 `src-tauri/src/telemetry.rs` 做 panic 桥（落盘 + 前端就绪后拉取）。
- 密钥打码：`utils/telemetry/redact.ts`、`isSensitiveKey()`。事件名沿用 `域.动作`，公共字段由前端补齐。
