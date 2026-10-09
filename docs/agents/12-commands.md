# 常用命令 · 手册速查 · 前端约定 · 提交协作（§7 / §9 / §10 / §13）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

## 7. 常用命令与验证基线

```bash
pnpm install                 # 依赖安装（首次 / 依赖变更后必须执行）
pnpm dev                     # 仅前端（Vite，端口 1420，strictPort；⚠️ 浏览器模式没有后端，聊天与压缩不可用）
pnpm tauri dev               # 桌面端开发（前端 + Rust）
pnpm build                   # tsc && rimraf dist && vite build
pnpm tauri build             # 桌面端安装包
pnpm test                    # vitest run（配置见 vitest.config.ts）
pnpm test:watch / test:ui
npx tsc --noEmit             # 类型检查（静态门禁之一）
cd src-tauri; cargo clippy --workspace --all-targets -- -D warnings   # Rust 静态门禁（须零告警；CI `ci.yml` 每次 push/PR 跑，见 §11.28）
cd src-tauri; cargo test --workspace   # Rust 侧测试（⚠️ 必须 --workspace，见 §7 下注）
pnpm build:msix              # Windows MSIX 打包（scripts/build-msix.ps1）
pnpm build:cli               # 打包 headless CLI（release 二进制；三元组用环境变量 CARGO_BUILD_TARGET，别用 `--target`，见 §11.31）
                             # 产物 src-tauri/target[/<triple>]/release/virlen-cli[.exe]；发版时三个 build-*.yml 会把它
                             # 连同 quasivision_models 打成 **zip** 上传（§11.29）
pnpm cli config get          # headless CLI（= cargo run -p virlen-cli -- …；与 GUI 同一份 app_settings）
pnpm cli run "解释 README"   # 无界面跑一次 agent（stdout=正文 / stderr=工具进度；同一份会话库）
pnpm cli list-session -g agent   # 列出会话（-g agent|workdir 分组；--limit / --json；含「上下文/200k」「条数」两列）
pnpm cli chat                    # 交互式 TUI：状态行显示上下文占用 %；/compress [ai|raw] 压缩上下文
pnpm cli list-agent              # 列出 Agent（读 app_settings.agents，含各自会话数）
pnpm cli provider add            # 交互式配一个供应商（逐步录入 → 验证 → 按 id 合并写入；需真终端）
pnpm cli provider list --json    # 列出供应商（apiKey 已掩码）；另有 provider edit|rm|test
pnpm cli agent add               # 交互式配一个 Agent（逐步录入；需真终端）；另有 agent edit|rm|list
```

- 测试文件实际位于 **`src/tests/**`（不是 `tests/`）**，`vitest.config.ts` include 已固定，setup 文件 `src/tests/setup.ts`（模拟 Tauri API）。
- 基线（README 记录，**本机沙盒未复现**，见 §11.2）：`cargo test --workspace` / `vitest run` 全绿、`tsc --noEmit` 零错误。
- 提交前**至少**自查：`npx tsc --noEmit`（无新增错误）+ 受影响模块的测试。
- ⚠️ 本机沙盒内 `vitest` / `vite build` 会因 `esbuild` 子进程 `spawn EPERM` 失败，须走**沙盒脱壳**（`sandbox:"off"`，见 §11.2）。
- ⚠️ **Rust 构建需要 `libclang`**（`quickjs_runtime` → `hirofa-quickjs-sys` → `bindgen` 的**构建期**依赖）：Windows 装 LLVM 并设 `LIBCLANG_PATH=<LLVM>\bin`，否则 `cargo build` / `cargo check` / `tauri dev` 会在 `hirofa-quickjs-sys` 直接失败（报 `Unable to find libclang`）。
  - `clang-sys` 只探测 `LIBCLANG_PATH` 与 `llvm-config.exe`，**不扫 `PATH`**：LLVM 装在非默认位置、或该发行版不带 `llvm-config.exe`（本机 `C:\config\LLVM` 即是）时**必须**显式设。
  - 必须**持久化**（用户级环境变量）并**重开终端 / IDE**：临时 `$env:LIBCLANG_PATH` 只对当前 shell 生效，而 `pnpm tauri dev` 由 CLI 新起 shell 跑 `cargo run` → 表现为「手动 `cargo build` 能过、`tauri dev` 报 `Unable to find libclang`」。
  - 该 bindgen 调用在 `hirofa-quickjs-sys/build.rs` 里**无条件**执行（无特性开关），**不能**用 feature 绕开。
