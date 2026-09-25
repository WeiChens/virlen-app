# 配置下沉（D3）+ `js` 沙盒规则求值（D4）— 实施计划

> **状态：设计已定稿（用户已签署）；存储介质由「磁盘 JSON」改为「SQLite」—— 见 §0 决策修订。**
> 决策记录：**D3 = 配置来源 C**（GUI 设置下沉，GUI 与 CLI 共用一份）；
> **存储 = 现有 `virlen.db` 内的 `app_settings` 表**（不再新增 `config.json`）；
> **D4 = 内嵌 JS 引擎求值 `js` 类沙盒规则**，库为用户指定的 `quickjs_runtime`（crates.io）。
> 关联：待办 #16/#17/#22、`docs/AGENTS.md` §5.3/§5.4、`docs/host-abstraction-draft.md`。

---

## 0. 决策修订（相对首版草案）

| 项 | 首版草案（磁盘 JSON） | 现定稿（SQLite） |
|---|---|---|
| 存储位置 | `<data_dir>/config.json` | **`<data_dir>/virlen.db` 的 `app_settings` 表**（与会话库同一个文件） |
| 一致性 | 原子写 + `.bak` + 「解析失败不回退默认」 | **由 SQLite 事务保证**（无需 `.tmp`/`.bak`）；连接沿用单写连接 + `spawn_blocking` |
| 覆盖环境变量 | `VIRLEN_CONFIG_DIR` | **不再需要**（库路径由 `HostEnv::data_dir()` 决定，`$VIRLEN_DATA_DIR` 覆盖） |
| 版本 | JSON 里的 `schemaVersion` | 表内保留键 `__schemaVersion`（会话库的 `PRAGMA user_version` 管表结构，两者互不干扰） |
| 迁移 | 首启从 localStorage 导入 | **不变**（首启把 localStorage 现有设置整份导入，写一次即可） |

**为什么更好**：会话库已经具备「WAL + 单写连接 + `spawn_blocking` + 迁移框架 + 维护命令（体积/整理）」，
配置只是多一张表 —— 不需要新造一套文件读写与并发/损坏处理；CLI 与 GUI 天然共用同一个文件。

**代价（如实登记）**：
1. 配置与聊天写入**共用一把连接锁** → 设置写入是短事务（微秒级），可接受；但 `VACUUM`（设置 → 存储「立即整理」）期间设置写入会排队，这与现状一致。
2. 备份/导出设置 = 随库文件一起（用户已有的「整理/体积」界面因此天然涵盖配置）。
3. 「用编辑器手改配置」不再可行（JSON 时可行）—— 这是取舍，**手改需求改为后续 CLI 子命令**（见 §5 S6）。

---

## 1. 为什么这是「真正的前置」

`web_fetch` / `web_search` 原生化（#17）与「纯 Rust CLI」都被同一件事卡住：**引擎需要的配置目前只存在于前端 localStorage**。

| 引擎侧运行期需要的东西 | 今天从哪来 | CLI 下有没有 |
|---|---|---|
| 工作目录 / 沙盒模式 / 技能目录（`NativeToolSecurity`） | 前端 `rust-engine.ts::resolveSecurityConfig` 随消息下发 | ❌ |
| 权限三态（`settings.permissions`） | 前端决策，Rust 只收结果 | ❌ |
| 搜索源配置（tavily / searxng / bocha） | `search-provider-service.ts`（localStorage） | ❌ |
| Provider 配置（apiKey / baseUrl / model） | `settingStore`（localStorage） | ❌ |
| 「忽略沙盒命令」规则（含 `js` 规则体） | ✅ **已下沉**（S7）：`app_settings.sandboxIgnoreRules`（**单一源**，localStorage 不再保存该字段） | ✅ |
| Agent 配置（`agents`） | ✅ **已下沉**（本轮）：`app_settings.agents`（**单一源**；localStorage 仅作迁移来源 / 非 Tauri 降级） | ✅ |

