# `virlen-cli chat`（交互式 TUI）方案与实测记录

> 状态：**P1 已落地**（`virlen-cli chat` 可用：内联视口 TUI + 顺序输出降级 + 多轮 + 异步审批 + Esc 取消
> + 实时输出尾部 + 状态行 + `/help /exit /status /new`）；§8 六项已拍板（见该节）；
> 实测记录见 §2 与 §7.2。与 `config-sink-plan.md` / `pty-research.md` 同级：本文是结论与实测证据的沉淀。
>
> 前置：headless 基础能力（`run` / `list-session` / `list-agent` / `config`）已落地，见 `AGENTS.md` §11.14–§11.16。

---

## 0. 一句话结论

`virlen-cli chat` 选定 **ratatui 内联视口（`Viewport::Inline`）**：正文与已完成的工具块**固化进终端原生滚动区**，输入框 + 状态行钉在底部（与 Claude Code 同形态，保留终端原生滚动与鼠标复制）。

**实测可用**，但 Windows 上必须内建四条健壮性措施（§3.3），否则「用户拖一下窗口」就会让程序退出——这是本轮花最大代价换来的结论。

---

## 1. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D5 | 形态 = **内联视口**（`Viewport::Inline`），非全屏、非纯行模式 | 用户拍板；全屏会失去终端原生滚动/复制；行模式做不到 spinner 与选项式审批 |
| D6 | 选型验证（spike）建在**仓库之外**（`%TEMP%\ratatui-inline-spike`），验证通过再引依赖 | 用户拍板；期间仓库零改动（`Cargo.toml` / `Cargo.lock` 未被触碰） |
| D7 | 只加 `ratatui`，**不单独声明 `crossterm`**（用 ratatui 的重导出 `ratatui::crossterm`） | 避免同一 crate 双版本（ratatui 0.30 用 `ratatui-crossterm` 0.1.2 → crossterm 0.29） |
| D8 | **弃用** `scrolling-regions` feature | 用户实测：模式 A（默认）按 `m` 不闪烁，与模式 B 无观感差异；且该 feature 在 Windows 无 winapi 实现（见 §3.1-3） |
| D9 | 固化必须**分块**（按「终端高 − 视口高」切段），不能一次性灌入 | 实测：一次性固化 120 行只落地 20 行（被上限截断） |

---

## 2. 实测证据（4 轮，均在真实终端）

| 轮次 | 环境 | 手段 | 结果 |
|---|---|---|---|
| R1 | cmd.exe（用户手动） | 内联视口演示；A/B 两种固化实现 | 前几秒不在底部、随后贴底（**正常**：`insert_before` 先把视口推到屏底才滚动上方）；`w` 之后固化内容完整；**可鼠标选中复制**；**中文可输入**；A 不闪烁；B 与 A 无差别；**改窗口大小 → A、B 均崩溃退出**；`q` 正常退出 |
| R2 | Virlen 桌面端终端 | 同上 + `ansi-probe` | 「完全看不到界面但输入有效」→ **假象**：当时命令被 `… 2>&1 \| Out-String` 包成管道（裸跑正常）；另 `ansi-probe` 在**放大窗口**时崩溃 |
| R3 | cmd.exe **双击 `.cmd` 启动器** | 四组对照（同一套"缩小窗口"动作） | `sizetest`（纯文本，无 ratatui）**放大缩小都没问题**；`sizetest-raw`（+raw mode）**没问题**；`spike` 内联**只绘制不固化** → **崩**；`spike` 全屏 → **崩** |
| R4 | 我的**非污染**复现（`start` 起独立控制台 + `SetWindowPos` 改尺寸） | 矩阵对照 | 独立控制台下 `stdout/stderr/stdin_is_terminal=true`；第一次 resize 后 **`autoresize` 与 `terminal.size()` 持续失败于 `os error 233`**；**关掉事件源**（不 poll/read）**照样失败**；**`sizetest` 在同一脚手架下 6 次尺寸变化、`size()` 全程可读、`write_fails=0`**（证明脚手架有判别力）；失败**是短暂的**（重试后自愈）；**加 300ms 去抖后连续 20 次快速改尺寸：10 次 resize、0 次失败、进程存活** |

