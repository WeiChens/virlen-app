# PTY 终端改造 — 调研报告与方案选型

> **状态**：**Step 1（L2 PTY 改造）已落地并实测通过**（2026-09-18 本机，见 §8.1）；
> **Step 2（交互语义）已实施并实测通过**（见 §8 Step 2 与 §8.2；D1–D6 已按建议默认值定稿）；
> Step 0 Spike 保留作回归测试（`conpty_spike.rs`）
> **决策**：采用**方案 B — 自研 ConPTY**（见 §4.2），不使用 `portable-pty`
> **关键结论**：**受限令牌 + Job Object + ConPTY 三者可以共存** —— 原 §7 风险 #1 已消除
> **日期**：2026-09-18（Spike 实测同日记入）
> **调研范围**：社区对标实现 2 个、Rust PTY 生态、ConPTY 官方 API 指南、**本机 Spike 实测**
> **Spike 代码**：`src-tauri/src/sandbox/windows/conpty_spike.rs`（`#[cfg(test)]`）
> **相关**：`docs/rust-engine.md`（引擎架构）、`AGENTS.md` §5 铁律 / §9 安全红线 / §11.2

---

## 一、背景与目标

当前 `execute_command`（Rust 原生 `native_tools/execute/execute_command.rs` + TS 侧
`infrastructure/tools/execute/execute-command.ts`）是**一次性、单向管道**模型：

- 子进程 `hStdInput = null`（`sandbox/windows/spawn.rs`），stdout/stderr 各一条匿名管道；
- 跑完才返回，结果里按 `stdout` / `[标准错误]` 分段；
- 用户对「执行中」的干预手段只有两个：**执行前**弹窗审批、**执行中**杀进程树。

因此以下场景全部不可用：

| 场景 | 现状 |
|---|---|
| `npm login` / `gh auth login` 等需要输入 | 挂到超时 |
| `y/n` 确认、密码提示 | 挂到超时 |
| `python` / `gdb` / `mysql` REPL 首次交互 | 不可用 |
| 进度条、彩色输出、TUI 光标控制 | `\r` / ANSI 被 `processTerminalOutput` 粗暴压平 |
| 命令跑偏时用户当场接管纠正 | 只能杀掉重来 |
| Ctrl+C 中断 | 只能杀整棵进程树（粗暴，且丢失 partial 输出语义） |

**目标**：把 `execute_command` 的 stdio 从「匿名管道」换成「伪控制台（PTY）」，
使 AI 可运行、**用户可干预、可交互**。

---

## 二、概念分层（先分清层次，否则方案必被谈乱）

社区实践里「给 AI 一个终端」其实是三个量级完全不同的东西，混谈必然踩坑：

| 层 | 形态 | 是否需要哨兵 | 难度 |
|---|---|---|---|
| **L1** | 单向管道 → 双向真终端（stdin 是控制台） | 否 | 低 |
| **L2** | PTY 挂在**每次一条命令的短命 shell** 上，进程退出 = 命令结束 | **否**（退出码就是真的） | 低 |
| **L3** | 常驻交互式 shell，AI 与用户共享同一会话 | **是**（需哨兵检测命令边界） | 高 |

**关键结论：Virlen 现有架构天然就是 L2** —— 每次调用 spawn 一个
`powershell -NoProfile -Command "<cmd>"`。这带来四个白捡的好处：

1. **不需要哨兵**：进程退出即命令结束，`exit_code` 由 `wait_and_read_exit_code()` 直接拿到，
   不必往 shell 里注入 `echo <SENTINEL>` 再从输出流里剥回来。
2. **不需要「shell 跳转重挂」**：`ssh` / `su` / `docker exec` 进去后哨兵会丢，
   这是 L3 方案必须额外处理的，而 L2 不存在这个问题。
3. **不需要 `output_ref` 两级取数**：可以直接沿用现有 32 KB 截断策略。
4. **用户干预的实现量极小**：一个 `pty_write` 命令 + 前端加输入框即可。

> 因此本次改造建议**先做 L2**，L3（常驻会话 + 哨兵 + 接管交还）作为后续可选演进。

---

## 三、社区对标实现

### 3.1 WinkTerm（`Cznorth/winkterm`，MIT，Python + Next.js）

**核心哲学：「AI 不偷偷替你执行命令」**——AI 把命令写进你的输入行然后停下，
你按 `Enter` 才跑；按 `Backspace` 可改，`Ctrl+C` 可取消。主动权始终在人手里。

三个工具的设计：

| 工具 | 语义 |
|---|---|
| `terminal_input` | 执行命令 / 发控制键，并拿到执行结果 |
| **`write_command`** | **只把命令写进输入行、不执行，然后停下等你确认** |
| `get_terminal_context` | 只读地读取终端输出内容（不产生副作用） |

后端 Agent API 的工程细节（均为实践沉淀，非设计推演）：

- `exec`：**原子执行 + 哨兵**，返回 stdout + **真实 `exit_code`** + 当前 `cwd`；
  哨兵自动剥掉命令回显与提示符。
- `input`：**命名控制键** `{"keys": ["ctrl+c"]}`，不必往 JSON 里塞裸控制字节；
  `data_b64` / `command_b64` 绕过多层引号转义地狱。
- `snapshot?pattern=`：服务端在 **256 KB 滚动缓冲**内做正则匹配，省带宽。
- `stream`：SSE 推流，服务长命令 / `tail -f`，支持 `since` 断线续传。
- **wait reason 字段**：区分 `idle` / `timeout` / `no_output` —— 比「只有超时」信息丰富得多。
- TTL 30 分钟自动清理，避免遗忘的终端泄漏。
- 技术栈：FastAPI + LangGraph + Python `pty` 后端，Next.js + **xterm.js** 前端，WebSocket 传输。

### 3.2 terminal-mcp（`fzxbl/terminal-mcp`，MIT，Go，MCP 服务器）

比 WinkTerm 更工程化，六个机制值得完整吸收：

1. **真 PTY + 常驻会话**，明确反对「一次性 exec 管道」。
2. **可观测**：每个会话给一个 live web terminal URL，用户开着就能实时看 AI 的每一步。
3. **接管 / 交还（takeover / release）** —— 本次调研看到的最贴合「用户可干预」的交互模型：
   - 点「接管」→ `held=true`，**AI 的写入立即暂停**；
   - 用户手敲命令 → 被重建为 `[rc=n] $ cmd` 喂回给 AI；
   - 点「交还」→ AI **带着「用户刚才干了什么」的完整上下文**继续，不丢状态、不用重新解释。
4. **哨兵 + 跳转重挂**（配置项 `shell_switch_commands`）：`ssh` / `su` / `docker exec` /
   `chroot` 进去后自动重装哨兵，保证跟踪不断。
5. **LLM 友好输出 + 内存有界**：
   - 剥离 ANSI，并且**卡住不完整的转义序列**（半个 `\x1b[` 不发给模型）；
   - 会话日志 append-only 落盘作为真相来源，内存只留有界 tail cache
     → `yes` / `cat 大文件` 打不爆内存；
   - 超长结果返回 `output_ref`，模型用
     `terminal_explore(op=stat|grep|read, line_offset, limit, pattern, before, after)`
     按需取行。
6. **围栏（fence）**：`resource_limit_cmd` 注入 `ulimit`，**且每次切 shell 都重新注入**；
   硬限制被所有子进程继承，未提权进程无法自行提高 → Agent 换 shell 也逃不掉。
   （Virlen 已有沙盒，这是同类问题的另一种解法；其「模型不可见」的思路值得借鉴。）

工具面：`terminal_open / send / output / explore / control / status / close / list`

> ⚠️ 其 `SECURITY.md` 写得很直白：**调用这些工具等价于宿主机 shell 访问**。
> 这正是 Virlen 的沙盒存在的理由 —— **不能因为要交互就放弃沙盒**。

### 3.3 可借鉴清单（按对本项目的适用性排序）

| # | 机制 | 来源 | 对 Virlen 的适用性 |
|---|---|---|---|
| 1 | **`held` 接管 / 交还语义** | terminal-mcp | ★★★ 直接采用。比「用户随时能插键盘」更不易两边打架 |
| 2 | **命名控制键** `ctrl+c` / `ctrl+d` / `ctrl+z` / 方向键 | WinkTerm | ★★★ 直接采用，避免裸控制字节穿 JSON |
| 3 | **`write_command` 只写不执行、等用户回车** | WinkTerm | ★★★ 可复用现有审批弹窗机制，把「弹窗」换成「写进终端待确认」 |
| 4 | **wait reason**（idle / timeout / no_output） | WinkTerm | ★★★ 比现有「超时/取消/退出码」信息量更大 |
| 5 | **ANSI 增量剥离 + 卡住半截转义序列** | terminal-mcp | ★★★ **必须做**，见 §6.2 |
| 6 | **内存有界**（落盘 + tail cache） | terminal-mcp | ★★★ **必须做**，否则 `yes` / `cat` 打爆内存 |
| 7 | **服务端 grep 滚动缓冲** `snapshot?pattern=` | WinkTerm | ★★ 阶段 2 可做，配合长输出场景 |
| 8 | `output_ref` + `terminal_explore` 两级取数 | terminal-mcp | ★★ L3 才需要；L2 沿用 32 KB 截断即可 |
| 9 | 哨兵 + 跳转重挂 | 两者 | ☆ **本项目不需要**（L2 架构天然规避，见 §2） |
| 10 | `ulimit` 围栏 | terminal-mcp | ☆ 本项目已有沙盒，属同类问题的另一种解法，暂不需要 |

---

## 四、Rust 侧技术选型

### 4.1 方案 A：`portable-pty`（**弃用**）

wezterm 出品，事实上的 Rust 跨平台 PTY 标准，MIT。
当前版本 0.9.0（2026-09-08），依赖 `winapi 0.3`（Windows 侧 ConPTY）、`nix 0.28`、
`filedescriptor`、`serial2`、`shell-words`。

API 很干净：

```rust
let pty_system = native_pty_system();
let mut pair = pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })?;
let child = pair.slave.spawn_command(CommandBuilder::new("bash"))?;
let mut reader = pair.master.try_clone_reader()?;
writeln!(pair.master.take_writer()?, "ls -l\r\n")?;
// MasterPty::resize(PtySize) 可动态改尺寸
```

**弃用理由（致命）**：`SlavePty::spawn_command(cmd)` **不接受自定义访问令牌**，
其 Windows 实现内部自己走 `CreateProcessW`。要走它就等于二选一：