> ⚠️ 上表前四行是**首版草案时的状况**（说明动机用）：S3 收尾后 `settings` 全量、搜索源与 Provider 配置都已随设置下沉，
> 现在已不存在「前端 localStorage 是唯一来源」的项。剩余未下沉的只有安全侧的**路径白/黑名单与跳过目录**、**技能启用状态**，
> 清单与对 headless 的具体影响见 `docs/AGENTS.md` §11.16。
>
> 结论（**历史**）：**不做配置下沉，`#17` 无法开工**（没有 API key、没有搜索源、没有工作目录）。

---

## 2. 目标 / 非目标

**目标**

1. 一份配置存于 `app_settings` 表，GUI 与 CLI 读写同一份；GUI 的 localStorage **已完全退出**（S3 收尾：不再写、表就绪后删副本，只保留「读兼容」）。
2. 引擎侧只吃「配置快照」，不关心它从哪来（保持 `security` / `repo` / `host` 那种显式注入）。
3. CLI 无 GUI 启动即具备：工作目录、沙盒模式、技能目录、权限、Provider、搜索源。
4. 迁移**无感**：老用户的 localStorage 设置首启自动导入，无需手工重配。

**非目标**

- 不下沉 UI 状态（展开项、窗口尺寸、草稿）—— 那属于界面偏好，CLI 不关心。
- 不做多用户 / 多 profile。
- 本期不迁移**密钥的存储方式**（见 §6 风险 R3）。

---

## 3. 存储设计（`app_settings` 表）

