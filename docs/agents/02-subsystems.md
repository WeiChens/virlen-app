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
> **37 个工具已全部原生化**（S5 补齐 `web_fetch` / `web_search`，P1 补齐 `memory_*`，后台服务补齐 `service` 四件套，文档解析补齐 `parse_document`，交付物补齐 `present`）——`is_native_tool` 就是全集，**没有工具再走 JS 桥**。
Rust 只使用前端组装好的 `session.systemPrompt`（为空时回退 `"你是一个有用的 AI 助手。"`）。完整清单见 `docs/rust-engine.md`。

> ⚠️ **改引擎语义（LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销）只需改 Rust**（`virlen-core`）；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装 / 事件契约）仍须与 Rust 同语义（铁律 1）。

### 5.2 工具系统——能力扩展的唯一入口

- **注册制**：`toolRegistry.register(name, executor, label?)`；不写全局函数表。
- **定义与执行器分离，且定义只有一份（机制 C）**：工具定义在 **Rust 侧权威源** `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`（37 工具 × 三平台变体 `windows`/`macos`/`linux`，键名与 `std::env::consts::OS` 同词表）；前端只注册执行器 + UI 文案（`label` 走 i18n，**不进契约**）。读取一律 `await toolRegistry.listDefinitions()`（**异步**接口），返回「契约 ∩ 已注册执行器」。详见 `docs/rust-engine.md` §12。
- **会话工具白名单**：`session.allowedTools` 的三态语义（`undefined` = 全部 / `[]` = 一个都不给 / 名单 = 按名单、顺序仍以契约为准）只在 `src/domain/tools/allowed.ts::filterAllowedToolDefs` 实现一份 —— 引擎组装请求（`services/rust-engine.ts::resolveToolDefs`）与轨迹检查器的「工具」页（`components/trajectory/trajectory-tool-catalog.tsx`）共用，禁止另写一份过滤。
- **12 大分类 / 37 个工具**（`src/domain/tools/category.ts` ↔ `src/infrastructure/tools/<分类>/`）：

  | 分类 id | 目录 | 工具数 | 代表工具 |
  |---|---|:--:|---|
  | `file` | `tools/file/` | 10 | read_file / write_file / edit_file / delete_file / copy_move_file / list_files / file_info / mkdir / parse_document（**文档解析**：PDF / Office / CSV，实现在 `doc_parse`）/ present（**交付物**：声明已有文件 → 右侧面板打开，不复制内容；**只接受面板能预览的类型**，其余记 skipped 报错而不开标签 —— 清单 `native_tools/file/preview_ext.json` ↔ TS 镜像 `domain/files/preview.ts`，由 `src/tests/contracts/present-preview-ext.test.ts` 守） |
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

- **原生化（37 个 = 全部）**：`file`(10) + `search`(2) + `execute`(2) + `service`(4) + `knowledge_base`(6) + `plan`(1：`todo_write`) + `system`(2：`user_choice` / `get_current_time`) + `chat`(2：`list_messages` / `read_messages`) + `memory`(3：`memory_search` / `memory_recall` / `memory_write`) + `skill`(2：`list_skills` / `read_skill_source`) + `vision`(1：`vision_analyze`) + `web`(2：`web_fetch` / `web_search`)，分发在 `src-tauri/virlen-core/src/agent/native_tools/mod.rs::is_native_tool / execute_native_tool`。**无任何工具走 JS 桥**。
  - `web_search` 的搜索源配置由引擎经 `NativeToolCtx::settings` **直读 `app_settings`**（与「忽略沙盒命令」规则同一份来源）→ CLI 同样可用；
  - `web_fetch` 的 HTML→Markdown 用 `htmd`（TS 侧是 `turndown`）——**Markdown 细节两侧不完全一致**（已知差异，见 `docs/rust-engine.md` §3）。
  - `memory_*` 的语义实现在 `agent::memory::tools`（**与 GUI 命令 `cmd_memory_*` 共用一份**），详情正文落专用知识库（`记忆详情`，`kb_id` 缓存在保留设置键 `__memoryKbId`）。
  - **再蒸馏（P2′，已实施）**：AI 写下的候选 ≥ 100 条时，宿主在**后台**把同一项目作用域内的若干条记忆交给模型合并成更少的条目（用户无感：无 UI / 无审批；逃生开关 `memoryRedistillEnabled` 默认开、不进 UI）。旧条目**只停用不删除**（`disabled` + `superseded_by`），原文（含它自己的详情正文）进新条目的**归档详情**；保留 30 天后由归档清理按**四条护栏**硬删（缺一不删，最关键的一条：它指向的新条目仍在且有归档详情）。落点：`agent/memory/redistill/`（`plan` 纯逻辑 / `parse` 模型输出 / `apply` 落库 · 归档 · CAS 停用 · 清理 / `sched` 队列 + 宿主 trait / `models` 候选链）、提示词 `prompts/memory-redistill.md`、流水表 `memory_redistill_runs`（主键 = 批次指纹，**不占 `SCHEMA_VERSION`**）。触发点 = 写路径闸门（`memory_write` / 面板保存）+ 宿主启动一次，**不引入定时器**；方案与口径见 `docs/memory-redistill-plan.md`。
