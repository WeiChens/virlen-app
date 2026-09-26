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

### 3.5 屏底行上滚：为何「光标压在状态行上、输入覆盖状态行」（2026-09-26 用户报回 → 已修）

**现象**：`virlen-cli chat` 底部两行是 `>` 与状态行，但光标不落在 `>` 后面，而在状态行开头；敲字时文字直接盖在状态行上（若输入的是 `abc`，状态行就变成 `STabcS-ROW …` 这种样子）。

**取证工具（已建在仓库外，可复用）**：`%TEMP%\ratatui-inline-spike`

- `console_probe.exe bottom <variant>`：在**隐藏的新控制台**里跑同一套 ratatui 序列，每一步用 WinAPI 读回真实屏幕（`buffer`/`win`（窗口原点）/`cursor` + 每一行文本）写入 `%TEMP%\console-probe.txt`；`variant` 用来做 A/B（`style` = 用 `Paragraph` 级样式、`spanstyle` = 样式落在 `Span`、`long` = 长 ASCII 文本、`t2` = 裁到 118 格…）。
- `console_probe.exe watch <pid>` / `watchloop <pid> <n> <ms>` / `type <pid> <text> [enter]`：**附加到另一个进程的控制台**（`FreeConsole` + `AttachConsole`）取屏 / 用 `WriteConsoleInputW` 注入按键（不需窗口焦点）→ 因此可以对**真 app** 逐帧观测。

**根因（逐帧实测）**：**写到某一行的最后一格时 conhost 会留下一个「待换行」；当它兑现时行号已在屏底，控制台就把整屏上滚一行**。ratatui/crossterm 不知道这件事，于是：

- 视口里的**正文比 ratatui 模型偏上一行**（窗口回退1），
- 但**光标仍按模型落位**（crossterm 的 CUP 是视口相对坐标）→ **光标落在状态行上**；
- 之后每帧的 diff 只重画“变了的格子”，而模型以为输入行在第 28 行 → 敲下的字被画在第 28 行（= 视觉上的状态行）→ **输入的文字覆盖状态行**。

**关键实验（120x30 控制台、视口贴底；「上滚」= `win_top` +1）**：

| 帧里画了什么 | 画出的终端宽度 | 结果 |
|---|---|---|
| 只有文本（`> ` / 状态文本本身，无补白无样式） | ≤ 119 | 不上滚 |
| 状态行用 `Paragraph` 级样式（`.style(Cyan)`）→ 文本之后的空格也全被 `set_style` → 逐格重画到行尾 | 120 | **上滚** |
| 同上但渲染区裁到 118 格（文本含 4 个 `·`；CJK 字体下每个按 2 列 → 实际 122 > 120） | 122 | **上滚** |
| 118 个 ASCII 字符（有样式 / 无样式各一组） | 118 | 不上滚 |
| 样式落在 `Span` 上（只画文本那一段） | 62 | 不上滚 |
| 输入行画满 120 格（`Paragraph` 级样式） | 120 | **上滚** |

⇒ 两条结论：**① 帧里任何一行都不能碰到屏的最后一格**；**② 状态行又必须把自己的尾巴涂满**（不涂，状态行变短时（`Esc 取消` → `/help · /exit`）上一帧的残字会留在屏上）。

**为什么文本会「比模型宽」——同机实测（写一个字符后读光标的列偏移）**：

| 字符 | `A` | `·` U+00B7 | `—` U+2014 | `取` | `⠧` U+2827 | `─` U+2500 |
|---|---|---|---|---|---|---|
| 终端推进列数 | 1 | **2** | **2** | 2 | 1 | 1 |

⇒ **`·` 这类「歧义宽度」字符在 CJK 字体下由终端按 2 列推进，而 ratatui 按 1 列排版**。这直接解释了上表的后三行：原代码把整行空格也涂色（`Paragraph` 级样式）→ 逐格画到行尾；文本里 5 个 `·` 让实际宽度多出 5 列 → 顶出 120 列行尾 → 待换行在屏底兑现 → **整屏上滚**。`unicode-width` 的 `width_cjk` 与实测一致（`·` 算 2 列），所以用它算上限是对的；`width`（默认口径）会偏低。


