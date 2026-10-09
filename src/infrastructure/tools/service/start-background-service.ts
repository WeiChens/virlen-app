/**
 * start_background_service — 起一个**常驻**命令（dev server / 文件监听 / 长跑任务）
 *
 * ⚠️ 只有 Rust 原生实现：服务的进程、输出窗口、寿命都由 Rust 注册表管理（跨工具调用存活，前端无处安放这份状态）。 见 ./common.ts 与
 * `virlen-core/src/agent/native_tools/service/`。工具描述在权威源
 * src-tauri/virlen-core/src/agent/tool_defs/definitions.json（机制 C）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { nativeOnly } from './common'

toolRegistry.register('start_background_service', nativeOnly('start_background_service') as ToolExecutor, t('启动后台服务'))