- **原生工具的会话库依赖**：需要读写会话库的工具（消息查询）从 `ctx.repo: &dyn SessionRepo` 取（由引擎注入；`repo.is_available()` 为 false 时如实回「本地存储不可用」）—— 与 `ctx.security` 同一种显式注入。
- **原生工具的长期记忆依赖**：`memory_*` 从 `ctx.memory: &dyn MemoryRepo` 取（同样由引擎注入，与会话库**共用同一把连接锁**；`is_available()` 为 false 时如实回「本地存储不可用」）；详情知识库经 `ctx.settings`（`__memoryKbId` 缓存）+ 进程级 RAG 服务，RAG 未初始化时降级为「不落详情 / 读不到详情」，不牵连记忆条目本身。
- **原生工具的技能依赖**：技能工具从 `ctx.skills`（本 agent 启用的技能名）+ `ctx.security.skills_dir` 取数，**自行扫盘解析 SKILL.md**（不依赖前端 localStorage 注册表，CLI 同样可用）。
- **原生工具的宿主依赖**：需要「资源目录 / 数据目录在哪」的工具（`vision_analyze` 的模型文件）从 `ctx.host: &dyn HostEnv` 取。宿主差异只有两份实现 —— GUI `host::TauriHost`（`resource_dir()` / `app_data_dir()`）、CLI `host::CliHost`（环境变量 + exe 位置）；**引擎核心（含 `native_tools/**`）不得出现 `tauri::`**，这是 headless 的前提。详见 `docs/host-abstraction-draft.md`。
- **模型侧文案一律英文（D2-A）**：工具返回给 LLM 的文本（`content`、抛出的错误、引擎迭代 / 验证反馈、系统提示词）固定英文且**不进 i18n** —— 否则 Rust 原生工具与 JS 执行器（Rust 回调）、中 / 英界面会产出不同文本。界面展示改由**结构化 `uiData`** 按界面语言重建（组件优先渲染 `uiData`，缺失时回退 `content`，如 `tool-call/TerminalBlock.tsx::displayNote`）。因此：改 TS 执行器文案**必须与 Rust 原生实现逐字对齐**（铁律 1），新增返回值务必同时给出语言无关的 `uiData` 字段。
- **跨层单例**：`src/infrastructure/tools/output-store.ts`（UI/services/engine 均引用）不归属任何分类，留在 tools 根目录。
- **UI 渲染**：`src/ui/pages/chat/components/tool-call/<Tool>Message.tsx` 实现 `IToolCallMessage` 并 `register(...)`；未注册自动落 `DefaultMessage`。

### 5.3 持久化与数据

- **会话消息**：Rust 侧 `src-tauri/virlen-core/src/session_db/`（已从单文件拆分为 16 文件目录）。
  分层：`types.rs`（IPC DTO）/ `repo.rs`（trait + Noop）/ `schema.rs`（DDL + 迁移）/ `row.rs`（行映射）/ `message_query.rs`（消息检索与查询）/ `usage.rs`（用量账本）/ `settings.rs`（应用设置）/ `memory.rs`（长期记忆 + `MemoryRepo`）/ `sqlite.rs`（实现）/ `commands.rs`（20 个 `cmd_*`）/ `tests/`。
  SQLite + WAL + 单写连接 + `spawn_blocking`；**先落库再 emit**。
  ⚠️ 打开库的入口分两层（配置下沉 D3 的前置）：**零 `tauri::`** 的 `commands::open_session_db(host, spawn)`（库路径 = `host.data_dir()/virlen.db`，返回 `SessionDb { repo, settings, memory, maintenance }`，后台任务由宿主传入的 `spawn` 派发）+ GUI 薄壳 `init_session_db(app)`（构造 `TauriHost` + `app.manage(...)`）。
  ⇒ 「会话库 / 配置在哪」只由 `HostEnv::data_dir()` 决定 —— CLI 传 `$VIRLEN_DATA_DIR` 就与 GUI 共用**同一份** `virlen.db`。
- **前端封装**：`src/infrastructure/sessionRepo/`（`cmd_list_sessions / cmd_get_session / cmd_get_messages / cmd_get_message_page / cmd_upsert_session / cmd_delete_session / cmd_replace_session_messages / cmd_append_messages` …）。
  启动只加载会话**元数据**，消息**懒加载**（`sessionStore.ensureMessagesLoaded`）。`utils/db.ts`（IndexedDB）已废弃删除，**不要复活**。