- 放弃受限令牌沙盒 → **直接违反 `AGENTS.md` §9**（禁止绕过沙盒直接 spawn）；
- 或者 fork / patch 该 crate 的 Windows spawn 路径 → 长期维护负担，且其依赖 `winapi 0.3`
  与本项目已用的 `windows-sys 0.61` 并存，符号体系割裂。

### 4.2 方案 B：自研 ConPTY（**采纳**）★

**决策：自己用 `windows-sys` 实现 ConPTY。**

理由：

1. **保住沙盒**：受限令牌（`CreateRestrictedToken`）+ Job Object + 伪控制台可以挂在
   **同一个 `PROC_THREAD_ATTRIBUTE_LIST`** 上，一次性原子完成，无中间态。
2. **现有基建已完成大半**：`src-tauri/src/sandbox/windows/spawn.rs` 已经在用属性列表
   （`ProcThreadAttributeList` + `PROC_THREAD_ATTRIBUTE_JOB_LIST`），
   结构就是 `InitializeProcThreadAttributeList(count)`，改造只需 `count: 1 → 2` 再加一条属性。
3. **依赖零增量**：`windows-sys = "0.61"` 已在 `Cargo.toml`，且已启用
   `Win32_System_Console` / `Win32_System_Pipes` / `Win32_System_JobObjects` /
   `Win32_System_Threading` feature（`CreatePseudoConsole` 等符号的 feature 归属**待 spike 确认**）。
4. **不引入新 crate 的版本/许可/构建风险**（§11.2 提示本机 `pnpm install` 与依赖变更本就敏感）。
5. **Unix 侧本来也不依赖它**：Linux/macOS 用标准 `openpty` + `fork/exec`，
   沙盒是 Landlock（继承跨 exec），实现比 Windows 简单。

**代价（如实记录）**：需要自己处理 §5 列出的若干 ConPTY 陷阱，代码量约
`spawn.rs` 的一个平行实现（估计 300–400 行 + 单测），比 `portable-pty` 方案多写一些，
但换来沙盒完整性与依赖可控。

---

## 五、ConPTY 实现要点（API 级，可直接当实现参考）

> 来源：Microsoft Learn《Creating a Pseudoconsole session》+ ConPTY 发布公告。

### 5.1 会话建立与句柄生命周期

```c
// 1) 先建两条同步通信管道（ConPTY 用自己的 CreatePipe，不是 §11.2 那个命名管道坑）
CreatePipe(&inputReadSide,  &inputWriteSide,  NULL, 0);
CreatePipe(&outputReadSide, &outputWriteSide, NULL, 0);

// 2) 建伪控制台：注意传的是「输入的读端」和「输出的写端」
HPCON hPC;
CreatePseudoConsole(size /*COORD, 字符数*/, inputReadSide, outputWriteSide, 0, &hPC);

// 3) 挂进属性列表（见 5.2）+ EXTENDED_STARTUPINFO_PRESENT 调 CreateProcessAsUserW

// 4) 创建子进程后，父进程立刻关掉这两个（降低设备对象引用计数，
//    使 I/O 能正确检测「通道断开」）
CloseHandle(inputReadSide);
CloseHandle(outputWriteSide);

// 5) 长期持有这两个做双向通信
//    写 inputWriteSide → 送用户/AI 输入
//    读 outputReadSide → 收 VT 渲染输出
```

**⚠️ 必须遵守**：三个 `HPCON` API —— `CreatePseudoConsole` / `ResizePseudoConsole` /
`ClosePseudoConsole`。`ClosePseudoConsole(hPC)` 会终止所有附加的字符模式应用
**及其进程树**（因此与 Job Object 存在功能重叠，需明确二者职责，见 §5.6）。

### 5.2 属性列表：`PSEUDOCONSOLE` 与既有 `JOB_LIST` 的写法**不同** ⚠️

`spawn.rs` 现有的 `set_job()` 传的是「指向句柄数组的指针 + 切片大小」：

```rust
// 现有 JOB_LIST 写法：value = &job_list（指针的指针），size = 切片字节数
let value = self.job_list.as_mut_ptr().cast();
let size = std::mem::size_of_val(self.job_list.as_slice());   // = 8（单个 HANDLE）
UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, value, size, ..)
```

而官方 `PSEUDOCONSOLE` 写法传的是「**句柄值本身**」：

```c
// 官方 PSEUDOCONSOLE 写法：value = hpc（句柄值本身），size = sizeof(hpc)
UpdateProcThreadAttribute(si.lpAttributeList, 0,
                          PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                          hpc, sizeof(hpc), NULL, NULL);
```

**两者语义不同（一个是数组指针，一个是值本身）**，直接照抄 `set_job` 的写法把
`&hpc` 传进去会失败。新增方法建议命名区分，并加注释说明差异：

```rust
fn set_pseudoconsole(&mut self, hpc: HPCON) -> Result<()> {
    // ⚠️ 与 set_job 不同：这里传句柄值本身，size = size_of::<HPCON>()
    // （JOB_LIST 要的是「句柄数组的指针」）——照抄 set_job 的写法会失败
    let value = hpc as *const c_void;
    let size = std::mem::size_of::<HPCON>();
    ...
}
```

### 5.3 `STARTUPINFO`：`STARTF_USESTDHANDLES` **必须设置**，三个句柄置 NULL ⚠️⚠️

> **本节结论已由 §8.0 实测修正。** 初版判断（「去掉 `STARTF_USESTDHANDLES`」）是**错的**：
> 实测会导致子进程继承父进程的 std 句柄，命令真实输出漏出伪控制台。

现有 `create_sandboxed_process()` 是：

```rust
// ---- 现有（匿名管道模型，保持不动）----
si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
si.StartupInfo.hStdInput  = null_mut();           // stdin 为 null
si.StartupInfo.hStdOutput = stdout_write;         // 接匿名管道写端
si.StartupInfo.hStdError  = stderr_write;
let ok = CreateProcessAsUserW(.., /*bInheritHandles*/ 1,
    CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, ..);

// ---- ConPTY 路径（实测修正后）----
si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;   // ✅ 必须设！见 §8.0
si.StartupInfo.hStdInput  = std::ptr::null_mut(); // ✅ 三个全部置 NULL
si.StartupInfo.hStdOutput = std::ptr::null_mut();
si.StartupInfo.hStdError  = std::ptr::null_mut();
let ok = CreateProcessAsUserW(.., /*bInheritHandles*/ 0,  // 不再继承管道
    CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, ..);  // 不设 CREATE_NO_WINDOW
```

ConPTY 路径下：**子进程的控制台来自伪控制台，不再通过 std 句柄传递**，但 **std 句柄仍须显式清空**：

- ✅ **必须设 `STARTF_USESTDHANDLES` 并把三个句柄全部置 NULL**。
  不设该标志时，Windows 的「标准句柄总是被继承」行为会让子进程拿到**父进程的 std 句柄**
  —— `bInheritHandles = 0` **挡不住这条**（实测见 §8.0）。置 NULL 后，CRT 在
  「句柄无效 + 进程已附着控制台」时会回退打开 `CONOUT$` / `CONIN$`，输出即正确进入伪控制台。
- `bInheritHandles` 应为 **0**（不再需要继承管道写端）。
- **`EXTENDED_STARTUPINFO_PRESENT` 必须保留**（属性列表靠它生效）。
- `CREATE_NO_WINDOW`：实测**不设**也能正常工作（未出现黑窗口，与官方示例一致）→ 建议不设。

> 建议：新增一个**独立的** ConPTY spawn 函数（如 `conpty.rs::create_sandboxed_process_pty`），
> **不要**在 `create_sandboxed_process` 里加 `if` 分支 —— 两条路径的 `STARTUPINFO`
> 语义根本不同，混在一起极易出隐性 bug。这也符合 §5 铁律 8「最小改动、不动无关代码」。

### 5.4 同步 I/O 限制：**不能用 tokio 异步管道** ⚠️

官方明确：通信通道只需**同步** I/O 句柄 ——
「File or I/O device handles like a file stream or pipe are acceptable as long as an
**`OVERLAPPED` structure is not required** for asynchronous communication」。

这意味着：

- **不能**直接把 `outputReadSide` 交给 tokio 做异步读；
- 必须用 `spawn_blocking` 里阻塞式 `ReadFile`；
- **裸跑路径要一并改造**：现在 `run_command_native` 裸跑分支用的是
  `tokio::process::Command` + `AsyncReadExt`（异步）。换 ConPTY 后这条路径也要改成
  阻塞读 + `spawn_blocking`。
  → 好消息：**沙盒路径 `run_command_sandboxed` 已经是 `spawn_blocking` + 阻塞 `read`**，
  这个模式直接复用。

官方另一条明确建议：**每条通道用单独线程服务**，各自维护缓冲区状态与消息队列；
「Servicing all of the pseudoconsole activities on the same thread may result in a deadlock
where one of the communications buffers is filled and waiting for your action while you
attempt to dispatch a blocking request on another channel.」

### 5.5 关停顺序与死锁风险 ⚠️

`ClosePseudoConsole` 有明确的死锁警告，两条都要处理：

1. 「**关闭会话时可能发出最后一帧更新到 `hOutput`，应从通信通道缓冲区中排空**」 ——
   即关停期间**读线程必须仍处于排空状态**，不能先停读线程再关伪控制台。
2. 若创建时用了 `PSEUDOCONSOLE_INHERIT_CURSOR`，不响应游标继承查询消息也会死锁
   （我们**不使用该 flag**，传 `0`，规避这条）。

另一条启动期陷阱：伪控制台在子进程**正在启动时**被关闭，会弹出错误对话框，
错误码形如 `0xc0000142`；对子进程而言「句柄无效」与「会话已关闭」表现一致。
→ 因此**不要在 spawn 后立刻 `ClosePseudoConsole`**。
（本项目的「快速失败/降级」逻辑要注意别踩这条。）

**建议的 teardown 顺序**：
杀进程树（Job Object / `kill_process_tree`）→ 等读线程自然 EOF →
再 `ClosePseudoConsole` → 关掉 `inputWriteSide` / `outputReadSide`。
配合现有「kill 后 3 秒清理窗口」的兜底逻辑（见 `run_command_native`）。

> **实测（§8.0）**：按上述顺序执行，在**读线程仍处于排空状态**时调 `ClosePseudoConsole`，
> 3.6–14.7 ms 即返回，读线程随后收到 EOF 正常退出 —— **未出现死锁**。

### 5.6 与其他机制的关系

