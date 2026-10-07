/**
 * memory — 长期记忆分类（id: memory）；import 即注册（见 domain/tools/category.ts）。
 * ⚠️ 三个工具都已原生化：Rust 引擎走 virlen-core/src/agent/native_tools/memory/（默认路径），本目录是回退路径，
 * 只做转发，语义统一在 Rust（agent::memory::tools）。
 */
import './memory-search'
import './memory-recall'
import './memory-write'