- **用量账本（token 统计）**：账本 DTO / 聚合 / 明细在 `session_db/usage.rs`；前端 `statsRepo/`、`usage-ledger/`、`services/token-stats-service.ts`。
  ⚠️ **Rust 只回 token 数，费用一律前端算**；内置价目表固定存 USD（`src/domain/pricing/index.ts`），切币种时按固定汇率折算。
- **删会话就要真回收空间**：`delete_session`（`sqlite.rs`）在事务提交后调用 `maintenance::reclaim_after_delete` ——
  `auto_vacuum=INCREMENTAL` 的库走 `incremental_vacuum`（空闲页归还、文件收缩）；还是 `off` 且本次释放 ≥ 4 MB 时
  一次性 `auto_vacuum=INCREMENTAL; VACUUM;`（模式写进库头，之后每次删除都只付增量回收）；末尾再 `PRAGMA wal_checkpoint(TRUNCATE)`
  让 `-wal` 归零。同一事务里还要删该会话的 `compactions` 行（`usage_ledger` 仍**故意不删**：用量是已发生消费的事实记录）。
  ⚠️ `PRAGMA incremental_vacuum` 是「**每 step 搬一页**」，`execute()` 只 step 一次（7 个空闲页要 7 次）——必须 step 到 DONE，
  否则看起来就像「回收没生效」。守卫：`session_db::tests::sessions::delete_reclaims_freed_space`。
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
| **跨平台沙盒** | `infrastructure/sandbox/*` + `src-tauri/virlen-core/src/sandbox/` | Windows：Job Object + 受限令牌 + ACL；Linux：Landlock（默认拒写）；macOS：`sandbox/macos/mod.rs`。**禁止绕过沙盒直接 spawn**。可写根 = workspace + 白名单 + **平台临时目录**（`sandbox::temp_write_roots`，仅默认模式/写隔离；Windows `%TEMP%`、Linux `$TMPDIR`|`/tmp` + `/var/tmp`、macOS 由 Seatbelt profile 放行 `/private/tmp` + `/var/folders`；`readonly` 下 Windows/Linux 不授予任何写根，macOS 仍保留临时目录）、**cwd 落在某临时目录内时该目录不授予**（否则等于开放工作目录的父级，与下面跳过白名单祖先目录同一条规则）。除此之外**不自动豁免**包管理器缓存（`~/.npm` / pnpm store / `~/.cargo`…）等区外目录——该「环境探测 + ACL 授予」机制已**整体移除**（实测不好用），要放行区外写入请让命令命中下方「忽略沙盒命令」规则 |
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
- **图片预览 OCR（只识别文字）**：大图浮层 `shared/ImagePreview` 与工作目录 `workspace-file/image-viewer` 共用 `hooks/useImageOcr` + `shared/ImageOcr`，**不调 `vision_analyze`**（UI 组件 / 图标 / 物体检测一概不做）。两条行为口径：① **文字层默认收起**（"默认不显示识别文字"）；② **是否在打开预览时自动识别由设置 `imageOcrAutoPreview` 控制**（默认关：点工具栏「识别文字」才开始；开着则打开即跑一次）。工具栏按钮始终在（`ready` / `loading` / 无字 / 失败都能点：没跑过就跑、识别完就收起/展开）。结果按**内容指纹**（sha256）落盘到 `<data_dir>/image-ocr-cache.json`：同一张图（文件路径 / data URL / blob URL 三种身份）只算一次，命中时连模型都不加载。
  ⚠️ **空结果不落盘**：quasivision 的 `detect_text` 会把「引擎未就绪 / predict 失败」吞成空文本（只往 stderr 打一行，GUI 看不见），与「图里真没字」无法区分 —— 写进缓存就把一次瞬时失败永久固化了（实测踩过）。读盘时也会丢掉历史遗留的空条目（自愈）；空结果额外自动重试一次（`OCR_RETRY_DELAY`），界面再给一颗带 `force`（绕缓存重算）的「重新识别」。
  ⚠️ **预览 OCR 用「轻量常驻引擎」**（`vision::ocr_preview_at` + `ensure_ocr_engine`：只 `text_detection::init_ocr()` 加载 det+rec，不要 `init_models`）。走过一次全流水线生命周期的坑：`init_models` 会把图标分类器 + YOLO 也建一遍、用完再 `clean_models` 全拆 —— 预览每次都要为此付几秒，而重算一个内容指纹缓存未命中的图只需求 OCR。dev/release 实测（1389×725 截图 / 16 个文本区域）：整套重建每次 ~8–11s → 轻量常驻后首次 ~5.7s、之后 ~3.2s、缓存命中 0ms；DirectML 比纯 CPU 快一倍（2.7s vs 5.4s），`intra_threads` 与输入尺寸（1200 vs 960）几乎无影响，`region_batch_size` 8 略优于 16（但那是 quasivision 内部常量，外部改不了）。仍未动的 ~2.6s 是模型推理本身（16 个区域的识别），要再快只能换/自建 OCR 管线。
  **透明定位层**：识别结果不止给拼好的文本，还给**逐框坐标**（`vision::OcrBox`：原图像素 `x/y/w/h`，`detect_text` 已把降采样坐标还原回原图空间，不需要二次推理）。前端 `shared/ImageOcr` 的 `ImageOcrPlane` 把每一框渲染成一个绝对定位的 `<span>`：`left/top/width/height` = 框 ÷ 原图尺寸（百分比）、`color: transparent`（只有 `::selection` 可见）、字号取 `--ocr-line` = 框高 ÷ 原图高 × 100`cqh`（容器查询单位 ⇒ 缩放 / 改窗口自动跟随，零 JS 量尺寸）。层本身 `pointer-events: none`（空白处拖动 / 滚轮缩放照旧），只有文字行吃事件 ⇒ 文字上拖动 = 选中、空白处拖动 = 平移。**字号被钉成框高之后字体步进宽度与图上真实字形并不一致**：不校正时“选中高亮”会明显比文字长一截（中文字宽 ≈ 1em、而 det 框是贴着真实字形量的）。所以 `OcrRun` 挂载 / 尺寸变化时量一次自身长度（`offsetWidth/offsetHeight`，布局尺寸，不含祖先缩放），按 `框长 ÷ 文字长` 做 `scaleX`（左端对齐）把高亮校回框上 —— **span 沿阅读方向用 `width: max-content`（而不是钉成框宽），否则 `scaleX` 会把盒子也一起缩，字反而比框短一截**；文字透明，形不变，只影响高亮与拖选范围；jsdom / 未布局时量不到就跳过（默认 1）。**高亮的高度也必须 clip 到框内**：浏览器画选区高亮走的是**字形上下沿**（ascent+descent ≈ 1.15em），而这一行的盒子是 `line-height: 1`（1em），不 clip 时拖选的蓝色比 hover 的蓝色高一截（`.image-ocr-run { overflow: hidden }`，见 `tests/ui/image-ocr-style-contract.test.ts`）。两处预览为此把 `transform` 从 `<img>` 上移到 `.image-preview-anchor` / `.wfp-image-anchor`，文字层与图片同级挂在该锚点里，才跟着一起平移 / 旋转 / 缩放。**摆不出位置就退回纯文本面板**：没有框（v1 老缓存）或 `naturalWidth/Height` 与 OCR 坐标系对不上（手机照片的 EXIF 旋转，浏览器显示已转、OCR 跑的是未转像素）。缓存 `VERSION 2`：条目多了 `boxes/width/height`，v1 文件整份丢弃重算。
  ⚠️ **跨行拖选复制要自己补换行，而且分隔符按框的几何算**：每行是独立元素，浏览器把跨元素的选区序列化成纯文本时**不补 `\n`**（选了两行、粘出来挤成一行）。所以 `OcrLayer` 在 `document` 上接 `copy`（事件打在焦点元素 / `body` 上，不保证落在文字层里），用 `selectedLinesText` 逐行取「选区与该行的交集文本」，分隔符交给 `lineSeparator`：两框在**垂直于阅读方向的轴**上重叠 > 75%（竖排则改看水平）就当同一行 → **一个空格**（det 把一行切成两框、表格同一行的相邻单元格）；否则 **至少一个 `\n`**，再按 `间隙 ÷ 行厚` 补到最多 3 个空行（段落间距 / 表格行距不粘连）。坐标从每行 `<span>` 的 `data-ocr-box` 读回（**原图像素**，不受祖先 `transform` 影响），读不到就退回「一行一个换行」；选区有一端在层外（或在小条上）就不接管，原样交给浏览器。
  **文字层里的右键菜单**：本窗口全局 `preventDefault` 了 `contextmenu`（原生菜单不出现），所以文字层上右键不能再“让给系统”——两处预览改成弹「复制 / 全选」（`ocrTextMenuItems` + `selectAllOcrText`，实现在 `menus.ts` 的 `textMenuItems` 上扩展 `getSelected`）：**开菜单那一刻**就把选区快照拓下来（点菜单项时的 `mousedown` 多半已经把网页选区折叠，运行时现取只会拿到空串），无选区时「复制」= 整段文字；「全选」是 `keepOpen`，选完可以直接接着点复制，复制仍走按行拼的路（换行不丢）。图片本体上右键仍是图片动作（复制图片 / 另存为…）。