### 3.1 DDL

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,      -- 与 TS `SettingsStore` 字段**同名**（camelCase）
  value      TEXT NOT NULL,         -- JSON 序列化后的值（标量/数组/对象统一）
  updated_at INTEGER NOT NULL
);
```

- **一 key 一行**（而非整份 JSON 塞一个 key）：
  - 写入是「只改我动过的键」，避免整份覆盖造成的**丢更新**（多窗口/并发时更安全）；
  - 体积小、`updated_at` 能定位「最近改了什么」。
- 键名与 `src/ui/store/settingStore.ts` 的 `SettingsStore` 接口**同名同层**（如 `providers`、`permissions`、`sandboxMode`），
  Rust 侧不建映射表 —— 这是**避免字段漂移**的关键约定（§6 R6）。
- 保留键：`__schemaVersion`（配置结构的版本，独立于表结构版本）。

### 3.2 Rust 侧形状（与 `SessionRepo` 同风格）

```rust
// session_db/settings.rs（同一个 SQLite 文件 / 同一把连接锁）
#[async_trait]
pub trait SettingsRepo: Send + Sync {
    async fn get_all(&self) -> Result<serde_json::Map<String, Value>, String>;
    async fn upsert(&self, entries: serde_json::Map<String, Value>) -> Result<(), String>;
    /// 仅当表为空时导入（首启从 localStorage 迁移用），返回是否真的写入
    async fn import_if_empty(&self, entries: serde_json::Map<String, Value>) -> Result<bool, String>;
    fn is_available(&self) -> bool;   // Noop 覆写为 false（与 SessionRepo 同一套探针语义）
}
```

- 实现 `SqliteSettingsRepo` **复用 `SqliteSessionRepo` 的 `Arc<Mutex<Connection>>`**（同一把锁 → 与聊天写入互斥，不会 SQLITE_BUSY）；
- `NoopSettingsRepo` 供单测 / 无库环境（`is_available() == false`）。

### 3.3 Tauri 命令（薄壳：参数兜底 + 调 repo + 埋点，与 `cmd_*` 会话命令同风格）

| 命令 | 语义 |
|---|---|
| `cmd_settings_get_all` | 返回全部键值（GUI 启动水合 / CLI 读配置） |
| `cmd_settings_upsert` | 单事务写入若干键（GUI 改动时调用；也供 CLI 写入） |
| `cmd_settings_import` | 仅当表空时导入（首启从 localStorage 迁移），返回 `bool` |

### 3.4 读取优先级（覆盖链）

```
CLI 显式参数  >  环境变量（VIRLEN_*）  >  app_settings 表  >  内置默认
```

### 3.5 前端接入（`src/ui/store/settingStore.ts`）

- `StorageState` 换用**只读 localStorage 适配器**（`settingsLocalStorage`，S3 收尾）：
  - **读**：仍读真 localStorage → 兼容老版本遗留的副本（同步初值）；
  - **写**：Tauri 下**丢弃**（设置只落表，避免 apiKey 等密钥明文存两份）/ 非 Tauri 下照写
    （浏览器 dev 没有表可写，不能丢持久化）；
  - 水合成功（表已就绪）后删掉历史副本（`dropLegacyLocalSnapshot`）。
- `src/infrastructure/settingsRepo/`（浏览器 dev / vitest 自动降级为空实现）：
  - 启动：`loadAll()` → `cmd_settings_get_all` → 有值则 `settingsState.set(...)`；**表为空**则把当前设置整份 `cmd_settings_import` 上去；
  - 变更：`settingsState.onChange` 已存在（埋点用）→ 追加一个 debounce 的 `save(entries)` 落库。
- `src/main.ts` 的 `init()` 增加一步 `await step('settings', () => hydrateSettings())`，
  **排在 `i18n` / `sessionLoad` / `security` 之前**（语言/主题/工作目录要先于它们生效）。
  ⚠️ `main()` 是 `await init()` **之后**才 `render()`、窗口在首帧 `requestAnimationFrame` 里才 `show()`
  → 用户看不到未水合的帧（删副本不会造成可见闪烁）。

### 3.6 迁移（一次性）

1. 启动时 `cmd_settings_get_all` 为空且 localStorage 有 `_storage_state_settings` → 前端把现有设置整份 `cmd_settings_import`。
2. 导入成功后写 `__schemaVersion: 1` 与 `__migratedFrom: "localStorage"`（便于排查）。
3. 之后以表为准；**S3 收尾已清掉 localStorage 副本**（表就绪即 `removeItem`，写入被丢弃 → 副本不会再生）。

---

## 4. D4：`js` 类沙盒规则在纯 Rust CLI 下怎么求值

### 4.1 现状（事实）

- 匹配器只有**一份实现**：`src/domain/security/sandbox-ignore-rules.ts`（`text`（完全/前缀/后缀）、`regex`、`js`）。
- **Rust 路径（默认引擎）不重实现**：经**内部交互** `sandbox_rule_check`（无 UI）问 JS 同一个 `matchSandboxIgnoreRule`；
  `security.hasSandboxIgnoreRules` 只是性能开关（false 时零 IPC）。

> **S7 之后的现状（本文件下文以“现状”描述）**：匹配下沉到 Rust（`src-tauri/virlen-core/src/security/`），
> 规则整体随 `NativeToolSecurity.sandbox_ignore_rules` 下发，`sandbox_rule_check` 桥交互**已删除**；
> TS 实现仍保留给浏览器 dev / TS 引擎 / 设置页「测试」，两侧由 golden 契约收敛。
- 唯一的保存期校验是 `compileSandboxRule`（**只验证能否编译**，不执行规则体）。

⇒ **纯 Rust CLI 没有 JS 进程**，`js` 规则在原理上无法求值 —— 这就是 D4 必须定案的原因。

### 4.2 选定方案：内嵌 QuickJS（`quickjs_runtime`）

**只在需要时启动**：仅当「存在启用的 `js` 规则」且命令走到匹配步骤时才构建 runtime。

```
匹配流程（Rust CLI）：
  1. text / regex 规则 → Rust 原生实现（零依赖、快、行为可直接与 TS 对齐）
  2. 遇到 js 规则 → 交给嵌入的 QuickJS：
       - 首次：compile(规则体) → 缓存编译产物（按规则 id）
       - 每次：call(matchCommand, command) → bool
       - 任何异常 / 超时 / 超内存 → 按「未命中」处理（与生产环境 JS 抛错的既有语义一致）
