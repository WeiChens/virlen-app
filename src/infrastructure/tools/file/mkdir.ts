/**
 * mkdir — 创建目录（支持单个 path 与批量 paths，幂等：已存在视为成功）
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { isTauriFsAvailable } from './common'

toolRegistry.register(
    'mkdir',
    (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!isTauriFsAvailable())
      throw '[mkdir] Error: not running in a Tauri environment'

    const recursive = args.recursive !== false

    // 兼容单个 path 与多个 paths；过滤空字符串
    const rawPaths: string[] = Array.isArray(args.paths)
      ? (args.paths as any[]).filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        )
      : typeof args.path === 'string' && args.path.trim() !== ''
        ? [args.path]
        : []

    if (rawPaths.length === 0) {
      throw 'Error: provide either the "path" or the "paths" parameter'
    }

    const created: string[] = []
    const existed: string[] = []
    const errors: string[] = []

    for (const raw of rawPaths) {
      const fullPath = await securityService.resolveSafePath(
        raw,
        'w',
        ctx.sessionId,
      )
      try {
        const alreadyExists = await tauriFs.exists(fullPath)
        if (alreadyExists) {
          existed.push(fullPath)
          continue
        }
        await tauriFs.mkdir(fullPath, { recursive })
        created.push(fullPath)
      } catch (e: any) {
        errors.push(`${fullPath} — ${e.message || String(e)}`)
      }
    }

    // ⚠️ 模型侧固定英文（P4b/D2-A）；UI 侧走 uiData。文案与 Rust
    // `native_tools/file/mkdir.rs` 逐字一致（铁律 1）。
    const parts: string[] = []
    if (created.length > 0) {
      parts.push(
        created.length === 1
          ? `📁 Directory created: ${created[0]}`
          : `📁 Created ${created.length} directories:\n${created
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (existed.length > 0) {
      parts.push(
        existed.length === 1
          ? `ℹ️ Directory already exists: ${existed[0]}`
          : `ℹ️ ${existed.length} directories already exist:\n${existed
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (errors.length > 0) {
      parts.push(
        `⚠️ Failed to create ${errors.length} directories:\n${errors
          .map((e) => `  - ${e}`)
          .join('\n')}`,
      )
    }

    if (created.length === 0 && existed.length === 0 && errors.length > 0) {
      throw errors.join('\n')
    }

    return {
      content: parts.join('\n'),
      uiData: {
        created,
        existed,
        errors,
      },
    }
  }) as ToolExecutor,
    t('创建目录'),
)
