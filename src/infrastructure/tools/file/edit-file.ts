/**
 * edit_file — 精确文本替换（带 hash 冲突检测、多段编辑、替换次数控制）
 *
 * 底层调用 Rust `edit_file_multi_in_place`：同一 expected_hash10 下按顺序应用多条编辑。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { computeDiff, countDiffRows } from '@/utils/diff'
import { t } from '@/ui/i18n'
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
    'edit_file',
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
      throw 'Missing required parameter: "edits" (array)'
    }

    // 规范化 edits 参数：每个 edit 的 replace_count 默认 1，0 表示全部
    // （Rust 端会把 0 当作 usize::MAX，与单编辑时代的 999999 哨兵等价）
    const normalizedEdits = edits.map((e: any, i: number) => {
      const oldString = (e.old_string ?? '').toString()
      const newString = (e.new_string ?? '').toString()
      const replaceCount = (e.replace_count as number) ?? 1
      if (!oldString) {
        throw `Edit #${i + 1}: old_string is required and cannot be empty`
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

      // ⚠️ 模型侧固定英文（P4b/D2-A）。首行与 Rust `native_tools/file/edit_file.rs` 一致（铁律 1）。
      return {
        content:
          `✅ File edited: ${fullPath}` +
          '\n' +
          `  - ${result.edits.length} block(s) edited (${totalReplaced} replacement(s) total)\n` +
          `  - ${totalDel} line(s) removed, ${totalIns} line(s) added\n` +
          `  - ${result.line_count} lines total\n` +
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
        throw `Error: edit failed — ${msg}`
      }
      throw `Error: file edit failed — ${msg}`
    }
  }) as ToolExecutor,
    t('编辑文件'),
)
