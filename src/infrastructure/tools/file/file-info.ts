/**
 * file_info — 获取文件/目录元信息（类型、大小、访问/修改时间）
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { formatSize, isTauriFsAvailable } from './common'

toolRegistry.register(
  {
    name: 'file_info',
    label: '文件信息',
    description: 'Get metadata about a file or directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file or directory.' },
      },
      required: ['path'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    if (!isTauriFsAvailable()) return '[file_info] 错误：当前不是 Tauri 环境'

    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'r',
      ctx.sessionId,
    )

    try {
      const exists = await tauriFs.exists(fullPath)
      if (!exists) return `错误：路径不存在 — ${fullPath}`

      const stat = await tauriFs.stat(fullPath)

      return [
        `📋 ${fullPath}`,
        `  类型: ${stat.isDirectory ? '📁 目录' : '📄 文件'}`,
        stat.size !== undefined ? `  大小: ${formatSize(stat.size)}` : '',
        stat.atime ? `  访问时间: ${stat.atime.toLocaleString('zh-CN')}` : '',
        stat.mtime ? `  修改时间: ${stat.mtime.toLocaleString('zh-CN')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch (e: any) {
      return `错误：获取信息失败 — ${e.message || String(e)}`
    }
  }) as ToolExecutor,
)