> R2 的教训值得单独记：**验证 TUI 时不能用 `… \| Out-String` 之类的管道包装**，否则 stdout 变成管道，界面"看不见"会被误判成环境不支持。

---

## 3. 关键结论

### 3.1 ratatui 侧硬事实（源码确证，非推测）

| # | 事实 | 出处 | 对设计的约束 |
|---|---|---|---|
| 1 | **内联视口高度运行期不可改** —— `Terminal.viewport` 是私有字段，`Terminal::resize(area)` 只用「构造期高度」重算原点 | `ratatui-core-0.1.2/src/terminal.rs`、`terminal/resize.rs` | H 必须是「输入框 + 状态行 + 在飞内容尾巴」的**固定上限**；超出部分要么滚尾部，要么先固化出去 |
| 2 | `insert_before` 有**两套实现**：默认（画完清空视口等重绘）/ `scrolling-regions`（发 `CSI t;b r` + `CSI n S` + `CSI r`，不动视口） | `ratatui-core/src/terminal/inline.rs` | 默认实现可用（用户实测不闪烁）；因此不必引入 `scrolling-regions` |
| 3 | Windows 上 `ScrollUpInRegion` **无 winapi 实现**（直接返回 `Unsupported`） | `ratatui-crossterm-0.1.2/src/lib.rs:741` | 与 D8 一致：不依赖 DECSTBM |
| 4 | 依赖增量：引入 `ratatui` 后 `virlen-cli` 的 `cargo tree` 集合差 ≈ **56 个 crate**（`unicode-width` 已在树内，不重复） | `cargo tree` 实测 | 相对 `virlen-cli` 现有 652 个 crate 属小增量；`ratatui 0.30.2` 的 `rust-version = 1.88.0` → **工作区 MSRV 抬到 1.88**（本机 1.98.1，可用） |

### 3.2 「拖动窗口 → 程序退出」的根因（实测定位）

**证据链**：

1. R3 的四组对照把范围收窄到「**ratatui 的绘制路径**」：纯文本输出不受影响、`raw mode` 不受影响、`insert_before` 不是必要条件、全屏与内联一样会崩。
2. R4 在**独立控制台**（非管道）里复现，确认失败来自 **`crossterm::terminal::size()`** —— 其实现是
   `ScreenBuffer::current()` → `Handle::new(CurrentOutputHandle)` → **`CreateFileW("CONOUT$")`** → `GetConsoleScreenBufferInfo`，
   报 **`os error 233` = `ERROR_PIPE_NOT_CONNECTED`**。
3. 关掉事件源后**照样失败** → 与 crossterm 的事件读取无关。
4. 同一脚手架下 `sizetest`（只 `println` + 每 300ms 调一次 `terminal::size()`，不启 VT 输出、不绘制）**20 次尺寸变化 0 失败** → 控制台 API 本身没坏，是**特定路径**在窗口尺寸变更期间断连。

**结论**：**conhost 在窗口尺寸变更期间会让 `CONOUT$` 相关查询/写入短暂失败**，持续约 **0.25–5 s** 后自愈；触发条件是「**启用 VT 输出 + 绘制**」这条路径（即任何真正的 TUI，不只是 ratatui）。

> ⚠️ **严谨性说明**：上述触发条件由**对照实验排除法**得出（纯文本输出 ✓、`raw mode` ✓、内联不固化 ✗、全屏 ✗），**未逐项分离「启用 VT 输出」与「输出量大小」**两个变量。对实施无影响（两者在真 TUI 里必然同时存在），但若日后要报给上游（ratatui / crossterm），需先补这一步分离实验。

