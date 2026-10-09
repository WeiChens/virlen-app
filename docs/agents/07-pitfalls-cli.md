# 常见坑 · CLI / TUI / 提示词 / 配置向导（§11.14–§11.27）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

**11.14 workspace 拆包（`virlen-app` / `virlen-core` / `virlen-cli`）后的四条硬约束**
1. **`cargo test` 必须 `--workspace`** —— 裸跑只跑当前 package，core / cli 的用例**静默不跑**（同一坑也适用于 `cargo check` / `build`，但那里是「想要的」：Tauri CLI 就靠默认目标）。
2. **`virlen-core` 不得出现 `tauri::`** —— `#[tauri::command]` 一律放 `virlen-app/src/commands/`；宿主差异走 `HostEnv` / `EventSink` / `TelemetrySink` 注入；测试 fixture 与资源根用 `CARGO_MANIFEST_DIR` + 多一级 `..`。
3. **CLI 的 bin 目标不能加 `windows_subsystem = "windows"`**（它要 stdout / stderr）；**CLI 逻辑一律放 lib** —— bin 目标不被单测引用，写在 bin 里就测不到。
4. **命令入口不得回到 core** —— core 为 CLI 新开的 `pub` 出口只有 `security::{parse_rules, SandboxIgnoreRule, load_sandbox_ignore_rules}`（其余仍 `pub(crate)`）；搬 `pub(crate)` 项目出 crate 会立刻编译不过，这是有意的护栏。
自检：`cargo tree -p virlen-cli` 不含 tauri / wry / tao（实测 CLI 少 94 个依赖 crate，但二进制只小约 5% —— linker 本来就会死代码消除）；`[package] default-run = "virlen-app"` 是防御性声明（缺它曾报 `failed to find main binary`）。

**11.15 headless CLI `run` 的四条边界（都是有意设计，不是缺陷）**
1. **无前端 = 无 JS 桥** —— 35 个工具全部原生，但 `security` **必须**下发 `Some(..)`（`tool_executor` 靠它决定原生 or 走桥，缺了会去等一个不存在的 JS 宿主而**永久挂起**）；`BridgedProvider`（Gemini 等）在**装配阶段**直接报错。
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
