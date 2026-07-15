<div align="center">
  <img src="public/logo.png" alt="Virlen Logo" width="120" height="120">
  <h1 align="center">Virlen</h1>
  <p align="center">
    All-in-One AI Agent Desktop Client — Multi-Model, Tool Calling, Vision, Skills
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

## 📖 Introduction

**Virlen** is a cross-platform AI Agent desktop application built with [Tauri v2](https://v2.tauri.app/). It's more than just an AI chat client — it's an **extensible AI Agent platform** that supports:

- **Multi-Model Providers**: Compatible with OpenAI, Anthropic, Gemini and other mainstream LLM APIs
- **Function Calling**: AI can autonomously perform file operations, command execution, web scraping, search, visual analysis, and more
- **On-Device Vision Engine**: Powered by [Quasivision](https://crates.io/crates/quasivision) — UI detection, OCR, object detection, and icon classification, all running locally without internet
- **Skill System**: Pluggable Skill mechanism that gives the AI domain-specific expertise
- **Security Mechanisms**: Path allowlist/blocklist, file access control, Shell sandbox execution, and StormBreaker tool-call storm protection for comprehensive system safety
- **Pause/Resume**: Supports pausing and resuming during Tool Call execution (Run Snapshot model)
- **Context Compression**: LLM-powered intelligent context compression for long conversations without token overflow
- **Search Providers**: Pluggable search provider architecture supporting Tavily, Bocha, SearXNG, and more

---

## 🚀 Quick Start

### Prerequisites

| Dependency                                     | Version |
| ---------------------------------------------- | ------- |
| [Node.js](https://nodejs.org/)                 | ≥ 18    |
| [pnpm](https://pnpm.io/)                       | ≥ 8     |
| [Rust](https://www.rust-lang.org/)             | ≥ 1.78  |
| [Tauri CLI](https://v2.tauri.app/start/cli/)   | ≥ 2.0   |

### Install & Run

```bash
# 1. Install frontend dependencies
pnpm install

# 2. Start development mode (frontend + Tauri desktop app)
pnpm tauri dev
```

Browser-only development mode (frontend only):

```bash
pnpm dev
```

Production build:

```bash
pnpm tauri build
```

---

## 🏗️ Architecture

Virlen adopts a **Hexagonal Architecture (Ports & Adapters)**, decoupling core business logic from infrastructure implementations.

```
src/
├── domain/           # Core Domain — pure business logic, no external dependencies
│   ├── agent/        # Agent models & system prompts (including context compression prompts)
│   ├── engine/       # Agent engine — orchestrates LLM, Tool, and Session interactions
│   │   ├── engine.ts          # Main engine flow (sendMessage)
│   │   ├── llm-round.ts       # Single LLM round management
│   │   ├── tool-executor.ts   # Tool executor (multi-step, pause/resume)
│   │   ├── run-state.ts       # Run state management
│   │   ├── compress-context.ts# LLM context compression
│   │   ├── storm-breaker.ts   # Tool call storm protection
│   │   └── types.ts           # Engine internal types
│   ├── ports/        # Port interface definitions (driving + driven)
│   │   ├── AgentEnginePort.ts   # Agent engine port
│   │   ├── ProviderPort.ts      # LLM Provider port
│   │   ├── SandboxPort.ts       # Sandbox execution port
│   │   ├── SearchProviderPort.ts# Search provider port
│   │   ├── SecurityPort.ts      # Security policy port
│   │   └── ToolRegistry.ts      # Tool registry interface
│   ├── provider/     # Provider domain models & configuration
│   ├── search/       # Search provider domain models (config, types, registry)
│   ├── security/     # Security policies — path allowlist/blocklist validation
│   └── tools/        # Tool definitions & executor interfaces
│
├── infrastructure/   # Infrastructure Layer — port implementations
│   ├── agentRepo/    # Agent persistence
│   ├── provider/     # LLM Provider implementations (OpenAI / Anthropic / Gemini)
│   ├── sandbox/      # Sandbox execution implementation (PluginShellSandbox)
│   ├── search-providers/ # Search provider implementations
│   │   ├── tavily.ts      # Tavily search
│   │   ├── bocha.ts       # Bocha search
│   │   ├── searxng.ts     # SearXNG self-hosted search
│   │   └── factory.ts     # Provider factory
│   ├── securityRepo/ # Security configuration persistence
│   ├── sessionRepo/  # Session persistence
│   ├── tools/        # Tool implementations
│   │   ├── builtin/      # Built-in tools (time, command execution, search, web fetch)
│   │   ├── file-tools/   # File operation tools (read, write, edit, copy, move, list, search)
│   │   ├── skill-tools/  # Skill management tools
│   │   └── vision/       # Vision analysis tools
│   └── vision/       # Vision service implementation
│
├── services/         # Application Service Layer — orchestrates business workflows
│   ├── agent-service.ts         # Agent service (prompt assembly)
│   ├── chat-service.ts          # Chat service (send messages, pause/resume)
│   ├── env-service.ts           # Environment info auto-detection
│   ├── export-service.ts        # Export service
│   ├── provider-service.ts      # Provider service
│   ├── search-provider-init.ts  # Search provider initialization
│   ├── search-provider-service.ts # Search provider management
│   ├── security-service.ts      # Security service
│   └── tool-service/            # Tool interaction service
│       ├── command_confirm.ts   # Command execution confirmation
│       ├── user_choice.ts       # User choice interaction
│       └── index.ts             # Tool service entry
│
├── ui/               # Frontend UI Layer (React + MobX + Sass)
│   ├── assets/       # Static assets (fonts, etc.)
│   ├── components/   # Common UI components
│   ├── constants/    # Constants (including quick action templates)
│   ├── hooks/        # Custom hooks (theme, font size, time)
│   ├── i18n/         # Internationalization (Chinese/English)
│   ├── layout/       # Window layout (frameless window)
│   ├── pages/        # Pages
│   │   ├── chat/         # Chat page
│   │   ├── Settings/     # Settings page
│   │   ├── setupFlow/    # First-time setup flow
│   │   └── test/         # Test page
│   ├── store/        # MobX state management
│   ├── styles/       # Global styles & theme variables
│   ├── App.tsx       # App root component
│   └── App.css       # Global CSS
│
├── events/           # Custom event bus (menu, settings, tool interactions, etc.)
├── skill/            # Skill system (loading, registration, management, store)
├── types/            # Global type definitions
└── utils/            # Utility functions (Diff, DB, EventEmitter, UUID, etc.)
```

### Core Engine Workflow

```
User Message → AgentEngine.sendMessage()
            │
            ├── Context Compression Check ← compressContext()
            │   └── Token limit exceeded → LLM summarizes & replaces early messages
            │
            ▼
      doLLMRound() ──→ Call LLM Provider (streaming output)
            │
            ├── Returns text → stream output to user
            │
            └── Returns tool_calls → createRun()
                        │
                        ├── StormBreaker Detection ← storm protection
                        │   └── Storm detected → throw interrupt, terminate loop
                        │
                        ▼
                  executeToolSteps()
                        │
                  ┌─────┴─────┐
                  │           │
               ┌──┴──┐   ┌───┴────┐
               │Sandbox│   │  User   │
               │ Exec  │   │Confirm  │
               └──┬──┘   └───┬────┘
                  │           │
                  ▼           ▼
            Continue Next   Pause waiting
            LLM Round       for user confirmation
                            then resume (Run Snapshot)
```

---

## 🔌 Supported LLM Providers

| Provider        | API Protocol          | Features                                                               |
| --------------- | --------------------- | ---------------------------------------------------------------------- |
| **OpenAI** Compat| `/v1/chat/completions`| Supports all OpenAI API-compatible services (including custom endpoints), tool calls, streaming |
| **Anthropic**   | Messages API          | Claude series models, tool calls, streaming                            |
| **Gemini**      | Gemini API            | Google models, tool calls, streaming                                   |

Supports custom Provider configuration (API Key, Base URL, model list), and `reasoningEffort` for different models (e.g., `low`/`medium`/`high` for o-series models). Custom HTTP Headers are also supported for special authentication needs.

---

## 🛠️ Built-in Tools

Virlen comes with a rich set of tools for the AI Agent:

| Category        | Tool Name              | Description                                                       |
| --------------- | ---------------------- | ----------------------------------------------------------------- |
| **File Ops**    | `read_file`            | Read file content (with line range, SHA256 hash validation)       |
|                 | `write_file`           | Write/overwrite files (auto-create parent directories)            |
|                 | `edit_file`            | Precise text replacement (with hash conflict detection, count control) |
|                 | `delete_file`          | Delete file or directory                                          |
|                 | `file_info`            | Get file/directory metadata                                       |
|                 | `copy_move_file`       | Copy or move files/directories                                    |
|                 | `list_files`           | List directory contents (recursive, max depth, hidden files)      |
|                 | `search_files_by_name` | Search by filename (plain text, regex, glob patterns)             |
|                 | `search_text_in_files` | Search file contents (Rust ripgrep-based, auto-skip binary files) |
| **Command Exec**| `execute_command`      | Execute shell commands (timeout, sandbox-safe execution)          |
| **Web Search**  | `web_search`           | Internet search (Tavily, Bocha, SearXNG multi-provider)          |
|                 | `web_fetch`            | Fetch web pages (HTML→Markdown conversion)                        |
| **Vision**      | `vision_analyze`       | On-device visual analysis (UI detection, OCR, 254 objects, 81 icons) |
| **System**      | `get_current_time`     | Get current time (with timezone parameter)                        |
| **Interaction** | `user_choice`          | Show choice dialog to user (single/multi-select)                  |
| **Skills**      | `list_skills`          | List all available skills                                         |
|                 | `read_skill_source`    | View skill source code directory and SKILL.md                     |

---

## 🧩 Skill System

Virlen supports injecting domain-specific expertise into the AI Agent through its **Skill mechanism**. Skills are defined in Markdown files, containing detailed domain knowledge, workflows, and constraints.

Built-in skills include:

| Skill                        | Description              |
| ---------------------------- | ------------------------ |
| 📝 `article-writer`          | Article writing assistant |
| 🎨 `canvas-design`           | Canva design tool        |
| 📋 `content-planner`         | Content planning         |
| 📋 `create-plan`             | Plan creation            |
| 🎮 `develop-web-game`        | Web game development     |
| 📄 `docx`                    | Word document generation |
| 🎬 `films-search`            | Movie search             |
| 🖌️ `frontend-design`         | Frontend design          |
| 📧 `imap-smtp-email`         | Email sending/receiving  |
| 🎵 `music-search`            | Music search             |
| 📑 `pdf`                     | PDF document processing  |
| 📊 `pptx`                    | PPT presentation generation |
| 🎞️ `remotion`                | Video generation         |
| 🎥 `seedance` / `seedream`   | AI video/image generation |
| 📈 `stock-analyzer`          | Stock analysis           |
| 📰 `stock-announcements`     | Stock announcement query |
| 🔍 `stock-explorer`          | Stock market data query  |
| 📰 `technology-news-search`  | Tech news search         |
| 🌤️ `weather`                 | Weather forecast         |
| 📗 `xlsx`                    | Excel spreadsheet generation |

---

## 🔒 Security Mechanisms

Virlen provides **multi-layered security protection**:

### File Access Security

- **Blocklist**: Automatically protects system-sensitive directories (e.g., Windows `C:/Windows`, macOS `/etc`, Linux `/etc/shadow`, etc.)
- **Allowlist**: Permits access to specific temporary directories
- **Working Directory**: Agent's working directory is accessible by default
- **Write Control**: Write operations are strictly limited to the allowlist and working directory
- **Cross-Platform**: Different default security policies for Windows / macOS / Linux

### Shell Sandbox Execution

- Secure sandbox based on `@tauri-apps/plugin-shell` — all command executions are sandbox-isolated
- High-risk commands prompt user confirmation dialog before execution
- Command execution timeout control prevents malicious long-running processes

### Tool Call Storm Protection (StormBreaker)

- Sliding window detection mechanism (window size: 6, threshold: 3)
- Detects repeated calls to the same (toolName, args) pattern
- Automatically interrupts execution when a storm pattern is detected, preventing infinite loops from consuming resources

---

## 🖼️ On-Device Vision Engine

Virlen features the built-in **Quasivision** vision engine (ONNX Runtime), with all visual analysis running locally — no internet connection required:

- **UI Element Detection**: Detect buttons, icons, images, text blocks, containers, and more
- **OCR Text Recognition**: PP-OCR v5 model, supports Chinese and English
- **Object Detection**: YOLOE-26n model, recognizes 254 everyday object categories
- **Icon Classification**: Recognizes 81 common icon meanings

> Vision model files are located in `src-tauri/resources/quasivision_models/` and are loaded automatically on first launch.

---

## 🧪 Technology Stack

### Frontend

| Technology                                                     | Usage                           |
| -------------------------------------------------------------- | ------------------------------- |
| [React 19](https://react.dev/)                                | UI framework                    |
| [TypeScript 5.8](https://www.typescriptlang.org/)             | Type safety                     |
| [Vite 7](https://vite.dev/)                                   | Build tool                      |
| [MobX 6](https://mobx.js.org/)                                | State management                |
| [Sass](https://sass-lang.com/)                                | CSS preprocessor                |
| [react-markdown](https://github.com/remarkjs/react-markdown)  | Markdown rendering              |
| [remark-gfm](https://github.com/remarkjs/remark-gfm)          | GFM extension (tables, task lists, etc.) |
| [PrismJS](https://prismjs.com/)                               | Code syntax highlighting        |
| [Vitest](https://vitest.dev/)                                 | Unit testing framework          |
| [Turndown](https://github.com/mixmark-io/turndown)            | HTML → Markdown conversion      |
| [Cheerio](https://cheerio.js.org/)                            | Server-side HTML parsing        |
| [JSZip](https://stuk.github.io/jszip/)                        | File packaging                  |

### Backend (Rust)

| Technology                                                | Usage                                       |
| --------------------------------------------------------- | ------------------------------------------- |
| [Tauri 2](https://v2.tauri.app/)                         | Desktop application framework               |
| [Serde](https://serde.rs/)                               | Serialization/deserialization               |
| [Walkdir](https://crates.io/crates/walkdir)              | Directory traversal                         |
| [Ignore](https://crates.io/crates/ignore)                | .gitignore rule matching                    |
| [Grep](https://crates.io/crates/grep) (ripgrep core)     | High-performance text search                |
| [Regex](https://crates.io/crates/regex)                  | Regular expression engine                   |
| [Sha2](https://crates.io/crates/sha2)                    | File hash validation (SHA256)               |
| [Quasivision](https://crates.io/crates/quasivision) 0.2  | On-device vision AI (ONNX Runtime + DirectML/CoreML) |
| [Tokio](https://tokio.rs/)                               | Async runtime                               |
| [Trash](https://crates.io/crates/trash)                  | Safe deletion to recycling bin              |
| [Image](https://crates.io/crates/image)                  | Image encoding/decoding                     |
| [Base64](https://crates.io/crates/base64)                | Base64 encoding/decoding                    |
| [Encoding_rs](https://crates.io/crates/encoding_rs)      | Multi-encoding support                      |

---

## 📦 Project Structure Overview

```
virlen-app/
├── public/                   # Static assets
├── src/                      # Frontend source (TypeScript + React)
│   ├── domain/               # Core domain layer
│   ├── infrastructure/       # Infrastructure (Provider, Tool implementations)
│   ├── services/             # Application services
│   ├── ui/                   # User interface
│   ├── skill/                # Skill system
│   ├── types/                # Type definitions
│   └── utils/                # Utility functions
├── src-tauri/                # Rust backend
│   ├── src/                  # Rust source code
│   │   ├── lib.rs            # Main entry (Tauri command registration)
│   │   ├── file_ops.rs       # File operations
│   │   ├── search.rs         # File search
│   │   ├── vision_service.rs # Vision service
│   │   ├── common_service.rs # Common service
│   │   ├── load_env.rs       # Environment info
│   │   └── task_manager.rs   # Task management (cancellation)
│   ├── resources/            # Resource files (skills, vision models)
│   │   ├── default-skills/   # Built-in skill definitions
│   │   └── quasivision_models/ # Vision AI models
│   ├── icons/                # App icons
│   └── tauri.conf.json       # Tauri configuration
├── tests/                   # Unit tests
│   ├── domain/               # Domain layer tests (compress-context, run-state, storm-breaker)
│   ├── services/             # Service layer tests
│   └── utils/                # Utility function tests
├── package.json              # Frontend dependencies & scripts
├── pnpm-lock.yaml            # Dependency lock
├── pnpm-workspace.yaml       # pnpm workspace config
├── vite.config.ts            # Vite build config
├── vitest.config.ts          # Vitest test config
├── tsconfig.json             # TypeScript config
├── tsconfig.node.json        # Node TypeScript config
└── index.html                # App entry HTML
```

---

## 🛠️ Development Commands

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `pnpm dev`          | Start frontend dev server (port 1420) |
| `pnpm build`        | Build frontend for production         |
| `pnpm tauri dev`    | Start Tauri desktop app dev mode      |
| `pnpm tauri build`  | Build desktop app installer           |
| `pnpm clean`        | Clean dist directory                  |
| `pnpm test`         | Run unit tests (Vitest)               |
| `pnpm test:watch`   | Run tests in watch mode               |
| `pnpm test:ui`      | Launch Vitest UI test panel           |

---

## 📄 License

This project is open-sourced under the MIT License.

---

<div align="center">
  <sub>Built with ❤️ using Tauri, React & Rust</sub>
</div>