**修法**（`virlen-cli/src/tui/view.rs`，±20 行）：整帧往右收 `RIGHT_MARGIN = 2` 列；状态行的颜色只落在 `Span`；状态行文本按 **`width_cjk`** 截断后再用空格补满到 `区宽 - RIGHT_MARGIN`（文本与补白同一上限 ⇒ 所有帧都只画 `[0, 上限)`，残字无处藏身）。`unicode-width` 因此开了 `cjk` feature（只新增 `*_cjk`，不改 `width()`，对 ratatui 无影响）。

**验收（真 cmd.exe 窗口 + `watch`）**：修后 `>` 在倒数第二行、状态行在最后一行，光标的窗口相对行 = 输入行；`type abc` → `> abc` 落在 `>` 后面、状态行完好；`/help`（提交 + 重绘）后视口仍与模型同步；**修前**同一手法能稳定复现错位（时间线：`win_top` 在首帧后就比预期多 1）。

**剩余风险（如实标注）**：`·`/`—` 这类**歧义宽度**字符在 CJK 字体下由终端按 2 列推进，而 ratatui 按 1 列排版 → 行内会轻微错位；本轮只把**状态行**（屏底行、最敏感）按 `width_cjk` 算死，**正文里出现这类字符时仍可能轻微错位**，被排满的行溢出到最后一格时仍可能触发上滚（`RIGHT_MARGIN=2` 只缓一部分）。彻底解法需 ratatui 支持 CJK 口径排版，或 TUI 自己测宽度后自行折行。

### 3.6 固化正文的中文「每字一个空格」：ratatui `insert_before` 的 continuation bug（2026-09-26 用户报回 → 已修）

**现象**：`virlen-cli chat` 退出后回看的会话输出里，中文/emoji 每个字后多一个空格（`我 是 你 的 **AI 智 能 助 手 **`）；但**输入框里的中文**（视口内）正常紧凑。

**根因（源码确证，非推测）**：ratatui buffer 里宽字符后面有一个 **continuation cell**（`CellDiffOption::Skip`，symbol=空格）。视口内渲染走 `Terminal::draw → diff_iter`（跳过 continuation）；固化走 `Terminal::insert_before`，但 Windows 上 `scrolling-regions` feature 不可用（`ScrollUpInRegion` 的 winapi 返回 `Unsupported`），落到 `insert_before_no_scrolling_regions → draw_lines`——它**直接遍历 buffer 每个 cell**、不跳过 continuation → 每个宽字符后多输出一个空格。

**修法**（`virlen-cli/src/tui/term.rs`）：`insert_before` 的 `draw_fn` 里、`Widget::render` 后调 `strip_wide_continuations`：把宽字符（`cell_width ≥ 2`）后面 `(w-1)` 个 continuation cell 的 symbol 清成空串（`set_symbol("")`，不是 `reset()`——`reset` 后 `symbol()` 返回 `" "` 等于没清）。

**验收**：真机注入中文提问 → 固化后滚动区中文紧凑无间隔（修前每字一个空格）；单测 `strip_wide_continuations_*`（cli 123 → **125**，全仓 508 passed）。

**如实标注**：这是绕过 ratatui 的 bug，不是上游修复；`draw_lines` 或 Windows `scrolling-regions` 一旦上游修好，此 workaround 可删。

### 3.7 中文「残影」：一行变短后多出来的汉字不消失（2026-09-26 用户报回 → 已修）

**现象**：长中文回答在在飞区滚动（或状态行变短）时，**行尾残留孤立的汉字**（实测 `…现实可能性。␣␣␣洛`、`…图灵机的提出␣␣␣洛`），即“某行比上一帧短，多出来的字符不消失”。

**根因（源码级）**：`ratatui-core/src/buffer/diff.rs` 在「宽字符被窄字符替换」时**不重发宽字符的 trailing（第 2 列）**——只在「previous 宽字符带可见样式」时才强制重发，否则 `else` 分支什么都不做（注释假设 *“标准宽字符（CJK）终端能很好处理”*）。**该假设在 conhost 上不成立**：conhost 不会在「窄字符覆盖宽字符起始列」时清掉第 2 列 → 半个/整个汉字残留。我们的正文是 `Style::default()`（无 bg）→ 正好落进那个“什么都不做”的分支。

**修法**（`virlen-cli/src/tui/view.rs`）：整帧渲染后把视口所有 cell 标为 `CellDiffOption::AlwaysUpdate`（diff 绕过相等判断 → 每帧完整重画；**只画 `[0, 宽-RIGHT_MARGIN)` 列**，右侧保留列不能画，否则触发 §3.5 的上滚）。视口 10×118，重画量可忽略。

