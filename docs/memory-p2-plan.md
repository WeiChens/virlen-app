# 记忆功能 P2 实施文档（蒸馏：让记忆自己长出来）

> 上位方案：`docs/memory-plan.md`（**冲突以它为准**）。P0 见 `docs/memory-p0-plan.md`。
> 本文只覆盖 **P2** 的落地细节与验收，不重新论证设计；已定稿决策见 memory-plan §11。
>
> P2 的定位：**把「前一天各会话的压缩摘要」变成 ≤120 字符的记忆条目**（摘要 → LLM → 记忆），
> 含**降级链**（当天无摘要时用正文摘录）、**模型降级链**（按压缩使用频次排序，3 次尝试）、
> **按天幂等**（`memory_runs`）、**详情落专用知识库**、**用量记账**（`kind='memory'`）。
>
> 完成后能做到：点一次「立即整理昨天」/ 跑一次 `virlen-cli memory consolidate` / 次日打开应用，
> 记忆面板里就多出几条来自真实对话的记忆（其中重要又庞大的内容带详情链接，可被
> `memory_recall` 取回）。

---

## 1. 范围

**做**

1. **收集（Collect）**：`SessionRepo::day_materials(start_ms, end_ms)` —— 当天每个会话取
   **最后一条 `role='summary'`**；无摘要但有对话 → 该会话当天 `user`/`assistant` 正文摘录（**降级链**）；
   两者都没有 → 该天 `status='skipped'`（不调模型、不花钱）。
2. **组装（Assemble）**：新提示词 `virlen-core/src/agent/prompts/memory-distill.md`（英文骨架，
   两个占位符 `{{material}}` / `{{existing}}`），注册进 `PromptTexts` + TS 侧镜像（四处接线）。
3. **蒸馏（Distill）**：一次**非流式** LLM 调用（与 `title.rs` 同构：不落库、不记账），
   严格 JSON → `Vec<DistilledMemory>`；解析失败**整体丢弃**。
4. **落库（Store）**：长度钳制（硬上限 150）→ 规范化去重 → 写 `memories`（`origin='distill'`）；
   `needs_detail` 且正文够长 → 写专用知识库（复用 P1 的 `agent::memory::kb`）并回填 `detail_kb_id` /
   `detail_doc_id`；**详情失败不牵连记忆条目**。
5. **模型选择（§4.3 已定稿）**：候选 = `usage_ledger` 里 `kind='compress'` 的模型按**调用次数倒序**
   （`memoryModel` 设置若给出则置顶）；逐个尝试（要能解析出 enabled 且含模型的 provider 配置），
   **3 次尝试全失败**才记 `status='failed'` 退出，**不写任何记忆**。
6. **编排（Consolidate）**：`agent/memory/consolidate.rs::consolidate_pending()`，`memory_runs`
   按天幂等（抢锁 → 跑 → 落终态），从「最后一个 done 的日的次日」补跑到「昨天」，单次最多
   `MEMORY_MAX_DAYS_PER_RUN`(7) 天。
7. **记账**：`usage_ledger` 新 `kind='memory'`（**四处同步**，见 §6）。
8. **三个触发点**：GUI 启动（`src/main.ts` 的 `step('memory', ...)`，非阻塞、失败只打日志）、
   GUI 面板「立即整理昨天」（`cmd_memory_consolidate`）、CLI `virlen-cli memory consolidate`。

**不做（P3 已完成于 `docs/memory-p3-plan.md` / P4 未做）**

- 常驻定时器 / 后台守护（方案 §1 非目标不变）。
- 去重的**向量**相似度合并（P2 只做规范化后的**完全相同**去重；P3 补的是**词形**近重复合并）。
- 导出 JSON（已随 P3 落地；**不含详情正文**）、按工作目录分区、手机端只读。

---

## 2. 数据与接口

### 2.1 `memory_runs`（P0 已建表，P2 开始写）

字段不变（`day` 主键 = 幂等键）。P2 的**状态机**（写在这里免得各处再解释）：

