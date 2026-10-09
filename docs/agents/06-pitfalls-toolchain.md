# 常见坑 · 环境 / 工具链 / 桌面端集成（§11.1–§11.13）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

## 11. 常见坑（踩过的，别再踩）

> **速查级**：每条只留「现象 → 根因 → 结论 / 改哪里」。专项细节在各自文档里（PTY `docs/pty-research.md`、TUI `docs/cli-tui-plan.md`、托盘 `src-tauri/src/tray/`、Rust 引擎 `docs/rust-engine.md`）；本节被压掉的长篇叙述与实验记录见 git 历史（`git log -p docs/AGENTS.md`）。

**11.1 PowerShell 5.1 按本地代码页（GBK）读文件** —— 看含中文的源码会乱码：读加 `-Encoding UTF8`；写统一用 `write_file` / `edit_file`（UTF-8）。

**11.2 本机沙盒的已知限制（环境行为，不是代码 bug）** —— `vitest` / `vite build` / `jest` / `node-gyp` / `child_process.exec*` 因 `esbuild` 子进程 `spawn EPERM` 跑不了。根因：libuv 给 spawn 的 stdio 建的是**命名管道**（NPFS 内置 SD 无 restricting SID 写 ACE → 受限令牌第二遍检查 `ACCESS_DENIED`）；**匿名管道不受影响**（python `subprocess(capture_output=True)`、`cargo`→`rustc` 均正常）。
退路：`execute_command` / `execute_script` 传 `sandbox:"off"`（按「沙盒脱壳」权限授权，`readonly` 拒绝）；不想每次授权就配「设置 → 安全 → 忽略沙盒命令」（命中即自动无沙盒，见 §5.4）。临时关闭：`VIRLEN_SANDBOX=off|readonly|on`（由 **Virlen 进程**读取，命令里 `set` 无效）。另：`node_modules` 可能不完整，先 `pnpm install` 再判错。

**11.3 版本号分散在 7 个文件 / 10 处，靠手动同步** —— `package.json`、`src-tauri/Cargo.toml`、`virlen-core|virlen-cli/Cargo.toml`、`src-tauri/tauri.conf.json`（**打包与 MSIX 实际读它**）、`Cargo.lock` 的三个本包条目、README ×2。用 `pnpm update`（`scripts/update-version.mjs` 已覆盖全部，`--dry-run` 可预览）。

**11.4 README ×2 需同步维护**（`README.md` / `README-CN.md`）—— 改工具数量、测试目录（`src/tests/`）、技术栈版本时最容易漂移。

**11.5 前端工程四条** —— `vite.config.ts` 的 `optimizeDeps.exclude: ['monaco-editor']` **不可去掉**（否则 monaco 打成多份实例、注册表互相隔离）；Vite 端口固定 1420（`strictPort`），`tauri dev` 会因占用失败；`tsconfig.json` 是 `strict: true` 但 `strictNullChecks: false`、`noUnusedLocals/Parameters: false`（别名 `@/*` → `src/*`，Vitest 另配一份）；Run Snapshot 只存内存、刷新即失效，用户取消**不算错误**（要保留 partial 内容，见 `docs/rust-engine.md`）。

**11.7 Windows `execute_command` 走 ConPTY（伪控制台）** —— stdout / stderr **合并为一条 VT 流**，`uiData.pty = true`（前端用 xterm 渲染，非 PTY 才回落 `<pre>`）；完整背景见 `docs/pty-research.md`。
- 给模型看的文本必须过 `process_terminal_output`（完整吞掉 ECMA-48 转义序列，**Rust / TS 两侧必须同步**）；**不要再假设子进程 stdio 是管道**。
- 交互走 Tauri 命令 `pty_write` / `pty_resize` / `pty_key`（**不经引擎事件总线**）。两条红线：用户输入正文**不回灌**给模型；终端内确认的命令**仍走沙盒 + 同一条执行路径**。
- 缺口：常驻交互 shell（Step 3）未做；Unix PTY 未实现（`runner/pty.rs` 整体 Windows 门禁，见 §11.31）。

