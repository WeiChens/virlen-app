import { t, tpl } from '@/ui/i18n'
import { getFileParentDir, getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import {
  buildDiffRows,
  diffStats,
  NL_MARK,
  normalizeDiffRows,
  type DiffRow,
} from '@/utils/diff'
import { diffLines } from 'diff'
import CodeBlock from '../message/code-block'
import { MonacoDiffView } from '../message/MonacoDiffView'
import type { SideBySideRow } from '../message/SideBySideDiff'
import { editorService } from '@/services/editor-service'
import { openPath } from '@tauri-apps/plugin-opener'
import FolderSvg from '@/ui/components/icons/FolderSvg'

/** uiData.edits 中单个编辑记录 */
type EditUiRecord = {
  oldStartLine: number
  oldEndLine: number
  newEndLine: number
  oldString: string
  newString: string
  diffRows?: unknown
  delCount?: number
  insCount?: number
}

/** 汇总多个编辑的新增/减少行数 */
function sumEditStats(
  edits?: EditUiRecord[],
): { delCount: number; insCount: number } | null {
  if (!edits || edits.length === 0) return null
  let delCount = 0
  let insCount = 0
  for (const e of edits) {
    if (e.delCount != null) delCount += e.delCount
    if (e.insCount != null) insCount += e.insCount
  }
  // 兼容旧数据：部分编辑项缺少统计时，直接从 diff 行数一次
  const needCount = edits.some(
    (e) => e.delCount == null || e.insCount == null,
  )
  if (needCount) {
    for (const e of edits) {
      if (e.delCount == null || e.insCount == null) {
        const s = diffStats(resolveEditRows(e))
        delCount += s.delCount
        insCount += s.insCount
      }
    }
  }
  return { delCount, insCount }
}

/**
 * 单个编辑的 diffRows。⚠️ 落库的是历史数据，老行模型交给 `normalizeDiffRows` 归一；
 * 完全没存过才现算（行号从 `oldStartLine` 起，显示绝对行号）。
 */
function resolveEditRows(edit: EditUiRecord): DiffRow[] {
  if (edit.diffRows) return normalizeDiffRows(edit.diffRows)
  return buildDiffRows(
    edit.oldString ?? '',
    edit.newString ?? '',
    edit.oldStartLine,
  )
}

/**
 * 同一文件多处编辑 → 逐行展示数据。保留各处编辑里的未改动行，让用户看得到中间相同部分；
 * 仅当行号跳跃、手里确实没有中间内容时才插入省略行（否则会把不相连的两段伪造成连续）。
 */
function mergeEditRows(edits: EditUiRecord[]): SideBySideRow[] {
  const sorted = [...edits].sort((a, b) => a.oldStartLine - b.oldStartLine)
  const result: SideBySideRow[] = []
  let prevOldEnd: number | null = null
  let prevNewEnd: number | null = null
  for (const edit of sorted) {
    const rows = resolveEditRows(edit)
    if (rows.length === 0) continue

    // 找出本段第一行带行号的 old/new 起始行，判断与上一段是否“没有数据可填”
    let firstOld: number | null = null
    let firstNew: number | null = null
    for (const row of rows) {
      if (firstOld == null && row.leftLineNo != null) firstOld = row.leftLineNo
      if (firstNew == null && row.rightLineNo != null) firstNew = row.rightLineNo
      if (firstOld != null && firstNew != null) break
    }
    const missingMiddle =
      (prevOldEnd != null &&
        firstOld != null &&
        firstOld > prevOldEnd + 1) ||
      (prevNewEnd != null &&
        firstNew != null &&
        firstNew > prevNewEnd + 1)
    if (missingMiddle) result.push({ type: 'gap' })

    for (const row of rows) {
      result.push(row)
      if (row.leftLineNo != null) prevOldEnd = row.leftLineNo
      if (row.rightLineNo != null) prevNewEnd = row.rightLineNo
    }
  }
  return result
}

/**
 * 「工具没给那段内容」的占位行：**两侧都插** —— 两边相同才被 Monaco 当未改动行，
 * 既保住「不相邻的两段不伪装成连续」，也不会被算成一处差异。
 */
const GAP_PLACEHOLDER = '⋯'

interface FoldedSide {
  lines: string[]
  /** 每一行的**文件绝对行号**（`null` = 占位行，不给行号） */
  numbers: (number | null)[]
}

/**
 * 行模型折回「一侧的文本行 + 逐行行号」。⚠️ `lineNo == null` 是**续行**（另一侧在那里断行），
 * 必须接在上一行后面不能换行；`↵` 是展示标记，不进文本。
 */
function foldSide(rows: SideBySideRow[], side: 'old' | 'new'): FoldedSide {
  const lines: string[] = []
  const numbers: (number | null)[] = []
  for (const row of rows) {
    if (row.type === 'gap') {
      lines.push(GAP_PLACEHOLDER)
      numbers.push(null)
      continue
    }
    const parts = side === 'old' ? row.left : row.right
    // 这一侧本来就没有这一行（新增行的左半 / 删除行的右半）
    if (parts.length === 0) continue
    const text = parts.map((p) => (p.value === NL_MARK ? '' : p.value)).join('')
    const lineNo = side === 'old' ? row.leftLineNo : row.rightLineNo
    if (lineNo == null && lines.length > 0) {
      lines[lines.length - 1] += text
      continue
    }
    lines.push(text)
    numbers.push(lineNo)
  }
  return { lines, numbers }
}

/** 逐行行号映射：合成文本的第 N 行 → 文件里的绝对行号（占位行给空串，不编号） */
function numberMapper(side: FoldedSide) {
  return (line: number): string => {
    const no = side.numbers[line - 1]
    return no == null ? '' : String(no)
  }
}

/**
 * 行模型 → `MonacoDiffView` 输入：Monaco 只吃两份全文，必须把片段折回文本。
 * `colHeaderNote` 仅行号首尾连续时给，否则为 null（与 DOM 版同口径）。
 */
export function toMonacoDiffInput(rows: SideBySideRow[]) {
  const old = foldSide(rows, 'old')
  const nw = foldSide(rows, 'new')
  const note = (side: FoldedSide): string | null => {
    const known = side.numbers.filter((n): n is number => n != null)
    if (known.length === 0) return null
    const contiguous = known.every((n, i) => i === 0 || n === known[i - 1] + 1)
    return contiguous ? `Ln ${known[0]}–${known[known.length - 1]}` : null
  }
  return {
    oldText: old.lines.join('\n'),
    newText: nw.lines.join('\n'),
    lineNumbers: { old: numberMapper(old), new: numberMapper(nw) },
    colHeaderNote: { old: note(old), new: note(nw) },
  }
}

class EditFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'edit_file'
  }
  getToolLabel(_type: string): string {
    return t('编辑文件')
  }
  getShortText(props: ToolMessageProps) {
    try {
      const input = props.useContent.input
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      const shortPath = toShortPath(input.path || '', workspace)

      // 多编辑模式：优先用工具结果里的精确统计，未完成时用输入粗略估算
      if (Array.isArray(input.edits) && input.edits.length > 0) {
        const uiEdits = (props.message?.uiData as
          | { edits?: EditUiRecord[] }
          | undefined)?.edits
        let delCount = 0
        let insCount = 0
        if (Array.isArray(uiEdits) && uiEdits.length > 0) {
          const s = sumEditStats(uiEdits)
          delCount = s?.delCount ?? 0
          insCount = s?.insCount ?? 0
        } else {
          for (const e of input.edits) {
            const oldText = String(e.old_string ?? '')
            const newText = String(e.new_string ?? '')
            if (oldText) delCount += oldText.split('\n').length
            if (newText) insCount += newText.split('\n').length
          }
        }
        const parts: string[] = []
        if (delCount > 0)
          parts.push(tpl('减少 $__count__行', { count: delCount }))
        if (insCount > 0)
          parts.push(tpl('新增 $__count__行', { count: insCount }))
        if (parts.length === 0) parts.push(t('无变更'))
        return (
          <div className="tool-short-row">
            <span className="tool-short-em">{shortPath}</span>
            <span className="tool-short-muted">{parts.join(',')}</span>
          </div>
        )
      }

      const {
        old_string,
        new_string,
        replace_count = 1,
      } = input

      if (replace_count !== 1) {
        return (
          tpl('替换 $__count__ 项', { count: replace_count }) + `: ${shortPath}`
        )
      }

      // 优先从 uiData 读取已由工具层计算好的 diff 统计（避免重复计算）
      const uiData = props.message?.uiData as
        | { delCount?: number; insCount?: number }
        | undefined

      if (uiData?.delCount != null && uiData?.insCount != null) {
        const parts: string[] = []
        if (uiData.delCount > 0)
          parts.push(tpl('减少 $__count__行', { count: uiData.delCount }))
        if (uiData.insCount > 0)
          parts.push(tpl('新增 $__count__行', { count: uiData.insCount }))
        if (parts.length === 0) parts.push(t('无变更'))
        return `${shortPath} ${parts.join(',')}`
      }

      // 降级：无 uiData 时用旧方法（纯行数统计）
      const newRowlen = new_string.split('\n').length
      const oldRowlen = old_string.split('\n').length
      return (
        tpl('减少 $__old__行,新增 $__new__行', {
          old: oldRowlen,
          new: newRowlen,
        }) + `: ${shortPath}`
      )
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    try {
      return this.renderExpandView(props)
    } catch (err) {
      console.error('[EditFileMessage] getExpandView failed:', err)
      return <div className="error">{t('内容渲染失败')}</div>
    }
  }

  private renderExpandView(props: ToolMessageProps): React.ReactNode {
    if (!props.expand) return null
    const { path, old_string, new_string } = props.useContent?.input ?? {}
    const uiData = props.message?.uiData as
      | {
        fullPath?: string
        oldStartLine?: number
        oldEndLine?: number
        newEndLine?: number
        oldString?: string
        newString?: string
        diffRows?: unknown
        edits?: EditUiRecord[]
      }
      | undefined

    const name = getUrlFileName(path, '')

    if (props.message?.isError) {
      return <div className="error">{props.message?.content as string}</div>
    }

    if (Array.isArray(uiData?.edits) && uiData.edits.length > 0) {
      const filePath = uiData?.fullPath || path
      const edits = uiData.edits
      const multi = edits.length > 1

      // 同一文件内的多处编辑：合并成一个 diff 展示
      const diffRows: SideBySideRow[] = multi
        ? mergeEditRows(edits)
        : resolveEditRows(edits[0])

      return (
        <div className="diff-mono-wrapper">
          <MonacoDiffView
            autoCenter
            autoHeight
            showHeader
            fileName={name}
            {...toMonacoDiffInput(diffRows)}
            actions={[
              {
                title: t('文件资源管理器打开'),
                iconRender() {
                  return <FolderSvg />
                },
                onClick() {
                  const parentDir = getFileParentDir(filePath)
                  openPath(parentDir)
                },
              },
              {
                title: t('编辑器打开'),
                iconRender() {
                  return (
                    <svg
                      viewBox="0 0 1024 1024"
                      version="1.1"
                      xmlns="http://www.w3.org/2000/svg"
                      width="200"
                      height="200">
                      <path
                        d="M438.4 849.1l222.7-646.7c0.2-0.5 0.3-1.1 0.4-1.6L438.4 849.1z"
                        opacity=".224"></path>
                      <path d="M661.2 168.7h-67.5c-3.4 0-6.5 2.2-7.6 5.4L354.7 846c-0.3 0.8-0.4 1.7-0.4 2.6 0 4.4 3.6 8 8 8h67.8c3.4 0 6.5-2.2 7.6-5.4l0.7-2.1 223.1-648.3 7.4-21.4c0.3-0.8 0.4-1.7 0.4-2.6-0.1-4.5-3.6-8.1-8.1-8.1zM954.6 502.1c-0.8-1-1.7-1.9-2.7-2.7l-219-171.3c-3.5-2.7-8.5-2.1-11.2 1.4-1.1 1.4-1.7 3.1-1.7 4.9v81.3c0 2.5 1.1 4.8 3.1 6.3l115 90-115 90c-1.9 1.5-3.1 3.8-3.1 6.3v81.3c0 4.4 3.6 8 8 8 1.8 0 3.5-0.6 4.9-1.7l219-171.3c6.9-5.4 8.2-15.5 2.7-22.5zM291.1 328.1l-219 171.3c-1 0.8-1.9 1.7-2.7 2.7-5.4 7-4.2 17 2.7 22.5l219 171.3c1.4 1.1 3.1 1.7 4.9 1.7 4.4 0 8-3.6 8-8v-81.3c0-2.5-1.1-4.8-3.1-6.3l-115-90 115-90c1.9-1.5 3.1-3.8 3.1-6.3v-81.3c0-1.8-0.6-3.5-1.7-4.9-2.7-3.5-7.7-4.1-11.2-1.4z"></path>
                    </svg>
                  )
                },
                onClick() {
                  editorService.openFile({
                    filePath,
                  })
                },
              },
            ]}
          />
        </div>
      )
    }

    if (uiData?.oldStartLine) {
      const filePath = uiData?.fullPath || path
      // 同一份行模型：存过的按老口径归一，没存过才现场算
      const rows = uiData.diffRows
        ? normalizeDiffRows(uiData.diffRows)
        : buildDiffRows(
            uiData.oldString ?? old_string ?? '',
            uiData.newString ?? new_string ?? '',
            uiData.oldStartLine,
          )
      return (
        <div className="diff-mono-wrapper">
          <MonacoDiffView
            autoCenter
            autoHeight
            showHeader
            fileName={name}
            {...toMonacoDiffInput(rows)}
            actions={[
              {
                title: t('文件资源管理器打开'),
                iconRender() {
                  return <FolderSvg />
                },
                onClick() {
                  const parentDir = getFileParentDir(filePath)
                  openPath(parentDir)
                },
              },
              {
                title: t('编辑器打开'),
                iconRender() {
                  return (
                    <svg
                      viewBox="0 0 1024 1024"
                      version="1.1"
                      xmlns="http://www.w3.org/2000/svg"
                      p-id="16625"
                      width="200"
                      height="200">
                      <path
                        d="M438.4 849.1l222.7-646.7c0.2-0.5 0.3-1.1 0.4-1.6L438.4 849.1z"
                        opacity=".224"
                        p-id="16626"></path>
                      <path d="M661.2 168.7h-67.5c-3.4 0-6.5 2.2-7.6 5.4L354.7 846c-0.3 0.8-0.4 1.7-0.4 2.6 0 4.4 3.6 8 8 8h67.8c3.4 0 6.5-2.2 7.6-5.4l0.7-2.1 223.1-648.3 7.4-21.4c0.3-0.8 0.4-1.7 0.4-2.6-0.1-4.5-3.6-8.1-8.1-8.1zM954.6 502.1c-0.8-1-1.7-1.9-2.7-2.7l-219-171.3c-3.5-2.7-8.5-2.1-11.2 1.4-1.1 1.4-1.7 3.1-1.7 4.9v81.3c0 2.5 1.1 4.8 3.1 6.3l115 90-115 90c-1.9 1.5-3.1 3.8-3.1 6.3v81.3c0 4.4 3.6 8 8 8 1.8 0 3.5-0.6 4.9-1.7l219-171.3c6.9-5.4 8.2-15.5 2.7-22.5zM291.1 328.1l-219 171.3c-1 0.8-1.9 1.7-2.7 2.7-5.4 7-4.2 17 2.7 22.5l219 171.3c1.4 1.1 3.1 1.7 4.9 1.7 4.4 0 8-3.6 8-8v-81.3c0-2.5-1.1-4.8-3.1-6.3l-115-90 115-90c1.9-1.5 3.1-3.8 3.1-6.3v-81.3c0-1.8-0.6-3.5-1.7-4.9-2.7-3.5-7.7-4.1-11.2-1.4z"></path>
                    </svg>
                  )
                },
                onClick() {
                  editorService.openFile({
                    filePath,
                  })
                },
              },
            ]}
          />
        </div>
      )
    }

    // 无 uiData（兼容旧版）→ 统一 diff
    const diff = generateFallbackDiff(old_string ?? '', new_string ?? '')
    return (
      <div
        style={{
          padding: '0 10px',
          margin: '0px 20px',
          width: 'fit-content',
        }}>
        <CodeBlock
          autoCenter
          className="language-diff"
          maxHeight={450}
          width={600}
          fileName={name}
          showLineNumbers={false}>
          {diff}
        </CodeBlock>
      </div>
    )
  }

  diyWrapper(): boolean {
    return true
  }
}