| 状态 | 含义 | 能否被下次触发覆盖 |
|---|---|---|
| `running` | 正在跑（抢到锁） | 仅在 `started_at` 超过 `MEMORY_RUN_STALE_MS`(10 分钟) 视为崩溃残留，可抢占 |
| `done` | 有产出并写库成功 | 否（幂等：同一天不再跑，除非显式 `force`） |
| `skipped` | 当天无素材（没调模型） | 否（无素材是事实，重跑也没用） |
| `partial` | 跑了但有降级（如详情落库失败） | 否 |
| `failed` | 模型调用 / 解析失败 | 是，但 `attempts < MEMORY_MAX_ATTEMPTS_PER_DAY`(2) |

`attempts` 每次抢锁 +1，`error` 存最后一次失败原因，`model` 存**实际使用**的 `providerConfigId/model`。

### 2.2 `MemoryRepo`（P2 扩展）

```rust
async fn get_run(&self, day: &str) -> Result<Option<MemoryRun>, String>;
async fn list_runs(&self, limit: usize) -> Result<Vec<MemoryRun>, String>;
async fn last_done_day(&self) -> Result<Option<String>, String>;
/// 抢锁（同一次加锁内完成「读现状 → 判定 → 置 running」）；`None` = 这次不该跑
async fn claim_run(&self, day: &str, now_ms: i64, stale_ms: i64, max_attempts: i64)
    -> Result<Option<MemoryRun>, String>;
/// 落终态（status/items/details/source_sessions/model/error/finished_at/tokens）
async fn finish_run(&self, run: &MemoryRun) -> Result<(), String>;
/// 删掉某天 `origin='distill'` 的条目（「重新整理」用），返回被删条目（供删详情文档）
async fn delete_distilled_day(&self, day: &str) -> Result<Vec<MemoryRecord>, String>;
```

判定逻辑是**纯函数** `decide_claim(existing, now_ms, stale_ms, max_attempts) -> ClaimDecision`
（`Claimed` / `AlreadyDone` / `Exhausted` / `Busy`），DB 方法只负责在一个事务里执行它的结论 —— 这样
「为什么这条没跑」可以在单测里逐个分支断言，不需要真库。

### 2.3 `SessionRepo`（P2 扩展）

```rust
/// 某一天各会话的素材（蒸馏输入）：有摘要用摘要，没有就用当天的正文摘录
async fn day_materials(&self, start_ms: i64, end_ms: i64) -> Result<Vec<SessionMaterial>, String>;
/// 库里最早一条消息的时间（首次整理时决定「从哪天开始补」）
async fn earliest_message_ts(&self) -> Result<Option<i64>, String>;
/// `usage_ledger` 里某 kind 的模型使用频次（倒序）—— 蒸馏模型候选的来源
async fn usage_model_counts(&self, kind: &str, limit: usize) -> Result<Vec<ModelUsageCount>, String>;
```

**实现落点**（与本文初稿的差别）：素材查询的 SQL 在 `session_db/message_query.rs::day_materials_in_conn`
（两个查询：摘要 + 正文），`SqliteSessionRepo` 只做 `spawn_blocking` 转发 —— 与会话检索 / 消息查询同一分层。
初稿写的 `summaries_between` 没有单独存在：一次查询就同时给出「摘要优先 + 正文降级」，
再拆一个只取摘要的接口只会多一份要维护的 SQL。

`SessionMaterial`（DTO）：

```rust
pub struct SessionMaterial {
    pub session_id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub agent_id: Option<String>,
    /// 当天该会话的最后一条摘要（`None` = 走降级链）
    pub summary: Option<String>,
    /// 当天该会话的正文摘录（仅在没有摘要时用于组装）
    pub transcript: String,
    /// 该会话当天最后一次活动时间
    pub updated_at: i64,
}
```

**为什么放在会话库而不是记忆库**：素材是 `messages` 的投影，查询要 JOIN `sessions`（标题 / 工作目录），
与记忆表无关；而且 `NoopSessionRepo` 会自然地给出空素材 → 整条链按「无素材」降级。

**素材上限**（避免一条会话把预算吃光）：
`MATERIAL_TRANSCRIPT_MESSAGES_PER_SESSION`(12) 条 / `MATERIAL_TRANSCRIPT_CHARS_PER_SESSION`(4000) 字符；
摘要单条上限 `MATERIAL_SUMMARY_MAX_CHARS`(4000)。这三个常量住在 `session_db/types.rs`
（**截断发生在 SQL 查询里**，所以常量与实现放同一层，不跨层复制）；总输入上限
`MEMORY_DISTILL_MAX_INPUT_CHARS`(40000) 在 core（超出按**会话活动时间从旧到新**裁：新内容最值钱）。

