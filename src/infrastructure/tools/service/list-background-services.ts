/**
 * list_background_services — 列出**本会话**的后台服务
 *
 * ⚠️ 只有 Rust 原生实现：「本会话有哪些服务」是 Rust 注册表的事实，前端没有第二份可查。 见 ./common.ts 与
 * `virlen-core/src/agent/native_tools/service/`。工具描述在权威源
 * src-tauri/virlen-core/src/agent/tool_defs/definitions.json（机制 C）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { nativeOnly } from './common'

toolRegistry.register('list_background_services', nativeOnly('list_background_services') as ToolExecutor, t('列出后台服务'))
