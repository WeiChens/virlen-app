import { useRef, useCallback, useLayoutEffect } from 'react'
import { t, tpl } from '@/ui/i18n'
import { getFileParentDir, getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import type { DiffRow } from '@/utils/diff'
import { computeDiff } from '@/utils/diff'
import type { Action } from '../message/code-block'
import CodeBlock, { toMonacoLang } from '../message/code-block'
import { monaco, virlenDarkTheme } from '@/monaco/setupMonaco'
import { editorService } from '@/services/editor-service'
import { openPath } from '@tauri-apps/plugin-opener'
import FolderSvg from '@/ui/components/icons/FolderSvg'

// ==================== 类型与工具函数 ====================

/** uiData.edits 中单个编辑记录 */
type EditUiRecord = {
  oldStartLine: number
  oldEndLine: number
  newEndLine: number
  oldString: string
  newString: string
  diffRows?: DiffRow[]
  delCount?: number
  insCount?: number
}

/** SideBySideDiff 可渲染的行：普通 diff 行 + 多处编辑之间的省略间隔行 */
type SideBySideRow =
  | DiffRow
  | {
    type: 'gap'
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
        for (const row of resolveEditRows(e)) {
          if (row.type === 'delete') delCount++
          else if (row.type === 'insert') insCount++
        }
      }
    }
  }
  return { delCount, insCount }
}

/** 获取单个编辑的 diffRows（缺省时现场计算） */
function resolveEditRows(edit: EditUiRecord): DiffRow[] {
  if (edit.diffRows) return edit.diffRows
  return computeDiff(
    (edit.oldString ?? '').split('\n'),
    (edit.newString ?? '').split('\n'),
    edit.oldStartLine,
  )
}

/**
 * 把同一文件里的多处编辑合并成一行行的展示数据。
 *
 * 保留每处编辑里的未改动行（equal，即 old/new 共有的上下文/中间相同行），
 * 让用户能看到“中间一样的部分”，而不是全部折叠成 ⋯。
 * 仅在工具返回的数据里确实没有中间内容（行号跳跃、无法展示相同行）时，
 * 才插入一行省略分隔，避免把互不相连的两段代码伪造成连续。
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
      if (firstOld == null && row.oldLineNum != null) firstOld = row.oldLineNum
      if (firstNew == null && row.newLineNum != null) firstNew = row.newLineNum
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
      if (row.oldLineNum != null) prevOldEnd = row.oldLineNum
      if (row.newLineNum != null) prevNewEnd = row.newLineNum
    }
  }
  return result
}

// ==================== Monaco 行内词法着色（左右对比的代码行） ====================
//
// diff 是“左右栏 + 逐行红/绿底 + 行号”的自定义布局，无法整段塞进 Monaco 编辑器。
// 因此这里用 Monaco 的 Monarch 词法器对每一行单独切词，再按 virlen-dark 主题规则
// 上色，视觉上和 CodePreview（Monaco 代码块）保持一致。

type DiffToken = { offset: number; type: string }

const _lineTokenCache = new Map<string, DiffToken[]>()

/** 用 Monaco Monarch 对单行做词法切分（每行独立起点，适配 diff 只显示变更行的场景） */
function tokenizeDiffLine(line: string, language: string): DiffToken[] {
  const key = `${language}\u0000${line}`
  const hit = _lineTokenCache.get(key)
  if (hit) return hit
  let tokens: DiffToken[] = []
  try {
    const rows = monaco.editor.tokenize(
      line,
      language,
    ) as unknown as DiffToken[][]
    tokens = rows && rows[0] ? rows[0] : []
  } catch {
    tokens = []
  }
  if (_lineTokenCache.size > 3000) {
    const oldest = _lineTokenCache.keys().next().value
    if (oldest !== undefined) _lineTokenCache.delete(oldest)
  }
  _lineTokenCache.set(key, tokens)
  return tokens
}

/** 按主题规则匹配 token 颜色（越具体的规则优先级越高） */
function diffTokenStyle(
  tokenType: string,
): { color?: string; fontStyle?: string } {
  let best: (typeof virlenDarkTheme.rules)[number] | undefined
  let bestDepth = -1
  for (const rule of virlenDarkTheme.rules) {
    const t = rule.token
    if (!t) continue
    if (tokenType === t || tokenType.startsWith(t + '.')) {
      const d = t.split('.').length
      if (d > bestDepth) {
        bestDepth = d
        best = rule
      }
    }
  }
  return { color: best?.foreground, fontStyle: best?.fontStyle }
}