### 2.4 常量（`agent/memory/mod.rs`，纯函数可测）

| 常量 | 值 | 说明 |
|---|---|---|
| `MEMORY_DETAIL_MIN_CHARS` | 200 | 详情正文达到该长度才值得落知识库 |
| `MEMORY_DETAIL_MAX_CHARS` | 8000 | 详情正文上限（超出截断） |
| `MEMORY_DISTILL_MAX_INPUT_CHARS` | 40000 | 单次蒸馏素材字符上限 |
| `MEMORY_MAX_ITEMS_PER_DAY` | 20 | 单日产出条数上限（模型跑飞时的兜底） |
| `MEMORY_MAX_DAYS_PER_RUN` | 7 | 单次触发最多处理几天（补跑有界） |
| `MEMORY_MAX_ATTEMPTS_PER_DAY` | 2 | 同一天最多尝试次数（之后等人工重试） |
| `MEMORY_RUN_STALE_MS` | 600_000 | `running` 超过 10 分钟视为崩溃残留，可抢占 |
| `MEMORY_MODEL_MAX_CANDIDATES` | 3 | 降级链长度（**3 次尝试全失败才退出**，已定稿） |
| `MEMORY_DISTILL_MAX_TOKENS` | 8000 | 蒸馏调用 `max_tokens`（必须钳制，见 memory-plan §4.3） |
| `MEMORY_DISTILL_TEMPERATURE` | 0.2 | 与 `title.rs` 的 0.3 同档（要稳定 JSON，取更低） |
| `MEMORY_EXISTING_MAX_CHARS` / `_ITEMS` | 6000 / 100 | 提示词里「现有记忆」参照块的上限 |
| `MATERIAL_TRANSCRIPT_MESSAGES_PER_SESSION` 等 | 12 / 4000 / 4000 | 见 §2.3（住在 `session_db/types.rs`） |

`normalize_summary(raw)`：去首尾空白 → 压缩连续空白 → 全角标点归一 → 小写化（ASCII）——
**只用于去重比较**，不改变落库正文（用户看到的仍是模型原话）。

### 2.5 `MemoryRun`（DTO）

```rust
pub struct MemoryRun {
    pub day: String,
    pub status: String,       // running | done | skipped | partial | failed
    pub items: i64,
    pub details: i64,
    pub source_sessions: i64,
    pub model: Option<String>,   // "providerConfigId/modelId"
    pub error: Option<String>,
    pub attempts: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
}
```

---

## 3. 蒸馏提示词（`prompts/memory-distill.md`）

骨架**英文**（模型侧文案规则），记忆正文**与素材同语言**（它是数据，不是提示词）。
两个占位符：

```
{{existing}}  现有记忆摘要列表（去重参照，由 Rust 渲染；空则填 "(none)"）
{{material}}  当天素材（各会话摘要 / 正文摘录 + 会话元信息）
```

提示词里**写死的规则**（都是方案能不能用的关键，不是建议）：

1. 每条 `summary` **≤120 字符**（硬上限 150，超出截断）；
2. 只留最精华：做了什么项目 / 改了什么 / 用户的偏好与明确要求 / 关键结论与决策；
3. **不复述过程**（不要「用户问了 A，我回答了 B」，要「结论是 A」）；
4. 信息不足**就不产出**（宁缺勿滥 —— 错误记忆会长期污染所有会话）；
5. 与 `{{existing}}` 重复的**不产出**；
6. 输出**严格 JSON**（无 markdown 围栏、无解释文字）：

```json
{"memories":[{"summary":"…","kind":"project","level":"normal",
  "tags":["virlen-app"],"needs_detail":false}]}
```

`needs_detail=true` 时**必须**同时给 `detail_title` + `detail_body`（正文 ≤8k 字符）。

`level` 可由模型判定 `permanent`（**已定稿：不设确认门**，见 memory-plan §11.2）——
但**解析侧只认字面量**：缺失 / 非法一律落 `normal`（绝不在解析失败时猜成 permanent）。

---

## 4. 实现落点（文件级）

### 4.1 新增