- ⚠️ `src-tauri/` 是 **cargo workspace 根**，含 **3 个 package** —— 即「**core / cli / tauri**」三个模块：`virlen-app`（GUI 壳，workspace 根 package）、`virlen-core`（零 `tauri::` 的核心库，**不含命令入口**）、`virlen-cli`（headless，只依赖 core，命令实现与规划的 TUI 都在它的 **lib** 里）。`target/` 与 `Cargo.lock` 位置**不变**（仍在 `src-tauri/`）。
  - **GUI 与 CLI 的差异只允许来自「宿主注入」**（`HostEnv` / `EventSink` / `TelemetrySink`），不允许来自「两份实现」—— 这条以前靠注释约定，现在**由编译器强制**（core 连 tauri 依赖都没有）。
  - ⚠️ **`cargo test` 必须带 `--workspace`**：manifest 指向 workspace 根 package 时，裸 `cargo test` **只跑 `virlen-app`**（实测：30 个用例），会**静默漏掉 `virlen-core` 的 354 个与 `virlen-cli` 的 57 个用例**（共 411）。CI 三个 workflow 已同步。
  - 纯 Rust 目标（`cargo build/check/test`，dev profile）**不读** `frontendDist` → **无需**先 `pnpm build`（实测：把 `frontendDist` 指向不存在的目录仍通过）。`tauri build` 自己会跑 `beforeBuildCommand = pnpm build`，也不用手动。
  - `[package] default-run = "virlen-app"` 保留为防御性声明，见 §11.14。

---

## 9. 手册速查（细节见对应章节 / 文档）

### 9.1 新增一个工具

1. **先写定义（Rust 侧权威源）**：在 `src-tauri/virlen-core/src/agent/tool_defs/definitions.json` 的**三个平台变体**里都补上该工具（`name` / `description` / `parameters`）；平台无关的工具三份内容相同，平台相关描述参考 `execute_command`。Rust 侧不用改代码（`include_str!` 自动带上），见 `docs/rust-engine.md` §12。

2. **再写执行器**（在所属分类目录新建文件；**不写定义**）：

   ```ts
   toolRegistry.register(
     'my_tool',
     (async (args, ctx: ToolContext) => {
       // ctx: { sessionId, toolCallId, abortSignal, write, skills }
       // 需要用户交互 → return new UserInteractionRequired('my_interaction', {...})
       return '给 LLM 的结果文本' | { content: string, uiData?: Record<string, any> }
     }) as ToolExecutor,
     t('我的工具'), // 可选：UI 文案（i18n），不进契约
   )
   ```

3. **挂进启动注册链**：分类 `index.ts` 加 `import './my-tool'`（新分类还需在 `tools/index.ts::toolsInit()` 加 `await import(...)`，并在 `domain/tools/category.ts` 的 `TOOL_CATEGORIES` 登记）。
4. **公共函数**：同分类 ≥2 工具复用 → 抽到分类 `common.ts`。
5. **UI 渲染**：`tool-call/` 新建 `XxxMessage.tsx` 实现 `IToolCallMessage` 并 `register(...)`（未注册落 `DefaultMessage`）。
6. **是否原生化**：在 `native_tools/mod.rs` 的 `is_native_tool` + `execute_native_tool` 加分派，对应分类目录新建 `<工具>.rs`（复用 `common.rs`）；需要会话库的工具从 `ctx.repo` 取（先看 `is_available()`），需要长期记忆的从 `ctx.memory` 取（同有 `is_available()`），需要安全配置的从 `ctx.security` 取。⚠️ 新增 `NativeToolCtx` 字段要同步改所有构造点（引擎链：`tool_executor` → `llm_loop` / `iteration` → `engine` → GUI `init_agent_engine` / CLI `run`|`tui`）。
7. **测试**：`src/tests/infrastructure/*.test.ts`（JS）；Rust 加内联单测。契约与执行器的名单一致性由 `src/tests/contracts/tool-defs-contract.test.ts` 守（契约里有定义 → 必须有执行器，反之亦然）。

### 9.2 新增 / 修改 Provider、搜索源、Skill

- **LLM Provider**：实现 `IProvider` → `provider/index.ts::createProviderInstance` 注册 → 模板放 `domain/provider/config.ts`。要 Rust 原生支持需在 `agent/provider.rs` 加实现，否则自动走 `BridgedProvider`。
- **搜索源**：实现 `ISearchProvider` → 放 `infrastructure/search-providers/` → `factory.ts` 注册 → 配置存 `SettingsStore.searchProviders`（已下沉 `app_settings`）。⚠️ **若要被默认引擎（Rust）+ CLI 使用，还要在 `src-tauri/virlen-core/src/agent/native_tools/web/web_search.rs` 里加同名分支**（当前只有 `tavily` / `bocha`）——否则该搜索源只在浏览器 dev / JS 执行器路径生效。
- **内置 Skill**：`src-tauri/resources/default-skills/<name>/SKILL.md`，frontmatter 至少 `name` / `description`（也兼容纯 Markdown：`# 标题` + `> 描述` + `**Version:** x.y.z`，解析器 `utils/mdYamlFrontmatter.ts`）；目录名应与 `name` 一致；脚本放 `scripts/`。