**连带**：`AlwaysUpdate` 让状态行整行连续重写，暴露了状态行里 `·`（歧义宽度）的错位（运行中变成 `… Documents1.1s · Es消`）→ **状态行分隔符 ` · ` 改为 ASCII ` | `**（ASCII 两边宽度一致）。

**验收**：真机长中文回答 + `watchloop` 连拍 60 帧 → 无孤立汉字残留、状态行干净；单测 `status_line_has_no_ambiguous_width_chars`（cli 125 → **126**，全仓 508 passed）。

**如实标注**：`AlwaysUpdate` 是绕过 ratatui 的 diff bug（上游修 `diff.rs` 后可撤）；代价是视口每帧全量重画。

### 3.8 工具调用处的「正文重复 / 时序错乱」：助手正文块按 `messageId` 认（2026-09-26 用户报回 → 已修）

**现象**（用户原话：“工具输出的时序为什么在下一轮 ai 回复的后面？”）：`⏺ user_choice(...)` 之后**又出现一段助手正文**；而`→ 答案`（答题回显）与 `⎿ ok · N 字符 · …`（工具结果）反而被顶到**下一轮正文之后**。

**引擎的事件顺序（源码确证）**：① 增量 `assistant_message_updated{streaming:true, contentDelta}`（`llm_round.rs::flush_stream_state`）→ ② `tool_call`（工具行）→ ③ **收尾帧** `{streaming:false, content=<全量>}`（`finalize_assistant_message`，在**执行工具之前**）→ ④ 交互请求 / 用户应答 → ⑤ `tool_result_created`（`execute_tool_steps` 是**顺序** `for`）→ ⑥ 下一轮 LLM（**新的** `messageId`）。⇒ “工具结果先于下一轮正文”是引擎侧保证的。

**根因（UI 侧）**：旧状态机只记“当前正在追加的那一块”（`assistant_at`），而 `ToolStart` 会把它置 `None` → ③ 的收尾帧找不到原块，被当成**新消息**再插一块（**正文重复**）；紧接着 ⑥ 的增量**继续写进那一块**（它成了“当前块”）→ 下一轮正文长在 ④⑤ **之前**（**时序错乱**）。**一个 bug，两个症状。**

**修法**：正文块改为**按 `messageId` 认块** —— `state/mod.rs` 新增 `assistant_blocks: HashMap<String, usize>`（`take_commit` 一并清空），`state/event.rs` 的 `append_assistant / set_assistant` 走新的 `assistant_idx(msg_id, create)`；增量来源改用 `assistant_message_updated.patch.contentDelta`（同一份 delta，但**多带 `messageId`**），`stream_event` 于是只记不送（两者都取会双份正文）。

**验收**：单测 `finalize_frame_after_tool_call_reuses_the_same_block` / `next_message_text_starts_a_new_block_after_the_tool_line`（cli 126 → **128**，全仓 508 → **512**）；真机 `user_choice` 场景（探针 `typecn` 注入「中国历史」→ `type1` 答 1）修前同屏可见“⏺ 后重复正文 + →/⎿ 被顶到下一轮正文之后”。

### 3.9 续连体验：退出给出会话 id 与续连命令，重连先预览最近 5 条（2026-09-26 用户要求 → 已落地）

**需求**（用户原话）：① 结束会话时显示 session id，「方便用户续连」；② `[chat] 已退出` 出现时给出 `virlen-cli chat --session <session id>`；③ 重连成功后先加载 top 5 条消息显示出来，「方便用户预览历史」。

**口径**：③ 按**最近 5 条**实现（`get_messages` 是 `ORDER BY rowid ASC`，取尾部）；退出提示里的 id **完整**给出（状态行的 `short_id` 只留前 8 位，不足以续连）。

**落点**：`tui/history.rs`（`history_preview` / `resume_hint`，纯函数，TUI 与顺序输出**共用一份**）→ `UiEvent::History(Vec<OutLine>)` → `state/event.rs` 整批进 `inflight` + `commit_pending`（**立刻固化进原生滚动区**，与 `Notice` 的区别是按角色着色）。TUI 路径下预览在「已续连会话」提示之前；顺序输出模式下直接打 stdout。

