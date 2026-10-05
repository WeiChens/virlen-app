# 记忆功能 P3 实施文档（打磨：近重复合并 / 导出 / 预算告警）

> 上位方案：`docs/memory-plan.md`（**冲突以它为准**）。P0 见 `docs/memory-p0-plan.md`，P2 见 `docs/memory-p2-plan.md`。
> 本文只覆盖 **P3 的三项剩余**，不重新论证设计。
>
> 方案 §10 里 P3 的「启动自动整理 / CLI `memory consolidate`」已随 P2 落地（见 `memory-p2-plan.md` §1.8），
> 因此 P3 实际剩余：**①去重第二道（近重复合并）②导出 JSON ③注入预算告警界面化**。

---

## 1. 范围

| 项 | 做什么 | 完成后能做到 |
|---|---|---|
| **① 近重复合并** | 落库时除「规范化后完全相同」外，再按**词形相似度**判定近重复 → **合并**而不是新增 | 「同一件事的两种说法 / 一天长一点」只留一条，永久区不被重复抬价 |
| **② 导出 JSON** | 版本化信封 + 全部字段；GUI 面板按钮（保存对话框）+ CLI `memory export` | 记忆可备份 / 可 diff / 可交给别的工具处理 |
| **③ 预算告警界面化** | 面板常驻显示「注入段字符数 / 预算」+ 超预算时的醒目告警；注入段 DTO 回传真实字符数 | 用户不用点「查看注入预览」也知道记忆有没有挤爆上下文 |

**不做**

- 常驻定时器 / 后台守护（方案 §1 非目标不变）。
- 详情正文进导出（详情在知识库，导出用知识库页的 zip；见 §3.3 的口径说明）。
- 手机端只读、按工作目录分区、内置「记忆整理」Skill（P4）。
- 导入（import）：导出是「单向可解释性 + 备份」，回灌语义（覆盖 / 合并 / 新 id）没定义清之前不做。

---

## 2. ① 近重复合并（去重第二道）

### 2.1 为什么是「词形」而不是「向量」（**甲方拍板**）

方案原文写的是「去重合并（向量）」。实施前重新评估后**改为词形相似度**，理由逐条记录（免得日后被当成偷工减料）：

1. **本项目的嵌入默认不是语义向量**：`rag::init_service` 在没有 `OPENAI_*` / `VITE_OPENAI_*` 环境变量时
   用 `NgramEmbeddingProvider`（本地 n-gram 哈希向量，512 维）—— 它的余弦相似度**本质上就是词形重合度**。
   也就是说：默认配置下「走向量」拿到的结论与走向量化的词形判定基本相同，但要多付：嵌入调用 + 向量存储。
2. **多一份状态就多一处漂移**：向量要落库（`memories` 加 `embedding` 列）、要随编辑 / 合并 / 重建失效，
   还要处理「嵌入服务换了模型 → 维度变了 → 全量重算」。记忆总量是百量级，这些成本换不来对应的收益。
3. **确定性**：词形判定是纯函数 —— 同一份输入永远同一个结论，可以逐条断言、可以在面板上解释
   「为什么这两条被合并了」。相似度阈值这种东西，不可解释就是埋雷。
4. **真正的语义去重已经在做**：蒸馏提示词里带着「现有记忆」参照块（最多 100 条 / 6000 字符），
   模型在**生成阶段**就在避重。近重复合并是**第二道**防线，针对的是「参照块被截断」与「模型没听话」，
   这两类残差用词形判定足够。
5. 想接真语义嵌入时，接口不变：把 [`summary_similarity`] 换掉即可（本模块是纯函数，替换成本极低）。

### 2.2 算法（实施后定稿：**只抓包含型**）

```
summary_text ──normalize_summary──► 规范化文本 ──char_bigrams──► 集合 A（字符 bigram）
                                                                     │
同理得到 B ────► overlap = |A∩B|         （共享 gram 数 = 绝对证据量）
                  contain = overlap / min(|A|,|B|)   （短的那条被长的那条包含了多少）
```

- **gram = 字符 bigram**（`"记忆功能"` → `{记忆, 忆功, 功能}`）：中文没有词边界，bigram 既免依赖又能标出
  「哪几个字是逐字相同的」。先 `normalize_summary`（P2 已有：全角→半角标点、压空白、去首尾与句尾标点、
  ASCII 小写），于是标点 / 空格 / 大小写差异不会拉低相似度。
- **判定（`is_near_duplicate` / `near_duplicate`）**：

| 条件 | 结论 | 理由 |
|---|---|---|
| 规范化后完全相同 | 近重复 | 与第一道去重同结论（本函数独立可用） |
| `min(|A|,|B|) < MEMORY_MERGE_MIN_GRAMS`(6) | **不合并** | 少于 6 个 bigram（≈7 字符）的碎片被长句「包含」是家常便饭 |
| `contain ≥ MEMORY_MERGE_CONTAIN_MIN`(0.98) | 合并 | 短句的内容**逐字**包含在长句里 → 「保留更长的那条」是信息不丢失的 |

