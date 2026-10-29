# Virlen MCP 支持方案（v1 设计稿）

> 目标：让 Virlen 像调用内置工具一样调用外部 **MCP（Model Context Protocol）服务器**的工具，并把「配一个服务器」变成设置页里的一次点击。
>
> 参考实现：`C:\code\github\deepseek-harness-master\packages\mcp\mcp-client`（下称 **dsh**）。本方案借用它的不变量（服务器限定命名、世代原子交换、重连预算、结果投影），但**不复用其 Cordis 插件体系与 TS 运行时**——本项目的引擎只有 Rust 一份。

---

## 0. 结论（TL;DR）

| 决定 | 内容 |
|---|---|
| 客户端放哪 | **Rust（`virlen-core/src/mcp`）**，GUI 与 headless CLI 共用 |
| 新增依赖 | **零**（手写 JSON-RPC 2.0 + 复用 `tokio` / `reqwest` / `serde_json`） |
| 配置存哪 | `app_settings.mcpServers`（与 `searchProviders` / `agents` 同一张表、同一份 CLI 可读配置） |
| 工具名 | `mcp__<serverName>__<rawName>`，超 64 字符 / 含非法字符时追加 12 位 SHA-256 前缀哈希 |
| 定义装配 | MCP 定义由 Rust 生成 → 前端 `cmd_mcp_tool_definitions` 取用 → 与契约合并后**由前端（GUI）/ CLI 各自装配**；白名单仍只有 `filterAllowedToolDefs` 一份实现 |
| 执行 | `tool_executor` 里按 `mcp__` 前缀分发到 `McpHost`，不再走 JS 桥 |
| 审批 | 每服务器三态 `allow / ask / deny`；`ask` 走既有 `request_user_interaction` 通道（类型 `confirm_mcp_call`），手机端经既有 approval 通道也能批 |
| 分期 | P0 协议层 → P1 工具桥 + 配置 UI → P2 审批 + 卡片 + 白名单 → P3 资源/指令/观测 → P4（可选）反向 MCP Server |

**一句话架构**：`Rust 持有连接与执行，TS 只做「配置 + 展示 + 白名单过滤」`。

---

## 1. 范围

### 1.1 v1 必须做（P0–P2）

1. 两种传输：**stdio**（本地子进程）与 **Streamable HTTP**（远端）。
2. `initialize` 握手（协议版本协商）、`tools/list`（含分页）、`tools/call`、`notifications/tools/list_changed` 重同步、`notifications/cancelled`。
3. 工具以 `mcp__<server>__<tool>` 暴露给模型，能被 Agent 白名单勾选、被轨迹检查器看到、被工具卡片渲染。
4. 设置页：增删改查 + 连接状态 + 工具清单 + 从 Claude Desktop 风格 JSON 导入。
5. 安全：默认不启用、`deny` 即不连接、stdio 子进程环境变量清洗、结果/参数大小上限、审批交互。
6. CLI 同源：`virlen-cli run/chat` 也能用同一批 MCP 工具。
7. 崩溃自愈：进程退出检测 + 指数退避重连 + 放弃后如实上报。

### 1.2 v1 不做（明确写进限制）

| 不做 | 原因 / 后续 |
|---|---|
| MCP **prompts**（斜杠模板） | 需要独立的用户选择机制，P4 之后再议 |
| **sampling / roots / elicitation** | 需要「服务器反向请求模型/用户」，会打穿现有交互模型，v1 明确拒绝并回 `MethodNotFound` |
| **OAuth 授权流** | 需要浏览器回调 + 令牌存储，v1 只支持手填 `headers`（Bearer / X-Api-Key） |
| 资源**订阅**（`resources/subscribe`） | v1 只做按需 `list` / `read`（P3） |
| stdio 服务器**沙盒化** | MCP 服务器是用户安装的第三方程序，需要完整文件/网络权限（详见 §7.4） |
| 反向 MCP **Server**（把 Virlen 工具暴露给别的客户端） | P4 可选，设计见 §15 |

---

## 2. 必须遵守的既有约束（决定了很多设计）

这些不是建议，是仓库里已经用测试固定住的规则，方案必须与它们共存：

| 约束 | 出处 | 对本方案的影响 |
|---|---|---|
| **引擎语义只在 Rust**（TS 引擎已移除） | AGENTS.md 铁律 1 / §11.37 | MCP 客户端必须用 Rust 写；TS 不能持有 stdio 子进程 |
| **工具定义只有一份权威源** | 铁律 5 / `tool-defs-contract.test.ts` | MCP 定义只能由 Rust 生成（`cmd_mcp_tool_definitions`），TS 不得手写第二份 |
| **`mcp__*` 不在 `definitions.json` 里** | 同上，`EXPECTED_TOOLS = 39`（三处：Rust `tool_defs` / `native_tools::NATIVE_TOOL_NAMES` / TS 契约测试） | 契约文件与「37」的断言**一个都不用改**；MCP 是**运行期动态定义**，与契约并列而非并入 |
| **白名单三态只有一份实现** | `domain/tools/allowed.ts` | MCP 工具与内置工具共用 `filterAllowedToolDefs`，不新写过滤逻辑 |
| **事件契约四方一致** | 铁律 2 | 若要新增 `AgentEventType`，TS 类型 / TS emit / Rust emit / chat-service 四处同步；MCP 状态事件改用**独立 Tauri 事件**，不塞进 `agent:event` |
| **新增 UI 文案必须同步 en-US.json** | 铁律 7 | §9.6 附完整文案清单 |
| **新命令必须注册 `generate_handler!`** | 铁律 4 | §10 列出全部命令 |
| **业务失败必须走 Error 通道** | `execute_command` 注释里反复强调 | MCP `isError:true` → `NativeToolOutcome::Error`（红色卡片 + 模型看到失败），绝不渲染成绿色成功 |
| **不新增依赖（本项目有一条 syn/bindgen 地雷）** | `virlen-core/Cargo.toml` 注释 | 见 §5.5：手写 JSON-RPC，不加 `rmcp` |

---

## 3. 架构总览

```
┌──────────────────────────── GUI（Tauri WebView, TS） ────────────────────────────┐
│  设置页 mcp-settings.tsx            Agent 编辑器           工具卡片 McpToolMessage │
│        │  invoke                      │ 读 toolRegistry              ▲              │
│        ▼                              ▼                              │              │
│  infrastructure/mcp/repo.ts ──► domain/tools（定义合并 + 白名单过滤）  │ uiData       │
└────────┼─────────────────────────────────┼────────────────────────────┼─────────────┘
         │ cmd_mcp_*                       │ agent_send_message(tool_defs)│ agent:event
         ▼                                 ▼                             │
┌──────────────────────────── virlen-app（Tauri 壳） ────────────────────┼─────────────┐
│ commands/mcp.rs（薄壳）            commands/agent.rs（引擎装配）       │             │
└────────┬─────────────────────────────────┬─────────────────────────────┼─────────────┘
         │                                 │                             │
┌────────▼─────────────────────────────────▼─────────────────────────────┴─────────────┐
│                        virlen-core（零 tauri::，GUI/CLI 共用）                        │
│  mcp::McpManager ── per-server Connection ── transport(stdio | http) ── jsonrpc       │
│      │  快照（tool defs / status / instructions）                                     │
│      │                                                                                │
│  agent::tool_executor ── is_mcp_tool(name) ? mcp::host().call(...) : native/bridge     │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 数据流（模型调用一次 MCP 工具）

```
LLM 返回 tool_calls[name="mcp__github__create_issue"]
  → execute_tool_steps：exec_path = "mcp"
  → mcp::host().call(server="github", raw="create_issue", args, ctx)
      ├─ 审批（approval=ask）→ bridge.request_user_interaction("confirm_mcp_call", …)
      │      └─ 前端 tool-service 弹窗 / 手机 approval 通道；拒绝 → NativeToolOutcome::Error
      └─ transport 发 tools/call（超时 + 可取消）
  → 结果映射成 NativeToolOutcome{ Value | Error } + uiData
  → 既有链路：tool_result 消息落库 → agent:event(tool_result_created) → 卡片渲染
```

### 3.2 为什么客户端必须在 Rust（而不是前端用 `@modelcontextprotocol/sdk`）

| 维度 | Rust（本方案） | 前端 TS SDK |
|---|---|---|
| stdio 子进程 | `tokio::process` + 既有 `ProcessTreeGuard`（Job Object 全杀），可控 | WebView 里没有 `child_process`；`tauri-plugin-shell` 只能拿行文本，做不了长驻双向 JSON-RPC |
| CLI 复用 | 天然可用（同一份 core） | 完全不可用（headless 无 WebView） |
| 与引擎的关系 | 引擎直接分发，不经过 JS 桥（少一次 IPC + 不依赖窗口存活） | 必须走 `agent:tool-request` 桥；窗口刷新/崩溃即断 |
| 依赖风险 | 零新依赖 | 引入 `@modelcontextprotocol/sdk` 及其整棵依赖树 |
| 长连接/重连 | `tokio` 任务 + 退避，容易做对 | 页面冻结（窗口最小化 > 5 分钟）会拖慢定时器 |
| 结论 | **选它** | 否决 |

---

## 4. 数据契约

### 4.1 配置（唯一持久化结构）

存储：`app_settings` 的 `mcpServers` 键（数组）。键名与 `SettingsStore` 字段同名同层（现有约定），CLI 直接读同一行。

```ts
// src/domain/mcp/types.ts —— 与 Rust McpServerConfig serde(camelCase) 一一对应
export interface McpServerConfig {
  /** 稳定 id（uuid），只用于 UI key / 重命名；公开工具名不用它 */
  id: string
  /** 命名空间：^[A-Za-z0-9_-]{1,32}$，全局唯一（大小写敏感） */
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'

  /** stdio */
  command?: string
  args?: string[]
  cwd?: string
  /** 合并到「清洗后的父环境」之上（显式覆盖永远优先） */
  env?: Record<string, string>

  /** http（Streamable HTTP） */
  url?: string
  headers?: Record<string, string>

  /** 三态：ask（默认）= 每次调用确认；allow = 直接执行；deny = 不连接、工具不下发 */
  approval: 'ask' | 'allow' | 'deny'