**而真正让用户看到"崩溃退出"的是我们自己的写法**：失败被当成致命错误 → 退出路径用 `println!` 写 stdout → 写失败本身又触发 `std` panic（`failed printing to stdout: os error 233`）→ `abort`（退出码 `0xC0000409`），并且 ratatui 的 restore 钩子把 panic 文本冲掉，于是"崩了但什么都没留下"。

### 3.3 因此：TUI 必须内建的四条（缺一不可）

| # | 措施 | 具体做法 |
|---|---|---|
| 1 | **resize 去抖** | 收到 `Event::Resize` 后 300ms 内**完全不碰终端**；⚠️ 且**把「读事件」排在「绘制」之前** —— 否则那一次 `draw` 仍会撞上（R4 已观察到：只去抖不改顺序时仍偶发 1 次失败） |
| 2 | **重试退避** | `autoresize` / `draw` / `insert_before` / 事件读取失败 → 记日志 + 退避 250ms 重试，**不要立即返回错误**；恢复后继续（无需重启） |
| 3 | **I/O 失败路径禁止 `println!`** | 一律 `writeln!` 并忽略错误；自装 panic 钩子，先把消息 + `Backtrace::force_capture()` 落盘（`ratatui::init` 的钩子会先 restore 终端，屏幕上的文本留不住） |
| 4 | **降级形态** | 连续失败超阈值（建议 5s）→ 切「**顺序输出模式**」（纯文本顺序打印 + 行长读入），并提示用户。这是能力要求最低的形态：管道 / ConPTY / 真终端都能跑 |

> 第 4 条是"兜底"，不是"主形态"：内联视口在 R1/R4 的终端能力测试里全部成立（中文、复制、滚动、键盘）。

### 3.4 引擎侧已有的能力（**不需要新增 core 出口**）

| 能力 | 出处 |
|---|---|
| 一次 `send_message(options)` 驱动整轮（含工具循环）；`cancel(session_id)` | `virlen-core/src/agent/engine.rs` |
| `SendMessageOptions.resume_from_snapshot` → **暂停恢复在 CLI 里第一次变得可用**（GUI 的 Run Snapshot 只存内存） | `agent/types.rs:367` |
| 事件契约：`assistant_message_created` / `assistant_message_updated{messageId,patch{content?,contentDelta?,reasoningContent?,reasoningElapsedMs?,toolCalls?,usage?,streaming,model}}` / `stream_event{delta}` / `stream_end{paused?,snapshot?}` / `tool_call`（start/end **两帧，需按 id 去重**）/ `tool_result_created` / `error` / `iteration_*` | `agent/llm_round.rs`、`agent/tool_executor.rs` |
| 交互：`emit_raw("agent:user-interaction-request",{requestId,sessionId,type,data})`，**必须**用 `bridge::handle_user_interaction_response` 应答；**未知类型也必须答**（否则引擎永久等待） | `agent/bridge.rs` |
| **实时命令输出已存在但 CLI 目前丢弃**：`emit_raw("agent:tool-output",{sessionId,toolCallId,stream,chunk})` | `native_tools/execute/common/runner/{pty,pipes,sandbox}.rs` |
| PTY 键位接管已在 core 导出：`pty_write` / `pty_resize` / `pty_key` / `pty_set_held`（按 `tool_call_id` 命中会话） | `native_tools/mod.rs` |
| todo 面板数据：`todo_write` 的结果 `uiData = {type:"todo", todos:[…]}`（已 sanitize） | `native_tools/plan/todo_write.rs` |
| 落库幂等：`messages` 表 `ON CONFLICT(id) DO UPDATE` → 每轮把完整历史交给引擎是安全的；用户消息由**引擎**落库 | `session_db/sqlite.rs` |
| token 用量随 `patch.usage` 下发；**费用拿不到**（价目表在 TS `src/domain/pricing`） | `agent/llm_round.rs` |

---

## 4. 目标界面（内联视口）

