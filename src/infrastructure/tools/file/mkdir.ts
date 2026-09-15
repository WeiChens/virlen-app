/**
 * mkdir — 创建目录（支持单个 path 与批量 paths，幂等：已存在视为成功）
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t, tpl } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { isTauriFsAvailable } from './common'

toolRegistry.register(
  {
    name: 'mkdir',
    label: t('创建目录'),
    description:
      'Create a directory (or directories). Pass "paths" (array) to create multiple directories in one call. ' +
      'By default creates parent directories if they do not exist (recursive=true). ' +
      'If a directory already exists, it is treated as success (idempotent).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path to create (relative to workspace or absolute). Use this for a single directory.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of directory paths to create in one call. Use this to batch-create multiple directories.',
        },
        recursive: {
          type: 'boolean',
          description:
            'Whether to create parent directories if they do not exist. Default: true.',
          default: true,
        },
      },
      oneOf: [{ required: ['path'] }, { required: ['paths'] }],
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!isTauriFsAvailable()) throw '[mkdir] 错误：当前不是 Tauri 环境'

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
      throw t('错误：请提供 "path" 或 "paths" 参数')
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

    const parts: string[] = []
    if (created.length > 0) {
      parts.push(
        created.length === 1
          ? `📁 ${tpl('已创建目录: $__path__', { path: created[0] })}`
          : `📁 ${tpl('已创建 $__count__ 个目录', { count: created.length })}:\n${created
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (existed.length > 0) {
      parts.push(
        existed.length === 1
          ? `ℹ️ ${tpl('目录已存在: $__path__', { path: existed[0] })}`
          : `ℹ️ ${tpl('已存在 $__count__ 个目录', { count: existed.length })}:\n${existed
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (errors.length > 0) {
      parts.push(
        `⚠️ ${tpl('有 $__count__ 个目录创建失败', {
          count: errors.length,
        })}:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
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
)