  /** 单次 tools/call 超时（默认 60000） */
  toolCallTimeoutMs: number
  /** 建连 + 首次 tools/list 超时（默认 30000；npx 冷启动经常 > 10s） */
  startupTimeoutMs: number
  /** 自动重连 */
  reconnect: { enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number }
  /** 只暴露这些工具（rawName 白名单，留空 = 全部） */
  enabledTools?: string[]
  /** 是否把服务器 instructions 注入系统提示词（P3） */
  injectInstructions: boolean
}
```

**默认值**（与 dsh 对齐，但更保守）：

```ts
export const DEFAULT_MCP_SERVER: Omit<McpServerConfig, 'id' | 'name' | 'transport'> = {
  enabled: true,
  approval: 'ask',
  toolCallTimeoutMs: 60_000,
  startupTimeoutMs: 30_000,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  injectInstructions: true,
}
```

迁移：新键不需要 `__schemaVersion` 升级（缺键 = 无服务器）。读取时一律过一遍 `normalizeMcpConfig()`（截断非法值、补默认、拒绝重名）——Rust 与 TS 各有一份**同语义**校验，校验规则由 §12.4 的共享 fixture 固定。

### 4.2 运行时状态（只读快照，不持久化）

```ts
export type McpServerState = 'disabled' | 'connecting' | 'ready' | 'backoff' | 'failed' | 'error'

