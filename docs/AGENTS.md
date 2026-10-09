# AGENTS.md — Virlen 项目总览（路由 · 动手前必读）

> 本文件是本仓库的**事实来源（source of truth）**，面向 AI 编码代理与人类协作者。
> 2026-10 起本文件**只保留「路由 + 必读约束」**：原先那份 974 行的单文件已按主题拆进 `docs/agents/`，
> 每一节的**原 §号保持不变**（源码注释与文档里大量「见 §11.47」式引用仍然有效）——先按下面两张表定位，再读对应分册。
> 与 `README.md` 冲突时以本文件 + 代码现状为准（README 存在若干过期描述，见 §11.3）。
>
> **维护约定**：新增内容一律写进对应分册（找不到合适的就新建一册，并在两张表里登记）；
> 本文件只维护「地图 + 铁律 + 安全红线」，不要再往这里堆细节。
>
> **动手前必读**：下面「铁律」与「安全红线」两节（全文照旧留在本文件）。

**一句话**：**Virlen（未霖）**是基于 **Tauri v2** 的跨平台 **AI Agent 桌面客户端** —— 不是聊天壳，而是「**可扩展的 Agent 运行平台**」：多模型接入、可插拔工具（35 个，**已全部 Rust 原生**）、本地视觉 / RAG / Skill、多层安全，以及一套 **Rust 实现的 Agent 引擎**（`virlen-core`，GUI 与 headless CLI 共用）。
抓住四条主线即可：**内核是「Agent 循环」**（§4）· **能力靠「工具」扩展**（§5.2）· **安全贯穿全文**（§5.4 / §8）· **引擎只有一份（Rust）**（§5.1 / §11.37）。

## 分册地图（按主题找）

| 分册 | 覆盖 | 什么时候读 |
|---|---|---|
| [`agents/01-overview.md`](agents/01-overview.md) | §0 导读 · §1 项目是什么 · §2 技术栈全景 · §3 六边形分层 · §4 一次对话的运行时全景与事件契约 | 第一次接触本项目；要建立全局观 |
| [`agents/02-subsystems.md`](agents/02-subsystems.md) | §5.1 引擎 · §5.2 工具系统 · §5.3 持久化与配置 · §5.4 安全四道闸 · §5.5 Provider / 搜索源 · §5.6 视觉 / RAG / Skill · §5.7 前端 UI 与状态 · §5.8 埋点 | 改某个子系统前的第一站 |
| [`agents/03-phone-core.md`](agents/03-phone-core.md) | §5.9 之一：装配入口 / 生产接线 / 传输 / 落盘 / 文件表 / 依赖方向 / 服务状态机 / 链路自愈对账 / 重连令牌 / 推送时机 | 改手机控制的链路与配对 |
| [`agents/04-phone-interactions.md`](agents/04-phone-interactions.md) | §5.9 之二：待应答交互注册表 / 终态通知 / 运行结束收敛 / JS 桥接 / 运行时状态 / Agent 选择 / 工具消息下行四字段 / runningTools / 默认打开哪个会话 | 改手机端的交互、审批、消息投影 |
| [`agents/05-phone-files.md`](agents/05-phone-files.md) | §5.9 之三：工作目录文件（浏览 / 下载 / 上传 / 编辑 / 引用）/ 压缩方式 / 界面字号 / 依赖形态 | 改手机端文件域与展示口径 |
| [`agents/06-pitfalls-toolchain.md`](agents/06-pitfalls-toolchain.md) | §11.1–§11.13：中文编码 / 本机沙盒限制 / 版本号 / README / 前端工程 / ConPTY / 拖拽 / 粘贴 / 输入框高度 / comctl32 清单 / 单实例 / 切会话入口 | 环境和桌面端集成踩坑 |
| [`agents/07-pitfalls-cli.md`](agents/07-pitfalls-cli.md) | §11.14–§11.27：workspace 拆包四条硬约束 / CLI 三条边界 / 配置下沉进度 / TUI 坑 / 大文件拆分口径 / TUI 渲染三坑 / 续连 / 评审四项 / 提示词解耦 / 配置向导 | 动 `src-tauri/virlen-cli`、core 目录结构或 TUI |
| [`agents/08-pitfalls-quality.md`](agents/08-pitfalls-quality.md) | §11.28–§11.36：clippy 与 CI 门禁 / CLI 打包 · 三类 CI 失败 / 启动即崩 / 暂停恢复慢 / 残留快照 400 / 只加载到最后 summary / GUI 压缩切 Rust | 改 CI、打包、启动链、压缩与恢复 |
| [`agents/09-pitfalls-engine.md`](agents/09-pitfalls-engine.md) | §11.37–§11.41：移除 TS 引擎 / 输入框右键菜单 / CLI 会话与用量 / 提示词缓存断点 / 账本缓存写入列 | 改引擎、Provider 请求体、账本与费用 |
| [`agents/10-pitfalls-phone.md`](agents/10-pitfalls-phone.md) | §11.42–§11.47：手机端文件面板两坑 / 编辑文件的三个坑 / 共享包契约四坑 / 默认会话 / 并发恢复 400 | 改手机端 UI 或共享包 `virlen-remote` |
| [`agents/11-background-service.md`](agents/11-background-service.md) | §11.48 后台服务（工具 / 面板 / 终端弹窗 / 全局视图 / 结束通知）· §11.49 埋点采样用例 · 托盘与后台工作 | 改 `service` 分类、标题栏面板或托盘 |
| [`agents/12-commands.md`](agents/12-commands.md) | §7 常用命令与验证基线 · §9 手册速查（新增工具 / Provider / 搜索源 / Skill）· §10 前端约定 · §13 提交与协作（含提交前自查清单） | 每次动手前查命令、口径与提交要求 |
| [`agents/13-locate-table.md`](agents/13-locate-table.md) | §12 快速定位表（「我要做的事 → 去哪里」，按功能域列出落点） | 知道要改什么、不知道文件在哪 |

