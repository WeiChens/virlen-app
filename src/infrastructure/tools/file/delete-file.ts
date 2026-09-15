/**
 * delete_file — 删除文件或目录（支持单个 path 与批量 paths，移入回收站）
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { isTauriFsAvailable } from './common'

toolRegistry.register(
  {
    name: 'delete_file',
    label: '删除文件',
    description:
      'Delete one or more files/directories. Accepts either "path" (single string) or "paths" (array of strings). ' +
      'Deleted items are moved to trash/recycle bin.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the file or directory to delete. Use this for a single item. (Deprecated in favor of "paths".)',
        },
        paths: {
          type: 'array',
          description:
            'Array of paths to delete. Use this to delete multiple files/directories in one call.',
          items: {
            type: 'string',
            description: 'Path to the file or directory to delete.',
          },
        },
      },
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    if (!isTauriFsAvailable()) return '[delete_file] 错误：当前不是 Tauri 环境'

    // 兼容单个 path 与多个 paths；过滤空字符串
    const rawPaths: string[] = Array.isArray(args.paths)
      ? (args.paths as any[]).filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        )
      : typeof args.path === 'string' && args.path.trim() !== ''
        ? [args.path]
        : []

    if (rawPaths.length === 0) {
      return '错误：未提供要删除的路径（请使用 "paths" 数组，或单个 "path" 字符串）'
    }

    const deleted: string[] = []
    const errors: string[] = []

    for (const raw of rawPaths) {
      const fullPath = await securityService.resolveSafePath(
        raw,
        'w',
        ctx.sessionId,
      )
      try {
        const exists = await tauriFs.exists(fullPath)
        if (!exists) {
          errors.push(`路径不存在 — ${fullPath}`)
          continue
        }
        await invoke('move_to_trash', { path: fullPath })
        deleted.push(fullPath)
      } catch (e: any) {
        errors.push(`${fullPath} — ${e.message || String(e)}`)
      }
    }

    const parts: string[] = []
    if (deleted.length > 0) {
      parts.push(
        deleted.length === 1
          ? `🗑️ 已移至回收站: ${deleted[0]}`
          : `🗑️ 已移至回收站 ${deleted.length} 项:\n${deleted
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (errors.length > 0) {
      parts.push(
        `⚠️ 有 ${errors.length} 项删除失败:\n${errors
          .map((e) => `  - ${e}`)
          .join('\n')}`,
      )
    }
    return parts.join('\n')
  }) as ToolExecutor,
)
