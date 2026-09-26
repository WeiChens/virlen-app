# 宿主抽象（Host Abstraction）接口形状 — 设计 + 实施记录

> **状态：方案 A（资源定位 trait）已实施（2026-09）。**
> 目的：为 `vision_analyze`（以及后续任何需要「宿主能力」的工具）在 **headless CLI** 下可用，
> 同时**不破坏**「引擎核心（`src-tauri/virlen-core/src/agent/**`）零 `tauri::` 依赖」这条 CLI 前提。
> 关联：待办 #22-②、`docs/rust-engine.md` §8「宿主注入」、`docs/AGENTS.md` §5.1 / §5.2 / §5.6。

---

## 0. 实施记录（与草案的差异都写在这里）

| 项 | 草案 | 实际落地 |
|---|---|---|
| trait | `HostEnv { resource_candidates, data_dir }` | ✅ 一致（`src-tauri/virlen-core/src/agent/host.rs`） |
| 实现 | `TauriHost` / `CliHost` | ✅ 一致；**已拆包**（2026-09）：GUI 实现 `virlen-app/src/host/tauri_host.rs`、CLI 实现 `virlen-core/src/host/cli_host.rs`；实测 `tauri::` 命中只在 `tauri_host.rs`（3 处），`vision/` 与 `agent/**` 均为 **0** |
| 注入位置 | `AgentEngine::new` 构造期 | ✅ `AgentEngine.host` 字段 + `with_deps(..., host)`；`new` / `with_provider_factory` 默认用 `host::default_host()`（既有单测无需改） |
| 视觉分层 | `vision/mod.rs` 无 `tauri::` + `vision_service.rs` 薄壳 | ✅ 一致；`VisionState` / `setup_vision` **已删除**（引用计数改为 `vision::REFCOUNT` 进程级静态，CLI 同样可用） |
| 无注入点的路径 | （草案未提） | 新增 `host::default_host()`：只给 TS 引擎的 `pty_run_command` 这类拿不到 `AgentEngine` 的入口用（均为 CLI 语义） |
| `data_dir` 的消费方 | 本次即用 | 落地时暂无调用方（当时会话库仍自取 `app_data_dir()`）；**现已由 `session_db::open_session_db(host, …)` 消费**（见 `docs/config-sink-plan.md` §5 S4） |
| 顺带修掉 | （草案未提） | 模型**加载失败未回滚引用计数**的既存泄漏（失败后 refcount 永久 > 0 → 后续永不再尝试加载） |

验收：`cargo test` 334 passed / 0 failed（本轮 +15 用例）；`npx tsc --noEmit` exit 0；`npx vitest run` 82 文件 / 1016 用例。

> 2026-09 复校（core 拆包后）：`cargo test --workspace` **395 passed / 2 ignored**；`npx vitest run` 88 文件 / 1038 用例；`npx tsc --noEmit` 0 错误。


---

## 1. 问题取证（改造前的事实）