```

**受限 runtime（必须项，不是可选项）**

| 措施 | 理由 |
|---|---|
| 不注入任何 host 函数（无 fs / 网络 / 计时器 / eval 逃逸面） | 规则体是用户代码，在**进程内**执行 |
| 内存上限 + 执行超时 | 防 `while(true)` / 大对象分配拖死 CLI |
| 每次求值结束销毁 context（仅缓存编译产物） | 防跨命令状态污染 |
| 规则 id → 编译句柄缓存 | 避免每条命令重编译 |

**位置**：`src-tauri/virlen-core/src/security/js_rule.rs`（**不进 `agent/`**），由 `native_tools/execute/common/rules.rs` 调用 ——
即「TS 引擎问 JS」与「Rust CLI 自己求值」两条路径**收敛到同一个判定函数**（铁律 1）。

**校验同步**：`compileSandboxRule` 的语义（能否编译）在两侧都要成立（GUI 用 `new Function`，CLI 用 QuickJS 编译阶段）；
⚠️ 二者对语法边缘特性（可选链、`??=`、顶层 await）的支持版本可能不同 → 见 §6 待定项。

### 4.3 依赖代价（已实测）

选定：`quickjs_runtime = { version = "0.18", default-features = false, features = ["quickjs-ng"] }`。
三项都必须写清楚，否则后来人会踩同一个坑：

**(1) 必须关掉默认特性（否则 +180 个 crate）**
`default = ["console", "setimmediate", "setinterval", "settimeout", "typescript", "bellard"]`，
其中 `typescript` 会拖进**整套 SWC**（`swc_ecma_*` / `swc_bundler` …）。实测对比：

| 特性集 | `Cargo.lock` 新增包 | 说明 |
|---|---|---|
| 默认（含 `typescript`） | **+180** | 我们只调用规则体的纯 JS 函数，不需要 TS 转译 |
| `default-features = false` + 引擎二选一 | **+29** | 见 `src-tauri/Cargo.toml` 的注释 |

**(2) 引擎必须选 `quickjs-ng`（默认的 `bellard` 在 Windows 编译不过）**
`hirofa-quickjs-sys` 把默认特性关了，所以必须显式二选一；而两个分支的 MSVC 兼容性不同：

- `bellard`（库的默认）：❌ **Windows MSVC 编译失败** ——
  `bellard/quickjs/cutils.h` **无条件**使用 GCC 内建且无 MSVC 分支
  （`#define __maybe_unused __attribute__((unused))`、`likely(x) = __builtin_expect(...)`），
  实测报 `libunicode.c(381): error C2143: 语法错误: 缺少")"`。
- `quickjs-ng`：✅ 通过 —— `quickjs-ng/quickjs/cutils.h` 带 `#if defined(_MSC_VER) && !defined(__clang__)`
  回退（`#define __attribute__(x)`、空 `__maybe_unused`）。

**(3) 构建期硬依赖 `libclang`（bindgen）**
`hirofa-quickjs-sys` 用 `bindgen` 生成绑定 → 需要 **libclang**：
- Windows：装 LLVM 并设 `LIBCLANG_PATH=<LLVM>\bin`（本机 `C:\config\LLVM\bin`，`libclang.dll` 83 MB）；
- macOS：Xcode CLT 自带；
- Linux：`libclang-dev`（CI 镜像需确认，见 §6 R4）。

  Windows 实测补充（2026-09 踩到，三点）：
  - `clang-sys` 只探测 `LIBCLANG_PATH` 与 `llvm-config.exe`，**不扫 `PATH`**：本机 LLVM 装在非标准位置
    `C:\config\LLVM` 且该发行版**不带 `llvm-config.exe`** → 无法自动识别，**必须**显式设 `LIBCLANG_PATH`；
  - 该变量须**持久化**（用户级环境变量）+ **重开终端**：临时 `$env:LIBCLANG_PATH` 只对当前 shell 生效，
    而 `pnpm tauri dev` 由 CLI 新起 shell 跑 `cargo run` → 表现为「手动 `cargo build` 通过、`tauri dev` 报
    `Unable to find libclang`」；
  - 该 bindgen 调用在 `hirofa-quickjs-sys/build.rs` 里**无条件**执行（无特性开关），**不能**用 feature 绕开。

**(4) 本机（Windows x86_64 MSVC）实测结果**