- **计划稿里的「Dice 系数（改写型）」在实测后**去掉**了**，这是实施阶段唯一一处算法改动，理由要写清楚：
  1. 【在 virlen-app 实现记忆功能】vs【在 virlen-app 实现记忆面板】的 Dice = **0.89**，
     而「同一句话插了个词」（`记忆功能 P3 已实现：词形近重复合并` vs `…，包括词形近重复合并`）= **0.84** ——
     **要合并的比不该合并的相似度更低**，阈值放哪里都错一边（差异发生在句尾「承载结论的那两个字」上，
     而插入语只破坏中间两个 bigram）；
  2. 把阈值压到 0.84 以下会直接吞掉【功能/面板】这类**独立事实**，而那是不可恢复的损失；
  3. 改写本来就有**更合适的一道**：蒸馏提示词里带着「现有记忆」参照块，模型在生成阶段就在避重。
     词形判定是第二道防线，只负责它擅长的那个形态（**长长了**）。

  代价是诚实的：**同义改写不合并**（会变成两条相邻记忆，用户可手动删）——单测里把这个边界写成
  显式断言（`rewrites_are_left_alone_by_design`），免得日后被当成 bug 去「修」。

### 2.3 合并策略（谁来写、写什么）

合并发生在落库 [`store_distilled`] 里，命中顺序：**先完全去重 → 再近重复合并 → 都不中才新增**。

| 已存在的那条 | 新来的那条 | 处理 | 计数 |
|---|---|---|---|
| 完全重复（规范化后相同） | 任意 | 丢弃新条目 | `duplicates` |
| 任一来源是**用户手写**（`origin != 'distill'`） | 蒸馏产出 | **丢弃新条目**（用户写的正文一字不改） | `merged` |
| 蒸馏产出 | 蒸馏产出 | **合并**：保留旧条目的 `id` / `created_at` / `hits` / `last_used_at`；正文取**更长**的那条（等长保留旧的）；`tags` 取并集（上限 `MEMORY_MAX_TAGS`）；`source_day` 更新为「存活正文所属的那天」；`updated_at = now` | `merged` |
| 蒸馏产出（**无**详情） | 蒸馏产出（有 `needs_detail` 正文） | 合并 + 把新的详情写进知识库并挂到旧条目上 | `merged` + `details` |

为什么这样定（每条都是取舍）：

- **id 不变**：注入段逐字节稳定 → prompt cache 命中率不掉；`hits` 的统计也不会因为合并归零。
- **正文取更长**：这正是「记忆长出来」的形态（第一天「要求中文回复」，第二天「要求中文回复，代码注释也要中文」）。
  等长时保留旧的（稳定优先）。
- **`created_at` 不变**：永久记忆按 `created_at` 升序注入，改时间会让注入段抖动。
- **用户手写永不被覆盖**：`origin != 'distill'` 的一律只读 —— 蒸馏不该动用户亲手敲的字
  （要改可以让用户自己在面板上合并，或删掉手写那条）。
- **详情只在旧条目没有时补（P3）**：避免每天往同一个文档里追加（无界增长），也避免「旧详情作废」的歧义。

- **补详情失败也进 `detail_errors`**（这天记 `partial`，与新增那条路径同口径）。
- **级别只升不降**：本次明确判 `permanent` 就升为永久（级别就是「是否全量注入」，新判断更准）；
  没再说 permanent 不会把用户升级过的降回去。

### 2.4 可观测

- `StoreOutcome.merged` 计数 → `memory_runs.merged`（新列，见 §4.1）→ 面板状态行 / CLI 输出
  （「合并 N 条」只在 >0 时出现，避免噪音）。
- 日志：合并时 `eprintln!` 一行（旧 id / 命中方式 / 两边长度），便于排查「我的记忆怎么只剩一条了」。

---

## 3. ② 导出 JSON

### 3.1 格式契约

```json
{
  "format": "virlen.memory",
  "schemaVersion": 1,
  "exportedAt": 1760000000000,
  "count": 12,
  "memories": [ { ...MemoryRecord 全字段（camelCase） } ]
}
```

- `format` + `schemaVersion`：给外部工具（或未来的导入）一个判据；**只增字段不改语义时才 +0**，改语义才 +1。
- 排序：**永久在前**（`created_at` 升序 → 与注入顺序一致）→ 普通（`created_at` 降序 → 最新的在前）→ `id` 升序兜底。
  全序，两次导出同一份库逐字节相同（可 diff、可入库）。