`vision_service.rs` 与宿主的耦合点**只有 5 处**且全在 `agent/` 之外：`use tauri::{AppHandle,
Manager}`、`resolve_models_dir(app)`（`resource_dir()` 定位模型，3 候选路径 + Windows `\\?\` 前缀）、
`load_models(app)`（进程级懒加载）、`setup_vision(app)`（启动初始化）、两个 `vision_analyze*` 命令
（`AppHandle` 入参）。**关键判断**：真正的推理（`quasivision`）不认识 Tauri，宿主依赖只在「**模型文件
在哪**」与「**何时初始化**」两件事上 → 只需抽象「**资源定位**」一项能力，不抽象「推理后端」（那会把
模型管理泄漏进引擎）。而「引擎核心零 `tauri::`」当时成立只是因为视觉这条链**根本没进 `agent/`** ——
一旦把 `AppHandle` 塞进 `native_tools/vision/`，前提立刻失效。

---

## 2. 设计目标 / 非目标

**目标**：① 引擎（`agent/**`）在「无 Tauri」环境下可编译可运行，宿主差异只以 **trait 对象**注入；
② GUI 行为与现状**完全等价**（资源目录探测顺序、模型懒加载语义、错误文案都不变）；③ 抽象**尽可能小**
（只放「引擎自己拿不到」的东西，能靠配置 / 环境变量表达的不进 trait）；④ 与既有注入风格一致
（`NativeToolCtx` 已有 `security` / `repo` / `skills` 三处，`host` 是第四处）。

**非目标**：不抽象「通知 / 托盘 / 窗口 / 剪贴板 / 拖放」等纯 GUI 能力；不引入 feature 分裂的默认路径
（见 §3-C，仅作可选加固）；本轮不改任何代码。

---

## 3. 候选形状对比

| 方案 | 形状 | 优点 | 代价 / 风险 | 结论 |
|---|---|---|---|---|
| **A. 资源定位 trait（推荐）** | `trait HostEnv { fn resource_candidates(&self) -> Vec<PathBuf>; fn data_dir(&self) -> PathBuf; }` | 切口最小；GUI/CLI 各一份实现；引擎只认 `PathBuf` | 需把 `resolve_models_dir` 改为「多候选 + 由调用方探测」 | ✅ 采纳 |
| **B. 推理后端 trait** | `trait VisionBackend { fn analyze(&self, img) -> Result<TreeText> }` | 理论上可换推理实现 | 把「模型加载 / 设备（DirectML/CoreML/CPU）/ 缓存」一并抬进引擎，抽象面积大十倍；CLI 也得自己实现一遍 | ❌ 过度设计 |
| **C. 编译期 feature 分离** | `#[cfg(feature = "gui")]` 才链接 tauri；`cargo build --no-default-features` 得 CLI | 结构性保证「CLI 二进制不含 GUI 依赖」 | 需要把 `lib.rs` 拆成 `main.rs`(GUI) + `cli.rs`；且同一 package 的多个 bin **共享同一套 feature**，只有显式 `--no-default-features` 才生效（默认构建仍链 tauri） | ✅ **已用「独立 crate」达成同一目标**（2026-09）：`virlen-core`（零 tauri）+ `virlen-cli`（独立 package，只依赖 core）；实测 `cargo tree -p virlen-cli` 比 GUI **少 94 个 crate**（452 vs 546）|
| **D. 独立 crate 拆分（实际采用）** | `virlen-core`（引擎/持久化/沙盒/安全/RAG/视觉/宿主抽象）+ GUI 壳 + CLI package | 编译器强制边界；CLI 的依赖树里根本没有 tauri | 搬 132 个文件 + 拆命令层 + telemetry/事件出口抽象；⚠️ 二进制体积收益很小（linker 本来就 DCE：实测 CLI 30.6MB → 29.1MB，约 −5%）| ✅ 采纳 |

> A 与 C **不互斥**：先做 A（把耦合点收敛到一处 trait），未来做 C 时只需替换实现与 `main` 入口。

---

## 4. 推荐方案：接口形状草案

### 4.1 trait（放 `src-tauri/virlen-core/src/agent/host.rs`，引擎核心内，**零 `tauri::`**）

```rust
/// 宿主提供的最小环境能力。
///
/// 只放「引擎自己拿不到」的东西 —— 路径来源。
/// ⚠️ 不要往里加「通知 / 窗口 / IPC」等 GUI 能力：引擎不需要知道它们的存在。
pub trait HostEnv: Send + Sync {
    /// 只读资源的**候选**目录（按优先级）。
    /// - GUI：`app.path().resource_dir()` → `[<res>, <res>/resources]`
    ///   （保留现状的两级探测 + Windows `\\?\` 前缀处理）
    /// - CLI：`$VIRLEN_RESOURCE_DIR` → 可执行文件同级 `resources/` → 编译期默认
    ///
    /// 返回候选而非直接返回目录：现状 `resolve_models_dir` 就是「多候选 + 探测存在性」，
    /// 把探测留给调用方可以**逐字保留**既有错误文案（含 Searched: 列表）。
    fn resource_candidates(&self) -> Vec<std::path::PathBuf>;

    /// 可写数据根（日志 / 运行快照 / 未来的配置下沉）。
    /// - GUI：Tauri `app_data_dir()`
    /// - CLI：`$VIRLEN_DATA_DIR` → `%APPDATA%/Virlen`（Win）/ `$XDG_DATA_HOME/virlen`（Unix）
    fn data_dir(&self) -> std::path::PathBuf;
}
```

**为什么是这两个方法**：`resource_candidates` 解开 `vision_analyze`（本轮的阻塞点）；`data_dir` 是
#E（配置下沉）的既有需求，且同属「宿主才知道」的信息 —— 一次收拢，避免二次改 trait。

### 4.2 两个实现（都在 `agent/` 之外）

GUI：`virlen-app/src/host/tauri_host.rs` 的 `TauriHost(tauri::AppHandle)`（**唯一允许出现 `tauri::`
的地方**，`resource_dir()` / `app_data_dir()`）；CLI / 单测：`virlen-core/src/host/cli_host.rs` 的
`CliHost`（由环境变量与 exe 位置推导）。

### 4.3 注入路径（与 `repo` / `security` 同风格）

| 注入点 | 值 |
|---|---|
| `AgentEngine::new(...)`（构造期，`Arc<dyn HostEnv>`） | GUI：`Arc::new(TauriHost(app.handle().clone()))`；CLI：`Arc::new(CliHost::from_env())` |
| `execute_tool_steps(...)` → `execute_single_step(...)` → `NativeToolCtx` | 新增字段 `pub host: &'a dyn HostEnv` |
| `vision_analyze` 原生工具 | `crate::vision::models_dir(ctx.host)` + 懒加载推理（进程级） |

> ⚠️ 不要用「全局单例 + `set_host()`」：那会让 CLI 与 GUI 的初始化顺序变成隐式依赖，
> 且单测无法并行。构造期注入是显式的、可测的。

### 4.4 视觉推理模块的归属

`vision_service.rs` 保留为 **GUI 命令壳**（`#[tauri::command]` + `AppHandle` 注入 `TauriHost`）；把
「模型定位 + 懒加载 + 推理调用」抽到 `virlen-core/src/vision/mod.rs`（**无 `tauri::`**，`models_dir(host)` /
`analyze(host, path)`）→ `native_tools/vision/vision_analyze.rs` 与命令壳**共用同一段实现**，不会出现
两份模型探测逻辑（铁律 1 的同精神）。

---

## 5. 迁移步骤（每步都可独立回归）

| 步 | 内容 | 状态 |
|---|---|---|
| S1 | 新增 `agent/host.rs`（trait）+ `host/tauri_host.rs`；`TauriHost` 内部复刻 `resolve_models_dir` 的探测与 `\\?\` 处理 | ✅ 已完成（探测留在 `vision::models_dir`，候选列表由 trait 给出 → 逐字保留原错误文案） |
| S2 | 抽出 `vision/mod.rs`（无 `tauri::`）；`vision_service.rs` 改为薄壳 | ✅ 已完成（实测 `src/vision` 的 `tauri::` 命中 = 0） |
| S3 | `NativeToolCtx` 增 `host`；`vision_analyze` 原生化（`native_tools/vision/`）+ 登记 `is_native_tool` | ✅ 已完成（+15 Rust 用例，覆盖「缺参 / 路径不存在 / 模型目录缺失」三条对齐分支） |
| S4 | （可选）CLI 入口与 feature 分离 | ⏸ **未做**（方案 C，按 §6-4 的结论推迟到 CLI 真正独立发布时） |

**规模预估**：S1–S3 约 5 个文件、200~300 行净增（不含测试），无事件契约改动。

---

## 6. 拍板结果（均已确认）

1. **trait 方法集**：就 `resource_candidates` + `data_dir` 两个 —— ✅ 按此实施（不纳入日志/网络，等真有第二个消费者再加）。
2. **注入位置**：`AgentEngine` 构造期注入（`Arc<dyn HostEnv>`）—— ✅ 按此实施；不用「全局单例 + set_host」。
3. **CLI 资源目录约定**：编译期根 → `$VIRLEN_RESOURCE_DIR` → `<exe_dir>/resources` → `<exe_dir>` —— ✅ 按此实施（编译期根打头是为了与现状/开发期逐字一致）。
   另：数据根约定为 `$VIRLEN_DATA_DIR` → `<平台数据根>/JianWeichen.virlen`，**与 GUI 同一目录**（同一个 `virlen.db`）。
4. **是否现在顺带做 feature 分离（方案 C）**：❌ 不做，推迟到 CLI 真正独立发布时（与 §5 S4 一致）。

---

## 7. 已知风险

| 风险 | 级别 | 说明 / 缓解 |
|---|---|---|
| CLI 侧模型文件缺失 | 中 | 现状 `resolve_models_dir` 已给「Searched:」列表；CLI 需文档说明「`resources/quasivision_models` 要随二进制分发」 |
| `AppHandle` 的 `Send + Sync` | 低 | Tauri 的 `AppHandle` 是 `Send + Sync + Clone`，可直接放进 `Arc<TauriHost>` |
| 抽象面积蔓延 | 中 | 约定：**trait 只增「引擎拿不到的信息」**，能进配置的不进 trait |
| 与 #E（配置下沉）撞车 | 低 | `data_dir()` 已被两者共用，先定形状可避免二次改动 trait |
