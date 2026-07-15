<div align="center">
  <img src="public/logo.png" alt="Virlen 未霖 Logo" width="120" height="120">
  <h1 align="center">Virlen 未霖</h1>
  <p align="center">
    全能型 AI 智能体桌面客户端 — 多模型、工具调用、视觉识别、Skill 技能系统
  </p>
  <p align="center">
    🌐 <a href="README.md">English</a> | <strong>中文</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/version-0.1.2-blue" alt="version">
    <img src="https://img.shields.io/badge/Tauri-2.0-purple" alt="tauri">
    <img src="https://img.shields.io/badge/React-19-61DAFB" alt="react">
    <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6" alt="typescript">
    <img src="https://img.shields.io/badge/Rust-1.91-000000" alt="rust">
  </p>
</div>

---

## 📖 简介

**Virlen 未霖** 是一款基于 [Tauri v2](https://v2.tauri.app/) 构建的跨平台 AI 智能体桌面应用。它不仅仅是一个 AI 聊天客户端，更是一个**可拓展的 AI Agent 平台**，支持：

- **多模型提供商**：兼容 OpenAI、Anthropic、Gemini 等主流 LLM API
- **工具调用（Function Calling）**：AI 可自主执行文件操作、命令执行、网页抓取、搜索、视觉分析等操作
- **内置视觉引擎**：基于 [Quasivision](https://crates.io/crates/quasivision) 的端侧 AI 视觉能力（UI 检测、OCR、物体检测、图标分类），无需联网
- **技能系统**：可插拔的 Skill 机制，让 AI 具备专业领域知识
- **安全机制**：路径黑白名单、文件访问权限控制、Shell 沙盒执行、工具调用风暴防护（StormBreaker），全面保护系统安全
- **暂停/恢复**：Tool Call 执行过程中支持暂停和断点续传（Run Snapshot 模型）
- **上下文压缩**：基于 LLM 的智能上下文压缩，支持超长对话而无需担心 Token 溢出
- **搜索供应商**：可插拔的搜索供应商架构，支持 Tavily、Bocha、SearXNG 等搜索引擎

---

## 🚀 快速开始

### 环境要求

| 依赖                                         | 版本要求 |
| -------------------------------------------- | -------- |
| [Node.js](https://nodejs.org/)               | ≥ 18     |
| [pnpm](https://pnpm.io/)                     | ≥ 8      |
| [Rust](https://www.rust-lang.org/)           | ≥ 1.78   |
| [Tauri CLI](https://v2.tauri.app/start/cli/) | ≥ 2.0    |

### 安装与运行

```bash
# 1. 安装前端依赖
pnpm install

# 2. 启动开发模式（前端 + Tauri 桌面应用）
pnpm tauri dev
```

浏览器开发模式（仅前端）：

```bash
pnpm dev
```

生产构建：

```bash
pnpm tauri build
```

---

## 🏗️ 项目架构

Virlen 未霖 采用**六边形架构（Hexagonal Architecture / Ports & Adapters）**，将核心业务逻辑与基础设施实现解耦。

```
src/
├── domain/           # 核心领域层 — 纯业务逻辑，无外部依赖
│   ├── agent/        # Agent 模型与系统提示词（含上下文压缩提示词）
│   ├── engine/       # Agent 引擎 — 编排 LLM、Tool、Session 交互
│   │   ├── engine.ts          # 引擎主流程（sendMessage）
│   │   ├── llm-round.ts       # LLM 单轮对话管理
│   │   ├── tool-executor.ts   # 工具执行器（多 step、暂停恢复）
│   │   ├── run-state.ts       # Run 状态管理
│   │   ├── compress-context.ts# LLM 上下文压缩
│   │   ├── storm-breaker.ts   # 工具调用风暴防护
│   │   └── types.ts           # 引擎内部类型
│   ├── ports/        # 端口接口定义（驱动端 + 驱动端）
│   │   ├── AgentEnginePort.ts   # Agent 引擎端口
│   │   ├── ProviderPort.ts      # LLM Provider 端口
│   │   ├── SandboxPort.ts       # 沙盒执行端口
│   │   ├── SearchProviderPort.ts# 搜索供应商端口
│   │   ├── SecurityPort.ts      # 安全策略端口
│   │   └── ToolRegistry.ts      # 工具注册中心接口
│   ├── provider/     # Provider 领域模型与配置
│   ├── search/       # 搜索供应商领域模型（配置、类型、注册中心）
│   ├── security/     # 安全策略 — 路径黑白名单校验
│   └── tools/        # Tool 定义与执行器接口
│
├── infrastructure/   # 基础设施层 — 端口实现
│   ├── agentRepo/    # Agent 持久化
│   ├── provider/     # LLM Provider 实现（OpenAI / Anthropic / Gemini）
│   ├── sandbox/      # 沙盒执行实现（PluginShellSandbox）
│   ├── search-providers/ # 搜索供应商实现
│   │   ├── tavily.ts      # Tavily 搜索
│   │   ├── bocha.ts       # 博查搜索
│   │   ├── searxng.ts     # SearXNG 自托管搜索
│   │   └── factory.ts     # 供应商工厂
│   ├── securityRepo/ # 安全配置持久化
│   ├── sessionRepo/  # 会话持久化
│   ├── tools/        # 工具实现
│   │   ├── builtin/      # 内置工具（时间、命令执行、搜索、网页抓取）
│   │   ├── file-tools/   # 文件操作工具（读、写、编辑、复制、移动、列表、搜索）
│   │   ├── skill-tools/  # 技能管理工具
│   │   └── vision/       # 视觉分析工具
│   └── vision/       # 视觉服务实现
│
├── services/         # 应用服务层 — 编排业务流程
│   ├── agent-service.ts         # Agent 服务（组装提示词）
│   ├── chat-service.ts          # 聊天服务（发送消息、暂停恢复）
│   ├── env-service.ts           # 环境信息自动检测
│   ├── export-service.ts        # 导出服务
│   ├── provider-service.ts      # Provider 服务
│   ├── search-provider-init.ts  # 搜索供应商初始化
│   ├── search-provider-service.ts # 搜索供应商管理
│   ├── security-service.ts      # 安全服务
│   └── tool-service/            # 工具交互服务
│       ├── command_confirm.ts   # 命令执行确认
│       ├── user_choice.ts       # 用户选择交互
│       └── index.ts             # 工具服务入口
│
├── ui/               # 前端 UI 层（React + MobX + Sass）
│   ├── assets/       # 静态资源（字体等）
│   ├── components/   # 通用 UI 组件
│   ├── constants/    # 常量定义（含快速操作模板）
│   ├── hooks/        # 自定义 Hooks（主题、字号、时间）
│   ├── i18n/         # 国际化（中/英文）
│   ├── layout/       # 窗口布局（无边框窗口）
│   ├── pages/        # 页面
│   │   ├── chat/         # 聊天页面
│   │   ├── Settings/     # 设置页面
│   │   ├── setupFlow/    # 首次设置流程
│   │   └── test/         # 测试页面
│   ├── store/        # MobX 状态管理
│   ├── styles/       # 全局样式 & 主题变量
│   ├── App.tsx       # 应用根组件
│   └── App.css       # 全局 CSS
│
├── events/           # 自定义事件总线（菜单、设置、工具交互等）
├── skill/            # 技能系统（加载、注册、管理、商店）
├── types/            # 全局类型定义
└── utils/            # 工具函数（Diff、DB、EventEmitter、UUID 等）
```

### 核心引擎工作流程

```
用户消息 → AgentEngine.sendMessage()
            │
            ├── 上下文压缩检查 ← compressContext()
            │   └── Token 超限 → LLM 摘要替换早期对话
            │
            ▼
      doLLMRound() ──→ 调用 LLM Provider（流式输出）
            │
            ├── 返回文本 → 流式输出给用户
            │
            └── 返回 tool_calls → createRun()
                        │
                        ├── StormBreaker 检测 ← 防风暴
                        │   └── 命中 → 抛出中断，终止循环
                        │
                        ▼
                  executeToolSteps()
                        │
                  ┌─────┴─────┐
                  │           │
               ┌──┴──┐   ┌───┴────┐
               │ 沙盒 │   │ 用户交互 │
               │ 执行 │   │ (确认框) │
               └──┬──┘   └───┬────┘
                  │           │
                  ▼           ▼
            继续下一轮    暂停等待用户
            LLM 调用     确认后恢复(Run Snapshot)
```

---

## 🔌 支持的 LLM Provider

| Provider        | 协议                   | 特点                                                                   |
| --------------- | ---------------------- | ---------------------------------------------------------------------- |
| **OpenAI** 兼容 | `/v1/chat/completions` | 支持所有兼容 OpenAI API 的服务（含自定义端点），支持工具调用、流式输出 |
| **Anthropic**   | Messages API           | Claude 系列模型，支持工具调用、流式输出                                |
| **Gemini**      | Gemini API             | Google 模型，支持工具调用、流式输出                                    |

支持自定义 Provider 配置（API Key、Base URL、模型列表），并可为不同模型设置 `reasoningEffort`（如 o 系列模型的 `low`/`medium`/`high`）。同时支持自定义 HTTP Headers 以满足特殊鉴权需求。

---

## 🛠️ 内置工具

Virlen 未霖 内置了丰富的工具供 AI Agent 调用：

| 工具类别     | 工具名称               | 功能                                                            |
| ------------ | ---------------------- | --------------------------------------------------------------- |
| **文件操作** | `read_file`            | 读取文件内容（支持行范围、SHA256 哈希校验）                     |
|              | `write_file`           | 写入/覆盖文件（自动创建父目录）                                 |
|              | `edit_file`            | 精确替换文件内容（带哈希冲突检测，支持替换次数控制）            |
|              | `delete_file`          | 删除文件或目录                                                  |
|              | `file_info`            | 获取文件/目录元数据                                             |
|              | `copy_move_file`       | 复制或移动文件/目录                                             |
|              | `list_files`           | 列出目录内容（支持递归、最大深度、隐藏文件）                    |
|              | `search_files_by_name` | 按文件名搜索（支持纯文本、正则、Glob 三种模式）                 |
|              | `search_text_in_files` | 按文本内容搜索（基于 Rust ripgrep，自动跳过二进制文件）         |
| **命令执行** | `execute_command`      | 执行 Shell 命令（支持超时、沙盒安全执行）                       |
| **网络搜索** | `web_search`           | 互联网搜索（支持 Tavily、Bocha、SearXNG 等多供应商）            |
|              | `web_fetch`            | 抓取网页（HTML→Markdown 转换）                                  |
| **视觉**     | `vision_analyze`       | 端侧视觉分析（UI 元素检测、OCR、254 类物体检测、81 种图标分类） |
| **系统**     | `get_current_time`     | 获取当前时间（支持时区参数）                                    |
| **交互**     | `user_choice`          | 向用户弹出选择框（支持单选/多选）                               |
| **技能**     | `list_skills`          | 查看所有可用技能                                                |
|              | `read_skill_source`    | 查看技能源代码目录和 SKILL.md                                   |

---

## 🧩 技能系统

Virlen 未霖 支持通过 **Skill 机制** 为 AI Agent 注入专业领域知识。技能以 Markdown 文件定义，包含详细的领域知识、工作流程和约束条件。

内置技能包括：

| 技能                        | 说明               |
| --------------------------- | ------------------ |
| 📝 `article-writer`         | 文章写作助手       |
| 🎨 `canvas-design`          | Canva 设计工具     |
| 📋 `content-planner`        | 内容规划           |
| 📋 `create-plan`            | 计划制定           |
| 🎮 `develop-web-game`       | 网页游戏开发       |
| 📄 `docx`                   | Word 文档生成      |
| 🎬 `films-search`           | 电影搜索           |
| 🖌️ `frontend-design`        | 前端设计           |
| 📧 `imap-smtp-email`        | 邮件收发           |
| 🎵 `music-search`           | 音乐搜索           |
| 📑 `pdf`                    | PDF 文档处理       |
| 📊 `pptx`                   | PPT 演示文稿生成   |
| 🎞️ `remotion`               | 视频生成           |
| 🎥 `seedance` / `seedream`  | AI 视频/图像生成   |
| 📈 `stock-analyzer`         | 股票分析           |
| 📰 `stock-announcements`    | 股票公告查询       |
| 🔍 `stock-explorer`         | 股票行情查询       |
| 📰 `technology-news-search` | 科技新闻搜索       |
| 🌤️ `weather`                | 天气预报           |
| 📗 `xlsx`                   | Excel 电子表格生成 |

---

## 🔒 安全机制

Virlen 未霖 构建了**多层次的安全防护体系**：

### 文件访问安全层

- **黑名单**：自动保护系统敏感目录（如 Windows 的 C:/Windows、macOS 的 /etc、Linux 的 /etc/shadow 等）
- **白名单**：允许特定的临时目录访问
- **工作目录**：Agent 的工作目录默认可访问
- **写权限控制**：写操作严格限制在白名单和工作目录内
- **跨平台适配**：Windows / macOS / Linux 各有不同的默认安全策略

### Shell 沙盒执行

- 基于 `@tauri-apps/plugin-shell` 的安全沙盒，所有命令执行经过沙盒隔离
- 高危命令执行前弹出用户确认对话框，由用户决定是否放行
- 支持命令执行超时控制，防止恶意长时间占用

### 工具调用风暴防护（StormBreaker）

- 滑动窗口检测机制（窗口大小 6，阈值 3）
- 检测模型对相同 (toolName, args) 的重复调用模式
- 命中风暴模式时自动中断执行，防止无限循环消耗资源

---

## 🖼️ 端侧视觉引擎

Virlen 未霖 内置了 **Quasivision** 视觉引擎（ONNX Runtime），所有视觉分析在本地完成，无需联网：

- **UI 元素检测**：检测按钮、图标、图片、文本块、容器等 UI 元素
- **OCR 文字识别**：PP-OCR v5 模型，支持中英文识别
- **物体检测**：YOLOE-26n 模型，可识别 254 类日常物体
- **图标分类**：识别 81 种常见图标含义

> 视觉模型文件位于 `src-tauri/resources/quasivision_models/`，首次启动时自动加载。

---

## 🧪 技术栈

### 前端

| 技术                                                         | 用途                         |
| ------------------------------------------------------------ | ---------------------------- |
| [React 19](https://react.dev/)                               | UI 框架                      |
| [TypeScript 5.8](https://www.typescriptlang.org/)            | 类型安全                     |
| [Vite 7](https://vite.dev/)                                  | 构建工具                     |
| [MobX 6](https://mobx.js.org/)                               | 状态管理                     |
| [Sass](https://sass-lang.com/)                               | CSS 预处理器                 |
| [react-markdown](https://github.com/remarkjs/react-markdown) | Markdown 渲染                |
| [remark-gfm](https://github.com/remarkjs/remark-gfm)         | GFM 扩展（表格、任务列表等） |
| [PrismJS](https://prismjs.com/)                              | 代码语法高亮                 |
| [Vitest](https://vitest.dev/)                                | 单元测试框架                 |
| [Turndown](https://github.com/mixmark-io/turndown)           | HTML → Markdown 转换         |
| [Cheerio](https://cheerio.js.org/)                           | 服务端 HTML 解析             |
| [JSZip](https://stuk.github.io/jszip/)                       | 文件打包                     |

### 后端（Rust）

| 技术                                                    | 用途                                          |
| ------------------------------------------------------- | --------------------------------------------- |
| [Tauri 2](https://v2.tauri.app/)                        | 桌面应用框架                                  |
| [Serde](https://serde.rs/)                              | 序列化/反序列化                               |
| [Walkdir](https://crates.io/crates/walkdir)             | 目录遍历                                      |
| [Ignore](https://crates.io/crates/ignore)               | .gitignore 规则匹配                           |
| [Grep](https://crates.io/crates/grep) (ripgrep 核心)    | 高性能文本搜索                                |
| [Regex](https://crates.io/crates/regex)                 | 正则表达式引擎                                |
| [Sha2](https://crates.io/crates/sha2)                   | 文件哈希校验（SHA256）                        |
| [Quasivision](https://crates.io/crates/quasivision) 0.2 | 端侧视觉 AI（ONNX Runtime + DirectML/CoreML） |
| [Tokio](https://tokio.rs/)                              | 异步运行时                                    |
| [Trash](https://crates.io/crates/trash)                 | 安全删除到回收站                              |
| [Image](https://crates.io/crates/image)                 | 图片编解码                                    |
| [Base64](https://crates.io/crates/base64)               | Base64 编解码                                 |
| [Encoding_rs](https://crates.io/crates/encoding_rs)     | 多编码支持                                    |

---

## 📦 项目结构速览

```
virlen-app/
├── public/                   # 静态资源
├── src/                      # 前端源码（TypeScript + React）
│   ├── domain/               # 核心领域层
│   ├── infrastructure/       # 基础设施（Provider、Tool 等实现）
│   ├── services/             # 应用服务
│   ├── ui/                   # 用户界面
│   ├── skill/                # 技能系统
│   ├── types/                # 类型定义
│   └── utils/                # 工具函数
├── src-tauri/                # Rust 后端
│   ├── src/                  # Rust 源码
│   │   ├── lib.rs            # 主入口（Tauri 命令注册）
│   │   ├── file_ops.rs       # 文件操作
│   │   ├── search.rs         # 文件搜索
│   │   ├── vision_service.rs # 视觉服务
│   │   ├── common_service.rs # 通用服务
│   │   ├── load_env.rs       # 环境信息
│   │   └── task_manager.rs   # 任务管理（取消）
│   ├── resources/            # 资源文件（技能、视觉模型）
│   │   ├── default-skills/   # 内置技能定义
│   │   └── quasivision_models/ # 视觉 AI 模型
│   ├── icons/                # 应用图标
│   └── tauri.conf.json       # Tauri 配置
├── tests/                   # 单元测试
│   ├── domain/               # 领域层测试（compress-context、run-state、storm-breaker）
│   ├── services/             # 服务层测试
│   └── utils/                # 工具函数测试
├── package.json              # 前端依赖 & 脚本
├── pnpm-lock.yaml            # 依赖锁定
├── pnpm-workspace.yaml       # pnpm workspace 配置
├── vite.config.ts            # Vite 构建配置
├── vitest.config.ts          # Vitest 测试配置
├── tsconfig.json             # TypeScript 配置
├── tsconfig.node.json        # Node 端 TypeScript 配置
└── index.html                # 应用入口 HTML
```

---

## 🛠️ 开发命令

| 命令               | 说明                            |
| ------------------ | ------------------------------- |
| `pnpm dev`         | 启动前端开发服务器（端口 1420） |
| `pnpm build`       | 构建前端生产包                  |
| `pnpm tauri dev`   | 启动 Tauri 桌面应用开发模式     |
| `pnpm tauri build` | 构建桌面应用安装包              |
| `pnpm clean`       | 清理 dist 目录                  |
| `pnpm test`        | 运行单元测试（Vitest）          |
| `pnpm test:watch`  | 监听模式运行测试                |
| `pnpm test:ui`     | 启动 Vitest UI 测试面板         |

---

## 📄 开源协议

本项目基于 MIT 协议开源。

---

<div align="center">
  <sub>Built with ❤️ using Tauri, React & Rust</sub>
</div>
