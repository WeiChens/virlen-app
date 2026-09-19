import { Fragment, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import type { DiffRow } from '@/utils/diff'
import type { Action } from './code-block'
import { toMonacoLang } from './code-block'
import { monaco, virlenDarkTheme } from '@/monaco/setupMonaco'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
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
 * 一行里的其中一半（左半=原文件 / 右半=新文件）。
 *
 * 两半是**同一个 grid 行的两个格子**（都由 .diff-body 承载），所以：
 * - 两侧列宽天然各占一半（不需要再量宽、写 --diff-col-w）；
 * - 行高由 grid 行决定 → 一侧折行时另一侧那一格跟着变高，左右不会逐行错位。
 */
function DiffHalf({
  side,
  row,
  language,
}: {
  side: 'old' | 'new'
  row: SideBySideRow
  language?: string
}) {
  const isOld = side === 'old'

  // 多处编辑之间的省略间隔行：两侧各画一个 ⋯（与整行底色一起连成一条横带）
  if (row.type === 'gap') {
    return (
      <div className={`diff-line diff-line--${side} diff-line--gap`}>
        <span className="diff-linenum"></span>
        <span className="diff-code">⋯</span>
      </div>
    )
  }

  const lineNum = isOld ? row.oldLineNum : row.newLineNum
  const line = isOld ? row.oldLine : row.newLine
  const highlight = isOld ? row.type === 'delete' : row.type === 'insert'
  const highlightClass = highlight
    ? isOld
      ? ' diff-line--highlight-old'
      : ' diff-line--highlight-new'
    : ''

  return (
    <div className={`diff-line diff-line--${side}${highlightClass}`}>
      <span className="diff-linenum">{lineNum ?? ''}</span>
      <span className="diff-code">
        <DiffCode text={line != null ? line || ' ' : ''} language={language} />
      </span>
    </div>
  )
}

/**
 * diff 正文（文件头 / 双栏表头 / 每一行的左右两半）。
 *
 * 「原位」与「全屏」各渲染一份：两边可用宽度不同（全屏铺满窗口），所以列宽不能写死 ——
 * 交给 CSS 的 grid 1fr 1fr 按各自容器算，这也是不再需要 JS 量宽的原因。
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
  blockRef,
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
  /** 原位那份的根节点 ref（居中用；全屏副本不接，避免 ref 被覆盖） */
  blockRef?: React.Ref<HTMLDivElement>
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

  return (
    <div
      className={`diff-side-by-side${isFull ? ' is-fullscreen' : ''}`}
      ref={isFull ? undefined : blockRef}>
      {/* 文件头（固定，不随内容滚动） */}
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

      {/* 唯一的滚动容器（只纵向滚动）：双栏表头 + 每一行的左右两半都在里面。
          横向不再需要滚动 —— 超长行会在各自那一半里折行。 */}
      <div className="diff-body">
        {/* 双栏表头（吸顶：纵向钉住、横向跟着两列走） */}
        <div className="diff-column-headers">
          <div className="diff-col-header diff-col-header--old">
            {/* 标签自己粘左边缘：横向滚到这一列时不会被推出视野 */}
            <span className="diff-col-header-label">
              {t('原文件')}
              {!showStat && startLine != null && (
                <span className="diff-col-range">
                  Ln {startLine}–{startLine + oldLineCount - 1}
                </span>
              )}
            </span>
          </div>
          <div className="diff-col-header diff-col-header--new">
            <span className="diff-col-header-label">
              {t('新文件')}
              {!showStat && startLine != null && (
                <span className="diff-col-range">
                  Ln {startLine}–{startLine + newLineCount - 1}
                </span>
              )}
            </span>
          </div>
        </div>

        {/* 每一行：左半、右半成对落进同一个 grid 行 */}
        {diffRows.map((row, i) => (
          <Fragment key={i}>
            <DiffHalf side="old" row={row} language={codeLang} />
            <DiffHalf side="new" row={row} language={codeLang} />
          </Fragment>
        ))}
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
  autoCenter = false,
}: {
  diffRows: SideBySideRow[]
  fileName: string | null
  /** 汇总统计（多处编辑合并后展示新增/减少行数） */
  stat?: { delCount: number; insCount: number }
  /** 自定义操作按钮 */
  actions?: Action[]
  /** 用户展开该 diff 时是否滚动到视口中间（见 useAutoCenter） */
  autoCenter?: boolean
}) {
  // 全屏态：与 CodeBlock 一致，由组件自身管理，按钮放在文件头右侧
  const [fullscreen, setFullscreen] = useState(false)
  // 「打开即居中」：hook 只能在组件顶层无条件调用（不能放进 EditFileMessage 的类方法里，见 §11）
  const rootRef = useAutoCenter(autoCenter)

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
      blockRef={rootRef}
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