/** 单行代码用 virlen-dark 主题上色（无语言时按纯文本输出） */
function DiffCode({
  text,
  language,
}: {
  text: string
  language?: string
}) {
  if (!text) return null
  if (!language) return <>{text}</>
  const tokens = tokenizeDiffLine(text, language)
  if (tokens.length === 0) return <>{text}</>
  const nodes: React.ReactNode[] = []
  let pos = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.offset < pos) continue
    if (tok.offset > pos) {
      nodes.push(text.slice(pos, tok.offset))
    }
    const end = i + 1 < tokens.length ? tokens[i + 1].offset : text.length
    const seg = text.slice(tok.offset, end)
    if (seg) {
      const st = diffTokenStyle(tok.type)
      const style: React.CSSProperties = { color: st.color ?? '#abb2bf' }
      if (st.fontStyle === 'italic') style.fontStyle = 'italic'
      nodes.push(
        <span key={i} style={style}>
          {seg}
        </span>,
      )
    }
    pos = end
  }
  if (pos < text.length) nodes.push(text.slice(pos))
  return <>{nodes}</>
}

/** 根据文件名推断 Monaco language id（复用 code-block 的语言映射） */
function diffLanguageFromName(fileName: string | null): string | undefined {
  const base = (fileName || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : base
  return toMonacoLang(ext)
}

// ==================== 左右对比面板 ====================

function SideBySideDiff({
  diffRows,
  fileName,
  stat,
  actions = [] as Action[],
}: {
  diffRows: SideBySideRow[]
  fileName: string | null
  /** 汇总统计（多处编辑合并后展示新增/减少行数） */
  stat?: { delCount: number; insCount: number }
  /** 自定义操作按钮 */
  actions?: Action[]
}) {
  // 有汇总统计时说明是多处编辑合并展示，行号区间不再连续，隐藏区间
  const showStat = stat != null

  // diff 代码行用该语言做 Monaco 词法着色
  const codeLang = diffLanguageFromName(fileName)

  // 从 diffRows 推导起始行号和行数（仅单段 diff 时展示区间）
  const startLine = (() => {
    if (showStat) return null
    for (const row of diffRows) {
      if (row.type === 'gap') continue
      if (row.oldLineNum != null) return row.oldLineNum
      if (row.newLineNum != null) return row.newLineNum
    }
    return 1
  })()
  const oldLineCount = showStat
    ? 0
    : diffRows.filter((r) => r.type !== 'insert' && r.type !== 'gap').length
  const newLineCount = showStat
    ? 0
    : diffRows.filter((r) => r.type !== 'delete' && r.type !== 'gap').length

  const oldPanelRef = useRef<HTMLDivElement>(null)
  const newPanelRef = useRef<HTMLDivElement>(null)
  const oldColRef = useRef<HTMLDivElement>(null)
  const newColRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)

  // 渲染后对齐 scrollWidth：让两列内容区等宽
  useLayoutEffect(() => {
    const oldCol = oldColRef.current
    const newCol = newColRef.current
    if (!oldCol || !newCol) return
    const maxW = Math.max(oldCol.scrollWidth, newCol.scrollWidth, 400)
    if (maxW > 0) {
      oldCol.style.width = maxW + 'px'
      newCol.style.width = maxW + 'px'
    }
  }, [diffRows])

  // 双向同步 scrollTop + scrollLeft
  const syncScroll = useCallback((source: 'old' | 'new') => {
    if (syncing.current) return
    syncing.current = true
    const oldEl = oldPanelRef.current
    const newEl = newPanelRef.current
    if (!oldEl || !newEl) {
      syncing.current = false
      return
    }
    if (source === 'old') {
      newEl.scrollTop = oldEl.scrollTop
      newEl.scrollLeft = oldEl.scrollLeft
    } else {
      oldEl.scrollTop = newEl.scrollTop
      oldEl.scrollLeft = newEl.scrollLeft
    }
    requestAnimationFrame(() => {
      syncing.current = false
    })
  }, [])

  return (
    <div className="diff-side-by-side">
      {/* 文件头 */}
      <div className="diff-header">
        <span className="diff-header-name">{fileName}</span>
        {/* {stat && (stat.delCount > 0 || stat.insCount > 0) && (
          <span className="diff-stat">
            {stat.delCount > 0 && (
              <span className="diff-stat--del">
                {tpl('减少 $__count__行', { count: stat.delCount })}
              </span>
            )}
            {stat.insCount > 0 && (
              <span className="diff-stat--ins">
                {tpl('新增 $__count__行', { count: stat.insCount })}
              </span>
            )}
          </span>
        )} */}
        {actions.length > 0 && (
          <div className="diff-actions">
            {actions.map((action) => (
              <button
                key={action.title}
                className="diff-action-btn"
                onClick={action.onClick}
                title={action.title}>
                {action.iconRender ? action.iconRender() : null}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 双栏表头 */}
      <div className="diff-column-headers">
        <div className="diff-col-header diff-col-header--old">
          {t('原文件')}
          {!showStat && startLine != null && (
            <span className="diff-col-range">
              Ln {startLine}–{startLine + oldLineCount - 1}
            </span>
          )}
        </div>
        <div className="diff-col-header diff-col-header--new">
          {t('新文件')}
          {!showStat && startLine != null && (
            <span className="diff-col-range">
              Ln {startLine}–{startLine + newLineCount - 1}
            </span>
          )}
        </div>
      </div>

      {/* 双栏内容（各自独立滚动，scroll 双向同步） */}
      <div className="diff-body">
        {/* --- 旧列 --- */}
        <div
          className="diff-panel diff-panel--old"
          ref={oldPanelRef}
          onScroll={() => syncScroll('old')}>
          <div className="diff-col" ref={oldColRef}>
            {diffRows.map((row, i) => {
              if (row.type === 'gap') {
                return (
                  <div key={i} className="diff-line diff-line--gap">
                    <span className="diff-linenum"></span>
                    <span className="diff-code">⋯</span>
                  </div>
                )
              }
              return (
                <div
                  key={i}
                  className={`diff-line${row.type === 'delete' ? ' diff-line--highlight-old' : ''}`}>
                  <span className="diff-linenum">{row.oldLineNum ?? ''}</span>
                  <span className="diff-code">
                    <DiffCode
                      text={row.oldLine != null ? row.oldLine || ' ' : ''}
                      language={codeLang}
                    />
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* --- 新列 --- */}
        <div
          className="diff-panel diff-panel--new"
          ref={newPanelRef}
          onScroll={() => syncScroll('new')}>
          <div className="diff-col" ref={newColRef}>
            {diffRows.map((row, i) => {
              if (row.type === 'gap') {
                return (
                  <div key={i} className="diff-line diff-line--gap">
                    <span className="diff-linenum"></span>
                    <span className="diff-code">⋯</span>
                  </div>
                )
              }
              return (
                <div
                  key={i}
                  className={`diff-line${row.type === 'insert' ? ' diff-line--highlight-new' : ''}`}>
                  <span className="diff-linenum">{row.newLineNum ?? ''}</span>
                  <span className="diff-code">
                    <DiffCode
                      text={row.newLine != null ? row.newLine || ' ' : ''}
                      language={codeLang}
                    />
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ==================== 主类 ====================

class EditFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'edit_file'
  }
  getToolLabel(_type: string): string {
    return t('编辑文件')
  }
  getShortText(props: ToolMessageProps): string {
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
        return `${shortPath} ${parts.join(',')}`
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
        diffRows?: DiffRow[]
        edits?: EditUiRecord[]
      }
      | undefined

    const name = getUrlFileName(path, null)

    if (props.message?.isError) {
      return <div className="error">{props.message?.content as string}</div>
    }

    // ===== 编辑模式：uiData.edits 数组（单/多编辑统一结构） =====
    if (Array.isArray(uiData?.edits) && uiData.edits.length > 0) {
      const filePath = uiData?.fullPath || path
      const edits = uiData.edits
      const multi = edits.length > 1

      // 同一文件内的多处编辑：合并成一个 diff 展示
      const diffRows: SideBySideRow[] = multi
        ? mergeEditRows(edits)
        : resolveEditRows(edits[0])
      const stat = multi ? sumEditStats(edits) : null

      return (
        <div className="diff-wrapper">
          <SideBySideDiff
            diffRows={diffRows}
            fileName={name}
            stat={stat ?? undefined}
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

    // ===== 旧版单编辑模式 uiData（无 edits 数组） =====
    if (uiData?.oldStartLine) {
      const filePath = uiData?.fullPath || path
      return (
        <div className="diff-wrapper">
          <SideBySideDiff
            diffRows={
              uiData.diffRows ??
              computeDiff(
                (uiData.oldString ?? old_string ?? '').split('\n'),
                (uiData.newString ?? new_string ?? '').split('\n'),
                uiData.oldStartLine,
              )
            }
            fileName={name}
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

// ==================== 后备：unified diff（无行号数据时用） ====================

function generateFallbackDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')

  let prefixLen = 0
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] ===
    newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const result: string[] = []

  const ctxBefore = Math.min(prefixLen, 3)
  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) {
    result.push(' ' + oldLines[i])
  }
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    result.push('-' + oldLines[i])
  }
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    result.push('+' + newLines[i])
  }
  const ctxAfter = Math.min(suffixLen, 3)
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    result.push(' ' + oldLines[i])
  }

  return result.join('\n')
}

export default EditFileMessage