## 章节 → 分册

| § 号 | 分册 | § 号 | 分册 |
|---|---|---|---|
| §0–§4 | [`agents/01-overview.md`](agents/01-overview.md) | §6 铁律 | 本文件 |
| §5.1–§5.8 | [`agents/02-subsystems.md`](agents/02-subsystems.md) | §7 常用命令 | [`agents/12-commands.md`](agents/12-commands.md) |
| §5.9 链路 / 配对 / 推送 | [`agents/03-phone-core.md`](agents/03-phone-core.md) | §8 安全红线 | 本文件 |
| §5.9 交互 / 审批 / 下行投影 | [`agents/04-phone-interactions.md`](agents/04-phone-interactions.md) | §9 手册速查 · §10 前端约定 | [`agents/12-commands.md`](agents/12-commands.md) |
| §5.9 文件域 / 引用 / 压缩 / 字号 | [`agents/05-phone-files.md`](agents/05-phone-files.md) | §12 快速定位表 | [`agents/13-locate-table.md`](agents/13-locate-table.md) |

| §11.x（常见坑） | 分册 |
|---|---|
| §11.1–§11.13 | [`agents/06-pitfalls-toolchain.md`](agents/06-pitfalls-toolchain.md) |
| §11.14–§11.27 | [`agents/07-pitfalls-cli.md`](agents/07-pitfalls-cli.md) |
| §11.28–§11.36 | [`agents/08-pitfalls-quality.md`](agents/08-pitfalls-quality.md) |
| §11.37–§11.41 | [`agents/09-pitfalls-engine.md`](agents/09-pitfalls-engine.md) |
| §11.42–§11.47 | [`agents/10-pitfalls-phone.md`](agents/10-pitfalls-phone.md) |
| §11.48–§11.49（含托盘说明） | [`agents/11-background-service.md`](agents/11-background-service.md) |

## 铁律（§6）—— 改代码前必读，违反将导致行为分叉 / 静默失效

1. **引擎语义只在 Rust，但被回调的 TS 须同语义**：聊天循环 / 工具执行 / 压缩 / 标题全在 `src-tauri/virlen-core/src/agent/*`（TS 引擎已移除）。
   改「LLM 轮次 / 工具执行 / 暂停恢复 / 迭代验证 / 撤销语义」只需改 Rust；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装 / `AgentEventType` 契约）仍须与 Rust 逐字对齐。