**验收**：单测 7 条（cli 128 → **135**，全仓 512 → **518**）；真机顺序输出模式：退出打印 `[chat] 会话 id: …` / `[chat] 续连本会话: virlen-cli chat --session …`，把该命令原样贴回去则 stdout 先打 `—— 历史预览：最近 N 条 / 共 M 条 ——` + 每角色一行。⚠️ TUI 路径未在无头演练中覆盖。详见 `docs/AGENTS.md` §11.23。

### 3.10 授权面板改成**显式二选一**（代码审查发现 fail-open → 已修）

**问题**：授权面板在 TUI 里是「行输入 + 回车放行」—— `Interaction::answer()` 把**空白输入**当「允许」，而界面上写的是 `[y/N]`。又因为交互期间的按键**全部**落到交互上，用户正在打字时的一次误触 Enter 就直接批准了危险命令（`execute_command` 会真的跑）；而同项目的 `run` / 顺序输出模式（`run/ask.rs`）**一直是** fail-closed（非 TTY / 空输入 = 拒绝）—— 两条路径对同一件事给出相反的安全语义。

**修法**（`tui/state/{mod,key}.rs` + `tui/view.rs`）：授权改为**显式选择**，默认选「拒绝」。

| 键 | 行为 |
|---|---|
| ← / ↑ | 选中「拒绝」 |
| → / ↓ | 选中「允许」 |
| Enter | 确认**当前高亮项**（不动就回车 = 拒绝） |
| Esc / Ctrl+C | 等同「拒绝」 |
| 其它（含 `y` / `n` / Backspace） | **一律不参与**（用户此刻可能在打字，不得当作对授权的表态） |

- 新增 `ConfirmChoice { Deny, Allow }`（默认 `Deny`）+ `Interaction::new()`（**唯一**构造入口，默认值只定一次）；`Interaction::answer()` 只看 `self.confirm`，与输入框内容彻底解耦；面板回显行由 `Interaction::answer_line(&payload)` 产出（按**实际发出的载荷**判「✔ 已允许 / ✘ 已拒绝」，界面与引擎不会分叉）。
- 视图：选项渲染成 `[拒绝] / [允许]`（选中项加方括号 + `REVERSED|BOLD`，未选中 DarkGray）→ **纯文本即可断言**，不必逐格读 `REVERSED`。分隔符用 ASCII `|`（`·` 是歧义宽度字符，见 §3.5）。
- 光标：授权面板**不调** `set_cursor_position` —— ratatui 的 `try_draw` 在 `cursor_position == None` 时调 `hide_cursor()`，等价于隐藏光标（把光标留在选择行会暗示「这里可以打字」，那正是旧实现被误触的根源）；`user_choice` 等行输入类仍显示光标。
- 提示文案同步更新：`tui/commands.rs::help_text()` 与 `chat --help` 都写明键位与「不动就回车 = 拒绝」。

**验收**：新增回归 6 条 —— `state/tests.rs`（`confirm_defaults_to_deny_so_a_stray_enter_never_approves` / `confirm_requires_moving_the_highlight_to_allow` / `confirm_ignores_letter_keys_and_keeps_input_clean`）、`view/tests.rs`（`confirm_panel_is_an_explicit_picker_with_deny_preselected` / `confirm_panel_highlight_follows_arrow_keys` / `choice_panel_keeps_the_line_input_cursor`）；cli 135 → **139**，全仓 518 → **523**；`cargo check --workspace --all-targets` 0 error / 0 warning。详见 `docs/AGENTS.md` §11.24。

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
    ├── history.rs     ★续连体验：历史预览（最近 N 条）+ 退出续连提示（tui/顺序模式共用，纯函数）
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
4. **授权必须是显式表态**：TUI 用「←/→ 选择 + Enter 确认，默认拒绝」（见 §3.10）；
   `run` / 顺序输出模式用「读一行，仅 `y`/`yes` 放行」—— 两者形式不同，但**语义一致**：
   没有主动表态（TUI 不动高亮 / 行输入不输出 `y`）= 拒绝。任何一侧都不允许把「空白输入」当「允许」。
5. **不新增事件类型**（TUI 是纯消费方）→ 不触碰"四处一致"契约。
6. **「记住授权」若要做**，只能写 `app_settings.settings.permissions`（桌面端读同一份）——**改安全配置，需明确拍板**。
7. **已知缺口必须在 `/status` 里明示**：`/compact`（`compressContext` 未原生化）、费用（价目表在 TS）、技能启用状态与路径黑白名单（仍在 localStorage，见 §11.16）、Gemini（`BridgedProvider` 在装配期已被拒绝）。

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