- **RAG 知识库**：`src-tauri/virlen-core/src/rag/`（`document.rs` / `embedding.rs` / `vector_store.rs` / `rag_service.rs`）+ `services/rag-service.ts` + `infrastructure/rag/`。向量索引用 turbovec。
- **Skill**：`src/skill/`（加载 / 注册 / 导入 / 广场）+ 内置包在 `src-tauri/resources/default-skills/<name>/SKILL.md`。

### 5.7 前端 UI 与状态

- **MobX 单一 store + `StorageState`**（`utils/storageState.ts`，localStorage，key 前缀 `_storage_state_`）。
  核心 store（`src/ui/store/`）：`settingStore`（全部设置 + 一次性迁移）、`sessionStore`（会话 CRUD + 消息懒加载）、`agentStore`、`securityStore`、`sessionRuntimeStore`（working / pendingContent / traceId）。
- **页面**：`ui/pages/chat`（chat-view 31 KB）、`ui/pages/Settings`、`ui/pages/setupFlow`。
- **窗口与入场启动屏**：无边框自绘（`ui/layout/WindowLayout`）。`tauri.conf.json` 里写着 `visible: false`，但 **Rust `setup` 里立刻 `show()`**（macOS 上 `visible:false` 会阻止 WKWebView 加载 JS）→ 「窗口可见」远早于「App 首帧」，这段空窗期由 `index.html` 里**内联**的 `#boot-cover` 填满（不依赖 vite 产物与 React）：`#boot-titlebar` 是同款自绘标题栏（同一个 `--window-top-bar-height`，logo + 标题 + 最小化/最大化/关闭），`#boot-splash` 是内容区（logo + 进度条 + 呼吸/流光动画）。文案 / 进度 / 失败态由 `src/boot/splash.ts` 驱动（`main.ts` 的 `step()` 每完成一步推一格，`render()` 后等两次 rAF 淡出并移除，两次而不是一次：React 提交与样式/绘制落地是两帧）。启动失败走 `bootSplash.fail()`（错误正文 + 重试 → 整页 reload，**标题栏保留** —— 那时最需要能关窗口），**不允许留在白屏或停在半路的加载动画上**。
  ⚠️ 启动屏本体是 HTML/CSS（不是组件）：改成 React 组件等于把这个空窗期重新变回白屏。
  ⚠️ **内容区必须从标题栏下方开始**（`top: var(--window-top-bar-height, 30px)`，与项目里所有全屏遮罩同一口径）：盖住标题栏 = 加载期间窗口既拖不动、也点不到按钮，卡住时只能杀进程。链由 `tests/boot/splash-style-contract.test.ts` 守。
  ⚠️ 标题栏三枚按钮的点击处理器在 bundle 就绪后由 `bootSplash.bindWindowControls(getCurrentWindow())` 挂上（拖拽不需 JS，`data-tauri-drag-region` 是 Tauri 自己处理）；关闭走 `Window.close()` 而不是直接退出 —— 「关闭 ≠ 退出」的判定在 Rust 侧。
  ⚠️ **主题色 / 深浅档在启动屏上也是对的**（分两步）：`index.html` 里的内联脚本先读 localStorage 缓存（`virlen-boot-accent` / `virlen-boot-theme`，由 `ui/theme/bootAppearance.ts` 在设置变更时写）涂一遭近似值（暗色档用 `color-mix`，系数同 `$accent-mix-dark-bar-primary`）；`main.ts` 的 `settings` 步骤后用 `bootSplash.applyAppearance()` 换成 `accentTokens()` 的精确值（含 `--primary-bar-fg` 的前景判定）。缓存**不是设置源**，只影响启动画面；键名被内联脚本按字面量读，改名必须两边同步（`splash-style-contract` 用例守）。
  ⚠️ `init()` 的分批直接决定首屏时长：阶段 0 只留真正有顺序的三步（`settings` → `codeDisplay` → `zoom`），其余互不依赖的水合 / 注册全进阶段 1 的 `Promise.all`，只有 `initDefaultAgent()`（要 agents + 工具定义）和 `initDefaultSecurity()`（要 securityStore）在阶段 2。**往阶段 0 加一步 = 直接加在首屏时长上**。