| 文件 | 内容 |
|---|---|
| `virlen-core/src/agent/prompts/memory-distill.md` | 蒸馏提示词（英文骨架 + 两个占位符） |
| `virlen-core/src/agent/memory/distill.rs` | 素材渲染 + `ChatRequest` 组装 + JSON 解析 + `distill_once()` |
| `virlen-core/src/agent/memory/models.rs` | provider 配置解析 + 候选排序（纯函数）+ `DistillProviderBuilder` |
| `virlen-core/src/agent/memory/store.rs` | 校验 / 去重 / 落库 / 详情落知识库 / 按天清理 |
| `virlen-core/src/agent/memory/consolidate.rs` | 编排（范围计算 / 抢锁 / 降级链 / 记账）+ 报告 DTO |
| `virlen-cli/src/memory.rs` | `memory consolidate` / `memory list` |
| `docs/memory-p2-plan.md` | 本文 |

### 4.2 修改

| 文件 | 改什么 |
|---|---|
| `agent/memory/mod.rs` | P2 常量 + `normalize_summary` + 子模块声明（+ 单测） |
| `agent/memory/prompt.rs` | 不变（注入链 P0 已完成） |
| `session_db/memory.rs` | `MemoryRun` + 6 个新方法（SQLite + Noop）+ 单测 |
| `session_db/types.rs` | `SessionMaterial` / `ModelUsageCount` DTO |
| `session_db/message_query.rs` | `day_materials_in_conn` / `earliest_message_ts_in_conn` |
| `session_db/usage.rs` | `model_counts()` + `kind` 说明加 `memory` |
| `session_db/repo.rs` / `sqlite.rs` | trait 3 个新方法 + SQLite 转发 + Noop 空实现 |
| `agent/prompts/mod.rs` | `MEMORY_DISTILL` + `PromptTexts.memory_distill` + 两个测试 |
| `agent/usage.rs` | `kind` 列表加 `memory`（注释） |
| `virlen-app/src/commands/memory.rs` | `cmd_memory_consolidate` / `cmd_memory_runs` + GUI 侧 Provider 构建器 |
| `virlen-app/src/lib.rs` | 注册两个命令（铁律 4） |
| `virlen-cli/src/lib.rs` | `memory` 子命令 + 帮助文本 + 分发 |
| `virlen-cli/src/session_rt/*` | 不变（CLI 自动整理属 P3） |
| `src/domain/memory/index.ts` | `MemoryRun` / `ConsolidateReport` 类型 + 状态文案键常量 |
| `src/infrastructure/memoryRepo/index.ts` | `consolidateMemories()` / `listMemoryRuns()` |
| `src/ui/pages/Settings/memory-settings.tsx` | 状态行（上次整理：日期 / 条数 / 失败原因）+「立即整理昨天」按钮 |
| `src/main.ts` | `step('memory', ...)` 启动触发（非阻塞） |
| `src/domain/agent/prompt-texts.ts` + `infrastructure/prompts/prompt-source.ts` + `tests/contracts/agent-prompts-contract.test.ts` | 第 6 个提示词接线 |
| `src/domain/usage/index.ts` + `services/token-stats-service.ts` + `ui/i18n/lang/en-US.json` | `kind='memory'` 四处同步（第 4 处见 §5） |

---

## 5. 与既有机制的边界

| 已有机制 | 关系 |
|---|---|
| 上下文压缩（`compress/`） | 只把它的产物（`role='summary'`）当输入，**不改压缩行为** |
| 会话标题 / 工作目录 | 素材里带上是**给模型的上下文**，不写进记忆正文（正文由模型提炼） |
| `usage_ledger` | 新 `kind='memory'`：一次蒸馏一条流水，`message_id` 用 `memory:<day>` 做幂等键（重试不重复记账） |
| 知识库（RAG） | 详情复用 P1 的 `agent::memory::kb`；KB 不可用 → 只存摘要（`status='partial'`） |
| 删除会话 | 记忆独立于会话；`source_session_id` 失效时 UI 显示来源日即可 |
| StormBreaker | 不涉及（蒸馏不是工具调用） |
| CLI | 与 GUI 共用 `consolidate_pending`；只有 Provider 构建方式不同（原生 vs 桥接） |

---

## 6. 记账四处同步（漏一处就静默失效）