- 时间：`exportedAt` 是「导出时刻」，与每条记录的 `created_at` / `updated_at` 并列 —— 便于判断「这份备份有多旧」。
- 用 `serde_json::to_string_pretty`（人能读，diff 友好）。

### 3.2 两条路径

| 入口 | 行为 |
|---|---|
| GUI 面板「导出 JSON」 | `cmd_memory_export` 返回 JSON 字符串 → 前端 `plugin-dialog.save()` 选路径 → `plugin-fs.writeTextFile`（与「导出会话 Markdown」「导出用量 CSV」同一范式；非 Tauri 环境降级为浏览器下载） |
| CLI `memory export [--out PATH]` | 不带 `--out` 打到 stdout；带 `--out` 写文件（父目录不存在即报错，不替用户建目录） |

**为什么不让 Rust 直接写文件**：写文件的路径得由用户在对话框里选，而「选路径」只有前端有（Tauri dialog 插件）；
Rust 侧写死一个路径等于替用户决定位置。CLI 侧本来就有路径参数，天然是文件出口。
（安全口径：记忆是应用数据目录内的内部数据，不经文件工具的路径黑白名单；见方案 §6.5。导出是**用户显式动作**
+ 显式选路径，同样不适用沙盒规则。）

### 3.3 导出包含什么（口径写清楚）

**包含**：`id` / `level` / `kind` / `summary` / `tags` / `source_day` / `source_session_id` / `origin` /
`hits` / `last_used_at` / `created_at` / `updated_at` / `disabled` / `detail_kb_id` / `detail_doc_id`。

**不含详情正文**：详情正文（可能几千字）在知识库「记忆详情」里 —— 要连正文一起备份，
用知识库页的**导出 zip**（已有能力）。理由：导出记忆是「条目级可解释性」，正文是知识库的职责，
混在一起会让导出文件从「一屏能看完」变成「几 MB」。

---

## 4. ③ 注入预算告警界面化

### 4.1 后端：DTO 补两个数（**真实值**，不是前端算的）

`MemoryPromptSection` 增 `chars` / `budget`：

- `chars` = **最终渲染出来**的 `# Memory` 段字符数（码点）—— 由 `select_for_inject` 在裁剪循环里顺带算出，
  与「是否超预算」用的是同一个数，不会出现「面板显示 3000、实际 4200」。
- `budget` = `MEMORY_PROMPT_MAX_CHARS`(4000)，随 DTO 下发（前端不写死常量，避免调阈值时两侧漂移）。

埋点已就位（P0 的 `cmd_memory_prompt_section` 在 `dropped_* > 0` 时打 `memory.inject.truncated`），
P3 给它补上 `chars` / `budget` 两个维度。

### 4.2 前端：常驻行 + 告警

- 面板**挂载即取一次**注入段（原先只有点「查看注入预览」才取）→ 常驻一行：
  `注入段 1234 / 4000 字符 · 已注入 15 条 / 共 23 条`。
- 被裁（`droppedNormal` / `droppedPermanent` > 0）→ 在常驻行位置显示**醒目告警** + 可操作建议：
  「记忆总量已超过注入预算：永久 N 条 / 普通 M 条未注入 —— 建议降级、停用或删除」。
- 任何写操作（新增 / 编辑 / 删除 / 升降级 / 停用 / 整理）后**重新取一次**注入段：告警必须是**当前**状态，
  而不是「打开面板那一刻的状态」。
- 整理状态行补「合并 N 条」（仅 >0 时）。

---

## 5. 改动清单（文件级）

**新增**

| 文件 | 内容 |
|---|---|
| `src-tauri/virlen-core/src/agent/memory/export.rs` | 导出信封 + 排序 + 序列化（纯函数）+ 单测 |
| `docs/memory-p3-plan.md` | 本文档 |

**修改**

| 文件 | 改什么 |
|---|---|
| `agent/memory/mod.rs` | `summary_similarity` / `is_near_duplicate` + 阈值常量；`MemorySelection.chars` |
| `agent/memory/store.rs` | 近重复合并（含用户手写只读）、`StoreOutcome.merged` |
| `agent/memory/consolidate.rs` | `DayReport.merged` 落流水；报告文案 |
| `agent/memory/prompt.rs` | `MemoryPromptSection` 补 `chars` / `budget` |
| `session_db/memory.rs` | `memory_runs.merged` 列 + `MemoryRun.merged`；`ensure_*` 补列 + `finish_run` 写入 |
| `session_db/schema.rs` | 调 `ensure_memory_run_merged_column`（走 `init_schema` 快速路径，**不动 `SCHEMA_VERSION`**） |
| `src-tauri/src/commands/memory.rs` | `cmd_memory_export` + `cmd_memory_limits` 补预算；埋点补维度 |
| `src-tauri/src/lib.rs` | 注册 `cmd_memory_export`（铁律 4） |
| `virlen-cli/src/memory.rs` | `memory export [--out]`、list/consolidate 文案补「合并」 |
| `src/domain/memory/index.ts` | `MemoryPromptSection` 补 `chars`/`budget`；导出 DTO 类型 |
| `src/infrastructure/memoryRepo/index.ts` | `exportMemories()` |
| `src/ui/pages/Settings/memory-settings.tsx` / `.scss` | 常驻预算行 + 告警 + 导出按钮 + 合并数 |
| `src/ui/i18n/lang/en-US.json` | 新文案（导出 / 预算 / 合并） |
| `src/tests/ui/memory-settings.test.tsx` | 预算行与告警用例、导出用例 |
| `docs/memory-plan.md` / `docs/AGENTS.md` | 状态与实现细节同步 |