| 机制 | 与 ConPTY 的关系 |
|---|---|
| **Job Object** | 仍要挂（`PROC_THREAD_ATTRIBUTE_JOB_LIST` 与 `PSEUDOCONSOLE` 可同时存在于一个属性列表）。`ClosePseudoConsole` 也会杀进程树 → **职责需明确**：建议 Job Object 负责「超时/取消/终止」，`ClosePseudoConsole` 只负责资源回收 |
| **受限令牌** | 仍用 `CreateProcessAsUserW` 传 `h_token`，与 `portable-pty` 方案的根本差别所在 |
| **UTF-8 解码** | ✅**实测确认**：ConPTY 输出严格通过 UTF-8 校验，且**中文直接可读**（`拒绝访问。` / `正在 Ping 127.0.0.1 具有 32 字节的数据:`），实测日志中**完全无 GBK 乱码**。→ PTY 路径下 `TerminalDecoder` 的 GBK 兜底几乎不会触发，§11.1 的老问题在 PTY 路径上消失 |
| **Ctrl+C** | ❌**实测修正**：发 `\x03` **不能**中断「不读 stdin 的前台程序」（实测 `ping` 未被打断、PTY 里也无 `^C` 回显）。根因：Windows 控制台的控制事件是在**有人读输入缓冲**时才生成的，`ping` 从不读 stdin。→ **保留 Job Object / `kill_process_tree` 作为中断主通道**；`\x03` 仅对「正在读输入的进程」有效（shell 提示符、REPL、`y/n` 提示） |
| **readonly 沙盒** | 语义不变：PTY 只改输入输出通道，写隔离仍由令牌/Landlock 负责 |

### 5.7 `ResizePseudoConsole` 会**整屏重绘** → 只在「屏幕为空」或「尺寸真的变了」时调 ⚠️

**实测**（独立 Rust 探针，无第三方依赖：`CreatePseudoConsole` + 手动 `ResizePseudoConsole`；子进程打印 9 行后等待）：
ConPTY 在**屏幕已有内容**之后收到 `ResizePseudoConsole`，会**整屏重绘** —— 先 `\x1b[25l`（隐藏光标）+ `\x1b[H`（回左上）逐行重写内容，**再为「内容以下的每一行」各发一次 `\x1b[K\r\n`**，最后用 `\x1b[<row>;1H` 把光标放回原位。

| 探针场景 | 结果 |
|---|---|
| 240×50 建 → **输出前** resize 到 80×15 | ✅ **干净**（0 空行；屏幕为空时重绘不产生内容） |
| 240×50 建 → **输出后** resize 到 80×15 | ⚠️ 多出 **14 个换行 = 内容 9 + 空行 5** |
| 240×50 建 → **输出后** resize 到 80×**30** | ⚠️ 多出 **29 个换行 = 内容 9 + 空行 21** |
| 直接按目标尺寸建、**不 resize** | ✅ 干净（**初始尺寸偏大也不会有空行**） |

**结论**：多余空行数 = `新行数 − 内容行数`。（用户看到的「一大堆空格」就是这些 `\x1b[K\r\n` 把视图往下推。）

**因此有两条硬约束**（违反就会出现「程序启动后第一次运行终端时多出一大堆空行」）：

1. **容器还没布局（宽高为 0）时，前端绝不 `pty_resize`** —— 此时 `fit()` 量不出尺寸，`term.cols/rows` 还是 xterm 默认的 **80×24**，推给后端就是用**错误行数**去 resize。首屏恰好是这种情况（`message-list` 初次打开会先隐藏容器、等布局稳定再显示，见 `message-list.tsx` 的 `needInitialBottomRef`）。
2. **尺寸没变就不要再调 `ResizePseudoConsole`** —— `ResizeObserver` 会反复回调，重复 resize 会反复白刷空行。

**落地**：

- 前端 `XtermTerminal.syncSize`：容器 `clientWidth/Height <= 0` → 直接 return；`fit()` 抛错 → return；与上次尺寸相同 → return（`lastSizeRef`）。
- 后端 `pty_session`：`SizeTracker` 记住当前尺寸，`pty_resize` 尺寸未变时**直接返回 true、不调 API**；并把最近一次的客户端尺寸缓存起来（`initial_size`），**新建伪控制台时直接用它作初始尺寸** → 后续会话的首次上报天然是 no-op，根本不重绘。

#### 5.7.1 ⚠️ 勘误：上述「缓存初始尺寸」曾**完全失效**（前端 fit 早于后端 create）

初版把「记录客户端尺寸」写在了 `pty_resize` 的**会话查找之后**：

```rust
let Some(session) = lookup(tool_call_id) else { return false };   // ← 先查会话
if let Ok(mut g) = LAST_CLIENT_SIZE.lock() { *g = Some(..) };      // ← 才写缓存
```

但实测存在**竞态**（前端加了临时日志后抓取，日志形如
`pty_resize:result … 113x13 ok=false` 紧跟 `ok=true`）：

| 时刻（相对挂载） | 事件 |
|---|---|
| +0.00s | 前端终端块挂载，`fit()` 得真实尺寸（如 `113×13`）→ `invoke('pty_resize')` |
| +0.01s | 后端 `pty_resize`：**会话尚未注册**（`create` 还没跑到）→ `lookup` 未命中 → **返回 false**，缓存也没写 |
| +0.4s | 后端 `create`：缓存为空 → 退回默认 **240×50** |
| +0.4s+ | 前端有 `lastSizeRef` 去重，**不再补发** → 尺寸永远停在 240×50 |

后果：ConPTY 以 240×50 运行，而 xterm 只有 13 行 → 每次重绘都按「50 行」补
`\x1b[K\r\n`（≈ `50 − 内容行数` 个空行，与 §5.7 表一致）。且因为缓存**从来没被写过**，
这不是「只在第一次」——**是每次都坏**（第二次看起来不同，只是内容行数不同）。

**修复（两处，缺一不可）：**

1. **后端 `pty_resize`：把缓存写入提到 `lookup` 之前**。这样即使会话未就绪，
   尺寸也已进缓存，紧接其后的 `create` 通过 `initial_size()` 直接按正确尺寸建控制台
   → **根本不发生 resize** → 不重绘 → 无空行。
2. **前端 `XtermTerminal.sendResize`：未命中会话时短重试**（120ms × 最多 8 次；
   尺寸变化 / 卸载作废旧链）。作为「`create` 抢跑在前」的兜底：重试命中会话时通常
   仍在子进程输出之前，resize 早于内容 → 干净。

> **实测验证**：修复后日志为 `resize → no-session(cache-seeded)` 紧接
> `create size=113x13`（不再是 240×50），`\x1b[K\r\n` 由 ~38 个降到 0~3 个，
> `npm init` 全程正常（含逐字段 `\e[12;1H…` 重定位）。
> ⚠️ 反思：§5.7 初版那句「第二次运行就正常」是**错的**——它假定缓存会被填上，
> 但写入点摆在 `lookup` 之后，缓存**永远填不上**。教训：跨前后端共享的状态，
> 其写入时机必须在「依赖它的下游」之前，否则就是一个静默失效的缓存。

#### 5.7.2 ⚠️ 再勘误：TS 引擎路径下 `create` **抢在**首次上报之前（顺序相反）

§5.7.1 的修复针对的是「前端 `fit()` **早于** 后端 `create`」这个顺序。但**两条引擎
路径的时序恰好相反**：

| | Rust 引擎路径 | TS 引擎路径（`pty_run_command`，§7 #14） |
|---|---|---|
| 谁先挂终端 | 引擎先发「步骤开始」事件 → UI 挂载终端并上报尺寸 → **才**执行工具 | 工具就地 `invoke('pty_run_command')`；终端要等 `toolOutputStore.register({pty:true})` 触发的**下一次 React 渲染**才挂载 |
| `create` 时的缓存 | **已有值**（上报早 ~0.4s 到）→ 直接用正确尺寸 | **还是空的** → §5.7.1 的「缓存提前」无从生效 |

因此 §5.7.1 的两处修复在 TS 路径**双双失灵**：

1. **缓存写入提前**：没有可提前的东西——`create` 跑的时候**根本还没有任何上报**；
2. **前端重试**：重试只在 `pty_resize` 返回 `false`（会话未注册）时触发；而 TS 路径下
   上报**晚于** `create`，会话**已注册** → 返回 `true` → **不触发重试**。

于是 `create` 已用兜底 **240×50** 建好伪控制台，首帧按 50 行铺满 → 内容下方补出
`\x1b[K\r\n`（≈ `50 − 内容行数` 个空行，与 §5.7 表一致）。用户视角即「TS 引擎路径下
`npm init` 第一次运行又是一大堆空行」——与 §5.7.1 修好前的 Rust 路径**同症不同因**。

**修复：让 `create` 主动等一等首次上报。**

`pty_session::initial_size` 由同步改为 **`async`**：缓存为空时按 20ms 轮询、最多等
`CLIENT_SIZE_WAIT = 800ms`，**拿到客户端真实尺寸再建伪控制台**；超时（终端从不上报，
如非 PTY 渲染）才退回 `fallback`。

- **正常情况**：登记 `pty:true` → React 下一帧挂载 xterm → `fit()` → 上报，全程约一两帧
  （几十 ms）≪ 800ms → `create` 用真实尺寸 → **不发生 resize → 无空行**；随后那次上报
  因尺寸相同被 `SizeTracker` 判为 **no-op**。
- **Rust 引擎路径**：缓存早已有值 → `initial_size` **立即返回**，无等待、行为不变。
- **与 §5.7.1 的关系**：§5.7.1 的 ① 仍必要——它保证「等待期间**晚到的上报**」能进缓存
  （`pty_resize` 先把尺寸写缓存、再查会话）；本节的「主动等待」+ ① 的「缓存提前」
  共同构成 TS 路径的完整修复，② 的重试继续作为 `create` 极端抢跑时的兜底。

> 落地：`pty_session::initial_size` 改为 `pub async fn`，`run_command_native_pty` 处
> 改为 `pty_session::initial_size((DEFAULT_COLS, DEFAULT_ROWS)).await`。
> **待真机复测**：TS 路径 `npm init` 首跑 `\x1b[K\r\n` 是否降到 ~0。

---

## 六、与 Virlen 现有代码的对接点

### 6.1 文件级落点