---

## 10. CLI 配置向导（`provider` / `agent`）—— 评估 → 设计 → 实现（2026-09-26）

### 10.1 起因（用户原话）

> 「评估一下 cli 还缺少什么功能，我希望 cli 可以单独配置一个供应商（不是 json 赋值）。是一个流程，让用户逐步输入数据，最后验证，也可以单独配置一个 agent」

### 10.2 评估：这条命令填的是哪个坑

**改前**「配一个供应商」只有一条路：`config set providers '[{…完整 JSON…}]'` —— 而它是**整键覆盖**：

| 症状 | 证据 |
|---|---|
| 想加一个供应商，必须把**已有全部** provider 连 `id` / `createdAt` 一起抄进 JSON，漏一个字段就毁掉现有配置 | `config.rs::set` 单键 upsert；`session_db/settings.rs` 无数组合并 |
| 写错键名**静默无效**（退出码 0、无任何提示、GUI 永远读不到） | 前端 `settingsRepo::pickKnownSettings` 丢弃未知键；`config.rs` 自己也不校验键名 |
| `config get` 把 `providers[].apiKey` **明文**打到 stdout | `config.rs::get` → `get_all()` 原样 `to_pretty` |
| 数组只能整组写 → 与桌面端（内存快照 + 400ms debounce 整组落库）的**冲突窗口很大** | `agentRepo::schedulePersist` / `settingStore::installSettingsPersist` |

**其余缺口（本次未做，按优先级留档）**：`session rm/rename/export`、`list-skill`、`usage`、`doctor`（自检）、`chat` 内 `/provider` `/model` 切换、`run --pick`。

### 10.3 技术前提（先解决才能写向导）

| # | 事实 | 处理 |
|---|---|---|
| 1 | `PROVIDER_TEMPLATES` / `REASONING_EFFORT_UNION` / `DEFAULT_REASONING_EFFORT_LIST` 只存在于 `src/domain/provider/config.ts`，**Rust 侧没有** → CLI 要么抄一份（第二个权威源），要么搬过来 | 按 §11.26「提示词迁 core」的同一套路搬到 `virlen-core/src/agent/provider/provider_catalog.json` |
| 2 | 原生 `Provider` trait 只有 `chat` / `chat_stream`，**没有 `list_models`** | core 新增 `agent/provider/models.rs`（`list_models` / `verify_connection`），**不加进 trait**（否则 `BridgedProvider` 也得陪跑一遍） |
| 3 | `reqwest` 只在 core 里（CLI 自身没有） | 校验逻辑放 core；`virlen-cli` 的依赖表**一个都没加** |
| 4 | `gemini` 走 `BridgedProvider`（需要前端 JS） | 向导在第 3 步**提前拒绝**，而不是配完才发现跑不起来 |
| 5 | Agent 需要的两个枚举源**已经在 core** | 工具：`tool_defs::list_tool_definitions()`；技能：`<data_dir>/skills` 子目录（`AgentEnv::load` 一处备齐） |

### 10.4 设计（已实现）

```
virlen-cli provider add | edit [<id>] | rm <id> [--yes] | list [--json] | test <id>
virlen-cli agent    add | edit [<id>] | rm <id> [--yes] | list [--json]
```

**`provider add` 十步**：模板 → 名称 → 协议类型 → API 地址 → API Key（**关回显**）→ 模型列表
（`GET {base}/models` 自动拉取，失败 / 超 50 个 / 无 key → 手工输入）→ 推理档位多选 → 默认档位 →
**连通性验证**（发一条 `ping`，与 GUI `validateApiKey` 同一路径、同样 `max_tokens: 1`）→ 回显确认 → **按 id 合并写入**。

**`agent add` 十步**：名称 → 描述 → 身份/性格 → 工作目录 → 项目规则文件（相对路径校验）→
默认模型（供应商 → 模型）→ 工具白名单（默认全选）→ 技能 → 温度/topP → 回显确认。

**三条口径**（都对齐桌面端）：