1. Rust `session_db/usage.rs` 的 `kind` 说明 + `agent/usage.rs` 的 `record_usage` 注释；
2. TS `src/domain/usage/index.ts::UsageKind`；
3. `src/services/token-stats-service.ts::kindLabel`（新文案「记忆整理」）；
4. `src/ui/i18n/lang/en-US.json`（新文案）。

⚠️ 蒸馏**没有会话**（一天可能跨多个会话）：`UsageEntry.session_id` 为 `None`、`message_id` 为
`memory:<day>` —— 因此**不复用** `agent::usage::record_usage`（它要求 `Session`），
由 `consolidate.rs` 直接构造 `UsageEntry`，并复用 `ledger_tokens()` 保持口径一致。

---

## 7. 验收

**自动化**

```bash
cd src-tauri; cargo test --workspace -- --skip sandbox::windows
cd src-tauri; cargo clippy --workspace --all-targets -- -D warnings
cd ..;        npx tsc --noEmit
cd ..;        pnpm test            # 本机需脱壳（sandbox: "off"）
```

新增用例：

- Rust `agent::memory::distill`：JSON 解析（围栏 / 前后噪声 / 缺字段 / 非法 `kind` / 非法 `level` /
  空正文 / 超长截断 / `needs_detail` 缺正文 / 条数上限）；素材渲染与超预算裁剪顺序。
- Rust `agent::memory::models`：候选排序（compress 频次倒序 / `memoryModel` 置顶 / 不可用跳过 /
  去重 / 3 条上限 / 无 compress 记录时回退默认模型）。
- Rust `agent::memory::store`：规范化去重（全角半角 / 空白）、长度截断、`origin='distill'`、
  详情写不进去时条目仍在。
- Rust `agent::memory::consolidate`：日期范围（首跑 / 补跑 / 上限）、`decide_claim` 四个分支、
  模型链失败 3 次 → `failed` 且不写记忆、成功路径写 `done` + 记账 + 素材为空 → `skipped`。
- Rust `session_db::memory`：`claim_run` / `finish_run` / `last_done_day` / `delete_distilled_day`。
- Rust `session_db`（素材）：摘要优先 / 无摘要降级 / 日界边界 / 空区间。
- TS：`tests/ui/memory-settings.test.tsx` 补「立即整理」按钮与状态行；
  `tests/contracts/agent-prompts-contract.test.ts` 6 个提示词。

**手工**

1. 造一天对话（含一次上下文压缩）→ 面板点「立即整理昨天」→ 面板出现条目（`source_day` = 昨天）；
2. 无摘要的一天 → 仍能产出（降级链生效）；
3. 关掉模型配置（或让模型返回非 JSON）→ `memory_runs` 记 `failed` + 原因，面板可见，**不产生半截记忆**；
4. `virlen-cli memory consolidate --day <某天>` → 与 GUI 产出同一份记忆（同一个库）；
5. 用量页「类型」筛选出现「记忆整理」。

---

## 8. 回滚

- 代码回滚：删掉三个触发点即恢复「只有手动维护记忆」的 P1 状态；表与数据留着不影响旧版本。
- 数据回滚：`DELETE FROM memories WHERE origin='distill'` + `DELETE FROM memory_runs`
  （面板逐条删除亦可；详情文档在知识库页里能单独删）。

---

## 9. 实施状态（P2 已完成）

