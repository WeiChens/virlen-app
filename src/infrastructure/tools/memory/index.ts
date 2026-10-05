/**
 * memory — 长期记忆分类（分类 id: memory）
 *
 * 一个工具一个文件，import 即完成注册（toolRegistry.register 副作用）。
 * 公共函数见 ./common.ts；分类定义见 src/domain/tools/category.ts。
 *
 * ⚠️ 三个工具都已原生化：Rust 引擎走 `virlen-core/src/agent/native_tools/memory/`（默认路径），
 * 本目录是回退路径 —— 语义统一在 Rust（`agent::memory::tools`），这里只做转发。
 */
import './memory-search'
import './memory-recall'
import './memory-write'
