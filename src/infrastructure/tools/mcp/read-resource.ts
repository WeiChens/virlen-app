/**
 * read_mcp_resource — 按 URI 读取一个 MCP 资源
 *
 * ⚠️ 只有 Rust 原生实现（`virlen-core/src/agent/native_tools/mcp/`）：读取要经服务器的
 * `resources/read`，二进制内容也必须由 Rust 侧挡在模型上下文之外。工具描述在权威源
 * src-tauri/virlen-core/src/agent/tool_defs/definitions.json（机制 C）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { nativeOnly } from '../native-only'

toolRegistry.register(
  'read_mcp_resource',
  nativeOnly('read_mcp_resource') as ToolExecutor,
  t('读取 MCP 资源'),
)