| 文件 | 操作 | 说明 |
|---|---|---|
| `src-tauri/src/sandbox/windows/conpty.rs` | **新建** | ConPTY 封装：`PseudoConsole`（`create` / `resize` / `close` / `take_input` / `take_output`）+ 自由函数 `resize_raw`（供会话注册表用） |
| `src-tauri/src/sandbox/windows/spawn.rs` | **修改** | 新增 `create_sandboxed_process_pty()` / `create_bare_process_pty()` / `PtyChild`（**不动**现有 `create_sandboxed_process`）；`ProcThreadAttributeList` 加 `set_pseudoconsole()` |
| `src-tauri/src/sandbox/windows/mod.rs` | **修改** | 导出 ConPTY 模块 |
| `src-tauri/src/sandbox/mod.rs` | **修改** | 新增 `pub(crate) mod pty` 门面（`windows` 保持私有，只导出执行器需要的最小面） |
| `src-tauri/src/sandbox/windows/runner.rs` | **修改** | `SandboxSession::spawn_pty()`（受限令牌 + 伪控制台） |
| `src-tauri/src/agent/native_tools/execute/common.rs` | **修改** | PTY 运行器 `run_command_native_pty`；原运行器改名 `run_command_native_pipes`（兜底）；抽出 `prepare_sandbox_session`；ANSI 解析器升级；有界缓冲；`build_command_result` 增 `pty` 标记 |
| `src-tauri/src/agent/native_tools/execute/pty_session.rs` | **新建** | PTY 会话注册表：`tool_call_id` → 伪控制台输入通道（`pty_write` / `pty_resize` 底座，双引擎共用一份） |
| `src-tauri/src/agent/native_tools/execute/execute_command.rs` | **未改** | 工具语义（风险分类 / 审批 / 超时）完全不变 |
| `src-tauri/src/lib.rs` | **修改** | 注册 `pty_write` / `pty_resize` / `pty_key` / `pty_set_held` / `pty_run_command`（铁律 4） |
| `src-tauri/src/sandbox/windows/tests.rs` | **修改** | ConPTY 回归用例并入（原独立 `conpty_spike.rs` 已删） |
| `src/infrastructure/tools/output-store.ts` | **修改** | `ToolOutput` 增 `pty?: boolean` |
| `src/services/rust-engine.ts` | **修改** | 运行中按平台预判 `pty`，注册带 kill 的 entry |
| `src/ui/pages/chat/components/tool-call/XtermTerminal.tsx` | **新建** | xterm.js 终端块（增量写入 + 键击直送 + `pty_resize`） |
| `src/ui/pages/chat/components/tool-call/TerminalBlock.tsx` | **修改** | `TerminalView` 按 `pty` 路由：PTY → xterm，非 PTY → 原 `<pre>`（两条路径互不影响） |
| `src/ui/pages/chat/components/tool-call/style.scss` | **修改** | `.execute-command-wrapper.is-pty` 等样式 |
| `src/infrastructure/tools/execute/common.ts` | **修改** | `processTerminalOutput` 与 Rust 侧逐条对齐（铁律 1） |
| `package.json` | **修改** | 加入 `@xterm/xterm@6.0.0` / `@xterm/addon-fit@0.11.0`（本机已存在，未跑 `pnpm install`） |

### 6.2 输出链路改造（**必须做，否则会退化成 O(n²)**）

现状（`TerminalBlock.tsx`）：

```
每次 toolOutputStore 通知（节流 50ms）→ buildLiveSegments(整个累积字符串)
  → processTerminalOutput() 从头到尾重跑一遍 ANSI/\r 解析
```

PTY 输出是带光标控制的原始流且刷新极快（进度条、`npm install`），
**整体重跑整个累积字符串是 O(n²)**，会烧 CPU 并卡 UI。

改造方向（对齐 terminal-mcp）：

1. **增量解析**：维护一个持久解析状态（当前行/列、缓冲区），只处理新增 chunk，不重跑历史；
2. **半截转义序列待发**：chunk 边界可能切断 `\x1b[`，未闭合的序列要**留在 pending** 等下一块
   （现有 `TerminalDecoder` 已有类似思路处理 UTF-8 跨块，可参照其「pending + 三态判定」结构）；
3. **内存有界**：会话日志 append-only 落盘为真相来源，内存只留 tail cache；
   否则 `yes` / `cat 大文件` 会打爆内存（现有实现是无限增长 `String`）；
4. **stdout/stderr 合并**：PTY 只有一条输出流 → `ToolOutput.uiData` 的 `{stdout, stderr, exitCode}`
   结构与 `agent:tool-output` 的 `stream: 'stdout'|'stderr'` 字段在 PTY 路径下失去意义。
   → 建议 `uiData` 增加 `pty: true` 标记，UI 据此走单流渲染；旧字段保留以兼容非 PTY 路径。

### 6.3 事件与命令契约

| 通道 | 结论 |
|---|---|
| `agent:tool-output` | **不改结构**，但 PTY 路径下 `stream` 恒为 `stdout`（合并流）。避免动 `AgentEventType` 四方契约（铁律 2） |
| `pty_write` | **新增 Tauri 命令**：`(toolCallId, data)`。前端直接 `invoke`，**不经过引擎事件总线** → 不污染 `AgentEventType` |
| `pty_run_command` | **新增 Tauri 命令**（§7 #14）：TS 引擎路径的「原生执行」入口。入参含 `security`（workspace / sandboxMode / skillsDir）+ `timeoutSecs` + `bypassSandbox`，外加一个 **`ipc::Channel`** 用于流式输出 → 直达调用方，**不经过引擎事件总线**（铁律 2） |
| 会话标识 | **直接用 `toolCallId` 当 PTY 会话 key** —— 前端 `TerminalView` 已持有它，`rust-engine.ts` 已按 `toolCallId` 注册 kill 入口 → **无需新增映射事件**，这是改动量最小的接法 |
| 取消 | 现有 `agent_kill_command` 保留（Job Object 杀树）；用户 Ctrl+C 走 `pty_write("\x03")`（真信号，更轻） |

### 6.4 双引擎（铁律 1）

建议架构：**PTY 会话管理器做成一份 Rust 服务**，两条引擎路径共用机制、各自保留工具语义：

```
Rust 原生工具（默认路径）── 直接调用 ──┐
                                       ├──► pty 会话管理器（Rust，一份实现）
TS 引擎路径（回退）──────── invoke ────┘
```

- Rust 原生：进程内直接调，无需过桥；
- TS 引擎：`runCommand` 改为 `invoke('pty_*')`，机制复用，语义仍留在
  `execute-command.ts`。

**浏览器 dev / vitest 环境**：`plugin-shell` 无 PTY 能力 → TS 路径在非 Tauri 环境
**降级为现有 `Command.create` 行为**（保持可用，不做交互）。

### 6.5 顺带影响

- **`execute_script` 共享同一个 runner**：改 runner 会连带影响它。需明确是否同步 PTY 化
  （建议同步，行为一致；但要注意脚本场景很少需要交互，收益主要是 ANSI 正确）。
- **`processTerminalOutput` 是 UI 与 Rust 两侧的镜像实现**（`common.ts` 与
  `native_tools/execute/common.rs`，且 `TerminalBlock.tsx` 复用 JS 版）→ 增量解析改造要**两侧同步**。
- **`tsconfig` 注意**：`strict: true` 但 `strictNullChecks: false`（§11.6），改 UI 时别按纯严格模式假设。

---

## 七、风险与未解问题