1. **字段名逐字对齐**前端 `ProviderConfig` / `Agent`（两侧不建映射表，`docs/config-sink-plan.md` §6 R6）；
2. **模板表 / 档位表来自 core**（与桌面端同一份）；工具 / 技能来自各自权威处；
3. **只写自己改的字段** —— `settings_edit::upsert_by_id` 走**字段级合并**：`enabled` / `createdAt` /
   桌面端以后新增的字段都不会被抹掉；写完**回读比对**，被并发覆盖时直接报错（**不是乐观锁**，见 §10.7）。

**⚠️ 刻意没做的事**：`add` / `edit` **不支持命令行开关**（只能交互）。理由：向导的价值就是「逐步录入 + 当场校验」，
加一套 flag 壳会让两条路径都难维护；而脚本本来就有 `config set` 这条逃生口。stdin 不是终端时**直接报用法错误（退出码 2）**，绝不半交互挂住。

### 10.5 实现落点

| 文件 | 放什么 |
|---|---|
| `virlen-core/src/agent/provider/provider_catalog.json` | **模板表 + 档位表的唯一物理源**（`include_str!` / 前端 `?raw` 同读一份） |
| `virlen-core/src/agent/provider/catalog.rs` | 解析 / `find_template` / `effort_rank`；`pub mod catalog` |
| `virlen-core/src/agent/provider/models.rs` | `list_models`（openai `/models`；anthropic 用 **origin**，对齐 TS）/ `verify_connection`（`ping`，`max_tokens: 1`） |
| `src-tauri/src/commands/agent.rs` | 命令 **`cmd_provider_catalog`**（`lib.rs` 已注册） |
| `src/domain/provider/catalog.ts` | 前端快照：`setProviderCatalog` / `providerCatalog()`（**未水合抛错**）/ `providerTemplates` / `reasoningEffortUnion` / `defaultReasoningEffortList` / `sortReasoningEfforts`（**替换**被删掉的 `domain/provider/config.ts`） |
| `src/infrastructure/provider/catalog-source.ts` | Tauri 走命令 / 浏览器 dev·vitest `?raw` 读同一份 json + `hydrateProviderCatalog()` |
| `virlen-cli/src/wizard.rs`（+ `wizard/tests.rs`） | 问答原语：`text` / `text_opt` / `text_with`（**校验不过就重问**）/ `secret`·`secret_opt`（真终端 raw mode **关回显**，Drop 守卫恢复）/ `choose` / `multi`（编号 / `all` / `none`）/ `confirm`；**EOF 一律报错**，绝不进「空输入→重问」死循环 |
| `virlen-cli/src/settings_edit.rs` | 数组键的按 id 增删改 + **字段级合并** + 回读校验 |
| `virlen-cli/src/provider.rs`（+ `provider/tests.rs`） | `provider` 子命令（10 步向导 + `list` / `test` / `rm`） |
| `virlen-cli/src/agent.rs`（+ `agent/tests.rs`） | `agent` 子命令（10 步向导 + `list`（复用 `list-agent`）/ `rm`） |

### 10.6 验证（本机实测）

| 项 | 结果 |
|---|---|
| `cargo test --workspace` | **582 passed**（app 29 / cli **183**（139→+44）/ core **370**（358→+12）；2 ignored） |
| `cargo clippy --workspace --all-targets` | 新增文件 **0 告警**（历史 74 条未动） |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | **91 文件 / 1059 tests**（90/1050 → +1 文件 `provider-catalog-contract.test.ts`、+9 用例） |
| **真机冒烟**（临时 `VIRLEN_DATA_DIR`） | `provider list`（空库 / 有数据 / 表格对齐）、`provider list --json`（apiKey → `****efgh`）、`agent list`、`provider test`（快速失败 + 两条检查各自报告）、`provider rm --yes`（**带「Agent 仍引用」告警**）、`agent rm __default__`（拒绝）、非终端跑 `add`（退出码 2） |
| 向导本身的可用性 | 在一次「误在真终端里跑」的冒烟中意外验到：模板列表、分步提问、**密文输入回显 `***`**、真实 HTTP 401 报告均正常 |

### 10.7 未闭环 / 已知限制（如实标注）