export interface McpToolInfo {
  /** 公开名（mcp__server__tool） */
  name: string
  /** 服务器自己的名字（只用于 tools/call） */
  rawName: string
  description: string
  /** 已做过 schema 清洗（§4.5），可直接下发模型 */
  inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  id: string
  name: string
  transport: 'stdio' | 'http'
  state: McpServerState
  toolCount: number
  tools: McpToolInfo[]
  /** 服务器自称的 serverInfo（仅供展示，绝不用于命名） */
  serverName?: string
  serverVersion?: string
  connectedAt?: number
  /** 最近一次失败的原因（已脱敏：不含 env / header / 参数正文） */
  lastError?: string
  /** 重连进度：第几次 / 上限 */
  attempt?: number
  maxAttempts?: number
  /** stderr / HTTP 错误的尾部诊断（≤ 4 KB） */
  stderrTail?: string
}
```

### 4.3 公开工具名（稳定身份）

```rust
/// 模型可见名 = f(serverName, rawName)，纯函数；同一对输入永远同一名字。
/// - 干净情况：`mcp__<server>__<raw>` 原样返回；
/// - 发生替换或截断时追加 12 位 SHA-256(server\0raw) 十六进制前缀，
///   保证不同身份**绝不折叠**（会话历史 / 权限规则不会因改名失效）。
pub fn public_tool_name(server: &str, raw: &str) -> String
```

规则：

1. 字符集 `[A-Za-z0-9_-]`（三大 provider 的函数名交集）；非法字符 → `_`。
2. 上限 **64** 字符（OpenAI 契约）；超出 → `前 51 字符 + "_" + 12 hex`。
3. `raw` 名**只**用于 `tools/call`，绝不解公开名反推（服务器改名 → 新名字，旧名字自然消失）。
4. 同一服务器列出重名工具 → 整批拒绝（保留上一世代），不做「部分注册」。
5. 若算出的公开名撞上内置工具（理论上不可能，`mcp__` 前缀保留）→ 该服务器按 `error` 上报，不注册。

TS 侧同名实现 `publicToolName()` + `parseMcpToolName(name)`（拆 `server` / `raw`，用于卡片标题与分组）；两侧一致性由 §12.4 fixture 守住。

### 4.4 结果映射（`tools/call` → 模型 / UI）

| MCP content block | 给模型（`NativeToolOutcome`） | 给 UI（`uiData.blocks[]`） |
|---|---|---|
| `text` | 原样拼接（块间 `\n`） | `{type:'text', text}` |
| `image`（png/jpeg/webp/gif） | 落附件 → 走既有 `role = vision_image` 注入队列（`image_send::build_image_message`）；文本里插 `[image: image/png 12 KB]` | `{type:'image', mediaType, bytes, imageMessageId}` |
| `audio` / 未知 blob | `[audio unavailable: <mime>, <bytes> bytes]`（**不进上下文**） | `{type:'unsupported', ...}` |
| `resource_link` | `[resource_link: <name> <uri> (<mime>)]` | 同左 + 可点击 uri |
| `resource`（embedded） | 取 `text` 字段；二进制 → 诊断文本 | `{type:'resource', uri, mimeType}` |
| `structuredContent` | 追加 `\n\n[structured]\n<JSON>`（≤ 8 KB，超出截断并标记） | `{type:'json', value}` |
| 空 content | `(no content)` | — |

错误语义（与既有「失败必红」纪律一致）：

- `result.isError === true` → `NativeToolOutcome::Error { content: 文本, ui_data }`。
- JSON-RPC 错误 / 超时 / 连接断 → `Error`，文案固定英文（模型侧）：`MCP call failed (github.create_issue): <code> <message>`。
- 用户拒绝审批 → `Error("[User cancelled]")`（与 `execute_command` 一致，避免绿色成功）。
- 工具结果总长上限 **60 KB**（超长截断 + `… [truncated, N chars omitted]`）；参数总长上限 **256 KB**（超限直接以 Error 回模型，不打给服务器）。

### 4.5 JSON Schema 清洗（一次做对，三 provider 都吃得下）

MCP 服务器给的是**任意** JSON Schema，而本项目 `ToolParameters` 是简化子集：

```rust
// types.rs
pub struct ToolParameters {
    pub type_: String,
    pub properties: Value,
    pub required: Vec<String>,
    pub one_of: Option<Vec<RequiredSet>>,
    /// ⚠️ 透传其余 JSON Schema 关键字（$defs / allOf / anyOf / additionalProperties…）。
    /// 不加这一条，MCP 工具的嵌套 schema 会在**序列化给 provider 时被静默丢掉**。
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
```

`mcp::schema::sanitize(input_schema) -> ToolParameters` 做四件事：

1. 剥离 `$schema` / `$id`（Gemini / OpenAI 会拒）。
2. **内联本地 `$ref`**：只解析 `#/$defs/<k>`、`#/definitions/<k>`，深度上限 8；解析不了（远端 ref / 循环）→ 该节点降级为 `{"type":"object"}` 并保留原 `description`。
3. `required` 只保留 `properties` 里真实存在的键（OpenAI 严格模式会因为「required 指向不存在的属性」整请求 400）。
4. `type` 缺失时补 `object`；顶层非 object → 整个工具降级成 `{type:'object', properties:{}, additionalProperties:true}` + description 末尾追加一行「参数为自由格式，见工具说明」。

> ⚠️ 这三条是**真实故障源**而不是洁癖：MCP 生态里 `$ref` + `$defs`（Zod → JSON Schema 常见产物）和「required 里有已删字段」都很常见，任一命中就是「某台服务器一连上，整个对话请求 400」。

---

## 5. 传输层与协议

### 5.1 模块布局（`src-tauri/virlen-core/src/mcp/`）

```
mcp/
├── mod.rs            对外 API：attach / host() / definitions() / status() / is_mcp_tool_name()
├── config.rs         McpServerConfig（serde camelCase）+ 校验 + 环境清洗
├── naming.rs         public_tool_name / is_mcp_tool_name / 64 字符与哈希规则
├── schema.rs         §4.5 的 JSON Schema 清洗
├── jsonrpc.rs        Request/Response/Notification + id 生成 + 错误码映射 + 行帧切分
├── transport/
│   ├── mod.rs        trait Transport { request, notify, close, closed }
│   ├── stdio.rs      子进程 + 行帧 + stderr 环形缓冲 + ProcessTreeGuard
│   └── http.rs       Streamable HTTP（POST/SSE + Mcp-Session-Id + GET 流）
├── client.rs         单连接：initialize 握手 / tools list 分页 / call / 通知分发
├── connection.rs     监督器：世代、重连退避、失败预算、串行化同步
├── registry.rs       多服务器快照（epoch）+ 名字冲突检测 + 按会话可见集
├── bridge.rs         NativeToolOutcome 映射（§4.4）+ uiData + 图片投影
└── resources.rs      （P3）resources/list + read
```

### 5.2 stdio 传输

- 帧格式：**NUL 无关的换行分隔 JSON**（MCP 规定，不是 LSP 的 `Content-Length`）。读取器按 `\n` 切、单行上限 8 MB（超限 → 断开并报错，防 OOM）。
- Windows 陷阱（必做）：`npx` / `pnpm` / `uvx` 是 `.cmd` / `.bat` 垫片，`Command::new("npx")` 直接 `NotFound`。做法：`cfg(windows)` 下若解析不到 `.exe`，用 `cmd /C "<command> <args>"` 启动并复用 `PATHEXT`；错误信息里附「请把命令写成绝对路径或 `node`/`cmd` 形式」。
- 环境：`scrubbed_parent_env()` = 复制父环境后**删除**匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的键与所有 `VIRLEN_*`，再叠加配置的 `env`（显式覆盖保留）。理由：不能因为用户装了 MCP 服务器就把 `OPENAI_API_KEY` 送给它。
- 生命周期：`ProcessTreeGuard::create_kill_on_close()` 挂到连接上（应用退出 / 崩溃 → 内核连带杀，绝不留孤儿 node 进程）；`child.wait()` 在独立任务里 await，退出即触发 `closed` → 重连或 `failed`。
- stderr：独立任务读到环形缓冲（尾部 8 KB），只用于 UI 诊断与埋点（**不过模型上下文**、不含密钥）。

### 5.3 Streamable HTTP 传输

- `POST <url>`，`Accept: application/json, text/event-stream`，`Content-Type: application/json`；`initialize` 响应头里的 `Mcp-Session-Id` 记下，后续请求带上；`Mcp-Protocol-Version` 带协商结果。
- 响应两种形态都要支持：`application/json`（直接一个消息）与 `text/event-stream`（逐 `event: message` / `data:` 行解析，**分发到 pending 表**，直到 `id` 匹配）。
- 会话过期：POST 收到 `404`（或 `400` + 明确 session 失效）→ 丢弃会话 id、重新 `initialize`、重试一次。
- 服务端主动消息：连一条 `GET <url>`（`Accept: text/event-stream`，带 `Last-Event-ID`）；返回 `405` → 该服务器不支持服务端推送，工具列表变化只能靠重连或手动刷新（如实显示「不支持推送」）。
- 超时：请求级 `tokio::time::timeout`（`toolCallTimeoutMs` / `startupTimeoutMs`）；`403/401` 直接 `error`，文案提示检查 headers。
- 认证：只支持静态 `headers`；收到 `401` + `WWW-Authenticate: Bearer` 时提示「该服务器要求 OAuth，v1 请用 Personal Access Token 填到 headers」。

### 5.4 协议要点（手写 JSON-RPC 的全部清单）

| 方法 / 通知 | 方向 | 说明 |
|---|---|---|
| `initialize` | → | `protocolVersion` 依次尝试 `2025-06-18` → `2025-03-26` → `2024-11-05`；`capabilities: {}`；`clientInfo: {name:"virlen", version: env!("CARGO_PKG_VERSION")}` |
| `initialize` 响应 | ← | 用**服务器回的**版本（不认同则不匹配就断开并报错）；记 `serverInfo` / `instructions` / `capabilities` |
| `notifications/initialized` | → | 握手完成通知 |
| `tools/list` | → | 分页：带 `cursor`，最多 50 页（防死循环）；分页期间失败 → 整批失败（保留上一世代） |
| `tools/call` | → | `{name: rawName, arguments}`；`_meta` 不发送 |
| `notifications/tools/list_changed` | ← | 触发重同步（串行队列，见 §6.3） |
| `notifications/cancelled` | → | 用户点停止 / 超时后尽力发（`requestId` + `reason`） |
| `ping` | → | 连接健康检查（30s，失败 2 次判定断链） |
| `notifications/message`（logging） | ← | 丢弃或落 stderr 缓冲（不进模型） |
| 其余（`sampling/*`、`roots/*`、`elicitation/*`、`prompts/*`、`resources/subscribe`） | ← | 回 `-32601 MethodNotFound`（不假装支持） |

### 5.5 零新依赖的理由与兜底

- **不加 `rmcp`**：virlen-app 有一条实测地雷——新增依赖会让 `bindgen` 的 `syn` 从 2 重解析成 3，直接编译失败（`virlen-core/Cargo.toml` 顶部注释有记录）。手写只需要 `serde_json` + `tokio` + `reqwest`，都是现成的。
- SSE 解析需要 `futures_util::StreamExt`：`futures-util` / `bytes` / `tokio-util` **已在 `Cargo.lock` 里**（reqwest 的传递依赖），作为直接依赖声明不会新增编译单元——即便 re-resolve 触发了 syn 问题，按既有做法把 `Cargo.lock` 里 bindgen 的 `syn` 钉回 `2.0.117` 即可。
- JSON-RPC 手写量约 250 行（`jsonrpc.rs`），协议语义由 §12 的测试固定住，比引一棵依赖树划算。

---

## 6. 连接生命周期

### 6.1 状态机

```
disabled ──(enabled=true)──► connecting ──ok──► ready ──(断开/工具变更)──► connecting…
    ▲                            │                    
    └──(enabled=false)───────────┴─fail─► backoff ──(预算耗尽)──► failed ──(手动重连)──► connecting
                                             │
                                   approval=deny ⇒ 永不连接（disabled 语义）
```

- `ready`：`tools/list` 成功后**原子发布**新世代（先取完全部工具、再整体换；失败保留上一世代）。
- `backoff`：`initialDelayMs * 2^(n-1)`，上限 `maxDelayMs`；连续 `maxAttempts` 次失败 → `failed` 并**注销该服务器全部工具**（模型不再看到），UI 显示原因 + 「重连」。
- 预算重置：连接稳定存活超过 `maxDelayMs` 后清零（避免「偶尔抖一下就永久耗尽」）。

### 6.2 快照与可见性

```rust
pub struct Snapshot {
    /// 单调递增：每次成功同步 +1；前端用它判断「要不要 invalidate 定义缓存」
    pub epoch: u64,
    pub servers: Vec<ServerSnapshot>,   // 按 config 顺序（稳定 → 提示词前缀稳定）
    pub tools: Vec<ToolDefinition>,     // 契约外动态定义，按 (serverName, rawName) 排序
}
```

- 只包含 `enabled && state == ready`（或 `backoff` 且保留最后已知工具？→ **v1 选「保留最后已知工具」**：与 dsh 一致，断链期间调用会失败但模型仍看得到工具，界面标黄）。
- 排序固定 → KV cache 前缀稳定（§14 风险表）。

### 6.3 同步串行化

所有同步（首次 / `list_changed` / 重连）进同一条队列：

```
syncChain = syncChain.then(sync_once)   // 一次只有一个 sync 在跑
```

理由：两次 sync 交错会「先 dispose 别人的世代、再注册自己的」，出现双 dispose / 泄漏一半工具。dsh 在这个点上踩过（见其 `connection.ts` 注释），直接照抄结论。

### 6.4 退出与清理

- 应用退出 / 会话删除：**不**杀服务器（服务器是全局资源，与会话无关）；应用退出时 `kill_all()`（GUI 挂 `RunEvent::Exit`，CLI 挂 `run` 结束 + `ctrl-c`）。
- 单服务器删除 / 禁用：`dispose()` → 取消重连、关闭传输（stdio 杀进程树）、注销工具、等队列静止。

---

## 7. 安全与审批（这一节是评审重点）

### 7.1 六道闸

1. **默认不启用**：`mcpServers` 为空时零代码路径生效；引擎侧 `McpHost` 为 `Noop`（`is_mcp_tool_name` 永不命中）。
2. **首次启用警示**：设置页启用开关弹确认（复用现有 Modal），文案明确「该服务器将以你的身份读写文件、访问网络」。
3. **per-server 三态**：`allow`（直接执行）/ `ask`（每次确认，**默认**）/ `deny`（不连接、工具不下发）。
4. **stdio 环境清洗**：见 §5.2。
5. **大小上限**：参数 256 KB / 结果 60 KB / 单行 8 MB / instructions 32 KB。
6. **审计与埋点**：`mcp.server.connect|disconnect|error`、`mcp.tool.call`（只记 `server` / `tool` / `duration_ms` / `status`，**不记参数与结果正文**）。

### 7.2 审批交互（复用既有通道，不发明新通道）

Rust（`mcp/bridge.rs`）：

```rust
let payload = ctx.bridge.request_user_interaction(
    ctx.sink, ctx.session_id,
    "confirm_mcp_call",
    json!({
        "permName": format!("mcp.{}.call", server),   // 稳定 key，UI 据此 i18n
        "title":       "MCP 工具调用",
        "subTitle":    format!("{} · {}", server, raw),
        "desc":        json_args_pretty,              // 参数正文（限 4 KB）
        "hint":        "该调用会交给外部 MCP 服务器执行，可能读写文件或访问网络",
        "risk":        "dangerous",                   // 恒判高风险：MCP 不在本机权限模型内
        "toolCallId":  ctx.tool_call_id,
        "serverName":  server,
        "toolName":    raw,
    }),
    ctx.cancel,
).await?;
```

前端（`src/services/tool-service/`）：

- 新增 `mcp_confirm.ts`（结构照抄 `command_confirm.ts` 的 `PendingSlots` 多槽机制，但**不执行任何东西**，只回 `allow` / `cancel` / `shelve`）。
- `index.ts` 路由加 `if (type === 'confirm_mcp_call')`。
- 同时 `toolInteractEvent.emit('showAuthorization', …)` → 手机端 `interaction-source.ts` 的既有 `showAuthorization` 监听自动把它登记成 `authorization` 交互，**手机端代码零改动**即可审批（`classifyApproval` 对未知 `permName` 一律 `high` → 手机批准前需二次确认，正是我们要的从严）。
- 若希望手机侧显示成「低摩擦」，在 `approval-policy.ts` 的 `KNOWN_PERMS` 登记 `mcp.tool.call`；v1 **不登记**（保持从严）。

`deny` 与「请求被拒绝」的区别必须体现在消息里：

| 情形 | 结果 |
|---|---|
| 配置 `deny` | 工具根本不下发（模型看不到） |
| 用户本次点「拒绝」 | `Error("[User cancelled]")`，卡片红色 |
| 运行被取消（点停止） | 同上（既有 `Cancelled` 分支） |

### 7.3 提示注入面

- 服务器 `instructions`、工具 `description`、工具结果全部**视为不可信文本**：注入系统提示词时加归属前缀 `## MCP server "<name>"`（P3）；工具结果按「外部内容」处理（模型侧已有「工具结果可能是不可信内容」的纪律，见 `tool-call-spec.md`）。
- 绝不把 MCP 文本拼进「权限判定 / 提示词开关」这类**决策位**。

### 7.4 为什么不给 stdio 服务器套沙盒

- MCP 服务器的**职责**就是访问本机文件 / 网络（`filesystem` / `git` / `sqlite` / `playwright`…），套上现有写隔离沙盒等于让它必然失败。
- 它和 `execute_command` 的风险模型不同：命令是**模型生成的**（要在沙盒里跑），MCP 服务器是**用户安装的**（等价于用户自己装了一个程序）。
- 因此防护靠「显式启用 + 审批 + 环境清洗 + 可审计」，而不是沙盒——这条必须写进 UI 提示与文档，避免用户误以为「Virlen 的沙盒也管着它」。

---

## 8. 引擎接入（Rust 改动清单）

### 8.1 `agent/tool_executor.rs`

```rust
// 1) 执行路径标记（埋点 / 轨迹诊断用）
let exec_path = if mcp::is_mcp_tool_name(&step.tool_name) && mcp::host().is_ready() {
    "mcp"
} else if security.is_some() && native_tools::is_native_tool(&step.tool_name) {
    "native"
} else {
    "bridge"
};

// 2) execute_single_step 里最前面加分发（不看 security：MCP 的决定来自自身配置）
if mcp::is_mcp_tool_name(&step.tool_name) {
    return mcp::bridge::call_mcp_tool(&step.tool_name, &step.input, /* ctx */).await;
}
```

注意点：

- **不能**把 MCP 名字加进 `NATIVE_TOOL_NAMES`（那是 `[&str; 39]` 的静态数组 + 契约守卫测试）。走独立前缀判定。
- `security == None`（JS 桥回退模式）时 MCP 仍应工作；反之 `mcp::host()` 未装配时命中 `mcp__` 前缀要**明确报错**（`Error("MCP support is not available in this host")`），不能静默转给 JS 桥（那里永远找不到执行器）。

### 8.2 `agent/types.rs`

- `ToolParameters` 加 `#[serde(flatten)] extra`（§4.5）。
- 无新增 `AgentEventType`（MCP 状态走独立 Tauri 事件）。

### 8.3 `mcp/mod.rs` 的装配（沿用既有全局 attach 风格）

```rust
/// 与 `attach_service_notice_host` / `attach_output_host` 同一套：宿主启动时挂一次。
pub fn attach(host: Arc<dyn McpHost>);
/// 未挂载时返回 Noop（定义为空、call 直接报错），测试与无 MCP 的宿主零负担。
pub fn host() -> &'static dyn McpHost;
```

理由：`execute_tool_steps` 已经 12 个参数（`#[allow(too_many_arguments)]`），再加一条要穿透 5 层调用链；全局 attach 是本仓库已有的成熟做法，且 CLI 与 GUI 的差异天然收敛到「注入什么」。

### 8.4 多服务器管理器（`registry.rs` / `connection.rs`）

- `McpManager::new(configs, deps)` → `Arc<McpManager>`；每个 `enabled` 服务器一个 `tokio::spawn` 的 actor（命令通道 + 事件通道）。
- `McpManager` 实现 `McpHost`：`definitions()`（读快照，同步、无锁竞争：`ArcSwap` 风格用 `RwLock<Arc<Snapshot>>`）、`status()`、`call()`、`reload(configs)`（diff：名字/传输没变则原地重连，否则新建）、`kill_all()`。
- 变更后 `emit("mcp:changed", {epoch})` + `emit("mcp:status", snapshot)`（由 Tauri 壳的 `McpEventSink` 实现，core 不碰 `tauri::`）。

### 8.5 定义装配（GUI 走前端，CLI 走自己）

```ts
// src/infrastructure/tools/definitions-source.ts（扩展，不改契约分支）
export async function loadToolDefinitions(): Promise<ResolvedToolDefinition[]> {
  const builtin = /* 现有逻辑：Tauri → cmd_list_tool_definitions；否则内嵌契约 */
  return [...builtin, ...(await loadMcpToolDefinitions())]   // 非 Tauri → []
}
```

- `loadMcpToolDefinitions()` = `invoke('cmd_mcp_tool_definitions')`，失败只 `console.warn` 并返回 `[]`（服务器挂了不能让聊天不可用）。
- 顺序：内置（契约顺序）在前，MCP 按 `(serverName, rawName)` 排序在后 → 前缀稳定。
- `cmd_mcp_tool_definitions` 必须**立刻返回当前快照**（可空），绝不等待连接完成——否则启动会被 `npx` 冷启动拖死（§13 的验收项）。
- `mcp:changed` → 前端 `toolRegistry.invalidateDefinitions()` + 通知 Agent 编辑器/轨迹视图重读。

### 8.6 白名单与分类

- 过滤：不新增逻辑。`filterAllowedToolDefs(defs, session.allowedTools)` 已能处理任意名字。
- **陷阱**：`allowedTools` 是「穷举白名单」时（Agent 编辑器保存的就是穷举列表），存量 Agent 不会自动包含新 MCP 工具 → 用户在设置页连了服务器却「模型看不到」。缓解：
  1. 编辑器里 MCP 工具按「动态分组」呈现（见 §9.3），保存时一并写入；
  2. MCP 设置页对每个服务器显示「已被 N 个 Agent 启用」计数，0 时给出提示链接；
  3. 文档 + 新增默认 Agent 时把已有 MCP 工具勾上。
- `TOOL_CATEGORIES` **不加** `mcp` 静态项（`tools-category.test.ts` 断言 12 个分类，且分类与 `definitions.json` 一一对应）。分组在编辑器内**动态计算**。
  > ⚠️ P3 已修订：动态 `mcp__*` 仍不进静态表，但**两个资源工具**（`list_mcp_resources` / `read_mcp_resource`）是静态内置工具，必须有自己的 `mcp` 分类（见文末 P3 §3.6 偏差 2，分类数 12 → 13）。

---

## 9. 前端改动清单

### 9.1 新增 domain（纯逻辑，可测）

```
src/domain/mcp/
├── types.ts        McpServerConfig / McpServerStatus / McpToolInfo（§4）
├── naming.ts       publicToolName / parseMcpToolName / MCP_PREFIX
├── config.ts       normalizeMcpConfig（补默认 / 校验 / 重名 / 与 Rust 同语义）
└── index.ts
```

### 9.2 新增 infrastructure

```
src/infrastructure/mcp/
├── repo.ts         invoke 封装：list / upsert / remove / reload / definitions / status / test
└── events.ts       订阅 'mcp:changed' / 'mcp:status'，转发到 ui/store/mcpStore
```

### 9.3 UI

| 文件 | 改动 |
|---|---|
| `ui/pages/Settings/mcp-settings.tsx` + `.scss` | 服务器列表（状态胶囊 / 工具数 / 启停 / 审批档）、空态引导、导入 JSON、删除确认 |
| `ui/pages/Settings/mcp-edit-modal.tsx` + `.scss` | 传输切换、stdio 字段（命令 / 参数 / 工作目录 / env 键值编辑器）、http 字段（URL / headers）、审批三态、超时、工具白名单、「测试连接」 |
| `ui/pages/Settings/settings-view.tsx` | 注册 `mcp` 页 + 图标 + 导航项 |
| `ui/store/mcpStore.ts` | `mobx` 状态：`servers` / `statuses` / `loading`，`hydrate()` 读 `appSettings.mcpServers` + 拉状态 |
| `ui/pages/Settings/agent-edit-modal.tsx` | `groupedTools` 增加动态分组：`name.startsWith('mcp__')` → 按 `server` 分组，标题 `MCP · <server>` |
| `ui/pages/chat/components/tool-call/McpToolMessage.tsx` | 新卡片：标题 `server · tool`、短文本取首个 text 块首行、展开渲染文本 + 图片 + JSON 折叠 |
| `ui/pages/chat/components/tool-call/IToolCallMessage.ts` | `getToolCallMessage()` 兜底改为：`mcp__` 前缀 → `McpToolMessage`（其余仍 `DefaultMessage`） |
| `src/services/tool-service/index.ts` + `mcp_confirm.ts` | `confirm_mcp_call` 路由 + 授权弹窗 |
| `src/ui/store/settingStore.ts` | `SettingsStore` 加 `mcpServers: McpServerConfig[]` + 默认 `[]` + 持久化（`app_settings`） |

### 9.4 定义的合并与失效

```
启动：setToolDefinitionsLoader(loadToolDefinitions) → toolRegistry.init()
      （loadToolDefinitions 内部已合并 MCP 快照）
mcp:changed → toolRegistry.invalidateDefinitions() → 下一次读取拿到新集合
```

⚠️ `toolRegistry` 的 `missingExecutorNames()` 会把 MCP 工具报成「有定义无执行器」（GUI 里没人用，但测试用它）。加一行排除 `mcp__` 前缀并写注释：「MCP 工具由 Rust 执行，不进 JS 注册表」。契约测试（`tool-defs-contract.test.ts`）不跑 Tauri 分支 → MCP 为空 → 现有断言不受影响。

### 9.5 手机端

- **零改动**（审批经 `showAuthorization` 既有通道）。
- 验证项：① 手机能收到 MCP 审批并批准 / 拒绝；② 手机侧 `desc` 是参数 JSON（已限 4 KB）；③ 终态同步（电脑拒绝 → 手机卡片收起）。

### 9.6 i18n 文案清单（全部写进 `src/ui/i18n/lang/en-US.json`，中文即 key）

```
MCP 服务器 / 添加服务器 / 编辑服务器 / 服务器名称 / 传输方式 / 标准输入输出（本地进程） / HTTP（远端）
命令 / 参数（每行一个）/ 工作目录 / 环境变量 / 请求头 / 审批方式 / 每次调用都确认 / 直接执行 / 禁用
单次调用超时（毫秒）/ 启动超时（毫秒）/ 自动重连 / 只暴露这些工具（留空为全部）/ 测试连接
正在连接… / 已连接 · $__count__ 个工具 / 连接失败 / 已禁用 / 重连中（$__current__/$__max__）/ 重连
从 JSON 导入 / 粘贴 mcpServers 配置 / 导入成功 / 导入失败：$__reason__
MCP 工具调用 / 该调用会交给外部 MCP 服务器执行，可能读写文件或访问网络
启用后该服务器将以你的身份读写文件、访问网络。只添加你信任的服务器。 / 仍要启用 / 取消
MCP 服务器已连接，但当前 Agent 未勾选它的工具 / 去勾选
工具参数 / 结构化结果 / 暂无详情 / 图片（$__mime__ · $__size__）/ 该结果块不受支持
服务器说明 / 不支持服务端推送（工具列表变化需重连）
```

---

## 10. Tauri 命令与事件

`src-tauri/src/commands/mcp.rs`（薄壳，全部转发 core）：

| 命令 | 入参 | 返回 |
|---|---|---|
| `cmd_mcp_list` | — | `{ configs: McpServerConfig[], statuses: McpServerStatus[], epoch: number }` |
| `cmd_mcp_upsert` | `{ config }` | `{ ok, warnings? }`（立即落 `app_settings` 并 reload） |
| `cmd_mcp_remove` | `{ id }` | `{ ok }`（dispose + 落库） |
| `cmd_mcp_set_enabled` | `{ id, enabled }` | `{ ok }` |
| `cmd_mcp_reload` | `{ id? }` | `{ ok }`（手动重连；无 id = 全部） |
| `cmd_mcp_tool_definitions` | — | `ResolvedToolDefinition[]`（当前快照，同步返回，**不等连接**） |
| `cmd_mcp_status` | — | `McpServerStatus[]` |
| `cmd_mcp_test` | `{ config }`（未保存的草稿） | `{ ok, toolCount, tools[], error? }`（临时连一次再 dispose，用于「测试连接」） |
| `cmd_mcp_import` | `{ json }` | `{ imported: number, skipped: [{name, reason}] }` |

事件（`app.emit`）：

| 事件 | 载荷 | 消费方 |
|---|---|---|
| `mcp:changed` | `{ epoch: number }` | `definitions-source` 失效缓存 + `mcpStore` 重拉 |
| `mcp:status` | `McpServerStatus[]` | `mcpStore`（状态胶囊 / 工具清单实时刷新） |

注册：`lib.rs` 的 `tauri::generate_handler![...]` 追加（铁律 4）。自定义命令不需要 capability（项目内已有先例，如 `read_file_with_hash`）。

---

## 11. CLI 支持

- `virlen-cli/src/session_rt/resources.rs`：`tool_defs` 装配处追加