2. **事件契约不可擅自改名**：`AgentEventType` 是四方共享契约（TS 类型 → TS emit → Rust emit → chat-service 处理），新增必须四处一致。
3. **引擎不碰前端 store**：Rust 引擎由 `SessionRepo` 内部直落 SQLite（先落库再 emit），前端只消费 `onEvent` / `agent:event`。
4. **新增 Tauri 命令必须注册**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]`，否则前端 `invoke` 静默 404；涉及权限还要看 `src-tauri/capabilities/default.json`。
5. **工具是「定义 + 执行器」分离注册制，且定义只有一份**：定义在 Rust 侧权威源 `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`；前端 `toolRegistry.register(name, executor, label?)` 只注册执行器与 i18n 文案，读取走异步 `listDefinitions()`。**不要在任何一侧另写定义体**（`src/tests/contracts/tool-defs-contract.test.ts` 守这条线）。
6. **写操作必须先过安全校验**：JS 侧 `securityService.resolveSafePath/isPathAllowed`，Rust 侧 `native_tools::resolve_safe_path / is_path_allowed`，两侧规则必须等价。禁止绕过。
   路径展开（`~` / `%USERPROFILE%`）与 canonicalize 规则**必须共用同一实现**：`src-tauri/virlen-core/src/sandbox/paths.rs::expand_user_path`（前端经 `canonicalize_path` 命令走同一函数）。禁止在任一侧另写一份展开/规范化逻辑，否则黑名单条目会在默认引擎下静默失效。
7. **业务文案走 i18n**：`t('中文')`（中文即 key），变量模板用 `tpl('已删除 $__count__ 个会话', {count})`；新增 UI 文案必须同步 `src/ui/i18n/lang/en-US.json`。
8. **最小改动**：不改动与任务无关的代码；顺手重构要单独说明。
9. **中文注释是本项目风格**：文件头写职责，关键分支写「为什么」而非「做了什么」；同一要点不在同一文件里重复（重复即合并，保留证据：数字 / 文件名 / § 引用）。
   **风险标记 `⚠️` 按分级保留**，三类之外的说明一律不加标记、并压到 1–3 行：
   - **① 安全 / 权限 / fail-closed**：脱壳门禁、只读拒绝、`deny` 优先、密钥红线、fail-closed 兜底；
   - **② 契约与铁律同步义务**：`AgentEventType` 四方契约、铁律 1「改一边必须同步另一边」、逐字一致约束、隐式的成对 / 顺序契约；
   - **③ 跨实现镜像 / 唯一源**：唯一权威源、两份镜像必须同步、禁止再写一份。
   纯实现细节（`#[allow]` 的理由、`cfg` 门禁取舍、估算 / 计数口径、字段可见性、性能取舍）不加标记；已失效的表述（所描述的实现已被移除）直接删掉，不要留着「当时的理由」。
10. **不用 `git push --force`、不重写历史、不动 `dist/`、不删别人的文件**。

## 安全红线（§8）—— 写涉及文件 / 命令 / 网络的代码前必读

- **路径**：优先级 **黑名单 > 白名单 > 工作目录**；写模式仅允许白名单 + 工作目录；黑名单按平台给默认值。
- **沙盒**：`settings.sandboxMode`（`on`/`off`/`readonly`）。**禁止绕过沙盒直接 spawn**；唯一例外是 `execute_command` / `execute_script` 的 `sandbox:"off"`（须按「沙盒脱壳」权限决策、`readonly` 直接拒绝、埋点 `tool.sandbox.bypass`）。
  另：命中「忽略沙盒命令」规则（§5.4）的命令**免脱壳审批并强制无沙盒执行**（AI 未申请也生效，埋点 `status: auto_rule`）；`off` / `readonly` 下规则不生效，`deny` 优先。
- **权限三态**：命令 / 脚本 / 沙盒脱壳（`allow`/`ask`/`deny`）；`deny` 永远优先；脱壳与命令/脚本权限**取更严格者**。UI 在「设置 → 安全 → 权限管理」。
- **工具风暴**：滑窗检测重复 `(toolName, args)`，命中即中断。
- **密钥**：埋点/日志**不得**输出 apiKey、token、密钥文件内容；`providers` / `searchProviders` 只上报数量。
- **端侧视觉**：图片不出本机，**不要**改成上传。

**AI 代理自我约束**：

- 不读取 `.env`、`*.key`、`~/.ssh/` 等敏感文件；
- 文件写入限制在工作区；
- 删除文件用**回收站语义**（`trash`）而非硬删；
- 破坏性操作（删库、清空会话、批量重命名）先向用户确认。

## 深读入口（细节已下沉，不在本分册里展开）

> - `docs/rust-engine.md` —— 引擎 Rust 化清单与已知差异
> - `docs/pty-research.md` —— Windows ConPTY / 终端交互完整设计
> - `docs/host-abstraction-draft.md` —— 宿主抽象（**方案 A 已实施**）：GUI / CLI 资源与数据目录的唯一接口
> - `docs/config-sink-plan.md` —— 配置下沉（**落 SQLite，与 GUI 共用同一份 `virlen.db`**）+ `js` 沙盒规则内嵌求值
> - `docs/cli-tui-plan.md` —— CLI 交互式 TUI（`virlen-cli chat`）与配置向导、上下文压缩、会话管理（`session`）/ 用量账本（`usage`）的方案 / 实测