- **外观落地**：`ui/hooks/` 下 `useTheme`（`<html data-theme>`）/ `useAccentColor`（`data-accent` 或注入样式表）/ `useFontSize`（`<html data-font-size>`，令牌在 `ui/styles/theme.scss`）都走「mount 时应用一次 + MobX `reaction` 跟随设置」；`useZoom` 不同 —— 它调 **webview 原生缩放**（`getCurrentWebviewWindow().setZoom`，口径 `domain/zoom`），启动那次由 `main.ts` 的 `step('zoom')` 在 `render()` 前落地（`useEffect` 在首帧之后才跑，否则会先按 100% 画一帧再跳）。
  缩放键 Ctrl/⌘ + `=`（或 `+`）/ `-` / `0` 在 `domain/zoom::zoomCommandOf` 识别，**只写设置**（滑杆 / 落库 / 埋点读的是同一份 `zoomFactor`）；监听在 window **捕获阶段并吃掉事件** —— 焦点在输入框 / Monaco / 终端里也生效，且不把 Ctrl+_ 打进 PTY（readline 的 undo）。
  ⚠️ 原生缩放依赖 capability `core:webview:allow-set-webview-zoom`（`src-tauri/capabilities/default.json`）：漏了不报编译错，只在运行期被 ACL 拒 → 「滑杆动、界面不动」。**缩放过大时 Ctrl+0 是唯一够得着的出路**，因此：范围硬夹紧在 0.5–2.0（`normalizeZoom`），且设置面板宽度是 `min(680px, 100%)` —— 写死 680px 时高缩放下左侧导航会被挤出屏外，那就只能键盘自救。
