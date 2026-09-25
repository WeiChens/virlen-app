/**
 * read_file — 读取文件内容（支持行范围、多文件批量、超长行截断）
 *
 * 底层调用 Rust `read_file_with_hash`，返回 content + hash10（供 edit_file 做冲突检测）。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { t } from '@/ui/i18n'
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
    'read_file',
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
            `${sliceHead(line, maxLineChars)} … [truncated, ${omitted} chars omitted]`,
          )
          truncatedLineCount++
        } else {
          slice.push(line)
        }
      }

      const displayStart = startIdx + 1
      const displayEnd = startIdx + slice.length
      const remainingLines = Math.max(0, totalLines - displayEnd)

      // ⚠️ 模型侧固定英文（P4b/D2-A）；UI 侧走 uiData 由组件渲染。
      // 文案与 Rust `native_tools/file/read_file.rs` 一致（铁律 1）。
      const headerLines = [
        `📄 ${fullPath}`,
        `📝 ${totalLines} lines / ${formatSize(result.byte_size)}`,
        `🔑 hash10: ${result.hash10}`,
        startLine > 1
          ? `🔢 Showing: lines ${displayStart}-${displayEnd} (total ${totalLines} lines)`
          : `🔢 Showing: lines 1-${displayEnd} (total ${totalLines} lines)`,
      ]

      if (truncatedLineCount > 0) {
        headerLines.push(
          `💡 Tip: ${truncatedLineCount} line(s) too long, truncated to ${maxLineChars} chars per line. Increase max_line_chars to read more`,
        )
      }
      if (startIdx > 0) {
        headerLines.push(`💡 Tip: use start_line=${displayEnd + 1} to read more`)
      }
      if (remainingLines > 0) {
        headerLines.push(
          `💡 Tip: content truncated, ${remainingLines} lines remaining. Use start_line=${displayEnd + 1} to read more`,
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
            `\n\n⚠️ Failed to read ${errors.length} file(s):\n` +
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
        throw 'Missing required parameter: "path" or "paths"'
      }
      const r = await readSingleFile(path)
      return { content: r.content, uiData: r.uiData }
    } catch (e: any) {
      throw `Error: failed to read file — ${e.message || String(e)}`
    }
  }) as ToolExecutor,
    t('读取文件'),
)