  ```rust
  let mut tool_defs = if enable_tools { tool_defs::list_tool_definitions() } else { vec![] };
  if enable_tools && !cmd.no_mcp { tool_defs.extend(mcp::host().definitions()); }
  ```

- `virlen-cli/src/run|tui`：启动时按 `app_settings.mcpServers` 建 `McpManager` 并 `mcp::attach(...)`；结束（含 `ctrl-c`）时 `mcp::host().kill_all().await`。
- 新增开关 `--no-mcp`（与 `--no-tools` 同风格）。
- `pnpm cli config get` 会自然带出 `mcpServers`（同一张表）——顺手在 `config get` 里掩码 `env` / `headers` 的值（避免终端回显密钥）。

---

## 12. 测试与验证

### 12.1 Rust 单测（`virlen-core/src/mcp/**` 内联 `#[cfg(test)]`）

| 用例组 | 覆盖 |
|---|---|
| naming | 干净名 / 非法字符 / 超 64 / 非 ASCII / 同 raw 不同 server 不折叠 / 哈希稳定（golden 值） |
| config | 缺字段默认值 / `serverName` 非法 / 重名 / transport 与字段不匹配 / env 清洗（TOKEN、VIRLEN_* 被删，PATH 保留） |
| schema | `$ref` 本地内联 / 远端 ref 降级 / `required` 指向不存在属性被清 / `$schema` 剥离 / 顶层非 object 降级 |
| jsonrpc | 行帧切分（半分包 / 多消息一行 / 超长行拒绝）/ id 关联 / 错误码映射 / 通知无 id 不产生 pending |
| client | initialize 版本回退 / tools/list 分页（3 页）/ 重复 rawName 整批失败 / `isError` → Error / 图片块 → vision 队列 |
| connection | 世代原子交换（sync 失败保留上一世代）/ 两次 sync 不交错 / 退避序列 `[500,1000,2000…]` / 预算耗尽注销 / 稳定期后预算清零 |
| 夹具 | **stdio 用「测试二进制自我 re-exec」**：`#[cfg(test)]` 下若 `VIRLEN_MCP_FIXTURE` 存在则跑一个手写 MCP echo 服务器（零外部依赖，CI 可跑）；HTTP 用 `tokio::TcpListener` 手写一个最小 HTTP/1.1 + SSE 夹具 |

### 12.2 前端单测（`src/tests/**`）

| 文件 | 覆盖 |
|---|---|
| `tests/domain/mcp-naming.test.ts` | `publicToolName` / `parseMcpToolName` / 与 Rust fixture 对拍 |
| `tests/domain/mcp-config.test.ts` | `normalizeMcpConfig` 三态默认 / 非法值截断 / 重名拒绝 |
| `tests/infrastructure/mcp-definitions.test.ts` | `loadToolDefinitions` 合并（mock invoke：37 + 2）/ 非 Tauri 只有 37 / `cmd_mcp_tool_definitions` 失败降级 |
| `tests/domain/tool-allowed.test.ts`（扩展） | 白名单里含 `mcp__*` 的过滤结果 |
| `tests/ui/mcp-tool-card.test.tsx`（轻量） | `mcp__*` → `McpToolMessage`；`isError` 渲染为红 |

### 12.3 契约守卫（新增 / 扩展）

- `src/tests/contracts/mcp-naming-contract.test.ts`：读 `src-tauri/virlen-core/src/mcp/naming_fixtures.json`（`[{server, raw, expected}]`），TS 与 Rust 两侧都断言同一份 → 命名算法不会两边漂移。
- `tool-defs-contract.test.ts`：**不改**（MCP 不在契约里）；补一条注释说明「`mcp__*` 为运行期动态定义，由 MCP 契约测试单独守」。

### 12.4 手工验收脚本（写进 PR 描述）

1. **stdio 冒烟**：`@modelcontextprotocol/server-filesystem`（`npx -y ...`）→ 连接 3s 内 ready、工具数 > 0、`read_file` 调用成功。
2. **Windows 垫片**：命令填 `npx`（不带 `.cmd`）也能起（§5.2 的 `cmd /C` 分支）。
3. **禁用即不可见**：`deny` → 模型工具列表里没有该服务器任何工具（轨迹检查器可核对）。
4. **审批**：`ask` → 桌面弹窗 / 手机卡片都能批；拒绝后卡片红、模型收到 `[User cancelled]`。
5. **断链自愈**：kill 掉服务器进程 → UI 进 `backoff` → 自动重连后工具恢复；连续杀 11 次 → `failed` + 手动重连可用。
6. **工具清单变更**：服务器 `list_changed`（如 filesystem 加目录）→ 新工具在当前会话下一轮就能看到（`mcp:changed` → invalidate）。
7. **不影响启动**：配 3 个服务器（其中一个 URL 指向黑洞）→ 冷启动到窗口显示的时间与不配时无显著差异（验证「不等连接」）。
8. **CLI**：`pnpm cli run "用 mcp 的 server-filesystem 列出当前目录"` 能跑通。
9. **孤儿进程**：退出应用后任务管理器里没有残留 `node`/`npx`。
10. **Gemini 兼容**：配一个 `$ref` 重的服务器，切 Gemini 模型发一条消息不 400。

### 12.5 门禁命令（照 §7 基线）

```powershell
npx tsc --noEmit
pnpm test                      # 视改动范围可先跑受影响文件
cd src-tauri
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace         # ⚠️ 必须 --workspace
```

---

## 13. 分阶段实施计划

> 预估按 1 名熟悉本仓库的开发者（含测试与自测），不含评审等待。

### P0 协议层（2–3 天）

| # | 任务 | 交付 / 验收 |
|---|---|---|
| 0.1 | `mcp/` 骨架 + `config.rs` / `naming.rs` / `schema.rs` + 单测 | 三个模块单测全绿；fixture 与 TS 对拍（先建 fixture） |
| 0.2 | `jsonrpc.rs`（行帧 + id + 错误映射）+ 单测 | 半分包 / 超长行 / 并发 id 用例通过 |
| 0.3 | `transport/stdio.rs`（含 Windows `.cmd`、env 清洗、stderr 环、ProcessTreeGuard）+ 自 re-exec 夹具 | 夹具服务器能跑通 initialize + tools/list |
| 0.4 | `client.rs`（握手 / 分页 / call / 通知）+ 单测 | 版本回退、分页、`isError` 全绿 |
| 0.5 | `transport/http.rs` + TCP 夹具 | POST/JSON 与 POST/SSE 两种响应都能跑通；404 重建会话 |

**P0 出口**：能在 Rust 测试里连上一个、两个传输，列出并调用工具；此时**还没有**任何 UI/引擎改动。

### P1 引擎接入 + 配置 UI（—— ✅ 已完成，见 §18）

| # | 任务 |
|---|---|
| 1.1 | `registry.rs` / `connection.rs`（快照、世代交换、重连） + `McpHost` 全局 attach + `Noop` |
| 1.2 | `tool_executor` 分发（`exec_path = "mcp"`）+ `ToolParameters.extra` |
| 1.3 | `commands/mcp.rs` + `lib.rs` 注册 + `McpEventSink`（`mcp:changed` / `mcp:status`） |
| 1.4 | TS：`domain/mcp/*`、`infrastructure/mcp/*`、`definitions-source` 合并、`mcpStore` |
| 1.5 | 设置页 `mcp-settings` + `mcp-edit-modal`（含「测试连接」、JSON 导入） |
| 1.6 | CLI：装配 + `--no-mcp` + 退出清理 |
| 1.7 | 前端单测（naming / config / 定义合并） |

**P1 出口**：能配一个 stdio 服务器，模型在一轮对话里成功调用它的工具并看到结果（审批暂时恒 `allow` 也行，但代码里已是三态）。

### P2 审批 + 卡片 + 白名单（✅ 已完成，见文末「P2 实施状态」）

| # | 任务 |
|---|---|
| 2.1 | `bridge.rs` 审批路径 + `mcp_confirm.ts` + `tool-service` 路由 + 手机端验证 |
| 2.2 | `McpToolMessage.tsx` + `getToolCallMessage` 前缀兜底 + 图片/JSON 展开 |
| 2.3 | Agent 编辑器动态分组 + MCP 设置页「未被任何 Agent 启用」提示 |
| 2.4 | i18n 全量补齐 + `toolRegistry.missingExecutorNames` 排除 `mcp__` |
| 2.5 | 踩坑回填：`docs/AGENTS.md` 新增 `§11.68 MCP`（进程/垫片/审批）或写进 `docs/mcp.md` |

**P2 出口**：§12.4 的 1–9 条手工验收全过。

### P3 资源 / 指令 / 观测（✅ 已完成，见文末「P3 实施状态」）

| # | 任务 |
|---|---|
| 3.1 | `resources/list` + `resources/read` → 两个新内置工具 `list_mcp_resources` / `read_mcp_resource`（走 §9.1 的「新增工具」完整清单：`definitions.json` ×3、`NATIVE_TOOL_NAMES` 37→39、`EXPECTED_TOOLS`、`TOOL_CATEGORIES`、卡片、CLI 测试、README/文档） |
| 3.2 | 服务器 `instructions` 注入（`mcp::instructions_block()`，GUI 在 `compose-prompt.ts` 末尾追加、CLI 在 `build_system_prompt` 末尾追加，32 KB 上限 + 归属前缀） |
| 3.3 | 观测：状态面板显示 stderr 尾部 / 失败原因 / 重连次数；埋点补齐 |

### P4（可选）反向 MCP Server（2–3 天）

见 §15。

---

## 14. 风险登记表

| # | 风险 | 触发条件 | 处理 |
|---|---|---|---|
| 1 | **编译卡死（syn/bindgen）** | 在 `virlen-core/Cargo.toml` 新增依赖后 `cargo build` | 本方案零新依赖；若必须加 `futures-util` 等已在锁文件中的 crate 而 re-resolve 触发问题 → 按既有做法把 `Cargo.lock` 的 `syn` 钉回 `2.0.117` |
| 2 | Windows 上 `npx` 起不来 | 用户填裸命令名 | §5.2 的 `cmd /C` 分支 + 报错里给可操作提示 |
| 3 | `npx` 冷启动 10–30s 拖慢体验 | 首次连接 | 连接在后台跑；`cmd_mcp_tool_definitions` 立即返回；UI 显示「正在连接…」；`startupTimeoutMs` 默认 30s 可调 |
| 4 | MCP schema 让某个 provider 400 | 服务器用 `$ref` / `$defs` / required 失配 | §4.5 清洗 + §12.4 第 10 条验收 |
| 5 | 工具列表中途变化 → 模型调用已消失的工具 | `list_changed` / 重连 | 调用时按快照二次校验，缺失则明确 Error（不静默重试） |
| 6 | KV cache 抖动 | 工具顺序不稳 / 频繁重同步 | 排序固定（server, raw）；同步只在变化时发布；提示词前缀不变 |
| 7 | 输出爆炸（服务器回 100 MB） | 恶意 / 有 bug 的服务器 | 单行 8 MB 硬断 + 结果 60 KB 截断 + 参数 256 KB 限制 |
| 8 | 孤儿进程 | 应用崩溃 / 强制退出 | `ProcessTreeGuard::create_kill_on_close` + 退出钩子 + CLI ctrl-c |
| 9 | 白名单把 MCP 工具挡在门外 | 存量 Agent 穷举白名单 | §8.6 的提示 + 编辑器动态分组 |
| 10 | 密钥泄漏（env / headers） | 落库 / 日志 / 埋点 / CLI 回显 | 落库同 apiKey 级别（本地 SQLite）；日志只记名字；`config get` 掩码 |
| 11 | `mcp__` 名撞内置 | 前缀保留已规避 | 碰撞即该工具按 error 上报，不注册 |
| 12 | 手机端拿到未知 `permName` 判 high | 预期行为 | 保持从严；若日后要低摩擦，在 `approval-policy.ts` 登记 `mcp.tool.call` |

---

## 15. 可选：把 Virlen 变成 MCP Server（P4）

**场景**：让 Claude Desktop / Cursor / 其他 IDE 调用 Virlen 的 39 个原生工具（等价于把 `virlen-cli` 变成一个 MCP 服务器）。

**做法**（成本低，因为工具实现都在 core）：

- `virlen-cli` 新增子命令 `virlen-cli mcp-serve`（stdio 传输）：
  - `initialize` → 回 `capabilities.tools`；
  - `tools/list` → `tool_defs::list_tool_definitions()` 映射成 MCP 工具（`list_tool_definitions` 已是 JSON Schema 子集，正好合规）；
  - `tools/call` → 构造 `NativeToolCtx`（`HostEnv = CliHost`、`SettingsRepo`/`MemoryRepo` 用真仓、`Security` 用 `app_settings`），调 `native_tools::execute_native_tool`，把 `NativeToolOutcome` 映射成 MCP `content`；
  - `user_choice` / 命令审批：**不支持**（headless 无人应答）→ 该类工具默认不暴露，或用 `--allow-tools` 白名单收窄。
- 安全：默认只读工具集？→ 建议 `--allow-tools` 必填或默认 `read/list/search/web` 等无副作用集合；stdout 只能有 JSON-RPC（日志一律 stderr）。

**为什么放 P4**：价值真实但受众小（先把「Virlen 用别人的工具」做扎实）；且它与 P0 的 JSON-RPC 实现完全复用，后做成本很低。

---

## 16. 与 dsh 的对照（借鉴 / 不借鉴）

| dsh 的做法 | 本方案 | 理由 |
|---|---|---|
| 一个服务器一个插件实例（Cordis） | 一个 `McpManager` 管 N 个连接 | 本项目没有插件容器；进程级管理器更简单，且 CLI 同样适用 |
| 公开名 64 字符 + 12 hex 哈希 | **照抄** | 会话历史与权限规则的稳定性要求一致 |
| 世代原子交换 + 同步串行队列 | **照抄** | 交错会导致双 dispose / 半注册（已被验证的坑） |
| 重连退避 500ms→30s / 10 次 / 稳定期重置 | **照抄** | 参数经过实战 |
| stdio 环境清洗（`/KEY|PASSWORD|SECRET|TOKEN/i` + `DSH_*`） | **照抄**，前缀改 `VIRLEN_*` | 同一个威胁模型 |
| 图片作为唯一持久富结果 | **照抄**，但落到既有 `role = vision_image` 注入队列 | 复用本项目已有的图片通道，不新造 |
| 共享资源工具（`mcp-resources` 三件套） | 缩成两个（`list_mcp_resources` / `read_mcp_resource`），P3 | 本项目没有「按作用域挂载」概念，server 参数显式传即可 |
| 服务器 `instructions` 进系统提示词 | P3，带归属前缀 + 32 KB 上限 | 一致 |
| MCP prompts / OAuth / sampling | 不做 | 见 §1.2 |
| TS SDK（`@modelcontextprotocol/*`） | 不用 | 见 §3.2 |

---

## 17. 附录：配置示例

### A. stdio（本地 filesystem 服务器）

```json
{
  "id": "01J8Z0M4",
  "name": "fs",
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\code\\my-project"],
  "env": {},
  "approval": "ask",
  "toolCallTimeoutMs": 60000,
  "startupTimeoutMs": 30000,
  "reconnect": { "enabled": true, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 10 },
  "injectInstructions": true
}
```

### B. Streamable HTTP（远端服务器）

```json
{
  "id": "01J8Z0M5",
  "name": "remote",
  "enabled": true,
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "approval": "allow",
  "toolCallTimeoutMs": 60000,
  "startupTimeoutMs": 30000,
  "reconnect": { "enabled": true, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 10 },
  "injectInstructions": true
}
```

### C. 导入（Claude Desktop 风格，`cmd_mcp_import`）

```json
{
  "mcpServers": {
    "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "web":  { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer x" } }
  }
}
```

导入规则：`key` → `name`（非法字符替换并提示）、`type:"http"` → `transport:"http"`、`docker run …` 之类的 `command+args` 原样保留；`env` 里带 `KEY/TOKEN/SECRET/PASSWORD` 的键在 UI 打码显示。冲突（重名）→ 跳过并计入 `skipped`。

---

## 18. 实施状态

### P0（协议层）—— ✅ 已完成（2026-10）

| 文件 | 内容 |
|---|---|
| `src-tauri/virlen-core/src/mcp/mod.rs` | 对外出口（三条不变量写在文件头） |
| `…/mcp/naming.rs` + `naming_fixtures.json` | 公开名算法 + **跨语言黄金值**（Rust 与将来的 TS 测试读同一份） |
| `…/mcp/config.rs` | `McpServerConfig` / 校验 / 环境清洗 / 重连退避 / Windows 启动解析 |
| `…/mcp/schema.rs` | `$ref` 内联 / `required` 清洗 / 降级 |
| `…/mcp/jsonrpc.rs` | 消息编解码 + 行帧（半包 / 多包 / 超长行 / CRLF） |
| `…/mcp/transport/{mod,stdio,http}.rs` | 共用 `Core`（id 关联 / 事件队列 / 关闭信号）+ stdio + Streamable HTTP（含 SSE 解码） |
| `…/mcp/client.rs` | 握手（版本降级）/ `tools/list` 分页 / `call_tool` / 通知与反向请求 |
| `src-tauri/virlen-core/src/bin/mcp_fixture.rs` | 测试夹具服务器（**只用于测试**，不随应用打包） |
| `src-tauri/virlen-core/tests/mcp_stdio.rs` | 真子进程端到端（握手 / 分页 / isError / stderr / 断链 / 启动失败） |

验证基线：`cargo clippy -p virlen-core --all-targets -- -D warnings` 零告警；`mcp` 相关 **68 个用例全绿**（库内 64 + 集成 4）。

⚠️ `cargo test -p virlen-core` 全量跑时有 12 个**既有环境限制失败**（`git::tests` 需要真 bash 管道、`sandbox::windows::tests` 需要 `WRITE_DAC` 权限），与 MCP 无关，属 §11.2 记录的「本机沙盒未复现」。

### 落地时发现的三处偏差（已按实际修正）

1. **`.cmd` 即使带绝对路径也必须走 `cmd /C`**：`CreateProcess` 根本不能执行批处理 —— 原来只在「裸命令」时包 shell 是错的。
2. **裸命令要先自己找一遍 PATH**：`cmd` 对不存在的命令**总是启动成功**（报错发生在 cmd 运行时），调用方只会看到「连上了又立刻断开」。现在 Windows 裸命令先按 `PATH` + `PATHEXT` 探测，找不到直接给「找不到命令 X」。
3. **只在没进 Job Object 时才 `taskkill`**：`taskkill` 找不到已终止的 pid 会往控制台喷「错误: 拒绝访问」，而 CLI 的 stderr 是用户可见输出。Windows 上 Job 分配成功就不必再兜底。

### 下一步（P2 入口）

审批通道 + 工具卡片 + Agent 编辑器动态分组（见 §13 的 P2）。—— ✅ 已完成，见文末「P2（审批 + 卡片 + 白名单）」；P3（资源 / 指令 / 观测）—— ✅ 已完成，见文末「P3（资源 / 指令 / 观测）」。

---

### P1（引擎接入 + 配置 UI）—— ✅ 已完成（2026-10）

#### Rust（`virlen-core`）

| 文件 | 内容 |
|---|---|
| `…/mcp/host.rs` | `McpHost` trait（定义 / 状态 / 世代 / call / kill_all）+ 全局 `attach`/`host()` + `NoopMcpHost` |
| `…/mcp/connection.rs` | 单服务器监督器：连接 → `tools/list` 世代发布 → `list_changed` 重同步 → 退避重连 / 预算耗尽 / 诊断尾部 |
| `…/mcp/results.rs` | `tools/call` 结果投影（text / image / audio / resource_link / resource / structured）+ 60 KB 上限 |
| `…/mcp/registry.rs` | `McpManager`（实现 `McpHost`）：快照 + 世代 + 差量 `reload` + 配置读写 + `probe` + `start_from_settings` |
| `…/mcp/import.rs` | Claude Desktop 风格 `mcpServers` JSON 导入（逐条跳过并给原因） |
| `…/agent/types.rs` | `ToolParameters` 加 `#[serde(flatten)] extra`（不然 MCP 的 `additionalProperties` / `$defs` 在序列化时静默丢失） |
| `…/agent/tool_executor.rs` | `exec_path = "mcp"` + 前缀分发到 `mcp::call_tool`（不看 `security`） |
| `…/mcp/transport/mod.rs` | `Transport::stderr_tail()` 默认实现（stdio 覆写，HTTP 无） |

#### GUI 壳（`virlen-app`）

| 文件 | 内容 |
|---|---|
| `src-tauri/src/commands/mcp.rs` | 9 条命令（list / upsert / remove / set_enabled / reload / tool_definitions / status / test / import）+ `TauriMcpSink`（`mcp:changed` / `mcp:status`）+ `init_mcp` |
| `src-tauri/src/lib.rs` | 命令注册（铁律 4）+ `RunEvent::Exit` 里 `shutdown_all()` |
| `src-tauri/src/commands/agent.rs` | `init_agent_engine` 末尾挂 `init_mcp`（先挂空管理器，再异步读配置） |

#### CLI（`virlen-cli`）

- `SessionRuntime::bootstrap` 里读同一份 `app_settings.mcpServers` 并 `start_from_settings`（**等服务器有结论**，否则一次性命令永远拿不到工具）；
- 工具定义拼接 `mcp::definitions()`；新增 `--no-mcp`（`run` / `chat` 同义）；
- `lib.rs::run` 收尾 `mcp::host().kill_all().await`。

#### 前端（`src`）

| 文件 | 内容 |
|---|---|
| `domain/mcp/{types,naming,config,index}.ts` | 数据契约 / 公开名**解析** / 校验与文本框互转 / 默认值 |
| `infrastructure/mcp/repo.ts` | 9 条命令的 `invoke` 封装（非 Tauri → Noop） |
| `services/mcp.ts` | `mcp:changed` → 失效定义缓存 + 补默认 Agent 白名单；`mcp:status` → `mcpStore` |
| `ui/store/mcpStore.ts` | 界面状态（configs / statuses / epoch / loading / error） |
| `ui/pages/Settings/mcp-settings.tsx` | 服务器列表（状态胶囊 / 工具数 / 审批档 / 重连 / 删除 / 展开详情）+ JSON 导入弹窗 |
| `ui/pages/Settings/mcp-edit-modal.tsx` | 增改弹窗（stdio / HTTP 字段、审批三态、超时、工具白名单、测试连接） |
| `infrastructure/tools/definitions-source.ts` | 内置契约之后拼接 `cmd_mcp_tool_definitions`（失败降级空数组） |
| `domain/tools/index.ts` | `listDefinitions()` 放行 `mcp__*`（它们由 Rust 执行，不需要 JS 执行器）；`missingExecutorNames()` 排除 |
| `main.ts` | 阶段 2 新增 `mcp` step（启动补偿：Rust 可能在前端挂监听前就连好了） |
| `ui/i18n/lang/en-US.json` | 45 条 MCP 文案 |

#### 验证基线

| 项 | 结果 |
|---|---|
| `cargo clippy -p virlen-core --all-targets -- -D warnings` | 零告警 |
| `cargo clippy -p virlen-app / -p virlen-cli --all-targets` | 零告警 |
| `cargo test -p virlen-core --lib mcp` | **99 passed**（连跑 4 次无抖动） |
| `cargo test -p virlen-core --test mcp_stdio` | 4 passed |
| `cargo test -p virlen-core --test mcp_manager` | 3 passed（真子进程：快照 / 调用投影 / 探针 / 拆除） |
| `cargo test -p virlen-cli` | 235 passed |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run src/tests/domain/mcp-{naming,config}.test.ts` | 19 passed |

#### 落地时又发现的七处偏差（已按实际修正）

1. **MCP 配置不经过 `SettingsStore`**：`cmd_mcp_*` 直接读写 `app_settings.mcpServers`（Rust 是唯一写者）。若同时塞进 `SettingsStore`，它的 debounce 落库会**整键覆盖** Rust 刚写的内容 —— 同一个键不能有两个写者。因此前端没有 `mcpServers` 字段，也不需要迁移分支。
2. **前端只解析公开名，不生成**：生成需要 SHA-256 + 「逐字符替换 → 截断 → 加哈希」三段规则，两侧各写一遍必然漂移（名字一不一致，会话历史里的工具名就指向另一个工具）。`naming_fixtures.json` 仍被前端测试使用，但断言的是「Rust 生成的名字能被正确拆回」。
3. **`exec_path = "mcp"` 不看 `is_ready()`**：只要名字带 `mcp__` 前缀就走 MCP 分支。否则断链期间模型调用历史里的 MCP 工具会被判成 JS 桥工具 —— 那里永远没有执行器，用户只会看到「工具不存在」。
4. **`failed` 不是死任务**：预算耗尽后监督任务仍存活，等 `Reconnect` 指令；否则用户点「重连」毫无反应（只有删除才救得回来）。
5. **默认 Agent 白名单要被主动补**：`allowedTools` 是穷举名单，新连上的 MCP 工具不会自动出现。`mcp:changed` → `toolRegistry.invalidateDefinitions()` + `initDefaultAgent()`（只补默认 Agent，不动用户自定义的）。启动时还要补偿一次：Rust 可能在前端挂监听之前就连好了。
6. **图片块暂不落附件**：`results.rs` 只给诊断文本 + `ui.blocks[image]`（`mimeType` / `bytes`），`role=vision_image` 的注入队列留到 P2 —— 它需要会话附件库落盘，写进 P1 会把「工具桥」变成「附件流水线」。
7. **CLI 必须等服务器「有结论」**：`start_from_settings` 最多等「各服务器启动超时的最大值 + 2s」，`backoff` / `failed` 也算有结论（它们本来就不可能在本轮提供工具）。不等的话一次性命令永远拿不到 MCP 工具（`npx` 冷启动 3–10 秒）。

---

### P2（审批 + 卡片 + 白名单）—— ✅ 已完成（2026-10）

#### 2.1 审批闸门（Rust `mcp/bridge.rs`）

```
call_with_approval(tool_name, args, ctx)
  ├─ 名字残缺（拆不出 server/raw）→ 不问人，直调（管理器会回「不可用」）
  ├─ approval_for(server) = None      → 直调（服务器已被删掉，弹了也白弹）
  ├─               = Allow  → 直调
  ├─               = Deny   → 立刻拒（配置刚改成 deny 的兜底）
  └─               = Ask    → confirm_mcp_call 交互 → 允许才真调
```

| 落点 | 内容 |
|---|---|
| `mcp/host.rs` | `McpHost::approval_for(server) -> Option<McpApproval>`（默认 `None`）+ `mcp::call_with_approval` / `McpApprovalCtx` / `McpGatedCall` 导出 |
| `mcp/registry.rs` | `McpManager::approval_for` 读 `configs`（**不是**服务器列表：刚改 deny 时监督任务可能还在收尾，审批判定不该跟着抖） |
| `mcp/bridge.rs`（新） | 审批闸门：载荷构造 / 回执解析 / 埋点 `mcp.tool.approval`（只记 server·tool·action·耗时） |
| `agent/tool_executor.rs` | MCP 分发改走 `call_with_approval`；`McpGatedCall::Shelved` → 既有的 `__SHELVED__`（run 暂停并保存快照） |
| `virlen-cli/run/ask.rs` | `confirm_command_native` 与 `confirm_mcp_call` 同一个问法（`y` → `approved`；非 TTY 一律拒） |
| `virlen-cli/tui/state` | `is_confirm()` 收纳 `confirm_mcp_call`（否则 TUI 里 MCP 调用会挂到运行结束） |

载荷（**与命令审批同一套字段**，手机端零改动即可审批）：

```json
{
  "permName": "mcp.<server>.call",
  "title": "MCP 工具调用",
  "subTitle": "<server> · <rawName>",
  "desc": "<美化后的参数 JSON，超 4 KB 按字符截断>",
  "hint": "该调用会交给外部 MCP 服务器执行，可能读写文件或访问网络",
  "risk": "dangerous",
  "toolCallId": "<id>",
  "serverName": "<server>",
  "toolName": "<rawName>"
}
```

三种结局各自可辨（方案 §7.2 的表已落地）：

| 情形 | 结果 |
|---|---|
| 配置 `deny` | 工具根本不下发（模型看不到）；竞态下走到闸门 → `Operation denied by the MCP server approval settings` |
| 用户点「拒绝」/ Esc | `McpCallOutcome::cancelled()` = `[User cancelled]`，卡片红（与 `execute_command` 逐字一致） |
| 用户点「暂存」 | `McpGatedCall::Shelved` → `__SHELVED__` → run 暂停（不是失败） |
| 本次运行被取消（点停止） | `[User cancelled]`（`request_user_interaction` 的取消分支） |

#### 2.2 前端授权（`services/tool-service/mcp_confirm.ts`）

- 结构照抄 `command_confirm.ts` 的多槽 `PendingSlots`，但**不执行任何东西**：允许只回 `'approved'`，真正的 `tools/call` 在 Rust；
- 复用通用的 `commandResolve` / `commandReject` 事件 → 桌面弹窗、会话内卡片、手机端（`interaction-source.ts` 的 `allowAuthorization`）**三端同一套**，手机端代码零改动；
- `title` / `hint` 由 Rust 下发中文 key，这一层过一遍 `t()`：手机与桌面都按界面语言显示；
- 埋点 `interaction.mcp.confirm.show|result`（参数字符数只记长度，正文一个字不记）。

#### 2.3 工具卡片（`ui/.../tool-call/McpToolMessage.tsx`）

- `getToolCallMessage()` 对 `mcp__*` **前缀兜底**（运行期才知道的工具名不可能逐个注册），其余仍精确匹配；
- 收起态 = 首个文本块的首个非空行（80 字符截断）；无结果时退回参数摘要；
- 展开态按 `uiData.blocks[]` 渲染：`text` / `image`（**只报类型与大小，绝不出现 base64**）/ `resource` / `resource_link` / `json`（收在 `<details>` 里）/ `unsupported`；`truncated` 有说明；
- `isError` 走红色通道。

#### 2.4 白名单可见性

| 位置 | 做法 |
|---|---|
| `domain/tools/grouping.ts`（新） | `groupToolsForEditor()` 纯函数：静态分类 → **MCP 按服务器动态分组**（`MCP · <server>`，按服务器名排序）→ 「其他」。MCP 工具**不进「其他」** |
| `agent-edit-modal.tsx` | 改用上面的纯函数（可单测），标签走 `tpl('MCP · $__server__')` |
| `mcp-settings.tsx` | 每台服务器显示「已被 N 个 Agent 启用」；`ready` 但 0 时给橙色提示（去 Agent 编辑器勾选） |

`TOOL_CATEGORIES` **仍不加** `mcp` 静态项：那张表与 `definitions.json` 一一对应且有契约测试守条数，而 MCP 服务器是用户在设置页随时增删的运行期事实。

#### 2.5 验证基线

| 项 | 结果 |
|---|---|
| `cargo clippy -p virlen-core -p virlen-app -p virlen-cli --all-targets -- -D warnings` | 零告警 |
| `cargo test -p virlen-core --lib` | 1089 passed（含 `mcp::bridge` 9 条） |
| `cargo test -p virlen-core --test mcp_stdio / --test mcp_manager` | 4 / 3 passed |
| `cargo test -p virlen-cli` | 236 passed |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | 294 文件 / 3286 passed |

新增前端用例：`tests/ui/mcp-tool-card.test.tsx`（9）、`tests/domain/tool-grouping.test.ts`（6）、`tests/services/mcp-confirm.test.ts`（6）。

#### 落地时发现的六处偏差（已按实际修正）

1. **服务器不存在时不弹窗**：`approval_for` 返回 `None` 说明服务器已被删掉（工具还能被调用只因快照残留），先弹一次审批再报「工具不可用」是纯骚扰 —— 直接调下去让管理器给如实错误（方案 §14 风险 5 的本意）。
2. **`Deny` 仍要留分支**：正常路径下 deny 的服务器连都不连、工具不下发，但「运行中把配置改成 deny」会让已下发的工具撞上闸门 —— 给一条明确拒绝，而不是放行。
3. **TUI 同样是审批端**：`is_confirm()` 只认 `confirm_command_native` 时，TUI 里 MCP 调用会走「未知类型」分支被默默拒掉（不是崩溃，是「怎么点都没反应」）。已并入同一种面板。
4. **`McpGatedCall` 必须独立于 `McpCallOutcome`**：暂存不是失败也不是成功，塞进 `content` 用魔法字符串表达会让 `tool_executor` 的状态判定变脆（红色卡片 / 暂停两种 UI 表现完全不同）。
5. **图片块仍不落附件**：P2 的「图片展开」= 报告类型与大小；落盘 + `role=vision_image` 注入（真让视觉模型看图）需要会话附件库，留给后续（与 P1 的同一条记录合并）。
6. **MCP 卡片测试要绕开 Monaco**：`IToolCallMessage.ts` 会把所有卡片拉进来（`EditFileMessage` → `MonacoDiffView` → `setupMonaco` → `@mono-codicon/codicon.css`），happy-dom 里无法解析。测试里 `vi.mock('@/monaco/setupMonaco')` 即可（不必逐个 mock 卡片）。

#### 2.6 手工验收（P2 出口，§12.4 的 1–9 条中与审批/卡片相关的部分）

1. `ask` 档调一次 → 桌面弹窗显示 `MCP 工具调用` + `server · tool` + 参数 JSON + 危险提示；
2. 允许 → 结果回填卡片；拒绝 → 卡片红、模型收到 `[User cancelled]`；暂存 → run 暂停、可从上次位置恢复；
3. 手机侧：同一张卡片出现在待应答列表（`permName = mcp.<server>.call` 未登记 → 判 high，批准前有一次二次确认）；
4. Agent 编辑器「工具」页出现 `MCP · <server>` 分组，可整组勾选；设置页显示「已被 N 个 Agent 启用」；
5. CLI：`virlen-cli run "..."` 遇到 `ask` 档会在终端问 `[confirm] MCP 工具调用（权限: dangerous）`。

### P3（资源 / 指令 / 观测）—— ✅ 已完成（2026-10）

#### 3.1 资源：两个新内置工具（`list_mcp_resources` / `read_mcp_resource`）

为什么是**内置工具**而不是动态 `mcp__*`：列资源天然是「跨服务器」的动作，而动态工具名必须绑定
一台服务器 + 一个工具名。两个工具走完整「新增工具」清单：

| 位置 | 改动 |
|---|---|
| `mcp/client.rs` | `InitializeResult.supports_resources`（读 `capabilities.resources`）；`list_resources()` 自动分页（50 页上限、无 uri 与重复 uri 跳过）；`read_resource()` → `ReadResourceResult { contents[] }` |
| `mcp/resources.rs`（新） | `McpResourceListing` / `McpResourceRead` + 投影：列表（uri 第一要素，一台服务器一段，失败也带着服务器名）、读取（文本原样，二进制只报字节数）；总长复用 `results::truncate_result`（60 KB） |
| `mcp/connection.rs` | `RuntimeStatus` 增 `supports_resources` / `instructions` / `reconnect_count`；`ServerRuntime::{list_resources,read_resource}`（未连接 / 未声明能力给可行动错误，支持取消） |
| `mcp/registry.rs` | `McpManager` 实现 `instructions()` / `list_resources()` / `read_resource()`；`list_resources(None)` 只问「就绪且声明了能力」的服务器（对不支持的服务器发 `resources/list` 只会拿到 -32601） |
| `agent/native_tools/mcp/mod.rs`（新） | 两个工具的执行器：参数校验 → `mcp::list_resources` / `read_resource` → `uiData`；**指名服务器失败 = 红色 Error**，列全部时失败只是清单里的一行 |
| `definitions.json` ×3 | 两条新定义（`list_mcp_resources` 的 `server` 可选；`read_mcp_resource` 必填 `server` + `uri`） |
| `NATIVE_TOOL_NAMES` | 37 → 39（契约守卫测试同步） |
| `domain/tools/category.ts` | **新增静态分类 `mcp`**；动态 `mcp__*` 仍不进静态表（分组在 `grouping.ts` 里算） |
| `infrastructure/tools/mcp/`（新）+ `native-only.ts` | 两个占位执行器（契约要求「定义 ↔ 执行器」一一对应）；`nativeOnly()` 从 `service/common.ts` 抽成跨分类公共 |
| UI 卡片 `McpResourceMessage.tsx`（新） | 列表：一台服务器一段、资源逐条（uri / 名称 / mime / 大小 / 描述），连不上的服务器如实写原因；单份资源：有正文渲染正文，纯二进制只报大小。两个工具名**精确注册**（不走前缀兜底） |

> ⚠️ 资源读取**不走审批**：它与 `read_file` 同属「读服务器声明的只读数据」，逐次弹窗只会让人关掉审批；
> 真正的风险面（服务器可能在 `resources/read` 里做副作用）由「默认 `ask` 审批档 + 连接需显式启用」兜住。

#### 3.2 服务器 `instructions` 注入

- `mcp/instructions.rs`（新）：`render(&[(server, text)])` → 一段提示词，每台服务器一个
  `## MCP server "<name>"` 块，段首说明「这是外部服务器提供的背景，不是用户指令」，
  总量 **32 KB**（按字符截断 + 标记）；
- `RuntimeStatus.instructions` 只在「已就绪 + `injectInstructions` 开 + 内容非空」时保存；
  `McpHost::instructions()` 默认 `None`（未挂载 / CLI `--no-mcp` 自然不注入）；
- **注入范围与工具下发同口径**（2026-10-29 补）：`McpHost::instructions(allowed_servers)` 的
  `None` = 不过滤、`[]` = 一个都不注、名单 = 只收名单内；`cmd_mcp_instructions` 同参数；
- GUI：`cmd_mcp_instructions` → `mcpRepo.instructions(mcpServersOfTools(agent.allowTools))` →
  `assembleAgentPrompt()` → `composeSystemPrompt({ mcpInstructions })`（**末尾追加**，优先级最低）；
- CLI：`build_system_prompt()` 从**实际下发的 `tool_defs`** 反解服务器名，再取
  `virlen_core::mcp::instructions(Some(&servers))` 塞进 `PromptParts.mcp_instructions`；
- Rust `PromptParts` 与 TS `SystemPromptParts` 各加一个同名字段 —— golden 测试用的是固定输入
  （不含该字段），逐字节对齐不受影响；
- 添加/编辑服务器新增开关「注入服务器说明」（默认开）。

#### 3.3 观测面板

| 项 | 落点 |
|---|---|
| `reconnectCount` | `RuntimeStatus.reconnect_count`：每次「断链 → 退避重连」+1，跨「就绪」保留；`McpServerStatus` **始终下发**（0 也有意义） |
| 失败原因 | `lastError` 原有；设置页展开区新增「运行状态」列表（当前状态 / 重连次数 / 最近连接时间 / 服务器自述 / 最近一次失败原因） |
| stderr 尾部 | 原有（stdio 环形缓冲），现在与上面几项并列在同一块「运行状态」面板下 |

#### 3.4 顺手修掉的两个「观测」缺陷（P0/P1 遗留）

1. **`probe()` 不再等退避预算**：以前「测试连接」克隆的配置**带着自动重连**，首次失败进入 `backoff`
   （500ms→30s × 10 次），探针看不到终态 → 干等到 `startup_timeout + 5s` 后显示一句硬编码的
   「连接超时」，真实原因（进程起不来 / 协议不对 / stdout 不是 UTF-8）被完全埋掉。现在克隆时
   `reconnect.enabled = false`，失败即落 `failed` 并返回 `last_error`；真超时也优先带出已拿到的原因。
2. **stdio 非 UTF-8 报错带修复办法**：`line is not UTF-8: …` 后面补一句
   「MCP stdio requires UTF-8 output; Python servers can set PYTHONIOENCODING=utf-8 (and PYTHONUTF8=1)」
   —— 实测踩出来的：Windows 上 Python 服务端默认按 cp936 写 stdout，`ensure_ascii=False` 的中文 / 破折号直接非法。

#### 3.5 验证基线

| 项 | 结果 |
|---|---|
| `cargo clippy -p virlen-core -p virlen-app -p virlen-cli --all-targets -- -D warnings` | 零告警 |
| `cargo test --workspace` | 1106 + 236 + 39 + 3 + 5 passed（`mcp::*` 新增 17 条单测，`tests/mcp_stdio.rs` 新增 1 条真子进程资源用例） |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | 295 文件 / 3296 passed（新增 `tests/ui/mcp-resource-card.test.tsx` 9 条；`tools-category` +1） |

#### 3.6 落地时发现的三处偏差

1. **`edit_file` 的 `replace_count` 不是「按出现次数替换」**：`replace_count: 3` 在**同一处**连续替换了三次
   （替换文本自身仍包含被替换片段），结果 windows 变体多了 3 份、macos/linux 各 0 份。已用
   JSON 往返（先验证 `JSON.stringify(parse(x), null, 2)` + CRLF 与原文件**逐字节相同**）的脚本修好。
   教训：多份相同片段要**用唯一锚点逐个改**，或先确认工具语义。
2. **`TOOL_CATEGORIES` 现在要加 `mcp` 静态分类**：P2 的结论（动态 `mcp__*` 不进静态表）仍然成立，
   但 P3 的两个工具是**静态内置工具**，必须有自己的分类目录（`infrastructure/tools/mcp/`）与契约条目。
3. **资源工具的失败语义分两种**：指名某台服务器却失败 → 红色 Error（否则模型会以为「这台服务器没有资源」）；
   列全部时某台失败 → 只是清单里的一行带 `error`（部分成功不该整条变红）。

#### 3.7 手工验收（P3 出口）

1. 接一台支持资源的服务器（如 filesystem）→ 让模型「列出可用资源」→ 卡片显示每台服务器一段、资源逐条；
2. 让模型读一个 `file://` 资源 → 正文上屏；读一个二进制资源 → 只显示「N KB，未显示」；
3. 指名一台不存在的服务器 → `list_mcp_resources` 卡片变红且文案可行动；
4. 设置页展开某台服务器 → 看到「运行状态」（状态 / 重连次数 / 连接时间 / 上次失败原因）与 stderr 尾部；
5. 关掉「注入服务器说明」→ 新建会话的系统提示词里不再出现 `# MCP Server Instructions`。

### 改名迁移与白名单幽灵名（2026-10-29，§8.6 白名单的收尾）

`allowTools` 是**穷举白名单**，而公开名 `mcp__<server>__<raw>` 内嵌配置名 —— 改名会让旧名整体失效，
界面却还按 `allowTools.length` 报「已选 N」（用户报过：48 行一个都没勾、写着已选 35）。三条落地：

- **计数改口径**：`agent-edit-modal` 只数「当前列表里被勾上的」，幽灵另起一行「N 项已失效（服务器改名或已移除）」+ 显式「清理」（只改表单状态，保存才落库）；
- **保存不裁剪**：MCP 服务器离线时它的工具本来就不在列表里，按列表裁掉等于永久丢勾选；
- **改名迁移**：`domain/mcp/rename.ts` 只替换**纯净前缀**（带 SHA-256 指纹 / 拼完超 64 字符的一律不动，留给上面的「已失效」兜底），由 `services/mcp.ts::migrateAgentToolNames` 写回 `agentStore` —— **不走 Rust 改表**：Agent 的运行期权威副本是 `agentRepo` 的内存快照，Rust 改表后前端会整份覆盖回去。

细节、边界与守卫单测见 `agents/06-pitfalls-toolchain.md` §11.69。

### 说明书注入与工具下发同口径（2026-10-29）

默认 Agent 一个 MCP 工具都没勾时，系统提示词里仍整段注入服务器说明书 —— 因为「发不发给模型」按
`filterAllowedToolDefs` 过滤，而「注不注说明书」只看 `ready` + `injectInstructions`，两套判定互不相干。

- `cmd_mcp_instructions(allowedServers)` / `McpHost::instructions(allowed_servers)`：`null` = 不过滤、
  `[]` = 一个都不注、名单 = 只收名单内（判定单点在 `mcp/instructions.rs::allows_server`）；
- GUI 传 `mcpServersOfTools(agent.allowTools)`；CLI 从**实际下发的 `tool_defs`** 反解服务器名
  （`--no-tools` / `--no-mcp` 时自然为空）；
- 改名后的幽灵名解出已不存在的服务器 → Rust 不认 → 不注（fail-closed，与工具侧等价）。

细节与守卫单测见 `agents/06-pitfalls-toolchain.md` §11.70。
