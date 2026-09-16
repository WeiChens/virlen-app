import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import type { DiffRow } from '@/utils/diff'
import type { Action } from './code-block'
import { toMonacoLang } from './code-block'
import { monaco, virlenDarkTheme } from '@/monaco/setupMonaco'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import './SideBySideDiff.scss'

/**
 * SideBySideDiff —— edit_file 的「原文件 / 新文件」左右对比视图。
 *
 * 从 tool-call/EditFileMessage.tsx 抽出为独立组件（含词法着色与全屏）。
 * 数据准备（把多处编辑合并成行）仍留在 EditFileMessage：那是 edit_file 工具的
 * uiData 结构知识，本组件只负责“给什么行就画什么行”。
 */

/** SideBySideDiff 可渲染的行：普通 diff 行 + 多处编辑之间的省略间隔行 */
export type SideBySideRow =
  | DiffRow
  | {
      type: 'gap'
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

/**
 * diff 正文（文件头 / 双栏表头 / 双栏内容）。
 *
 * 抽成独立组件是为了让「原位」与「全屏」两份各持一套 DOM ref：
 * 左右面板的滚动同步、列宽对齐都挂在 ref 上，两份共用一个实例会互相抢元素。
 * `isFull` 只切换类名，结构完全一致。
 */
function DiffContent({
  diffRows,
  fileName,
  stat,
  actions,
  fullscreen,
  onToggleFullscreen,
  isFull,
}: {
  diffRows: SideBySideRow[]
  fileName: string | null
  /** 汇总统计（多处编辑合并后展示新增/减少行数） */
  stat?: { delCount: number; insCount: number }
  /** 自定义操作按钮 */
  actions: Action[]
  /** 当前是否全屏（决定全屏按钮的图标/提示） */
  fullscreen: boolean
  onToggleFullscreen: () => void
  /** 是否渲染为全屏形态 */
  isFull: boolean
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
    <div className={`diff-side-by-side${isFull ? ' is-fullscreen' : ''}`}>
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
        <div className="diff-actions">
          {/* 内置全屏按钮：与调用方的 actions 同级，始终可用 */}
          <button
            className="diff-action-btn diff-fullscreen-btn"
            onClick={onToggleFullscreen}
            title={fullscreen ? t('退出全屏') : t('全屏')}>
            {fullscreen ? <ExitFullScreenSvg /> : <FullScreenSvg />}
          </button>
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

// ==================== 对外组件 ====================

/**
 * 左右对比 diff，内置「全屏」动作。
 *
 * 全屏与 CodeBlock / 终端块同构：原位照常渲染（不能卸载，否则虚拟列表条目会变矮、
 * 触发重测量把滚动锚点带偏），另用 createPortal 把「铺满」形态挂到 body 上，
 * 靠 position:fixed 逃出消息条目祖先的 transform / overflow。
 */
export function SideBySideDiff({
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
  // 全屏态：与 CodeBlock 一致，由组件自身管理，按钮放在文件头右侧
  const [fullscreen, setFullscreen] = useState(false)

  // Esc 退出全屏（与 CodeBlock / TerminalBlock 保持一致的操作习惯）
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  const renderContent = (isFull: boolean) => (
    <DiffContent
      diffRows={diffRows}
      fileName={fileName}
      stat={stat}
      actions={actions}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen(!fullscreen)}
      isFull={isFull}
    />
  )

  return (
    <>
      {/* 原位 diff：全屏时照样渲染 */}
      {renderContent(false)}
      {fullscreen &&
        createPortal(
          <div className="diff-fullscreen-layer">{renderContent(true)}</div>,
          document.body,
        )}
    </>
  )
}