**11.8 拖拽取文件路径：`dragDropEnabled` 只能为 `true`（与 HTML5 拖拽互斥）** —— 原生拖放能拿真实路径（`onDragDropEvent().payload.paths`），但页面收不到 HTML5 `drop`。实现见 `ui/pages/chat/components/input/index.tsx`（监听 + 命中判断）+ `input/hooks.ts`（同类说明散见于 `use-tree-drag.ts` / `sandbox-rules-dnd.ts` 的文件头）。
附件：`MessageContent` 的 `file` 块**只存路径**，各 Provider 统一降级为文本（TS `fileBlockToText` ↔ Rust `provider.rs`，**两侧文案必须一致**；`ATTACHED_FILE_LABEL` / `ATTACHED_DIR_LABEL` 用英文、不进 i18n）。

**11.9 粘贴文件：路径只能问原生剪贴板**（页面 `DataTransfer` 里没有）—— `read_clipboard_file_paths`（`src-tauri/src/clipboard_files.rs` = `CF_HDROP`）；读不到一律返回 `[]`，**不报错、不打断粘贴**。前端在 `input/index.tsx` 汇到 `acceptPaths`，含 Ctrl+V 原生兜底（WebView2 对「复制的文件」可能连 `paste` 事件都不触发）。

**11.10 输入框高度模型：固定高度只落在 textarea 上**（否则附件把工具条顶出盒子）—— 两个必须对齐的常量：`index.tsx` 的 `INPUT_CHROME_HEIGHT = 58` ↔ `style.scss` 的 `.input-wrapper` 静止高度 125 / `textarea { min-height: 67px }`；`.has-fixed-height textarea` 必须 `flex: 0 0 auto`。

**11.11 Windows 上 `cargo test` 可能连启动都启动不了（comctl32 v6 清单）** —— 报 `0xc0000139` 且无任何 Rust 输出，而 `cargo build` / `check` 正常。根因：托盘**菜单**（muda）链进 comctl32 **v6 专属**导出 `TaskDialogIndirect`，而带 RT_MANIFEST 的 `resource.lib` 只经 `rustc-link-arg-bins` 给了 **bin** → 测试二进制在**加载阶段**就失败。修法在 `src-tauri/build.rs`：全局 `/MANIFEST:EMBED` + `/MANIFESTINPUT:windows/common-controls.manifest`，同时给 bin 加 `/MANIFEST:NO`（否则 `CVT1100 duplicate resource`）。定位手法可复用：解析两个 exe 的 PE 导入表做差分。

**11.12 单实例：`tauri-plugin-single-instance` 必须第一个注册，且它自己会 `process::exit`**
- **顺序**：插件 `setup` 按注册顺序执行、都在 `App::build()` 内（`initialize_plugins`），**早于** `.setup()` 回调与窗口创建 → 不在链上第一个的话，第二实例会先建好窗口 / 托盘 / SQLite 再被杀。
- **清理**：第二实例的退出**绕过** `tray::destroy()`（不发 `NIM_DELETE` → 幽灵图标）。当前无事（那时还没建托盘），但**别**在 `tauri.conf.json` 加 `app.trayIcon` —— 那个默认托盘在 `initialize_plugins` **之前**就建好了。
- **dev 下不注册**：`lib.rs::run()` 用 `if !tauri::is_dev()` 包住，否则没关干净的 dev 实例（关窗只隐藏到托盘）会把新起的 `pnpm tauri dev` 顶掉，表现为「跑完什么都没出现」。判定信 `tauri::is_dev()`（= `DEP_TAURI_DEV`），**别**自己写 `cfg!(feature = "custom-protocol")`（本包没声明该 feature，恒 true = 永远算 dev）。
- 窗口唤起统一走 `tray::activate_main_window(app, reason)`（**不清未读**）。

**11.13 切会话有唯一入口 `chat-view.tsx::handleSelectSession()`** —— 外部只改 `chatState.currentSessionId` 会「跳过去但消息列表是空的」（它还要 SQLite 懒加载、`setMessages` 镜像、中断残留修复、用户消息索引、埋点、清红点）。
外部入口（托盘唤起等）拿不到组件函数 → `chat-view` 有「外部入口兜底 effect」（`handledSessionRef`）接住：**新增外部切会话入口只改 store**；组件内自己切（如 `doSend` 新建会话）必须登记 `handledSessionRef`，否则兜底 effect 会按旧内容覆盖刚加的消息。另：`message-list` 的 `hide`（`opacity: 0`）在 `messages` 为空时也必须解除（见 `use-scroll-controller.ts`）。