| 门禁 | 结果 |
|---|---|
| `cargo check` / `cargo build`（含静态库链接） | ✅ 通过 |
| `cargo test` | ✅ 343 passed / 0 failed / 2 ignored |
| `Cargo.lock` 变动 | 新增 29（含引擎 + bindgen 链）+ 3 个**仅构建期**依赖顺带升版（`cc 1.2→1.4`、`shlex 1.3→2.0`、`find-msvc-tools`）；已回滚 lockfile 后做**最小再解析**，避免无关的 `icu_*` 等运行时依赖被顺带升版 |

⚠️ **未验证**：macOS / Linux 的本机编译（本机只有 Windows 工具链，且项目多处依赖 C 交叉编译，`--target` 跨查不可行）。
验证路径：CI 的 `Build macOS` / `Build Linux` 工作流均支持 `workflow_dispatch`（可手动在分支上触发，不必打 tag）。

- 备选：`rquickjs`（同类绑定，无需 bindgen/libclang）。若某平台仍编译不过，可平移实现（外层只用到
  「runtime → eval 一个函数 → call」这几个 API）。

### 4.4 备选方案对比

| 方案 | `js` 规则在 CLI 下 | 代价 | 评估 |
|---|---|---|---|
| **内嵌 QuickJS**（选定） | ✅ 与 GUI 同结果 | 新依赖（C 编译）+ 用户代码进程内执行的攻击面 | 语义最完整；接受构建与安全代价 |
| 只支持 `text` + `regex` | ❌ `js` 规则在 CLI 下**忽略**（记警告） | 零新依赖 | **语义分叉**：同一条命令 GUI 命中、CLI 不命中 → 与铁律 1 冲突 |
| CLI 显式禁用 `js` 规则（启动报错） | ❌ | 零新依赖 | 「能跑起来」优先，但用户必须改配置 |
| CLI 侧用外部 JS 运行时（node/deno） | ⚠️ 依赖用户环境 | 不新增 Rust 依赖 | 与「纯 Rust CLI」的前提矛盾 |

---

## 5. 分阶段落地

| 阶段 | 内容 | 验收 / 状态 |
|---|---|---|
| **S1** | `app_settings` 表 + `SettingsRepo` + `cmd_settings_get_all/upsert/import` | ✅ **已完成**：`session_db/settings.rs` + `commands.rs` + `schema.rs` 建表；7 个 Rust 单测（写入/覆写/`import_if_empty` 幂等/逐键不丢/坏行退化/Noop）；`cargo test` 341 passed |
| **S2** | 前端 `settingsRepo` + `settingStore.hydrate()` + `main.ts` 引导步骤（首启从 localStorage 导入） | ✅ **已完成**：`infrastructure/settingsRepo/` + `settingStore.hydrateSettings()/flushSettingsPersist()` + `main.ts` 的 `step('settings')`（排最前）+ 退出前 flush；7 个前端契约测试；`vitest` 83 文件 / 1023 用例 |
| **S3** | 读源正式切换：以表为准（localStorage 仅初值/回滚信道） | ✅ **已完成**（含收尾）：读源随 S2 已是表；本轮清掉回滚信道 —— `settingStore` 的 `StorageState` 换只读适配器（Tauri 下 `setItem` 丢弃、表就绪后 `removeItem` 历史副本，非 Tauri 仍照写），3 处模块级迁移不再整份写回 localStorage；回归项 `src/tests/infrastructure/settings-local-snapshot.test.ts`（4 用例，模拟 Tauri） |
| **S4** | 引擎侧不再依赖前端下发：`init_session_db` / 引擎改为吃 `&dyn HostEnv`，CLI 可直读配置 | ✅ **已完成**：拆出 **零 `tauri::`** 的 `session_db::commands::open_session_db(host, spawn)` + `SessionDb{repo, settings, maintenance}`；`init_session_db` 降为 GUI 薄壳（README 的 `tauri::` 只留在这里与 `manage_noop_settings`）；新增 2 个 Rust 用例（库路径由 `host.data_dir()` 决定、GUI/CLI 同目录→同一份配置） |
| **S5** | `#17` web_* 原生化（依赖 S1–S4 提供 apiKey / 搜索源） | ✅ **已完成**：`src-tauri/virlen-core/src/agent/native_tools/web/{web_fetch,web_search,common}.rs`（新增依赖 `htmd`；搜索源配置经新增的 `NativeToolCtx::settings` **直读 `app_settings`** —— 不需要前端下发）；`is_native_tool` 由此成为**全集**（28/28，无桥接工具）；结果文本两侧共读 golden `src/tests/fixtures/web-search-format.golden.json`。门禁：`cargo test` 381 / `vitest` 1032 / `tsc` 0。⚠️ 已知差异：HTML→Markdown 细节（TS `cheerio+turndown` ↔ Rust 正则 + `htmd`）不保证逐字一致 |
| **S6** | CLI 子命令：`config get/set`（替代「手改 JSON」的易用性损失） | ✅ **已完成**（与 CLI 二进制落地同批）：`src-tauri/virlen-cli/src/{lib,config}.rs`；`config get [key …]` / `config set [--string] <key> <value>` / `config path`，值优先按 JSON 解析、失败按字符串；缺失键警告 + 退出码 1；12 个 Rust 单测（含真 SQLite 往返）。见 §5.1 |
| **S7** | `js` 规则内嵌求值 + **规则判定整体下沉 Rust**（§4） | ✅ **已完成**：`src-tauri/virlen-core/src/security/{rules,js_rule}.rs`（text / regex 原生 + js 受限 QuickJS 求值）+ `native_tools/execute/common/rules.rs` 本地判定 + `security::load_sandbox_ignore_rules`（CLI 读取入口）；规则来源下沉为 `app_settings.sandboxIgnoreRules`（**单一源**：localStorage 不再保存该字段；前端 `securityStore.hydrate()` 水合 + debounce 回写）；`sandbox_rule_check` 桥交互删除；两侧共读 golden `src/tests/fixtures/sandbox-rules.golden.json`。门禁：`cargo test` 372 / `vitest` 1025 / `tsc` 0 |