```
⏺ Bash(npm test)                      ⟳ 12s        ← 在飞工具 + 实时输出尾部
  ⎿ 3 passing, 1 failing …
⏺ Read(src/App.tsx)                   ⎿ 320 lines   ← 已完成的工具块

✅ 报告已生成，见 docs/…                             ← 已固化进滚动区（原生滚动/复制可用）

─────────────────────────────────────────────────
> 再帮我补个用例_                                     ← 输入框（多行 / ↑↓ 历史）
  deepseek-chat · 3f2a1c · E:\code\virlen · 12.3k tok · 8s   ← 状态行（模型/cwd/token）
```

**动态区（固定高 H）** = 在飞内容尾巴 + 输入框 + 状态行；**已完成的正文与工具块**在回合结束时 `insert_before` 固化（分块，见 D9）。

---

## 5. 架构（实现落点）

```
src-tauri/virlen-cli/src/
├── lib.rs             参数解析 / 分派（新增 Command::Chat）/ USAGE
├── run/               无界面跑一次（管道友好）
│   ├── mod.rs         参数解析（RunCmd/parse）+ 驱动（run）
│   ├── render.rs      事件 → 文本纯函数（render_event / Rendered / flush_rendered）
│   ├── ask.rs         交互应答（授权 / 选择，fail-closed）
│   ├── sink.rs        CliEventSink（渲染成文本→输出循环；桥请求就地应答）
│   └── tests.rs       测试（原 run.rs 的 mod tests）
├── session_rt/        ★run 与 chat 共用的「会话运行时」
│   ├── mod.rs         RunOptions / Resources / SessionRuntime::{bootstrap, bootstrap_chat,
│   │                  activate, turn_messages, send_options}
│   ├── resources.rs   装配链：resolve_workspace / build_resources / build_system_prompt / …
│   └── session.rs     会话装载：load_or_create_session / new_session / title_from_prompt
├── list/              list-session / list-agent
│   ├── mod.rs         参数解析 + 执行入口 + open_db
│   ├── group.rs       分组纯函数（group_sessions / group_name）
│   ├── render.rs      表格渲染（按显示列宽对齐：pad / pad_left / brief / fmt_time / session_line）
│   ├── sessions.rs    list-session 输出
│   ├── agents.rs      Agent 视图（模型 / 解析 / 装载 / 输出）
│   └── tests.rs
└── tui/
    ├── mod.rs         入口（参数解析 + 终端能力判定 + 降级决策）
    ├── app.rs         ★TUI 线程编排（run_tui / tui_loop / Chat）
    ├── plain.rs       ★顺序输出模式（无 TTY / 降级；复用 run::CliEventSink）
    ├── sink.rs        ★结构化事件出口（UiEventSink + 预览助手）
    ├── state/         ★纯状态机（零 I/O，可单测）
    │   ├── mod.rs     LineKind / OutLine / Key / UiEvent / Action / Status / Interaction / UiState
    │   ├── line.rs    行模型 + sanitize（ANSI 转义整段剔除）+ expand
    │   ├── event.rs   引擎事件 → UI 状态（唯一解释点：tool_call 两帧去重等）
    │   └── key.rs     按键 → 动作（字符下标编辑 / 历史 / 交互键位 / Ctrl+C 两义性）
    ├── view.rs        ★纯渲染（&UiState → Frame）—— ratatui TestBackend 可断言
    ├── commands.rs    ★斜杠命令解析（纯；执行分派在 mod/app）
    ├── input.rs       按键映射（纯）+ 读一批终端事件（返回 resize 尺寸）
    ├── term.rs        终端接管/恢复（raw mode、内联视口、退出与 panic 兜底、
    │                  **四条健壮性措施**：去抖 / 退避重试 / 禁 println! / 降级判定、分块固化）
    └── tests.rs
```

**为什么这样切**：`bin` 目标不被单测引用（见 `AGENTS.md` §11.14），因此核心逻辑必须放在**可测的纯函数**里——`state/`（事件/按键 → 动作）与 `view.rs`（状态 → 帧）都能在无 TTY 环境下断言。