- **代码编辑器（可编辑 Monaco）**：`ui/components/code-editor/CodeEditor.tsx` + `style.scss`，调用点为工作目录文件编辑与「设置 → 安全 → 忽略沙盒命令」的 JS 规则。
  ⚠️ **查找控件（Ctrl/Cmd+F，右上角搜索框 + 命中高亮）必须自己按需引**：精简入口 `editor.api.js` 只导出 API、一个 contrib 都不带（`editor.main.js` 里那行 `contrib/find/browser/findController.js` 才是它），漏引**不报错**，只是 Ctrl+F 没反应（与 codicon 字体同类坑，§11.53 ㉞）；而且 contrib 是**构造编辑器时**按注册表取的，晚于构造引入无效 —— 只能在组件模块顶层引。只读预览 `CodePreview` 不引（`tests/ui/code-editor-find.test.ts` 守这三条），但 **contrib 是全局注册的**，所以预览 / 差异视图里按 Ctrl+F 也会开查找框 —— 它们都靠 `src/monaco/findWidget.ts::tameFindWidget` 收口（`CodeEditor` / `CodePreview` / `MonacoDiffView` 三处都接）：① 捕获阶段吞掉 `.find-widget` 内的 `mouseover`，气泡是 `setupDelayedHover` 从 `mouseover` 长出来的，断在源头就不依赖它挂在哪个节点（气泡宿容就是编辑器容器、`overflow: hidden`、查找框又贴顶边，必被切一半；`aria-label` 仍在，无障碍名不受影响）；② 查找框是 overlay widget（钉在编辑器顶部、不随编辑器内部滚动而移动）。**只读预览的纵向滚动 2026-10 起归 Monaco 自己**：`CodePreview` 的 `maxContentHeight`（`CodeBlock` 把 `maxHeight` / 全屏可用高度换算成像素）一夹住，高度就钉在上限、`scrollbar.vertical` 从 `hidden` 切成 `auto`，走库自带滚动条；外层 `.code-block-wrapper` 不再 `overflow: auto`（外层滚动的旧版会把查找框一起滚出视野，这正是当初加夹紧的原因；回退层 `<pre>` 自己滚）。`tameFindWidget` 的夹紧逻辑保留作兜底：编辑器上半被消息列表 / 弹窗裁掉时仍把 `top` 顶到可见交集里（整体可见时 offset 恒为 0）。另外两处预览都关了 `find.addExtraSpaceOnTop`（否则 Ctrl+F 会插 33px view zone，「没超上限」的代码块会凭空长高 33px）。浮层配色（`input.*` / `editor.findMatch*` / `editorWidget.foreground`）在 `domain/code-display/themes.ts`（CSS 侧另有一道 `.code-editor .monaco-hover` 兜底）：「其余命中」必须半透明 —— 命中底色画在选区**之上**，不透明就把选区盖住。查找框三个开关（区分大小写 / 全字 / 正则）的悬浮气泡**已关掉**（机制见上面的 `tameFindWidget`）。
