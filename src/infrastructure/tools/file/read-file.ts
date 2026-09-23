/**
 * read_file — 读取文件内容（支持行范围、多文件批量、超长行截断）
 *
 * 底层调用 Rust `read_file_with_hash`，返回 content + hash10（供 edit_file 做冲突检测）。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { t, tpl } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { formatSize } from './common'
// 截断必须代理对安全，否则 emoji 会被切成孤立代理（IPC 落库/桥接直接报错）
import { sliceHead } from '@/utils/text'

/** Rust read_file 返回类型 */
interface FileReadResult {
  content: string
  hash10: string
  line_count: number
  byte_size: number
}

toolRegistry.register(
  {
    name: 'read_file',
    label: t('读取文件'),
    description:
      'Read a file\'s content. Returns content, line count, size, and hash10 (short fingerprint) (for edit_file conflict detection). ' +
      'Pass "paths" (array) to read multiple files in one call — avoids N round-trips for N files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path (relative to workspace or absolute). Use this for a single file.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of file paths to read in one call. Use this to batch-read multiple files efficiently.',
        },
        start_line: {
          type: 'number',
          description:
            'Starting line number (1-indexed). Use this to read a specific section of a large file. ' +
            'When set, returns at most max_lines lines starting from this line. Default: 1.',
          default: 1,
        },
        max_lines: {
          type: 'number',
          description:
            'Max lines to read. Default is 2000. When start_line is used, this limits how many lines are returned.',
          default: 2000,
        },
        max_line_chars: {
          type: 'number',
          description:
            'Max characters per line. Default is 1600. ' +
            'Prevents token explosion from single very long lines ' +
            '(minified JS/CSS, long JSON/base64, etc.). Lines longer than this ' +
            'are truncated with a marker so the AI knows content is incomplete.',
          default: 1600,
        },
      },
      oneOf: [{ required: ['path'] }, { required: ['paths'] }],
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const maxLines = +(args.max_lines as number) || 2000
    const maxLineChars = +(args.max_line_chars as number) || 2000
    const startLine = Math.max(0, +(args.start_line as number) || 1)

    // 读取单个文件的核心逻辑（供 paths 批量复用）
    async function readSingleFile(
      rawPath: string,
    ): Promise<{ content: string; uiData: any }> {
      const fullPath = await securityService.resolveSafePath(
        rawPath,
        'r',
        ctx.sessionId,
      )
      const result: FileReadResult = await withCancelResult(
        ctx.abortSignal,
        invoke('read_file_with_hash', { path: fullPath }),
        () =>
          ({
            content: '',
            hash10: '',
            line_count: 0,
            byte_size: 0,
          }) as FileReadResult,
      )

      if (!result.hash10) {
        throw '[Cancelled] File read was cancelled.'
      }

      const lines = result.content.split('\n')
      const totalLines = lines.length
      const startIdx = Math.max(0, startLine - 1)

      const slice: string[] = []
      let truncatedLineCount = 0

      for (let i = startIdx; i < totalLines && slice.length < maxLines; i++) {
        const line = lines[i]
        if (line.length > maxLineChars) {
          const omitted = line.length - maxLineChars
          slice.push(
            `${sliceHead(line, maxLineChars)} … [已截断，省略 ${omitted} 字符]`,
          )
          truncatedLineCount++
        } else {
          slice.push(line)
        }
      }

      const displayStart = startIdx + 1
      const displayEnd = startIdx + slice.length
      const remainingLines = Math.max(0, totalLines - displayEnd)

      const headerLines = [
        `📄 ${fullPath}`,
        tpl('📝 $__lines__ 行 / $__size__', {
          lines: totalLines,
          size: formatSize(result.byte_size),
        }),
        `🔑 hash10: ${result.hash10}`,
        startLine > 1
          ? tpl('🔢 显示: 第 $__start__-$__end__ 行 (共 $__total__ 行)', {
              start: displayStart,
              end: displayEnd,
              total: totalLines,
            })
          : tpl('🔢 显示: 第 1-$__end__ 行 (共 $__total__ 行)', {
              end: displayEnd,
              total: totalLines,
            }),
      ]

      if (truncatedLineCount > 0) {
        headerLines.push(
          tpl(
            '💡 提示: 有 $__count__ 行内容过长，已按每行 $__max__ 字符截断。可增大 max_line_chars 参数读取更多内容',
            { count: truncatedLineCount, max: maxLineChars },
          ),
        )
      }
      if (startIdx > 0) {
        headerLines.push(
          tpl('💡 提示: 使用 start_line=$__line__ 读取后续内容', {
            line: displayEnd + 1,
          }),
        )
      }
      if (remainingLines > 0) {
        headerLines.push(
          tpl(
            '💡 提示: 文件内容未完整显示，剩余 $__remaining__ 行。使用 start_line=$__next__ 读取后续内容',
            { remaining: remainingLines, next: displayEnd + 1 },
          ),
        )
      }

      const displayedContent = slice.join('\n')
      return {
        content: headerLines.join('\n') + '\n\n' + displayedContent,
        uiData: {
          content: displayedContent,
          hash10: result.hash10,
          line_count: result.line_count,
          byte_size: result.byte_size,
          fullPath,
          startLine: displayStart,
          endLine: displayEnd,
        },
      }
    }

    try {
      // 支持 paths 数组（批量读取多个文件）
      const paths: string[] = Array.isArray(args.paths)
        ? (args.paths as any[]).filter(
            (p): p is string => typeof p === 'string' && p.trim() !== '',
          )
        : []

      if (paths.length > 0) {
        const results: { content: string; uiData: any }[] = []
        const errors: string[] = []

        for (const p of paths) {
          try {
            const r = await readSingleFile(p)
            results.push(r)
          } catch (e: any) {
            errors.push(`${p} — ${e.message || String(e)}`)
          }
        }

        if (results.length === 0 && errors.length > 0) {
          throw errors.join('\n')
        }

        // 文件之间用分隔线隔开
        const parts = results.map((r, i) =>
          i === 0 ? r.content : '\n---\n' + r.content,
        )
        if (errors.length > 0) {
          parts.push(
            `\n\n⚠️ 有 ${errors.length} 个文件读取失败:\n` +
              errors.map((e) => `  - ${e}`).join('\n'),
          )
        }

        const uiData =
          results.length === 1
            ? results[0].uiData // 单文件 → 保持原有 uiData 结构
            : { files: results.map((r) => r.uiData) }

        return {
          content: parts.join('\n'),
          uiData,
        }
      }

      // 单文件路径（向后兼容）
      const path = args.path as string
      if (!path) {
        throw t('错误：请提供 "path" 或 "paths" 参数')
      }
      const r = await readSingleFile(path)
      return { content: r.content, uiData: r.uiData }
    } catch (e: any) {
      throw tpl('错误：读取文件失败 — $__error__', {
        error: e.message || String(e),
      })
    }
  }) as ToolExecutor,
)