> S1/S2 是必须先做的；S7 可以晚于 S5（过渡期行为见 §6 待定项 1）。
>
> **当前进度：S1 ✅、S2 ✅、S4 ✅、S5 ✅、S7 ✅、S3 ✅（收尾已完成）。**
> localStorage 里的存量设置会在首次启动时整份导入 `app_settings`；之后读源已是表。
> S3 收尾进一步：**localStorage 不再保存设置副本**（Tauri 下写入被丢弃、表就绪后删掉历史副本），
> 密钥（`providers[].apiKey` / `searchProviders[].apiKey`）不再在 localStorage 重复存一份明文。
> 「忽略沙盒命令」规则更进一步：S7 起 **localStorage 完全不保存它**（单一源在表）——
> `load()` 在 Tauri 下只认内存快照（来自表），启动时的历史副本一次性迁进表后即从 localStorage 清除。
> **下一站 = 待定（S1–S7 与 CLI 二进制均已完成）。** S6（CLI `config get/set`）与 headless CLI 二进制已落地（见 §5.1）；剩余可选项见 §6 待定项。

### 5.1 CLI 落地形态（headless，已完成）

| 项 | 现状 |
|---|---|
| 二进制 | `virlen-cli`（`src-tauri/virlen-cli/src/main.rs`，三行转发）—— **独立 package，只依赖 `virlen-core`**（依赖树中无 tauri / wry / tao / tray-icon）；配置读写落在同一个 `virlen.db` 的 `app_settings` 表 |
| 实现 | `src-tauri/virlen-cli/src/lib.rs`（参数解析 / 帮助 / 版本 / 分派）+ `src-tauri/virlen-cli/src/config.rs`（`get` / `set` / `path`）；解析写成纯函数、输出走**注入的** `Write` → 12 个单测（含真 SQLite 往返、「path 不建库」、「另一个进程读同一目录」） |
| 库路径 | 复用 `virlen_core::session_db::open_session_db(&CliHost::from_env(), …)` —— 与 GUI **同一条**推导链（`host.data_dir()/virlen.db`），因此不存在「CLI 改的配置桌面端读不到」 |
| 目录覆盖 | `VIRLEN_DATA_DIR`（环境变量）> 默认 `<平台数据根>/JianWeichen.virlen`；`config path` 可直接核对与 GUI 是否同一份 |
| ⚠️ 连带要求 | `cargo test` 必须带 `--workspace`（拆包后裸 `cargo test` 只跑 `virlen-app`，会静默漏掉 core 的用例）；`[package] default-run = "virlen-app"` 保留为防御性声明 |
| 验证 | `cargo test --workspace` 395 passed / 2 ignored；`npx tauri build --no-bundle --debug --config <覆盖 beforeBuildCommand 的 json>` → 末行 `Built application at: …/virlen-app.exe`；`cargo tree -p virlen-cli` 无 tauri 系（比 GUI 少 94 个 crate）；CLI 端到端冒烟用临时 `VIRLEN_DATA_DIR`（不碰真实库） |
| 已落地（后续批次） | `run`（无界面跑一次 agent）、`list-session [-g agent\|workdir]`、`list-agent`（读 `app_settings.agents`）—— 实现同在 `src-tauri/virlen-cli/src/`（**core 不含命令入口**）；边界见 `docs/AGENTS.md` §11.15 / §11.16 |
| 尚未做 | `set` **不校验键名**（Rust 侧没有权威 schema，与 §6 R6 的「同名字段直接映射」一致）；没有 `unset` 子命令；交互式 `tui` 目前只有设计说明（规划中） |