- **文件面板的预览**（右侧 `side-panel` 里的 `workspace-file`）：判定唯一源 `domain/files/preview.ts`（扩展名 → `text` / `image` / `audio` / `video` / `pdf` / `document` / `sheet` / `model` / `other`）；文本里 `md` / `html` / `svg` 与 `csv` / `tsv` 多一个「预览」tab（渲染的是**草稿**，所见即当前所改）。
  - **读取 / 解析中统一是一颗转圈 + 一句话**（`workspace-file/loading-icon.tsx` → `.wfp-spinner`）：读文本、等媒体 blob、等 HTML 预览基址、PDF 打开、模型解析都用它，**不再显示裸文字**；内容没到之前不挂空编辑器（空编辑器会被读成「文件是空的」），模型则把画布用 `visibility: hidden` 藏起来（`display: none` 会让 `ModelScene` 量到 0 从而永不渲染）。⚠️ 转圈必须带 `will-change: transform` —— three 解析 glb / pdfjs 栅格化会占住主线程，不提升成独立合成层动画会跟着停（看起来像卡死）；这两条由 `model-preview-contract.test.ts` 守。
  - `pdf`：**前端 pdfjs 按页栅格化**（`workspace-file/pdf-view.tsx`：模块懒加载 + 滚到附近才画 + 适应宽度）；Core 只做纯 Rust 文本抽取、不做页面栅格化（见 `doc_parse::pdf` 模块头）。
  - `docx`/`doc`/`pptx`/`ppt`/`xlsx`/`xls`：Rust `cmd_preview_document`（`doc_parse::preview`）→ 文稿给 **Markdown**（`MarkdownRenderer` 渲染）、表格给每张工作表一份 `行 × 列` 网格 + **合并区域坐标**（`SheetView` + `DataTable`，行号 / 列标 / `colspan`·`rowspan` / 截断提示；坐标→span 的换算在 `domain/files/sheet-spans.ts`，按物化窗口裁、被覆盖格记 `null` 不画）。⚠️ 与 `parse_document` 是**同一套抽取**（`office::extract_text` / `office::preview_grids`、合并区域同走 `parse_a1_range`），不许在前端另解 OOXML。
  - ⚠️ 物化上限（正文 300k 字符 / 每张表 500 行 × 40 列）**只限制物化**：真实总量（`charCount` / `rowCount` / `colCount`）必须如实报出，界面据此提示「只显示前 N 行」。
  - ⚠️ pdfjs 的 `cmaps` / `standard_fonts` 要在运行时可取（中文 PDF 没嵌字体时，缺 cMaps 会整段空白）：由 `vite.config.ts` 的 `pdfjsAssets` 插件在 dev 直接服务 `node_modules`、build 时 emit 到 `/pdfjs/…` —— 不要往 `public/` 里塞那 185 个二进制文件。
  - `model`（3D 模型，13 种：`glb`/`gltf`/`fbx`/`obj`/`stl`/`ply`/`dae`/`3ds`/`3mf`/`amf`/`wrl`/`vrml`/`pcd`）：**前端 three 渲染**（`workspace-file/model-view.tsx` 工具栏 + `model-scene.ts` 场景 + `model-loaders.ts` 注册表）。四个口径：① 扩展名唯一源是 `preview.ts::MODEL_EXTENSIONS`，注册表用 `Record<ModelExtension, …>` 做**穷尽检查**（那边加格式忘了加加载器 → 编译期报错）；② three 与各个 loader 全靠 `import()` **懒加载**（只有打开模型才下载，主包不动），所以 `model-view` 只能静态引纯数据 `model-presets.ts`；③ Draco 压缩网格 / KTX2 压缩贴图的解码器**不用自己搬** —— `DRACOLoader` / `KTX2Loader` 默认用模块内 `new URL('../libs/…', import.meta.url)`，build 时被 emit 成资产（离线可用）、dev 时直接服务 `node_modules`（构建产物里会多出非 gltf 那份兜底解码器 ≈1MB，是 three 模块级 `new URL` 的副作用，运行时不下载）；④ 面板只拿**一个文件**的字节 → 引用外部 `.bin` / 贴图的 `.gltf` 在解析前就拒（`ModelLoadError` 的 `external-resources`），贴图加载失败静默（`LoadingManager.onError`），外部贴图只会让模型少层皮、不该刷一屏 404。另：`pdb` 仍归「其它」（同名扩展名是 MSVC 程序数据库）；隐藏标签（0 尺寸）时 `ModelScene` 自己停渲染、关标签即 `dispose`（几何 / 材质 / 环境贴图 / renderer 全释放）。
  - ⚠️ **PMREM 源贴图宽度不能给成 1**（真踩过，表现是「模型一片空白」）：`PMREMGenerator._fromTexture` 对等距柱状贴图取 `texture.image.width / 4` 作为 cube 尺寸，宽 1 → cube 0.25 → 生成的 CubeUV **高 1px** → three 把 `CUBEUV_TEXEL_HEIGHT` 定义成整数字面量 `1` → 片元着色器 `uv.y *= CUBEUV_TEXEL_HEIGHT` 编译失败（`cannot convert from 'const int' to 'highp float'`）→ 带 `envMap` 的材质全部画不出。梯度画布现为 64×32，且 `model-scene.ts::applyPreset` 有 `target.height >= 2` 兜底（不满足就保留旧环境贴图）。同批 r186 变更：`PCFSoftShadowMap` 已移除（用 `PCFShadowMap`）、`THREE.Clock` 已废弃（用 `THREE.Timer`）。
  - ⚠️ **`vite.config.ts::optimizeDeps.exclude` 必须留着 `three/examples/jsm/loaders/{DRACOLoader,KTX2Loader}.js`**：它们靠 `new URL('../libs/…', import.meta.url)` 定位解码器，被预打包后那几行会被重写成 `/node_modules/.vite/libs/…`（**那个目录不存在**）—— dev 下 Draco 压过的 glb 静默解不出来（报的是 wasm 解析错，很难归因），生产构建不受影响。`model-preview-contract.test.ts` 守这条。
