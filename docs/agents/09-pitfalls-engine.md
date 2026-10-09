# 常见坑 · 引擎统一 / 提示词缓存 / 账本（§11.37–§11.41）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

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