---

## 10. 前端约定

- **状态**：MobX 单一 store + `StorageState`（`utils/storageState.ts`）。⚠️ **设置类**（`settingsState`，key `_storage_state_virlen-settings`）自 S3 起 **Tauri 下不再写 localStorage**（权威源是 `app_settings` 表，见 §5.3）。新增设置项记得加进 `SettingsStore` 接口 + `defaultSettings` + 设置页 UI（`ui/pages/Settings/`）。
- **会话持久化**：见 §5.3。启动只加载元数据，消息懒加载；`utils/db.ts` 已废弃，不要复活。
- **组件事件**：`src/events/*` 的 EventEmitter；禁止 `window.*` 全局挂载。
- **样式**：组件目录内 `style.scss`，BEM 类名；主题变量在 `ui/styles/theme.scss`（原 `theme.css`，改为 scss 后品牌色由 SCSS 函数派生）。
- **主题色（品牌色）**：唯一色源 = 品牌基色。默认档与预设色板由 `theme.scss` 的 `accent-tokens()` **构建期**算死（预设用 `<html data-accent='<name>'>` 选中，零运行期计算）；用户在「设置 → 通用 → 主题色」选的**任意颜色**由 `ui/theme/accentPalette.ts` 用**同一套系数**在运行期派生，经 `ui/hooks/useAccentColor.ts` 注入 `:root[data-theme=…]` 覆盖样式。
  - ⚠️ **改一处必须改两处**：SCSS 的 `$accent-mix-*` 与 TS 的 `ACCENT_MIX` 一一对应；`src/tests/ui/accent-color-contract.test.ts` 会把 `theme.scss` 编译出来逐令牌对拍，漂了就是红的。
  - ⚠️ **品牌底色上的文字/图标一律用 `var(--primary-fg)`**（标题栏用 `var(--primary-bar-fg)`），不许写 `#fff`/`fill: white` —— 浅色主题色时前景会自动转黑，写死白字就糊在亮底上了（同一用例里有全仓扫描守卫）。
- **窗口**：无边框自绘 + 首帧 `show()`。
- **性能**：消息列表虚拟滚动 + 分页（改 `message-list.tsx` 注意 `measureElement`）。
- **埋点**：`track('域.动作', props)`，默认关闭、关闭时零开销。

---

## 13. 提交与协作约定

- 提交信息风格：`feat: ...` / `fix: ...` / `update Version` / `update`（中英混用，保持一致即可）；
  涉及引擎/持久化的改动请在正文写清「TS / Rust 两侧都改了什么」。
- 一次提交只做一件事；格式化 / 重命名等噪音改动不要混进功能提交。
- **提交前自查清单**：
  1. `npx tsc --noEmit` 无新增错误；动了 `src-tauri/` 则 `cargo clippy --workspace --all-targets -- -D warnings` **零告警**（CI 门禁，见 §11.28）；
  2. 受影响模块的 `vitest` 通过；动了 `src-tauri/` 则 `cargo test --workspace` 通过（**拆包后必须带 `--workspace`**，见 §7/§11.14）；
  3. 若改了引擎语义 → **只需改 Rust**（TS 引擎已移除，见 §11.37）；但**被 Rust 回调的 TS 部分**（工具执行器 / Gemini provider / 提示词组装）与**事件契约**是否已同步？
  4. 若新增工具 → 注册链、UI 组件、Rust 白名单、i18n 文案是否齐备？
  5. 若新增 Tauri 命令 → `lib.rs` 是否已注册？`capabilities/default.json` 是否需补权限？
  6. 是否引入无关改动、是否触碰 §8 安全红线？
  7. 若改了 workflow / 打包流程 → 产物路径与 `upload-artifact` 的 `path`、Release 的 `files` glob 是否对齐？（CLI 发布物是 **zip**（含视觉模型）：命名约束 / zip 内布局 / 打包自检见 §11.29；**CLI 构建步骤的三元组用 `CARGO_BUILD_TARGET` 环境变量**，不要走 `pnpm run … -- --target`，见 §11.31）；
  8. 新增/修改了**平台专属代码**（`#[cfg(target_os = …)]`）→ 反向平台能不能编译？（CI 的 clippy 只在 ubuntu 跑，Windows 专属的常量 / 函数在 Linux 上就是 `dead-code`，必须显式门禁，见 §11.31）
  9. 有没有在**模块顶层**读「启动水合」的快照（`providerCatalog()` / `promptText()` / `providerService.getDefaultProviderList()` …）？那等于在 `main.ts` 水合之前读 —— 整个应用会**启动即崩、窗口都不显示**，见 §11.32；