---

## 6. 风险登记 / 待定项

| 项 | 级别 | 说明 |
|---|---|---|
| R1 并发写入 | 低 | 复用单写连接 + 事务；设置写入是短事务 |
| R2 GUI 与库双源不一致 | 中 | 设置：**S3 收尾后 localStorage 不再写**（Tauri 下写入丢弃、表就绪删历史副本），读源只有表 —— 回归项 `src/tests/infrastructure/settings-local-snapshot.test.ts`（4 用例，模拟 Tauri）与 `security-repo-settings.test.ts`（4 用例） |
| R3 密钥明文入库 | 中 | 库文件在用户数据目录、明文；**S3 收尾后 localStorage 不再重复保留一份**（少一处暴露面）。钥匙串另立项 |
| R4 新依赖的跨平台编译 | **中** | Windows 已实测通过（且**必须**用 `quickjs-ng`，见 §4.3）；macOS / Linux **未验证** → 落地 S7 前先手动触发 CI 的 `Build macOS` / `Build Linux`（都支持 `workflow_dispatch`），重点看两项：① `quickjs-ng` 的 C 源码编译；② Linux 镜像是否有 `libclang`（bindgen 需要） |
| R5 用户 `js` 规则拖死 CLI | 低 | ✅ 已实现（S7）：单次求值 200 ms 中断超时 + 16 MB 内存上限 + 512 KB 栈上限 + 「异常/超时即未命中」；每次求值新建 runtime（无状态残留）。⚠️ TS 侧（浏览器 `new Function`）**没有**超时保护，但那是既有行为且不在 CLI 路径上 |
| R6 配置与前端字段漂移 | 高 | 约定「同名字段直接映射」，不写映射表；**新增设置项时必须同时改 Rust 侧 schema 文档**（列入 PR 检查清单） |
| R7 库体积增长 | 低 | 配置量级是 KB，相对消息正文可忽略；「设置 → 存储」已能查看/整理 |

**待定项**

1. ~~**S7 之前 CLI 遇到 `js` 规则**~~ → **已消解**：S7 已实现内嵌求值，CLI 与 GUI 是同一个实现，不再需要过渡策略。
2. ~~**`js` 规则的语法子集**~~ → **已消解**：不额外限定语法子集，改由两侧共读的 golden 逐条对齐 TS `buildJsFunction`
   的 5 级宽容策略（function 声明 / 赋值式箭头 / 含 `return` / 单表达式 / 原样语句体）。
   已知差异只剩「Rust `regex` 不支持 lookaround → 按未命中」（安全侧）。
3. **是否把 `usage-ledger` / `security` 等其它配置一并纳入**：`security` 的「忽略沙盒命令」规则**已纳入**（S7，单一源在表）；`whitelist` / `blacklist` / `skipEachDirs` 与 `usage-ledger` 本期不做。