1. **不是乐观锁**：桌面端正在运行时，它的内存快照 + debounce 落库仍会**整组覆盖**本次改动；回读校验只能把「已经发生」的覆盖变成一条可见错误，不能阻止它。命令成功时会打一行提示让用户重启桌面端。
2. **`provider add` / `edit` 需要真终端**（stdin 不是终端就直接报用法错误）—— 这是有意的，不是待办。
3. **`gemini` 等未原生化协议在 CLI 里配不了**：向导明确拒绝并给出「改 openai 兼容端点」的替代做法。
4. **`config get` 仍会明文输出 `apiKey`**（评审项 N1，用户本次未勾选 → **未动**）；`provider list` / `provider list --json` 已自行打码，**没有**新增泄漏面。
5. **项目规则文件路径校验有两份实现**（TS `normalizeProjectRulesPath` ↔ Rust `validate_project_rules_path`）：真正的准入闸仍在前端读路径上（CLI 不读规则文件），差异的后果只是多一次驳回。改规则要**两处一起改**。
6. **未做端到端的自动交互测试**：`wizard` / `provider` / `agent` 的用例都是「喂脚本 + 断言」，真实 raw-mode 密文输入与真终端的按键流**只能人眼验**（与 §9 第 6 条同类）。

---

## 11. 上下文占用显示 + 压缩上下文（2026-09-26）

### 11.1 需求与决策（用户原话）

> 给 cli chat 添加，显示上下文（100% 200k先写死，后面调整）百分比、压缩上下文的功能，压缩上下文要让用户用户可以选中 ai 摘要压缩或者正文压缩
>
> （追加）在 list-session 的时候多显示两项，上下文大小%，对话条数

三个决策点由用户拍板：

| 决策 | 选定 | 为什么不选另一条 |
|---|---|---|
| 压缩逻辑落哪层 | **`virlen-core`**（`agent/compress/`，两种模式） | 原先只有 TS 一份；GUI 走 Rust 引擎时也是**回调 TS**。落 core 才能只保留一份实现，将来 GUI 也可切过来 |
| 占用 token 口径 | **优先 DB 里最后一条带 `usage` 的消息**（供应商回报的真实值）；`raw` 压缩后的占用用估算 | 零成本且精确；把 7.85MB tokenizer 搬进 core 代价大（首次 ~1s + 内存） |
| 交互形态 | **`/compress` 弹选择面板** + `/compress ai\|raw` 直接指定；占用 < 40% 拦下 | 面板才是用户说的「选中」；阈值与桌面端同口径 |

### 11.2 界面

```text
状态行：  · deepseek-v4-flash | 81985144 | virlen-app | 6% (12.5k/200k) | 0.4s | /help | /exit
                               ↑ 没有用量数据时这一项**不显示**（而不是显示 0%）

/compress 面板（与授权面板同款的**显式选择器**，无文本光标）：
  ? 压缩上下文：选择方式
     AI 摘要
    [正文压缩（默认）]          ← 方括号 = 当前高亮（纯文本可断言）
    （↑/↓ 选择 | Enter 确认 | Esc 取消）
```

- 压缩期间状态行提示「正在压缩上下文…」，spinner 继续转（AI 摘要要等一次模型调用）；
- 面板开着时**字符键一律不参与**（与授权面板同一条 fail-closed 口径）：用户此刻很可能在盲打下一句；
- 顺序输出模式（无 TTY / `--no-tui` / 降级）没有面板：读设置里的 `contextCompressMode`，读不到就要求写明方式，**不猜**；每回合末尾额外报一行「上下文 40k / 200k（20%）」。

### 11.3 三个数不能混

| 数 | 含义 | 来源 |
|---|---|---|
| `usage.totalTokens` | 这次摘要调用**花了多少**（含压缩前全部历史） | 供应商回报（记入用量账本 `kind=compress`） |
| `uiData.contextTokens` | 压缩后下一轮请求**上下文多大** | 本地粗估（CJK 0.6 token/字符）；也是状态行显示的那个 / 200k |
| 上一条消息的 `usage.totalTokens` | **当前**上下文占用（未压缩时） | 供应商回报（口径与桌面端 token 环一致） |

AI 摘要消息同时带前两个：拿 `usage` 当占用会显示成「压缩后反而更大」——这是 `context_tokens()` 里「带 `contextTokens` 的消息一律优先」的由来。

### 11.4 与 TS 的差异（如实标注）