const FALLBACK_CONTEXT = 3

/** 把 diff 片段的 value 拆成行（末尾换行不算一行，与内核同一口径） */
function partLines(value: string): string[] {
  const v = value.replace(/\r\n/g, '\n')
  if (v === '') return []
  const lines = v.split('\n')
  if (v.endsWith('\n')) lines.pop()
  return lines
}

/**
 * 无 uiData 的老消息兜底：两侧文本折成统一 diff 文本交给 CodeBlock（差异仍由 `utils/diff` 内核算），
 * 首尾未改动块各留 3 行上下文。
 */
function generateFallbackDiff(oldStr: string, newStr: string): string {
  const parts = diffLines(oldStr, newStr)
  const out: string[] = []
  parts.forEach((part, i) => {
    const lines = partLines(part.value)
    if (part.added) out.push(...lines.map((line) => `+${line}`))
    else if (part.removed) out.push(...lines.map((line) => `-${line}`))
    else {
      // 首块只留末尾 3 行、末块只留开头 3 行（夹在中间的未改动块照常整段保留）
      const first = i === 0 && parts.length > 1
      const last = i === parts.length - 1 && parts.length > 1
      const kept = first
        ? lines.slice(-FALLBACK_CONTEXT)
        : last
          ? lines.slice(0, FALLBACK_CONTEXT)
          : lines
      out.push(...kept.map((line) => ` ${line}`))
    }
  })
  return out.join('\n')
}

export default EditFileMessage