> 2026-09-26 模块瘦身：上面的目录形态是把原来的单文件按职责切开的结果（`run.rs` / `tui/mod.rs` / `state.rs` / `list.rs` / `session_rt.rs` 各拆成目录模块 + `tests.rs`），纪律与代价见 `AGENTS.md` §11.18。

**线程与任务模型**（`main.rs` 是 `#[tokio::main(flavor="current_thread")]`，且 crate 只开 `rt`）：

```
主任务（tokio current_thread）: select! {
    引擎事件通道   ← EventSink（同步 trait → mpsc，沿用 run.rs 既有做法）
    终端事件通道   ← 输入线程（阻塞读键，**必须独立 std::thread**，不能占 runtime 线程）
    tick (~70ms)   ← spinner / 状态行 / 去抖与重试的节拍
    回合 future    ← engine.send_message(...)
}
```

**两处必须做对的改造**：

1. **交互异步化**：Sink 收到交互请求时不再同步阻塞读 stdin，而是入队 `UiRequest{request_id, kind, data, reply}`，由 UI 渲染成问题、按键后经 `bridge::handle_user_interaction_response` 应答。**必须排队**，且**未知类型也要答**（`run.rs` 文件头已记录这条教训）。
2. **切会话的唯一入口**：`SessionRuntime::activate(session_id)` 一次做全「重读会话记录 → 重算工作目录（冲突报错）→ 重建 security（可写根/权限/沙盒规则）→ 取会话的 provider/model → 重载消息」。少一步就会出现「跳过去了但工作目录还是旧的」这类静默错误（桌面端同款教训见 `AGENTS.md` §11.13）。

---

## 6. 与桌面端的一致性红线

1. **同一份库与配置**：`HostEnv::data_dir()`（`virlen.db` + `app_settings`）；TUI 不引入任何私有存储。
2. **不重实现判定**：工具/沙盒/权限判定仍在 `security::` 与 `native_tools/`；TUI 只负责"提问与展示"。
3. **审批文案不自造**：`title/desc/hint/risk` 由 Rust 侧下发，TUI 直接展示。
4. **不新增事件类型**（TUI 是纯消费方）→ 不触碰"四处一致"契约。
5. **「记住授权」若要做**，只能写 `app_settings.settings.permissions`（桌面端读同一份）——**改安全配置，需明确拍板**。
6. **已知缺口必须在 `/status` 里明示**：`/compact`（`compressContext` 未原生化）、费用（价目表在 TS）、技能启用状态与路径黑白名单（仍在 localStorage，见 §11.16）、Gemini（`BridgedProvider` 在装配期已被拒绝）。

---

## 7. 分阶段计划

| 阶段 | 内容 | 新增依赖 | 验收 |
|---|---|---|---|
| **P0** | 抽 `session_rt.rs`（纯搬代码，不改语义） | 0 | ✅ **已落地**：`cargo test --workspace` = app 29 + cli **63** + core 354 = **446 passed**（2 ignored）；`cargo check -p virlen-cli --all-targets` 0 error / 0 warning；`run` 的 e2e（本地 mock Provider）逐项不变 |
| **P1** | 引入 `ratatui`；`state.rs` / `view.rs` / `term.rs`；多轮、异步审批、Esc 取消、实时输出尾部、**四条健壮性措施**、`/help /exit /status /new` | `ratatui`（不单独加 crossterm） | ✅ **已落地**（见 §7.2） |
| **P2** | spinner、工具块、todo 面板、状态行 token、历史、多行输入、分块固化 | — | 同上 + 目视确认 |
| **P3**（可选） | `/resume` 列表、`/model`、`@` 文件补全、PTY 键位接管（`pty_write`/`pty_key`）、markdown 渲染 | `pulldown-cmark` 等 | 同上 |

### 7.1 P0 落地记录（2026-09-25）

