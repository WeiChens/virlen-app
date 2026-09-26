/**
 * delete_file — 删除文件或目录（支持单个 path 与批量 paths，移入回收站）
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { isTauriFsAvailable } from './common'

toolRegistry.register(
    'delete_file',
    (async (
      args: Record<string, any>,
      ctx: ToolContext,
    ): Promise<ToolResult | string> => {
    if (!isTauriFsAvailable())
      return '[delete_file] Error: not running in a Tauri environment'

    // 兼容单个 path 与多个 paths；过滤空字符串
    const rawPaths: string[] = Array.isArray(args.paths)
      ? (args.paths as any[]).filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        )
      : typeof args.path === 'string' && args.path.trim() !== ''
        ? [args.path]
        : []

    if (rawPaths.length === 0) {
      return 'Error: no path to delete was provided (use a "paths" array, or a single "path" string)'
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
          errors.push(`Path does not exist — ${fullPath}`)
          continue
        }
        await invoke('move_to_trash', { path: fullPath })
        deleted.push(fullPath)
      } catch (e: any) {
        errors.push(`${fullPath} — ${e.message || String(e)}`)
      }
    }

    // ⚠️ 模型侧固定英文（P4b/D2-A）；UI 侧走 uiData。文案与 Rust
    // `native_tools/file/delete_file.rs` 逐字一致（铁律 1）。
    const parts: string[] = []
    if (deleted.length > 0) {
      parts.push(
        deleted.length === 1
          ? `🗑️ Moved to trash: ${deleted[0]}`
          : `🗑️ Moved ${deleted.length} item(s) to trash:\n${deleted
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (errors.length > 0) {
      parts.push(
        `⚠️ Failed to delete ${errors.length} item(s):\n${errors
          .map((e) => `  - ${e}`)
          .join('\n')}`,
      )
    }
    return { content: parts.join('\n'), uiData: { deleted, errors } }
  }) as ToolExecutor,
    t('删除文件'),
)
