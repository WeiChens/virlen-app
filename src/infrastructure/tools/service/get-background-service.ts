/**
 * get_background_service — 读某个后台服务的状态 / 增量输出 / 退出码
 *
 * ⚠️ 只有 Rust 原生实现：输出窗口与「已读游标」在 Rust 侧（读取口径必须与写入口径同源）。 见 ./common.ts 与
 * `virlen-core/src/agent/native_tools/service/`。工具描述在权威源
 * src-tauri/virlen-core/src/agent/tool_defs/definitions.json（机制 C）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { nativeOnly } from './common'

toolRegistry.register('get_background_service', nativeOnly('get_background_service') as ToolExecutor, t('查看后台服务'))