- 新增 `src-tauri/virlen-cli/src/session_rt.rs`：`RunOptions` / `ProviderLite` / `Resources` / `resolve_workspace` /
  `build_resources` / `build_system_prompt` / `load_or_create_session` / `SessionRuntime::{bootstrap, send_options}`；
  `run.rs` 只留「参数解析 + 事件渲染 + 交互应答 + select 循环」，装配段改为调 `SessionRuntime::bootstrap`（`run.rs` 2087 → 1471 行）。
- **搬运方式**：按锚点机械切分（脚本），`run.rs` 用 `use crate::session_rt::*;` 重新引入同名项 ——
  因此本文件的调用点与 `mod tests`（63 个用例）**一行都不用改**。这层 glob 是纯搬移的护栏，不是风格选择。
- **验收证据**：`run --workspace <ws> "现在几点？"` 对本地 mock Provider —— stdout 仍**只有正文**、stderr 仍有
  `[run] session=… model=… tools=28 workspace=<ws>` 与 `[done] 用时 … ms`、2 个会话 / 6 条消息落库、
  **落库的 `workspace` 未被改写**（正是那个 bug 的回归点）、`AGENTS.md` 仍被注入、工具定义仍在请求体里。
- **已知待办**：`SessionRuntime` 的 `host` / `settings` / `cwd` 目前只有写入（已标 `#[allow(dead_code)]` 并写明原因）——
  它们属于 P1 的**切会话**入口，那一步落地后**请删掉该属性**。
- **未做（属 P1）**：`activate()`（切会话唯一入口）、`Command::Chat` 子命令、`tui/` 实现。

### 7.2 P1 落地记录（2026-09-26）

**新增依赖**：`ratatui = { version = "0.30.2", features = ["unstable-rendered-line-info"] }` + `unicode-width = "0.2"`
（后者已在依赖树内，不新增 crate；**不单独声明 `crossterm`** → 用 `ratatui::crossterm` 重导出，避免同 crate 双版本）。
只进 `virlen-cli`：GUI 二进制的依赖与体积不受影响。

**新增文件**（`src-tauri/virlen-cli/src/`）：

| 文件 | 职责 | 可测性 |
|---|---|---|
| `tui/state.rs` | 纯状态机：`UiEvent`/`Key` → `UiState` + `Action`；**事件语义只在这里解释一次**（如 tool_call 两帧去重、ANSI 剔除、token 按 messageId 求和） | 纯单测 |
| `tui/view.rs` | 纯渲染：`&UiState` → `Frame` | `TestBackend` 断言 |
| `tui/commands.rs` | 斜杠命令解析（未知命令不得当提问发给模型） | 纯单测 |
| `tui/input.rs` | crossterm 按键 → 归一化 `Key`；读一批事件（返回 resize 尺寸） | 纯单测（映射）/ 真终端 |
| `tui/term.rs` | 终端接管/恢复 + **四条措施**（去抖、退避重试、禁 `println!` + panic 钩子落盘、降级判定）+ **分块固化** | 真终端 |
| `tui/mod.rs` | 编排：`chat` 参数解析、TUI 线程、`select!` 主循环、**顺序输出模式**、事件出口 → UI 的映射 | 入口与 sink 映射可单测 |

**改动**：`session_rt.rs` 新增 `bootstrap_chat` / `activate` / `turn_messages` / `new_session` / `recorded_workspace`
（**并删掉 `#[allow(dead_code)]`**：三个字段现在真的被读了）；`run.rs` 的 `CliEventSink` / `flush_rendered` 提为 `pub(crate)`（顺序输出模式复用同一份渲染）；`lib.rs` 新增 `chat` 子命令。

**两处与设计文档不同的决定**：① **输入不另起线程**（原计划 `input.rs` 是「输入线程 + 通道」）：绘制与状态都在 TUI 线程，`poll(60ms)` 本就带超时，多一个线程只多一个同步点；② **`chat` 不接受位置参数**（`chat 你好` 直接报错并引导到 `run`），避免用户以为它是一次性调用。