---

## 6. 测试与验收

**Rust**

- `memory::tests`（词形相似度，纯函数）：
  - 完全相同 / 标点与大小写差异 → 近重复；
  - **共享前缀但结论不同**（「实现记忆功能」vs「实现记忆面板」）→ **不**近重复（钉住保守阈值）；
  - 太短的两条 → 不近重复（`MEMORY_MERGE_MIN_GRAMS` 生效）；
  - 包含关系（一条是另一条的加长）→ 近重复；
  - 空串 / 单字符 / 只差空格 → 不 panic、结论确定。
- `memory::store`：合并四个分支（完全重复 / 用户手写只读 / 蒸馏+蒸馏取更长 / 补详情）；
  `merged` 计数；合并后 `id` / `created_at` / `hits` 不变、`tags` 并集不超上限。
- `memory::export`：字段齐备、排序全序（同输入两次导出逐字节相同）、`count` 与实际条数一致。
- `session_db`：老库打开后 `memory_runs.merged` 列自动出现（不改 `SCHEMA_VERSION`）。
- `consolidate`：`merged` 进 `DayReport` 与流水。

**TS**：`tsc --noEmit` 零错误；`vitest run` 全绿（面板预算行 / 告警 / 导出按钮新增用例）。

**门禁**：`cargo test --workspace -- --skip sandbox::windows`、`cargo clippy --workspace --all-targets -- -D warnings`。

**手工验收（真机）**

1. 面板常驻行显示 `字符数 / 4000`，与「查看注入预览」的段一致；
2. 造 30+ 条大记忆 → 常驻行变告警，降级 / 停用 / 删除后告警即时更新；
3. 「导出 JSON」→ 保存对话框 → 文件内容含 `format` / `schemaVersion` / 全部条目；
4. `virlen-cli memory export --out mem.json` 与 GUI 导出同一份内容（同库同实现）；
5. 连续两天产出一条「同一件事、第二天更长」的记忆 → 面板只有一条，且「上次整理」显示合并了 N 条。

---

## 7. 实施状态

**已完成**（全部门禁绿）。与本文的偏离共 3 处：

1. **去重判定只保留「包含型」**，计划稿里的 Dice（改写型）去掉 —— 实测两者相似度区间重叠且方向相反（要合并的 0.84 < 不该合并的 0.89），详见 §2.2。代价（同义改写不合并）已写成显式单测，不当 bug 去「修」。
2. 计划稿 §4.1 写的「埋点补 `chars` / `budget`」——实际还顺带补了 `merged`（整理埋点多了这个维度）。
3. `cmd_memory_limits` 除了 `summaryMaxChars`，又回了 `summaryHintChars` / `promptBudgetChars`；但**面板常驻行的预算取自注入段 DTO 里的 `budget`**（每次都是真值，不依赖这个常量命令）。

**验证结果**

| 门禁 | 结果 |
|---|---|
| `cargo test --workspace -- --skip sandbox::windows` | cli **236/236**、core **555/556**（1 个需真实权限的沙盒用例，非本次引入）、app **29/29** |
| `cargo clippy --workspace --all-targets -- -D warnings` | **0 告警** |
| `npx tsc --noEmit` | **0 错误** |
| `npx vitest run` | **117 文件 / 1335 用例**全绿（含面板 15 个：预算行 / 告警 / 导出 / 取消与失败路径） |

**真机手工验收（本机沙盒跟不了 GUI）**

1. 面板常驻行显示「字符数 / 预算」，与「查看注入预览」里的段一致；
2. 造 30+ 条大记忆 → 常驻行变告警；降级 / 停用 / 删除后告警**即时**更新（写操作后会重新取段）；
3. 「导出 JSON」→ 保存对话框 → 文件含 format / schemaVersion / count / 全部条目；
4. `virlen-cli memory export --out mem.json` 与 GUI 导出同一份内容（同库同实现）；
5. 连续两天产出一条「同一件事、第二天更长」的记忆 → 面板只有一条，且状态行显示「合并 N 条」；
6. 手写一条与模型产出近重复的记忆 → 产出被丢弃，手写的一字不改。
