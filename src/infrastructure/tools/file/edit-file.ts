/**
 * edit_file — 精确文本替换（带 hash 冲突检测、多段编辑、替换次数控制）
 *
 * 底层调用 Rust `edit_file_multi_in_place`：同一 expected_hash10 下按顺序应用多条编辑。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { computeDiff, countDiffRows } from '@/utils/diff'
import { t, tpl } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type {
  ToolContext,
  ToolExecutor,
  ToolExecutorResponse,
} from '@/domain/tools/types'
import { securityService } from '@/services/security-service'

/** Rust edit_file_multi 单次编辑结果 */
interface SingleEditResult {
  replaced_count: number
  old_start_line: number
  old_string_context: string
  new_string_context: string
}

/** Rust edit_file_multi 返回类型 */
interface FileEditMultiResult {
  hash10: string
  line_count: number
  edits: SingleEditResult[]
}

toolRegistry.register(
  {
    name: 'edit_file',
    label: t('编辑文件'),
    description:
      'Replace exact text in a file. Requires expected_hash10 from read_file (conflict detection). Prefer for partial edits over write_file. ' +
      'Use the "edits" array to apply one or more edits in a single call — each edit is { old_string, new_string, replace_count }.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (relative to workspace or absolute).',
        },
        edits: {
          type: 'array',
          description:
            'Array of edits to apply sequentially in one file. Each item: { old_string, new_string, replace_count }. ' +
            'All edits share the same expected_hash10 and are applied in order on the same content. ' +
            'Use this instead of multiple edit_file calls to avoid hash conflicts between edits.',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description:
                  'The exact existing text to replace. Include enough surrounding context for a unique match.',
              },
              new_string: {
                type: 'string',
                description: 'The new text to insert in place of old_string.',
              },
              replace_count: {
                type: 'number',
                description:
                  'How many occurrences of old_string to replace. Default: 1. Set to 0 to replace all.',
                default: 1,
              },
            },
            required: ['old_string', 'new_string'],
          },
        },
        expected_hash: {
          type: 'string',
          description:
            'The hash10 value of the current file content, obtained from read_file output. ' +
            'Used for conflict detection to ensure no one modified the file since you read it.',
        },
      },
      required: ['path', 'edits', 'expected_hash'],
    },
  },
  (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolExecutorResponse> => {
    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'w',
      ctx.sessionId,
    )
    const expectedHash = args.expected_hash as string

    const edits = Array.isArray(args.edits) ? args.edits : []
    if (edits.length === 0) {
      throw t('错误：请提供 "edits" 参数（至少一项编辑）')
    }

    // 规范化 edits 参数：每个 edit 的 replace_count 默认 1，0 表示全部
    // （Rust 端会把 0 当作 usize::MAX，与单编辑时代的 999999 哨兵等价）
    const normalizedEdits = edits.map((e: any, i: number) => {
      const oldString = (e.old_string ?? '').toString()
      const newString = (e.new_string ?? '').toString()
      const replaceCount = (e.replace_count as number) ?? 1
      if (!oldString) {
        throw tpl('错误：第 $__n__ 处编辑的 old_string 不能为空', {
          n: i + 1,
        })
      }
      return {
        old_string: oldString,
        new_string: newString,
        replace_count: replaceCount,
      }
    })

    try {
      const result: FileEditMultiResult = await withCancelResult(
        ctx.abortSignal,
        invoke('edit_file_multi_in_place', {
          path: fullPath,
          edits: normalizedEdits,
          expectedHash,
        }),
        () => {
          throw new Error('[Cancelled] File edit was cancelled.')
        },
      )

      // 为每个编辑计算 diff
      const uiEdits = result.edits.map((e: SingleEditResult) => {
        const oldLineCount = e.old_string_context.split('\n').length
        const newLineCount = e.new_string_context.split('\n').length
        const diffRows = computeDiff(
          e.old_string_context.split('\n'),
          e.new_string_context.split('\n'),
          e.old_start_line,
        )
        const { delCount, insCount } = countDiffRows(diffRows)
        return {
          oldStartLine: e.old_start_line,
          oldEndLine: e.old_start_line + oldLineCount - 1,
          newEndLine: e.old_start_line + newLineCount - 1,
          oldString: e.old_string_context,
          newString: e.new_string_context,
          replacedCount: e.replaced_count,
          diffRows,
          delCount,
          insCount,
        }
      })

      const totalReplaced = result.edits.reduce(
        (sum, e) => sum + e.replaced_count,
        0,
      )
      const totalDel = uiEdits.reduce((s, e) => s + e.delCount, 0)
      const totalIns = uiEdits.reduce((s, e) => s + e.insCount, 0)

      return {
        content:
          tpl('✅ 已编辑文件: $__path__', { path: fullPath }) +
          '\n' +
          `  - ${tpl('编辑 $__count__ 处（共替换 $__replaced__ 次）', {
            count: result.edits.length,
            replaced: totalReplaced,
          })}\n` +
          `  - ${tpl('减少 $__del__行,新增 $__ins__行', {
            del: totalDel,
            ins: totalIns,
          })}\n` +
          `  - ${tpl('共 $__count__ 行', { count: result.line_count })}\n` +
          `  - hash10: ${result.hash10}`,
        uiData: {
          fullPath,
          hash10: result.hash10,
          edits: uiEdits,
        },
      }
    } catch (e: any) {
      const msg = e.message || String(e)
      if (
        msg.includes('old_string not found') ||
        msg.includes('appears') ||
        msg.includes('Conflict') ||
        msg.includes('Cannot read')
      ) {
        throw tpl('错误：编辑失败 — $__msg__', { msg })
      }
      throw tpl('错误：编辑文件失败 — $__msg__', { msg })
    }
  }) as ToolExecutor,
)
