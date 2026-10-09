/**
 * kill_background_service — 杀掉某个后台服务（整棵进程树）
 *
 * ⚠️ 只有 Rust 原生实现：杀进程走 Rust 的 Job Object / 进程树强杀（前端拿不到进程句柄）。 见 ./common.ts 与
 * `virlen-core/src/agent/native_tools/service/`。工具描述在权威源
 * src-tauri/virlen-core/src/agent/tool_defs/definitions.json（机制 C）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { nativeOnly } from './common'

toolRegistry.register('kill_background_service', nativeOnly('kill_background_service') as ToolExecutor, t('终止后台服务'))