### 7.3 模块瘦身（2026-09-26 — P2 之前的一次结构整理）

**起因**：P1 之后 `tui/mod.rs` 1506 行、`run.rs` 1474 行、`tui/state.rs` 1240 行、`list.rs` 1122 行、`session_rt.rs` 833 行——单文件承担过多职责，审阅与定位成本高（core 侧 `execute_command.rs` 更极端：1075 行里 794 行是测试）。

**做法**：全部按「**目录模块 + 测试外移 + 纯搬运**」处理（口径、三个搬运陷阱与代价见 `AGENTS.md` §11.18）。本轮范围：`virlen-cli` 五个文件 + `virlen-core` 三个文件（用户拍板）。

| 原文件 | 现状（行数） |
|---|---|
| `run.rs` 1474 | `run/{mod 300, render 192, ask 156, sink 159, tests 727}` |
| `tui/mod.rs` 1506 | `tui/{mod 246, app 405, plain 178, sink 331, tests 421}` |
| `tui/state.rs` 1240 | `tui/state/{mod 348, line 104, event 169, key 248, tests 409}` |
| `list.rs` 1122 | `list/{mod 202, group 95, render 134, sessions 134, agents 192, tests 428}` |
| `session_rt.rs` 833 | `session_rt/{mod 316, resources 432, session 120}` |
| core `rag/vector_store.rs` 1186 | `vector_store/{mod 215, persist 206, docs 373, search 205, tests 224}` |
| core `execute/execute_command.rs` 1075 | **281** + `tests.rs 794` |
| core `agent/engine.rs` 888 | 468 + `tests.rs 419` |

**验收**：`cargo test --workspace` **504 passed**（app 29 / cli 121 / core 354，2 ignored）——与拆分前**完全一致**；`cargo check --all-targets` 对三个 package 均 **0 error / 0 warning**；重建后的 `virlen-cli.exe` 冒烟 6 项（`chat --help` / `chat --no-tui` 非 TTY 降级 / `run --help` / `list-session --help` / `list-agent` 空库 / 未知子命令 exit 2）与拆分前一致。

**代价与边界**：跨文件使用的方法/字段放宽为 `pub(crate)`（清单见 `AGENTS.md` §11.18）；**语义零改动**（纯搬运，未动任何逻辑分支）。

**未拆（下次可继续）**：`agent/llm_round.rs` 705、`native_tools/execute/common/runner/tests.rs` 688、`rag/embedding.rs` 649、`agent/tool_executor.rs` 551、`agent/bridge.rs` 531、`rag/rag_service.rs` 502、`execute_command/tests.rs` 794。

**实测（均在真实终端）**：

| 门禁 | 结果 |
|---|---|
| `cargo test --workspace` | app **29** + cli **121**（P0 是 63）+ core **354** = **504 passed**（2 ignored）；重构前基线 446 → 全部为新增用例 |
| `cargo check -p virlen-cli --all-targets` | **0 error / 0 warning**（唯一 warning 是 MSVC linker 的 `linker_messages`，非代码问题） |
| 二进制冒烟（真 exe × 8 项） | `chat --help` 不建库；缺 Provider → 退出码 1 且不进入界面；管道 stdin → **自动降级**并说明原因；`/status` 输出含有已知缺口；失败回合（本地死端口）报错但**不退出**；`/new` 切会话；`/exit` → 0；`--session` 不存在 / 位置参数 → 可读错误与退出码 |
| **resize 压测（非污染：`start` 起独立控制台 + `SetWindowPos`）** | 两轮共 **30 次**尺寸变更（含 `48x5`、`39x8`——比 10 行视口还矮）：**全部收到 resize 事件、进程全程存活、日志 0 次绘制/取尺寸/固化失败、0 panic** |
| TUI 真终端 e2e（`SetForegroundWindow` + `SendKeys` 注入按键） | 提交一轮→回合失败但界面存活→回合结束时**固化 3 行**进原生滚动区→`/exit` → `TUI 退出: 已 restore`；会话以首条消息为标题落库 |