1. **token 计数**：TS 在 Tauri 下用 DeepSeek tokenizer 精确计数；Rust 侧只有 CJK 感知粗估 → **只有「压缩后占用」这个数不同**（当前占用优先取真实用量）。
2. **截断单位**：TS 按 UTF-16 码元（并做代理对保护），Rust 按字符（码点）→ 阈值附近 ±1 字符差异；Rust 侧不可能切出非法内容。
3. **`max_tokens`**：TS 传 `undefined`（用 provider 默认），Rust 传会话自己的 `params.maxTokens`（<= 0 时退 4096）—— `ChatRequest.max_tokens` 是 `i64` 且 provider 会**无条件**写进请求体，传 0 会被部分 API 拒掉。
4. **未动 GUI**：TS 那份仍在（GUI 仍走它），两份实现暂时并存。

### 11.5 验证

| 项 | 结果 |
|---|---|
| `cargo test --workspace` | **625 passed**（app 29 / cli 199 / core 397；本次 +43） |
| `cargo clippy --workspace --all-targets -- -D warnings` | **0 告警**（exit 0） |
| 真机冒烟（真实库 175 会话） | `virlen-cli list-session --limit 5` 两列正常：`4% 8.3k / 8 条`、**`100% 356.0k / 2540 条`** |
| 真实 SQLite 集成测试（`session_rt/tests.rs`，4 条） | 落库/快照/占用刷新；**失败不留半成品**；无用量数据被闸门拦下并说清原因；桥接协议在装配期被拒 |
| TUI 渲染/状态机（TestBackend + 纯状态机） | 面板两项可见、默认预选设置里的方式、无光标；字符键不参与；Esc 取消；压缩中拦输入/不固化/继续 tick；状态行 `20% (40k/200k)`；无数据不显示百分比 |

⚠️ `100% 356.0k` 这条**同时是 200k 只是占位的证据**：真数据已超窗口 → 百分比按设计饱和到 100%。将来改成「按模型下发窗口」时，这一列会立刻变得有区分度。

### 11.6 未闭环 / 已知限制

1. **选择面板的真终端外观与键位未人工复验**（TestBackend 能断言选项/高亮/无光标，但真 conhost 的按键流只能人眼验，与 §9 第 6 条同类）。
2. **AI 摘要在 CLI 里不可取消**：主循环直接 `await`（TUI 线程独立照常渲染，期间按键排到压缩结束后处理）。上限由 provider 的 HTTP 超时决定。
3. **`list-session` 表格约 139 列宽**：窄终端下最后一列（标题）会折行（真机已复现，列对齐不受影响）。需要机器可读请用 `--json`；要压窄就改 `list/render.rs` 的 `COL_*`（尤其 `COL_TITLE`）。
4. **`raw` 压缩后的占用是粗估**（同 §11.4 第 1 条）；中文与代码混合文本下偏差最大。
5. **压缩阈值 40% 是硬编码常量**（与 TS 同值），不随模型窗口变化。

> **后续更新**：窗口大小已不再写死 —— `app_settings.contextWindowTokens`（桌面端设置页可改，CLI 只读展示）为「100%」对应的 token 数；`CONTEXT_WINDOW_TOKENS = 200_000` 退为默认值，百分比（状态行 / `/status` / `list-session` / `/compress` 闸门）均按该窗口算。

### 11.7 上下文压缩与「清单保活」

压缩产物是一条 `role="summary"` 消息，而请求组装（`provider::blocks::slice_messages`）会丢弃**最后一个 summary 之前**的全部消息 —— 因此若「当前活跃清单」（消息历史里最后一条 `uiData.type == "todo"` 的快照，模型 `todo_write` 的 tool_result 或用户 feedback 都可能）落在压缩区间内，模型此后就看不到它（表现：压缩后 AI 忘记清单）。

对策：压缩时把清单**原文**渲染成文本补在 summary 正文末尾（`agent::compress::todo_recap`，渲染复用 `plan::render_todo_content`）；summary 会被 Provider 统一映射成 `user` 消息，靠文本足够。
⚠️ **不**把清单快照的 `tool` 消息原样搬到 summary 之后：`tool` 消息必须紧跟带 `tool_calls` 的 assistant 消息，否则 OpenAI / Anthropic 协议直接报错。

- 只在快照**落在压缩区间内**（`index >= slice_start`）时补 —— 若它在更早的 summary 之前，说明上一次压缩已处理过，补了会重复。
- TS 侧（`compress-context.ts::withTodoRecap`）与 Rust 侧**同语义**（铁律 1）；GUI 与 CLI 共用 core 实现（GUI 仍走 TS 那份）。