| 位置 | 内容 |
|---|---|
| `virlen-core/src/agent/prompts/memory-distill.md` | 蒸馏提示词（英文骨架 + `{{existing}}` / `{{material}}`） |
| `agent/prompts/mod.rs` | `MEMORY_DISTILL` + `PromptTexts.memoryDistill` + 3 个用例（注册表 / 非空 / 占位符） |
| `agent/memory/mod.rs` | P2 常量（详情 / 素材 / 条数 / 天数 / 尝试 / 老化 / 标签）+ `normalize_summary` |
| `agent/memory/distill.rs` | 提示词组装 / 素材渲染（超预算裁旧）/ JSON 解析（容错包装、绝不猜 permanent）/ `distill_once` + 16 个用例 |
| `agent/memory/models.rs` | `ProviderLite` 解析 + `model_candidates`（preferred → compress 频次 → 默认模型 → 首个可用；上限 3）+ `DistillProviderBuilder` + 6 个用例 |
| `agent/memory/store.rs` | 校验 / 规范化去重（含批内）/ 落库 / 详情入 KB / `discard_day` + 7 个用例 |
| `agent/memory/consolidate.rs` | 范围计算 / 抢锁 / 降级链 / 记账 / 报告 + `day_bounds_ms` 等本地日辅助 + 14 个用例 |
| `agent/memory/kb.rs` | 新增 `remove_detail`（重跑时清旧详情文档） |
| `session_db/memory.rs` | `MemoryRun` / `ClaimDecision` / `ClaimOptions` / `decide_claim` + 6 个新 trait 方法（SQLite + Noop）+ 6 个用例 |
| `session_db/types.rs` | `SessionMaterial` / `ModelUsageCount` / `MATERIAL_*` |
| `session_db/message_query.rs` | `day_materials_in_conn` / `earliest_message_ts_in_conn` |
| `session_db/usage.rs` | `model_counts_in_conn` + `kind` 说明加 `memory` |
| `session_db/repo.rs` / `sqlite.rs` | trait 3 个新方法 + 实现 + Noop + `tests/materials.rs`（9 个用例） |
| `src-tauri/src/commands/memory.rs` | `cmd_memory_consolidate` / `cmd_memory_runs` + `GuiProviderBuilder` |
| `src-tauri/src/lib.rs` | 注册两个新命令（铁律 4） |
| `virlen-cli/src/memory.rs` + `lib.rs` | `memory list` / `memory consolidate`（含 `--day` / `--force` / `--json`）+ 4 个用例 |
| `src/domain/memory/index.ts` / `infrastructure/memoryRepo/index.ts` | `MemoryRun` / `ConsolidateReport` 类型 + `consolidateMemories` / `listMemoryRuns` |
| `src/ui/pages/Settings/memory-settings.{tsx,scss}` | 状态行 + 「立即整理昨天」+ 失败时「重新整理这一天」 |
| `src/main.ts` | 启动 `step('memory', ...)`（非阻塞、失败只打日志） |
| `src/domain/agent/prompt-texts.ts` + `infrastructure/prompts/prompt-source.ts` + 契约测试 | 第 6 个提示词接线 |
| `src/domain/usage/index.ts` + `services/token-stats-service.ts` + i18n | `kind='memory'` 四处同步（新文案「记忆整理」） |

**验证记录**

| 命令 | 结果 |
|---|---|
| `cargo test --workspace -- --skip sandbox::windows` | `virlen-cli` 235/235；`virlen-core` 533/534（唯一失败为需真实权限的 `test_execute_command_pty_sandboxed_end_to_end`）；`virlen-app` 29/29 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 0 告警 |
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run` | 117 文件 / 1330 用例全绿（含面板 10 个、提示词契约 6 个） |
| 记忆相关单测 | 99 个（`agent::memory::*` + `session_db::memory` + `session_db::tests::materials`） |

**需要真机手工验收（本机沙盒跟不了 GUI）**

1. 造一天对话（含一次上下文压缩）→ 面板点「立即整理昨天」→ 面板出现条目（`source_day` = 昨天）；
2. 重启应用 → `memory_runs` 里那天不会重跑（幂等）；删掉该天的流水再重启 → 自动补跑；
3. 把 Provider 的模型改错 / 关掉 → 面板状态行显示失败与原因，且**不产生半截记忆**；
4. `pnpm cli` 或 `cargo run -p virlen-cli -- memory consolidate --json` → 与 GUI 同一份记忆；
5. 用量页「类型」筛选出现「记忆整理」。

**与方案 §4.2 的一处有意偏离：素材超预算时是「截断」而不是「拆多次调用」**

方案写的是「超 `MEMORY_DISTILL_MAX_INPUT_CHARS` 时拆成多次调用，每次带上第 k/n 批」。
实现选择**截断最旧的会话块**（`distill::render_material`）：

- 拆批会把「一天」拆成多次调用 = 多倍成本与延迟，而收益只是更早的内容也参与蒸馏；
- 而记忆的价值随时间**快速衰减**（今天要的是「最近在做什么」）——40k 字符已经能装下十几二十个会话的摘要；
- 截断是**可解释**的：素材按会话活动时间旧 → 新排序，丢的一定是最早的那些。

若将来发现确实需要（例如一天几十个长会话），再按方案改成拆批即可 —— 接口不用变，只是循环里多一层。