**⚠️ 未实测**：降级第②条（连续失败 5s — 要人为造终端故障）；macOS / Linux；「在 Virlen 桌面端自带终端里跑 `chat`」的双层 PTY；渲染观感（颜色/对齐/中文输入/鼠标复制）需**人眼**确认。

**验证手法本身的两个坑**（已回写 `AGENTS.md` §11.17）：① 向独立控制台注入按键时 `WScript.Shell.AppActivate` 返回 False，必须 `FindWindow` → `ShowWindow(SW_RESTORE)` → `SetForegroundWindow` → `SendKeys`；② `TestBackend` 里逐格取 `symbol()` 会得到「你 好」（宽字符后有填充格），中文断言必须跳过填充格。

---

## 8. 已拍板（用户 2026-09-26 定案，P1 已按此实施）

| # | 问题 | 决定 |
|---|---|---|
| 1 | 依赖引入时机 | **P1 就加 `ratatui`**（实际 +约 56 crate，MSRV → 1.88；只进 `virlen-cli`，`cargo tree -p virlen-cli` 仍无 tauri/wry/tao） |
| 2 | v1 功能范围 | 必做：多轮 / 流式 / 工具行 / **异步审批** / Esc 取消 / **实时输出** / 状态行 / `/help /status /new /exit` / 历史；可延后：todo 面板、thinking 展示、markdown、`@` 补全、PTY 键位接管 |
| 3 | 「记住授权」写不写 `settings.permissions` | **v1 不写**（改安全配置风险高，且是跨端共享状态）→ 只做「本次允许 / 拒绝」 |
| 4 | markdown 渲染 | **v1 不做** |
| 5 | 子命令与入口 | `virlen-cli chat [--session <id>] [--workspace <path>]`；**去掉 `--agent`**（`run` 本就不传 agent，那是新语义）；`run` 语义完全不动（另加 `--no-tui`，见第 6 项） |
| 6 | 降级策略 | 三条触发切**顺序输出模式**：① `stdout`/`stdin` 非终端 ② 连续失败 5s ③ `--no-tui` |

> 实施状态（逐项）：①✅ 已加；②✅ 必做项全部落地、可延后项均未做；③✅ 未写；④✅ 未做；
> ⑤✅ 一致；⑥✅ 三条均实现（①③已实测，② 无法自然触发故**未实测**）。

---

## 9. 未验证 / 剩余风险

1. **双层 PTY**（在 Virlen 桌面端自带的终端里跑 `virlen-cli chat`）：resize、键位、IME **未实测**（§11.7 同类坑）。
2. ✅ 降级路径**已实现**（§3.3 第 4 条）：非终端 / `--no-tui` 两条已实测（真 exe 冒烟），只有「连续失败 5s」那条**未能自然触发**（要人为造终端故障）。
3. **原始 flash 与长回合**：终端高 30 行、视口 10 行时，`insert_before` 的分块上限约 20 行/次 → 长回合要多次固化，**节奏与闪烁只能靠人眼确认**（单次固化 2–3 行的路径已实测无误）。
4. **非 Windows 平台**：本轮的坑是 Windows conhost 特有的；macOS/Linux 需各自冒烟（内联视口在 ANSI 终端上语义更标准，预期更顺）。
5. ✅ **极小窗口**（终端高 < 视口高 + 1）：真终端实测过 `48x5` 与 `39x8`（比 10 行视口还矮）——**不崩、不失败**；`TestBackend` 下 `1x1` 也不 panic。
6. **渲染观感未确认**：颜色 / 对齐 / 中文输入 / 鼠标选中复制 / 中文宽度下的光标位置——**必须人眼**。
7. **`/status` 的 token 计数**按 `messageId` 去重求和（同一条消息重复上报不会重复计），但引擎在部分路径下可能不发 `usage`（则该行保持空）。