- **性能**：消息列表 `@tanstack/react-virtual` 动态高度虚拟滚动 + 分页（改 `message-list.tsx` 注意 `measureElement`）。
- **工具调用折叠**：行模型 `message-list/rows.ts` —— 连续工具调用合成一组；`tail` = **尾部段**（后面再没有可见气泡的那组）**默认展开**（agent 还在干活时折起来就看不到进展），用户点过则以用户的选择为准（`use-message-list` 的 `openGroups` 只存用户表态）。
  ⚠️ `tail` 判定只认**可见气泡**（`messageHasVisibleContent`）：`tool` 结果与空壳 assistant 不算（否则工具调用之间会闪折叠），而组的**段首正文**对**前面**的行算（否则中段正文切开的两段会双双误判成尾段）。
- **待应答交互并发**（AI 提问 + 授权确认同时挂起）：队列与展示焦点在 `modals/pending-interactions.ts`（纯函数），弹窗调度 `components/tool-ui.tsx`，导航条 `modals/pending-switcher.tsx` —— **一次只展示一个弹窗**，新到的**不抢焦点**（只挂未读点），点条或 `Alt+←/→` 切换（先去答别的、再切回来接着答）。
  ⚠️ 队列里**每一项都常驻挂载**（只有当前项 `visible`），且 `useToolUI` 返回的是**元素**而不是 `useCallback` 内联组件 —— 后者每次渲染都换组件类型，React 会把弹窗整体卸载重挂，草稿（已勾选选项 / 自定义输入）与输入焦点一起丢。
  ⚠️ 服务侧 `services/tool-service/{user_choice,command_confirm}.ts` 的待应答槽位是**多槽 Map（`pendings`，按 interactionId）**而不是单槽：AI 并行发两次提问 / 并行跑两条命令时，单槽会让上一条的 resolve/reject 被后到的顶掉（用户回答它时「弹窗关了、引擎没收到」）。别再改回单槽；回归在 `tests/infrastructure/command-approval.test.ts`。
  ⚠️ **暂存 → 恢复的草稿**：`modals/choice-drafts.ts`（键 `sessionId|toolCallId`）—— 暂存（shelve）保留草稿、恢复时预填（勾选 / 自定义输入 / 展开态）；应答 / 取消 / 收敛一律清掉。**别用 interactionId 当键**（每次都换，恢复后找不到），也别用 visible 重置表单（切走再切回也要保留）。
- **组件事件**：跨层通信用 `src/events/*` 的 EventEmitter（**禁止 `window.*` 全局挂载**）。
- **工作目录树**（`sidebar/workspace-tree.tsx`）：`. 开头`的**文件**不隐藏（`.env` / `.gitignore` / `.github` 是要编辑的正文，藏起来会让人以为目录里没有它）—— `list_directory` 与 `search_files_by_name` 都传 `includeHidden: true`；但**系统隐藏项**（`.git`：Windows 隐藏位 / macOS `UF_HIDDEN`）Rust 侧一律不列（`search::is_hidden_by_attr`，无条件生效，`include_hidden` 只放开点前缀约定）。搜索另按 `skipDirNames` 剪掉 `.git` 内部（macOS / Linux 上它不一定带隐藏位，且对象文件海量）。路径补全（`input/path-autocomplete.tsx`）与手机端文件浏览（`bridge/file-source.ts` 的 `listFiles`）同口径，改一处要同步另两处。
- **样式**：组件目录内 `style.scss`（或 `style.module.scss`），跟随 BEM 类名；主题变量在 `ui/styles/theme.css`。
- **通用控件**：开关用 `ui/components/shared/Toggle`（`size: sm/md/lg` 三档，`virlen-toggle` 命名空间；`md` 与老 `.toggle` 视觉一致）。
  ⚠️ 老页面那套 `<label class="toggle"> + .toggle-slider` 是**全局约定类**，在 general / editor / provider / security 的 scss 里各拄了一份，尚未迁移；新代码请用组件，**别再用 `.toggle` 命名新样式**（会被 `.settings-panel .toggle ...` 这类跨层选择器意外命中）。

### 5.8 埋点与诊断

- `track('domain.action', props)` / `trackPerf` / `startSpan`（`utils/telemetry`）。命名 `域.动作`（如 `chat.message.send`、`engine.iteration.verify`、`session.create`）。
- **默认关闭**（`telemetryEnabled`），必须保持「关闭时零开销」。
- Rust 侧 `src-tauri/src/telemetry.rs` 做 panic 桥（落盘 + 前端就绪后拉取）。
- 密钥打码：`utils/telemetry/redact.ts`、`isSensitiveKey()`。事件名沿用 `域.动作`，公共字段由前端补齐。