| # | 问题 | 状态 | 判定方式 |
|---|---|---|---|
| 1 | **ConPTY 能否在受限令牌（`WRITE_RESTRICTED \| LUA_TOKEN`）下正常工作** | ✅**已实测通过**（§8.0）：`CreatePseudoConsole` + `CreateProcessAsUserW` + Job Object 全通，写隔离仍有效 | Spike 实测 |
| 2 | `CreatePseudoConsole` 等符号在 `windows-sys 0.61.2` 中的归属 | ✅**已确认**：`Win32_System_Console`（已启用）；常量 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 131094 (0x00020016)` 在 `Win32_System_Threading` | 本机 registry 源码核对 + 编译通过 |
| 3 | `CREATE_NO_WINDOW` 是否影响伪控制台 attach | ✅**已确认无影响**：不设该标志即正常工作，建议不设 | Spike 实测 |
| 4 | conhost/OpenConsole 宿主在受限令牌下的「两遍检查」 | ✅与 #1 同批通过（未出现 ACCESS_DENIED） | Spike 实测 |
| 5 | **`STARTF_USESTDHANDLES` 的处理方式** | ✅**已修正**：必须设置且三句柄置 NULL（初版判断错误，见 §5.3 / §8.0） | Spike 实测 |
| 6 | **`\x03` 能否中断前台命令** | ✅**已确认不能**：只能影响「正在读输入的进程」；中断主通道仍须 Job Object（见 §5.6） | Spike 实测 |
| 7 | 前端终端模拟器选型（`@xterm/xterm`） | ✅**已引入且 lock 已补齐**：`@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0` | Step 1 落地时 `node_modules` 里已有（junction → `.pnpm`）故**未跑 `pnpm install`**，但 `pnpm-lock.yaml` **未登记** → 已由用户执行 `pnpm add` 补上（2026-09-18 核实：lock 里 `importers` / `packages` / `snapshots` 三处均有记录）→ CI 的 `--frozen-lockfile` 不再阻塞 |
| 8 | 输出流合并导致 `[标准错误]` 分段与 `stream` 字段语义消失 | ✅**已实现** | PTY 路径 `stream` 恒为 `stdout`、`stderr` 恒为空串，`uiData.pty = true`（旧字段保留以兼容非 PTY） |
| 9 | PTY 输出含 `\x1b[87X` / `\x1b]0;…\x07` 等序列，`<pre>` 无法表达 | ✅**已解决** | 前端用 xterm 渲染 + 增量写入；模型可见文本走升级后的 ANSI 解析器 |
| 10 | **旧 ANSI 解析器把私有模式参数漏成正文**（`\x1b[?25l` → 输出里混进 `25l`） | ✅**已修（两侧同步）** | 旧实现只认 `ESC [` 且只吃 `0-9;`；ConPTY 输出里 `?25l/?25h` 极其密集 → 按 ECMA-48 完整吞掉（参数/中间/结束字节 + OSC + 三字节转义） |
| 11 | **伪控制台按列宽硬换行**：折行产生的换行会进入模型可见文本 | 已缓解，未消除 | 初始尺寸改用客户端上报值（`initial_size`，见 §5.7.1 / §5.7.2）→ 折行列宽与用户所见一致；缓存未命中时短暂等待上报（§5.7.2），超时才兜底 240×50；彻底解决需按需 reflow，属后续阶段 |
| 12 | **后台进程语义变化**：`ClosePseudoConsole` 会终止附着其上的进程 → **裸跑路径**下 `start` 拉起的后台进程不再存活（沙盒路径本来就会杀，见 windows/mod.rs） | 已识别，**接受** | 属 ConPTY 固有行为；仅影响 `sandbox:"off"` 的少数用法 |
| 13 | 内存无界：`yes` / `cat 大文件` 打爆内存 | ✅**已缓解** | 单条流 1 MB 上限；超出后丢弃早期内容（保留末尾 256 KB）并在输出开头插入提示 |
| 14 | **TS 引擎路径尚未 PTY 化** | ✅**已实现**（`pty_run_command`） | TS 分支经 `pty_run_command` 复用 Rust 原生运行器（沙盒 + ConPTY + `ipc::Channel` 流式回传），与 Rust 引擎路径**共用同一套执行语义**（铁律 1）；非 Tauri / 非 Windows 仍回落 `plugin-shell` 管道 + `<pre>` |
| 15 | `prepare` 对「不存在的 extra root」是**硬失败** → 整条命令**静默降级裸跑（失写隔离）**；而 `package_cache_roots` 的 env 覆盖路径不校验目录是否存在 | 已发现，**本次未改** | 属改造前既有行为（fail-open 是既定产品决策）；若要收紧，应把 extra root 改成 best-effort 跳过 |
| 16 | **「终端内确认」的观感风险**：命令出现在真终端外观的块里，用户可能误以为「已经跑过了 / 这是 AI 跑的结果」 | ✅**已实现**（Step 2 ①） | 专门的确认态组件 `TerminalConfirmBlock.tsx`（独立配色 + 「尚未执行」文案 + 无终端光标），与运行态**视觉显著区分**；文案里明说「Enter 才执行」 |
| 17 | **`held` 冻结超时**可能把命令无限期挂住（人在慢慢输入，也可能只是忘了） | ✅**已实现**（Step 2 ②） | 硬上限 `PTY_HOLD_MAX = 30 min`（对齐 WinkTerm TTL，见 `execute/common.rs`）；到顶强制终止并记 `waitReason = timeout` + `holdTimedOut = true`（用例 `test_pty_hold_hard_cap`）。接管**不等于**取消：终止按钮 / `agent_cancel` 在接管期间仍可用 |
| 18 | `pty_key` 的 `backspace` 该发 `\x08` 还是 `\x7f`（ConPTY 下两者的 VK 映射**未实测**） | 已知不确定项（Step 2 ③） | 只影响按键条里的退格键，不影响安全；先发 `\x08`，真机验证后再定 |
| 19 | xterm 全屏采用「双实例同时渲染」→ 同一条流被解析两遍（≈2× CPU） | 已识别，**接受**（Step 2 ⑤） | 全屏是短时交互态；内存仍由 `scrollback: 2000` 封顶 |
| 20 | **用户编辑命令后不再二次审批**（用户本人就是审批人），但编辑可能把命令改成远超原风险的东西 | ✅**已实现**（Step 2 ①） | 编辑后**重新 `classify_command`**（风险升高仅埋点 `interaction.command.confirm.escalated`，只记级别不记正文，用例 `test_terminal_confirm_reclassify_escalation`）、仍走沙盒 + PTY 同一路径、`readonly` 拒绝逻辑保持前置 |

**关于原 #1 的推理链（已被 §8.0 实测证实）**：

- 有利面（**猜对了**）：`CreatePseudoConsole` 在 Virlen 自己（非受限）进程内调用；通信管道由
  **我们自己的 `CreatePipe` 创建**（匿名管道，SD 取自令牌默认 DACL）——
  **确实不是 §11.2 的命名管道坑**。
- 不利面（**猜错了**）：担心 conhost/OpenConsole 宿主的「两遍访问检查」会拦住 ——
  实测**未被拦住**，`CreateProcessAsUserW` 一次成功。
- 结论：**方案 B 成立**，无需走「PTY 路径降级回匿名管道」的退路。

---

## 八、实施路径

### Step 0 — Spike ✅ **已完成（2026-09-18 本机实测通过）**

代码：`src-tauri/src/sandbox/windows/conpty_spike.rs`（`#[cfg(test)]`，生产代码零改动，
仅 `windows/mod.rs` 加一行 `#[cfg(test)] mod conpty_spike;`）

```bash
cd src-tauri
cargo test conpty_with_restricted_token -- --nocapture
```

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 受限令牌 + `PSEUDOCONSOLE` + `JOB_LIST` 同一属性列表 + `CreateProcessAsUserW` | ✅ 通过（**主闸门**） |
| 2 | `CreatePseudoConsole` / `ResizePseudoConsole` | ✅ 返回 `S_OK` |
| 3 | `inputWriteSide` 写入被 cmd 执行 | ✅ 通过（`a.txt` 已生成） |
| 4 | 输出经伪控制台回传（含孙进程 `ping` 输出） | ✅ 修正 `STARTF_USESTDHANDLES` 后通过 |
| 5 | 输出编码 | ✅ 严格 UTF-8，**中文直接可读，无 GBK 乱码** |
| 6 | 写隔离在 PTY 路径下仍有效 | ✅ 通过（区外写入被拒，cmd 报「拒绝访问。」） |
| 7 | `ClosePseudoConsole` 关停顺序 | ✅ 3.6–14.7 ms 返回，读线程正常收 EOF，**无死锁** |
| 8 | `\x03` 中断前台命令 | ❌ **不生效**，见 §5.6（设计上改用 Job Object 承担中断） |

**Spike 踩到并已修正的两处**（都已回填 §5.3 / §5.6）：

1. 初版「去掉 `STARTF_USESTDHANDLES`」的判断是**错的** → 命令输出会漏到父进程 stdout；
2. 初版 Ctrl+C 测试是**假阳性**（等待窗口恰好覆盖了 `ping -n 20` 的完整生命周期），
   收紧到「`ping -n 60` + 6 s 判定窗口」后才露出真实结论。

> ✅ **已整并（本轮）**：`conpty_spike.rs` 已并入 `sandbox/windows/tests.rs`
> （用例名不变：`conpty_with_restricted_token`），不再作为独立 `cfg(test)` 模块。
> 运行：`cargo test --lib conpty_with_restricted_token -- --nocapture`。

### Step 1 — L2：`execute_command` stdio 换成 ConPTY ✅ **已完成（2026-09-18 本机实测通过）**

保持「一条命令、跑完返回」语义。已获得：ANSI/中文输出正确、交互式提示可用、
`pty_write` 让用户中途插键盘（xterm 里直接键击）。

⚠️ **不要**把「Ctrl+C 变真信号」列为收益（§5.6 已推翻）：中断仍走 Job Object /
`agent_kill_command`；`\x03` 仅作为「对正在读输入的进程」的补充手段。

**落地范围**

- Windows：`run_command_native` 分派到 `run_command_native_pty`（沙盒 / 裸跑共用）；
  伪控制台建不起来时自动降级回原匿名管道实现（`run_command_native_pipes`，保留为兜底）；
- 非 Windows：仍走管道（Unix PTY 待后续）；
- `execute_script` 共享 `run_command_native` → **自动跟随**，无需额外改动；
- 新增 Tauri 命令 `pty_write(toolCallId, data)` / `pty_resize(toolCallId, cols, rows)`，
  走前端 `invoke`、不经引擎事件总线 → 不污染 `AgentEventType` 四方契约。

### 8.1 Step 1 实测结果

**新增/修改的测试**（`cargo test --lib` 150 passed；`npx vitest run` 483 passed）

| 用例 | 覆盖 |
|---|---|
| `test_execute_command_pty_sandboxed_end_to_end` | readonly 沙盒 + PTY：输出路由、中文直接可读、`uiData.pty`、退出码、真的跑在沙盒里（未降级） |
| `test_execute_command_pty_write_interaction` | `Read-Host` + `pty_write`：用户在执行中写入的输入被命令读到（改造前 stdin=NULL 只能拿到 EOF）+ `pty_resize` 命中会话 |
| `test_process_terminal_output_ansi_sequences` / `..._backspace` | `?25l`、`X`、OSC(BEL/ST)、中间字节 CSI、三字节转义、退格 |
| `test_push_bounded_*` / `test_push_bytes_bounded` | 内存有界 + UTF-8 边界 |
| `test_build_command_result_pty_flag` | `uiData.pty` 与「PTY 下不出现 `[标准错误]` 分段」 |
| `src/tests/infrastructure/terminal-output.test.ts` | 与 Rust 侧逐条对齐的 12 个 TS 用例（铁律 1） |

**运行方式**

```bash
# Rust（含上面两个 PTY 端到端用例）
cd src-tauri && cargo test --lib
# 前端
npx vitest run
```

**环境说明**：本次 `cargo test` / `vitest` 是在**无沙盒（已关闭）**模式下跑的，
因此**不能**据此判断「沙盒内 cargo test / vitest 可用」——AGENTS §11.2 的基线未复现，
该结论仍然成立。

**实现中修正的两处认知**

1. **结束判定不能用「输出通道 EOF」**：伪控制台的输出管道要等 `ClosePseudoConsole`
   之后才断开（Spike 已露出这条，但直到写运行器才意识到它会直接导致挂死）→
   主循环改为以**进程退出**为结束条件，收尾时先关伪控制台、再等读线程收尾（3 s 看门狗）。
2. **ANSI 解析器必须完整吞掉转义序列**：旧实现只吃 `0-9;`，`\x1b[?25l` 会把 `25l`
   漏成正文（Rust 单测当场抓到）。两侧已按 ECMA-48 重写。

**顺带修复（与 PTY 无关，但已两次污染验证结果）**

`agent/package_cache_roots.rs` 的 3 个用例都改**进程级全局状态**
（`set_roots_for_test` / `clear_cache` / `npm_config_cache`），而 cargo 默认并行跑测试 →
互相踩（**只跑该模块时实测 7/10 失败**，与本次改动无关）。已加模块内互斥锁串行化，
10/10 稳定；完整套件 6/6 稳定。

⚠️ 该锁只串行化本模块内部。**任何并发调用 `cache_roots_for_workspace` 的测试**仍可能与
它打架（会触发真实 `refresh()` 并覆盖它注入的根）—— 新加的 PTY 端到端用例因此刻意用
`readonly` 模式避开缓存探测（同时也避免测试去改用户真实缓存目录的 ACL）。

**已知缺口（刻意延后）**
- ~~**TS 引擎路径未 PTY 化**~~ → ✅ **本轮已实现**（见 §7 #14，经 `pty_run_command`）；
  非 Tauri / 非 Windows 仍回落 `plugin-shell` 管道 + `<pre>`；
- **xterm 的 `<pre>` 版全屏按钮未移植**到 PTY 块（属交互增强，放在 Step 2，见 §8 Step 2 / 2.6。
  实现上是**双实例渲染**，因为 xterm 的写入是自包含的 → **不需要** serialize、也不需要「搬迁实例保 scrollback」）；
- **硬换行**（§7 #11）与 **prepare fail-open**（§7 #15）见风险表。

**依赖状态（重要）**

`@xterm/xterm@6.0.0` / `@xterm/addon-fit@0.11.0` 在本机 `node_modules` 中**已存在**
（junction 指向 `node_modules/.pnpm/...`），因此 Step 1 落地时**没有执行 `pnpm install`**，
规避了 §11.2 的依赖安装风险；`package.json` 已登记这两个版本。
✅ **`pnpm-lock.yaml` 现已补齐**：用户随后执行了 `pnpm add @xterm/xterm@6.0.0`，
lock 的 `importers.devDependencies` / `packages` / `snapshots` 三处均已登记 xterm（0.11.0 + 6.0.0）
→ CI 的 `pnpm install --frozen-lockfile` 不再阻塞。

### Step 2 — 交互语义 ✅ **已完成**（D1–D6 按建议默认值定稿）

> **目标**：把 Step 1 的「能交互」补成「**有控制权**」——AI 不偷偷替用户执行命令、
> 用户可接管、交互质量（按键 / 结束原因 / 状态提示）到位。
> **两条自我约束**：本轮**不引入新的 `AgentEventType`**（交互一律走既有桥 / Tauri 命令，铁律 2）；
> **不记录用户输入正文**（很可能是密码，见 §9 与决策点 D4）。

#### 2.0 前提：L2 下 `held` / `write_command` 必须重新定义（**本轮最重要的判断**）

社区两个项目的这两个机制都长在**常驻交互会话（L3）**上。Virlen 是 **L2**
（每次调用 spawn 一条短命 shell，进程退出 = 命令结束，见 §2），照抄会落空：

| 原版 | 原文语义 | L2 下为什么不能照抄 | 本轮等价物 |
|---|---|---|---|
| terminal-mcp `held` | 接管后**暂停 AI 的写入**，用户敲完再交还 | 模型在工具返回前**没有控制权**（工具调用是阻塞的，没有并发工具调用）→ 执行期唯一的写入者就是用户，「暂停 AI 写入」**没有作用对象** | **冻结超时 + 事件摘要回灌**：接管期间命令不会被超时杀（人在慢慢输入），交还后恢复；模型侧只知道「有人接管过」 |
| WinkTerm `write_command` | 把命令**写进终端输入行**，等你按 `Enter` 才跑 | L2 的 shell 是 `powershell -NoProfile -Command "…"`：**非交互、没有提示符、也不读 stdin**，根本没有可写进去的「输入行」 | **执行前在终端里确认**：命令以**可编辑命令行**呈现在该工具调用的终端块里，用户改完按 `Enter` → 后端再按标准 L2 路径（沙盒 + PTY）执行 |

**要字面等价就必须上常驻交互 shell**（`powershell -NoProfile -NoExit`）+ 命令边界检测
（OSC 133 或自定义 `prompt` 函数 = **哨兵**）→ 那正是 **Step 3**，会引入哨兵 / shell 跳转
（`ssh` / `su` / `docker exec`）/ prompt 噪声 / CLM 约束等一整类新问题，**本轮不做**（见 2.11）。

#### 2.1 交付范围

| 编号 | 交付物 | 风险 | 备注 |
|---|---|---|---|
| ✅① | **终端内确认**（`write_command` 的 L2 等价物） | 高 | 动审批桥载荷 + 新增 UI 分支；必须保住「必须人工确认」语义 |
| ✅② | **`held` 接管 / 交还** | 中 | 已把 Step 1 的单次 `sleep` 换成「预算 + 心跳」 |
| ✅③ | **命名控制键** `pty_key` | 低 | 纯新增命令 + 映射表纯函数单测 |
| ✅④ | **`waitReason` + 空闲「疑似等待输入」提示** | 低 | `uiData` 加字段 + 前端本地计时（零后端成本） |
| ✅⑤ | **xterm 块补全屏按钮** | 低 | 复用 `TerminalBlock` 既有「双渲染」做法 |

**明确不做**：常驻交互 shell / 哨兵 / shell 跳转重挂 / `output_ref` / `terminal_explore`（Step 3）；
TS 引擎 PTY 化（§7 #14）；模型侧写 PTY（L2 结构性限制）；新增 `AgentEventType`；
新增持久化（PTY 会话仍是内存表，命令结束即注销）。

---

#### 2.2 ① 终端内确认（WinkTerm `write_command` 的 L2 等价物）

**语义**（三条必须同时成立，缺一不算实现）

1. **AI 不偷偷执行**：命中该模式的命令，在用户按 `Enter` 之前**一行都不会跑**；
2. **可改**：用户能直接编辑命令正文，且**执行的是改后的版本**；
3. **可退**：`Esc` / `Ctrl+C` 取消 → 工具返回 `[User cancelled]`，模型能看见。

**时序**

```
LLM 调 execute_command{ command:"npm login", confirm:"terminal" }
  → 风险分类（照旧，逻辑不动）
  → Rust 判定伪控制台是否可用 ── 否 ──▶ 回落现有弹窗（语义不变，降级可见）
                                └ 是
  → 桥下发 confirm_command_native + { presentation:"terminal", command, risk, label, hint, tips, toolCallId }
  → 前端**不弹 modal**：在该 toolCallId 的终端块里渲染「待确认命令行」（可编辑）
  → 用户编辑 → Enter ──▶ content = {"approved":true,"command":"<改后>"}
                 └ Esc/Ctrl+C ──▶ BridgeInteractionResult::Cancelled
  → Rust：classify_command(改后) 重新分类（仅埋点，不二次审批）
  → run_command_native(改后, …)        ← 仍是沙盒 + PTY 的同一条路径，不走捷径
  → 输出照常流式进终端（此后用户仍可用 pty_write 键击）
```

**契约（改动集中，不扩散）**

Rust → JS（`request_user_interaction` 的 `data`，**只加字段不加类型**）：

```json
{ "command": "…", "risk": "install", "label": "…", "hint": "…", "tips": "…",
  "toolCallId": "…", "presentation": "terminal" }
```

JS → Rust（`agent_user_interaction_response` 的 `content`，字符串，JSON 编码）：

```json
{ "approved": true, "command": "<用户改完的最终命令>" }
```

- **兼容策略（关键）**：Rust 侧「content 以 `{` 开头 → 先试 JSON；否则走旧白名单
  （`approved` / `允许` / `ok`）」→ **现有弹窗路径与 `resolve('approved')` 行为完全不受影响**，
  终端路径与弹窗路径**共用一个 handler**（`createNativeCommandConfirmHandles`）。
- **为什么必须回传命令正文**：用户可能已经改过；只回「批准」会让 Rust 跑**旧命令**，
  直接违背语义 2。代价是命令正文过一次桥 —— 它本来就已经在桥里下发过。
- **前端不要在 JS 侧猜平台**：走哪条路**只由 Rust 下发的 `presentation` 决定**，
  否则三平台 / 降级场景行为分叉。

**安全约束（红线）**

1. **必须仍走标准执行路径**（沙盒 + PTY + 风险分类）：*用户写的命令 ≠ 免检命令*；
2. `readonly` 沙盒下的「绕过沙盒」拒绝逻辑**保持在审批之前**（现有顺序不动）；
3. 编辑后**重新 `classify_command`** → 风险升高时埋点 `interaction.command.confirm.escalated`
   （只记 `from`/`to` 两级风险，**不记正文**，与 §9 一致）；
4. **不因编辑而重新审批**（用户刚刚就是人肉审批），但见 §7 #20 的挂载点约定；
5. `sandbox:"off"` 的 `sandboxBypass` 标记**沿用**（该请求已由用户批准），
   结果首行仍如实报告沙盒状态。

**降级规则（不可用时语义不能丢）**

| 场景 | 行为 |
|---|---|
| 非 Windows / 伪控制台创建失败 | Rust 不下发 `presentation` → 前端走**现有弹窗** |
| 非 Tauri（浏览器 dev / vitest） | 同上（`invoke` 不可用） |
| TS 引擎路径 | TS 执行器见到 `confirm:"terminal"` → **强制 `needsApproval = true`**（回落弹窗）；PTY 化仍记 §7 #14 |

**文件级改动清单**

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agent/native_tools/execute/execute_command.rs` | 解析新参数 `confirm`；伪控制台可用时在交互 `data` 里加 `presentation:"terminal"`；解析回传 content（JSON → 命令）→ 用改后命令执行；重新分类 + 埋点 |
| `src-tauri/src/agent/native_tools/execute/common.rs` | 暴露「伪控制台是否可用」判定（上一行要用；`cfg(target_os="windows")` 且 `PseudoConsole::create` 试建成功） |
| `src/infrastructure/tools/execute/execute-command.ts` | 参数定义加 `confirm`（含 LLM 面向描述）；执行器：`confirm === 'terminal'` → 强制 `needsApproval = true`，payload 带 `confirm:'terminal'` |
| `src/infrastructure/tools/output-store.ts` | `ToolOutput` 加 `pendingConfirm?: { command, risk, label, hint, tips }` 与 `lastOutputAt?: number`（④ 用） |
| `src/services/tool-service/command_confirm.ts` | `createNativeCommandConfirmHandles`：`data.presentation === 'terminal'` 时**不 emit** `showCommandConfirm`，改为 `toolOutputStore` 写入 `pendingConfirm`；`commandResolve` 的值**透传**（JSON 原样 resolve），非 JSON 退回 `'approved'`；提交后清空 `pendingConfirm` |
| `src/events/toolInteractEvent.ts` | 新增纯 UI 事件 `terminalConfirmSubmit(toolCallId, command)` / `terminalConfirmCancel(toolCallId)`（组件 → service，不让组件直接摸 service） |
| `src/ui/pages/chat/components/tool-call/TerminalBlock.tsx` | `TerminalView` 新增分支：`entry.pendingConfirm` 存在 → 渲染 `<TerminalConfirmBlock>`（此时**尚无 PTY**，不渲染 xterm） |
| `src/ui/pages/chat/components/tool-call/TerminalConfirmBlock.tsx` | **新建**：可编辑命令行 + 风险徽标 + 「尚未执行」文案 + Enter/Esc 键处理 |
| `src/ui/pages/chat/components/tool-call/style.scss` | `.execute-command-wrapper.is-confirm` 等（与运行态**显著区分**，见 §7 #16） |
| `src/ui/i18n/lang/en-US.json` | 新增文案，见 2.7 |

**测试计划**

- Rust：`test_execute_command_terminal_confirm_roundtrip`（伪造桥回 `{"approved":true,"command":"echo edited"}` → 用**输出内容**断言跑的是改后命令）；
  `test_execute_command_terminal_confirm_cancelled`（回 `Cancelled` → `[User cancelled]`）；
  `test_terminal_confirm_reclassify_escalation`（编辑成危险命令 → 分类与埋点参数正确）；
  `test_terminal_confirm_no_presentation_without_pty`（伪控制台不可用时 `data` 里**没有** `presentation`）。
- TS：`parseTerminalConfirmPayload` 的 JSON / 非 JSON / 空串三分支；`confirm:'terminal'` → `needsApproval === true`。

---

#### 2.3 ② `held` 接管 / 交还

**语义（L2 版）**

- 点「接管」→ 该命令的**超时预算冻结**（人在慢慢输密码 / 走 OAuth 跳转，不该被 30 s 杀掉），
  前端显示「已接管：超时已暂停」；
- 点「交还」→ 恢复超时预算（**按剩余额度**继续，不是重新计时）；
- **接管 ≠ 取消**：终止按钮 / `agent_cancel` 在接管期间**仍然可用**（明确写在 UI 提示里）；
- **模型侧只知道事件摘要**，不知道用户敲了什么（D4）。

**超时预算实现（为什么不沿用 Step 1 的 `sleep`）**

Step 1 是「循环外建一次 `Box::pin(sleep(timeout))`，`select!` 里轮询」——`sleep` **无法暂停**。
改为**预算 + 心跳**：

```rust
let mut remaining = Duration::from_secs(timeout);   // 剩余预算
let mut held_elapsed = Duration::ZERO;              // 接管累计时长
let mut tick = tokio::time::interval(Duration::from_millis(250));
loop {
    tokio::select! {
        /* 既有 4 个分支（out_rx / done_rx / kill_requested / cancel）保持不变 */
        _ = tick.tick(), if !killed_by_timeout && !killed_by_user => {
            if held.load(Ordering::Relaxed) {
                held_elapsed += TICK;
                if held_elapsed >= PTY_HOLD_MAX { /* 到顶：强制终止，waitReason=timeout, holdTimedOut=true */ }
            } else if remaining > TICK {
                remaining -= TICK;
            } else {
                /* 预算耗尽：等价于原 timeout 分支 */
            }
        }
    }
}
```

- 选「心跳 + 预算」而不是 `Sleep::reset()`：预算剩多少是**显式状态**，好断言、好单测，
  也不会因为 reset 时序写出难查的边界 bug；代价是每 250 ms 醒一次（对 CPU 无实质影响，
  但要保证该分支的 `if` 卫兵与既有 4 个分支的卫兵不互相遮蔽）。
- `PTY_HOLD_MAX = 30 min`（对齐 WinkTerm 的 TTL），写成常量、**不做设置项**（先简单）。
- 事件摘要进 `uiData.userInterventions`：`{ keys, enters, ctrlC, heldSeconds }` + 顶层 `holdTimedOut`。
  **只记计数，不记内容**（D4）；`pty_write` / `pty_key` 都经过 `PtySession::write()`，在那里记账。

**文件级改动清单**

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agent/native_tools/execute/pty_session.rs` | `PtySession` 加 `held: AtomicBool` + `InterventionLog`（计数）；新增 `pty_set_held` / `interventions()`；`write()` 记账 |
| `src-tauri/src/agent/native_tools/execute/common.rs` | 超时改「预算 + 心跳」（见上）；结束时取 `heldSeconds` / 计数塞 `uiData`；`build_command_result` 增 `wait_reason` / `interventions` 参数（管道路径传 `pty:false` + 同名字段） |
| `src-tauri/src/agent/mod.rs` + `src-tauri/src/lib.rs` | 新增 Tauri 命令 `pty_set_held(toolCallId, held) -> bool`，并在 `generate_handler!` 注册（铁律 4） |
| `src/ui/pages/chat/components/tool-call/XtermTerminal.tsx` | header 增「接管 / 交还」按钮（`running` 且有会话时）；接管态显示暂停标记；`invoke` 返回 `false` → 复位按钮（命令已结束） |
| `src/ui/i18n/lang/en-US.json` | 见 2.7 |

**测试计划**

- `test_pty_hold_freezes_timeout`：`timeout=2`，0.5 s 时置 held、2.5 s 后交还 → 总耗时 > 2.5 s 且**未**超时、`heldSeconds >= 2`；
- `test_pty_hold_hard_cap`：把上限做成可注入常量（`#[cfg(test)]` 缩短）→ 到顶被终止，`waitReason == "timeout"` 且 `holdTimedOut == true`；
- `test_pty_interventions_counted`：若干次 `pty_write` → `keys` / `enters` / `ctrlC` 计数正确，**并断言 `uiData` 里不含用户输入文本**（D4 的回归保护）。

---

#### 2.4 ③ 命名控制键

**契约**：`pty_key(tool_call_id: String, keys: Vec<String>) -> bool`（新增 Tauri 命令，注册进 `lib.rs`）。

**为什么在 Rust 里做映射**：命名 → 字节的映射表只能有一份（铁律 1 的同类问题）。
前端只发名字，不发裸控制字节 —— 也就不必往 JSON 里塞 `\u0003` 之类的转义。

| 名称 | 字节 | 备注 |
|---|---|---|
| `enter` / `return` | `\r` | 伪控制台用 CR，不是 LF |
| `tab` | `\t` | 也是 `ctrl+i` |
| `escape` / `esc` | `\x1b` | |
| `backspace` | `\x08` | ⚠️ 与 `\x7f` 的取舍**未实测**（§7 #18） |
| `space` | `' '` | |
| `up` / `down` / `right` / `left` | `\x1b[A` / `B` / `C` / `D` | |
| `home` / `end` | `\x1b[H` / `\x1b[F` | |
| `delete` | `\x1b[3~` | |
| `pageup` / `pagedown` | `\x1b[5~` / `\x1b[6~` | |
| `ctrl+<a..z>` | `0x01..0x1a` | **通用规则**：字母码 − 0x60（`ctrl+c` → `\x03`、`ctrl+d` → `\x04`、`ctrl+z` → `\x1a`…） |
| `ctrl+[` / `ctrl+backslash` / `ctrl+]` | `\x1b` / `\x1c` / `\x1d` | 键名写成 `backslash` 而非符号，避免 markdown 转义歧义 |

- 未知名字 → 该键跳过（**不**返回整体失败），便于前端无脑加按钮；全部无效则返回 `false`。
- **模型侧用不了**：L2 中模型无法在执行期写（同 2.0 的结构性限制）→ 这是**纯用户面向**的面。
- **前端按键条**：终端 header 增 `Enter` / `Ctrl+C` / `Ctrl+D` / `Tab` / `↑` / `↓` 六个按钮
  （触控板/触屏场景有用；`Ctrl+C` 现有的裸 `'\x03'` 调用改为走 `pty_key`）。
- ⚠️ 保持 §5.6 / §7 #6 的既有结论：`\x03` **只对正在读 stdin 的进程有效**，中断主通道仍是 Job Object。

**测试计划**：`test_pty_key_named_sequences`（逐条对齐上表 + 未知名字行为）—— 纯函数，零副作用。

---

#### 2.5 ④ `waitReason` 与「疑似等待输入」

**后端：`uiData` 新增 `waitReason`**

| 值 | 含义 |
|---|---|
| `exit` | 进程自行退出（`exitCode` 有意义） |
| `timeout` | 预算耗尽被终止（含 `held` 到硬上限，另带 `holdTimedOut`） |
| `cancelled` | 用户主动终止 / `agent_cancel` |

- **管道路径（非 Windows / 降级 / `pty:false`）也下发同名字段**，语义一致 → UI 与模型侧都不需要分叉判断（D5）。
- **超时且全程无输出**（`stdout` 为空或极短）时，**结果文本**追加一句面向模型的引导：
  「该命令在超时前没有产生任何输出，通常意味着它在等待输入（密码 / `y/n` / REPL）。
  可让用户在终端中输入，或改用 `confirm:"terminal"` 先确认再执行。」
- **不新增后端空闲事件**：不做「N 秒无输出」的后端推送 —— 那会污染 `AgentEventType` 四方契约（铁律 2）。

**前端：「疑似等待输入」提示（本地计时，零后端成本）**

- `ToolOutput` 加 `lastOutputAt`（`append` 时打时间戳）；
- `running && Date.now() - lastOutputAt >= IDLE_HINT_MS (15_000)` → 终端块下方显示
  「N 秒无输出，可能正在等待输入（可直接在终端中输入）」；
- 判定逻辑抽成**导出的纯函数** `shouldHintIdle(now, lastOutputAt, running)` 供单测；
- 定时器只在 `running` 时挂（命令结束即无开销）。

**测试计划**：`test_build_command_result_wait_reason`（三个值 + 管道路径也下发）；
TS `shouldHintIdle` 的边界（未运行 / 无输出记录 / 恰好 15 s / 超过 15 s）。

---

#### 2.6 ⑤ xterm 块补全屏按钮

- **复用 `TerminalBlock` 的既有做法**：同一个 block 渲染两份（原位 + `createPortal` 到 body），
  而不是搬迁终端实例；Esc 退出；按钮沿用 `FullScreenSvg` / `ExitFullScreenSvg`。
- **为什么不需要 serialization**：`XtermTerminal` 的写入是**自包含**的 —— 首帧整段
  `term.write(stream)`，之后只追增量（`stream.startsWith(written)` 判断）。
  因此全屏时新挂载的实例在首帧就拿到了**完整 scrollback**（受 `scrollback: 2000` 约束），
  无需 `serialize`/`restore`，也不需要「搬迁实例保 scrollback」那套复杂逻辑
  （Step 1 §8.1 里那句「全屏需重建终端实例并保 scrollback」**可以改写成这条更简单的结论**）。
- 进入全屏后**补一次 `term.scrollToBottom()`**（新实例默认停在顶部）；
  原位那份**保持挂载**（虚拟列表条目矮下去会触发重测量 → 滚动跳动，与 `<pre>` 版同因）。
- ⚠️ 代价：全屏期间两个实例同时解析同一条流（≈2× CPU），见 §7 #19 —— 短时交互态，接受。

**测试计划**：TS 侧只覆盖纯逻辑（全屏是 DOM 行为，交给手动验收）。

---

#### 2.7 文档与文案同步清单

- **i18n（`src/ui/i18n/lang/en-US.json`，中文即 key）**：
  「接管」「交还」「已接管：超时已暂停（上限 30 分钟）」「终止执行」「尚未执行」
  「按 Enter 执行，Esc 取消；可直接编辑」「等待用户确认」「用户已编辑该命令」
  「N 秒无输出，可能正在等待输入（可直接在终端中输入）」「全屏」「退出全屏」；
  `tpl` 模板：`tpl('已暂停超时 $__secs__ 秒', { secs })` 之类（按最终 UI 定）。
- **`docs/AGENTS.md`**：§11.7 追加「Step 2 已实现的部分」；快速定位表的 PTY 落点补
  `TerminalConfirmBlock.tsx` / `pty_key` / `pty_set_held`。
- **本文件**：实施完成后把本节状态改成实测结果（含 §8.1 那种表格）。

#### 2.8 实施顺序与提交切分（建议）

| 批次 | 内容 | 为什么这个顺序 |
|---|---|---|
| **2a** | ④ `waitReason` + ⑤ 全屏 + ③ `pty_key` | 全部是**新增字段 / 新增命令**，不碰审批与超时语义，回归面最小 |
| **2b** | ② `held` | 只改超时预算这一处，且有单测直接驱动预算函数 |
| **2c** | ① 终端内确认 | 动桥载荷 + 新增 UI 分支，风险最高，放最后单独一批提交 |

每批次独立提交，提交信息写清「Rust 侧改了什么 / 前端改了什么」，并各自跑通
`cargo test --lib` + `npx vitest run` + `npx tsc --noEmit`。

#### 2.9 验收标准

**自动**（⚠️ 仍在**无沙盒**模式下跑，§11.2 基线未复现，不能据此判定「沙盒内可用」）

```bash
cd src-tauri; cargo test --lib          # 含 2.2 / 2.3 / 2.4 / 2.5 的新用例
npx vitest run                          # 含 2.2 / 2.5 的 TS 用例
npx tsc --noEmit && npx vite build
cargo check --all-targets               # 目标是 0 warning
```

**手动（必须真机跑，`pnpm tauri dev`）**

1. 让 AI 跑一个要输入的命令（如 `Read-Host 你的名字`）→ 在 xterm 里键入 + 回车 → 中文输出正常；
2. 点「接管」→ 跑 `Read-Host`（`timeout: 20`）→ **磨蹭 40 s** 再输入 → 命令**没被超时杀**；
   点「交还」→ 剩余预算恢复；
3. 全屏切换 → scrollback 完整、Esc 退出、原位不跳动；
4. `confirm:"terminal"`：终端里出现可编辑命令行 → 改几个字 → Enter → **跑的是改后的命令**；
   期间块外观与运行态明显不同（§7 #16）；
5. 在确认态按 Esc / Ctrl+C → 工具返回 `[User cancelled]`；
6. `waitReason`：正常结束 / 超时 / 终止三条路径的 `uiData` 与结果文本；
7. 照旧验证「不改沙盒语义」：`readonly` 下 `sandbox:"off"` 仍被拒、区外写入仍被拒。

#### 2.10 待用户确认的决策点（**已定稿，均按建议默认值**）

| # | 决策点 | 我的建议 |
|---|---|---|
| **D1** | `write_command` 的形态：`execute_command` 加 `confirm:"terminal"` 参数，还是新增独立工具 `write_command` | **参数**（不新增工具 = 少改注册链 / UI 组件 / i18n / 双引擎；语义完全一致）。若更看重「模型一眼看出这是请人确认」，再改独立工具 |
| **D2** | 是否把「终端内确认」升级成**审批模式的一个选项**（`commandApprovalMode: 'terminal'`） | **本轮不做**：那会改变**所有用户**的审批体验（`all` / `risky` / `install` 三个档位都受影响），风险与收益不匹配 |
| **D3** | `held` 硬上限取值 | **30 min**（对齐 WinkTerm TTL），写死常量；若你觉得该更短（如 10 min）我改 |
| **D4** | 用户输入**内容**是否回灌给模型 | **不回灌**，只回事件计数。理由：PTY 里用户敲的往往是**密码 / token**（`npm login` / `gh auth login` 的典型场景），正文一旦进工具结果就会**进模型上下文 + 落 SQLite** → 直接踩 §9 的密钥红线。若坚持要正文，需要先定「敏感输入如何识别 / 打码」的策略 |
| **D5** | `waitReason` 是否也下发给**管道路径** | **下发**（语义统一，UI 不必分叉）。代价是 TS 引擎路径仍缺该字段（已记 §7 #14） |
| **D6** | 实施顺序 2a → 2b → 2c | 建议按此顺序；也可只挑其中一批（如只做 2a） |

#### 2.11 本步明确不做（避免范围蔓延）

- 常驻交互 shell / 哨兵（OSC 133 或自定义 `prompt`）/ shell 跳转重挂 / `output_ref` / `terminal_explore` → **Step 3**；
- **模型侧写 PTY**（`pty_write` 只在执行期由前端调用）—— L2 结构性限制，要做得先进 L3；
- TS 引擎 PTY 化（§7 #14，已知延后）；
- 记录 / 回灌用户输入正文（除非 D4 改）；
- 新增 `AgentEventType`、新增设置项、新增持久化（会话表仍是内存态）。

### 8.2 Step 2 实测结果

**实现范围**：2a（④ `waitReason` + ⑤ xterm 全屏 + ③ `pty_key`）→ 2b（② `held` 接管/交还）
→ 2c（① 终端内确认），即 §2.8 的三批顺序。

**新增 Tauri 命令**（均已注册进 `lib.rs`，铁律 4）：
`pty_key(toolCallId, keys: string[])`、`pty_set_held(toolCallId, held) -> bool`
（`pty_write` / `pty_resize` 沿用 Step 1）。

| 用例 | 覆盖 |
|---|---|
| `test_build_command_result_wait_reason` | ④ `waitReason` 三值 + 管道路径也下发（D5）+ 超时无输出的模型引导 |
| `test_pty_key_named_sequences` | ③ 命名控制键逐条对齐（含 `ctrl+<a..z>` 通用规则、未知名字跳过） |
| `test_pty_hold_freezes_timeout` | ② 接管期间冻结超时预算（`timeout=1s` 而命令跑 2.5s 未被杀） |
| `test_pty_hold_hard_cap` | ② 接管到顶强制终止（`waitReason=timeout` + `holdTimedOut=true`） |
| `test_pty_interventions_counted` | ② 干预计数正确，且 `uiData` **不含用户输入正文**（D4 回归保护） |
| `test_parse_approval` | ① JSON 优先 → 旧白名单兼容（弹窗路径行为不变） |
| `test_terminal_confirm_reclassify_escalation` | ① 编辑后风险升高（仅埋点，不二次审批） |
| `test_execute_command_terminal_confirm_roundtrip` | ① 端到端：回传改后命令 → **跑的是改后的版本**；PTY 可用时下发 `presentation=terminal` |
| `test_execute_command_terminal_confirm_cancelled` | ① 取消 → `[User cancelled]` |
| 前端 `tool-output-idle.test.ts` | ④ `shouldHintIdle` 边界 + `pendingConfirm` 必须替换对象（触发重渲染） |
| 前端 `tool-call-terminal.test.tsx` | ③⑤② 按键条 / 全屏按钮 / 接管按钮的结构回归 |
| 前端 `execute-command-confirm.test.ts` | ① TS 路径 `confirm:"terminal"` → 强制审批（回落弹窗） |
| 前端 `command-approval.test.ts` | ① 原生 handles：`presentation=terminal` 不弹 modal、提交回传改后命令、取消 reject |

- `cargo test --lib`：**159 passed / 0 failed / 2 ignored**；
- `npx vitest run`：**499 passed**；`npx tsc --noEmit` 零错误；`npx vite build` 通过；
- `cargo check --all-targets`：0 warning。
- ⚠️ 仍在**无沙盒**模式下跑（§11.2 基线未复现，不能据此判定「沙盒内可用」）。

**实现中修正的一处认知**

- 前端「待确认命令行」的显隐依赖 **store 对象引用变化**：`useToolLiveOutput` 的
  `setEntry(out)` 收到同一引用不会触发重渲染 → `setPendingConfirm` / `clearPendingConfirm`
  必须**替换为新对象**（已加单测钉住）；就地改字段会让确认块永远不出现。

**决策点定稿（D1–D6，均按建议默认值）**

| # | 结论 |
|---|---|
| D1 | 用 `execute_command` 的 `confirm:"terminal"` 参数，**不新增工具** |
| D2 | 不把终端内确认升级成 `commandApprovalMode` 的档位（改动面太大） |
| D3 | 接管硬上限 **30 min**（`PTY_HOLD_MAX`，写死常量） |
| D4 | 用户输入**正文不回灌**：`uiData.userInterventions` 只记 `{keys,enters,ctrlC,heldSeconds}` |
| D5 | `waitReason` **也下发给管道路径**（TS 引擎路径仍缺，见 §7 #14） |
| D6 | 按 2a → 2b → 2c 三批落地 |

**仍存在的缺口（刻意延后）**

- xterm 全屏为「双实例同时渲染」（≈2× CPU，§7 #19）；全屏那份**不**同步 `pty_resize`
  （两实例列宽不同，都调会互相覆盖后端尺寸）。
- ~~TS 引擎路径仍未 PTY 化~~ → ✅ **已实现**（§7 #14）：TS 的 `execute_command` 经
  `pty_run_command` 复用原生运行器（沙盒 + ConPTY + Channel 流式输出）。
  ⚠️ 但 `confirm:"terminal"`（终端内确认）在 TS 路径**仍回落审批弹窗** —— TS 侧审批
  通道独立于 Rust 的交互桥，未纳入本轮。
- 硬换行（§7 #11）、`prepare` fail-open（§7 #15）与 §7 其余条目状态不变。

### Step 3 — L3（可选，需另行评估）

常驻会话 + 哨兵 + 跳转重挂 + xterm.js + `output_ref`/`terminal_explore`。
**注意**：L3 会引入哨兵、会话生命周期、shell 跳转等一大类新问题，工作量与风险量级不同。

---

## 九、参考资料

| 主题 | 链接 |
|---|---|
| ConPTY 官方实现指南（本方案主要依据） | https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session |
| ConPTY 发布公告（架构与 VT Interactivity / VT Renderer） | https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/ |
| WinkTerm（AI 与用户共用 PTY、`write_command`） | https://github.com/Cznorth/winkterm |
| terminal-mcp（真 PTY + 接管交还 + 哨兵 + 围栏） | https://github.com/fzxbl/terminal-mcp |
| `portable-pty` API（方案 A，已弃用） | https://docs.rs/portable-pty/latest/portable_pty/ |
| 受限令牌语义（两遍访问检查） | https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens |
| ConPTY 官方示例代码 | https://github.com/microsoft/terminal （`samples/` 目录） |
