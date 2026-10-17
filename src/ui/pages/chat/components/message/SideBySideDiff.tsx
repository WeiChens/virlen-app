import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import { NL_MARK, maxDiffWidthCh, type DiffRow } from '@/utils/diff'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import type { Action } from './code-block'
import { toMonacoLang } from './code-block'
import { monaco, virlenDarkTheme } from '@/monaco/setupMonaco'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import './SideBySideDiff.scss'

/**
 * 「原文件 / 新文件」左右对比视图（含词法着色与全屏）。行数据由调用方准备，本组件画什么说什么。
 * 每侧是一串行内片段（equal / removed / added），所以改动行有行内高亮而不是整行一色。
 *
 * showHeader=false：调用方已有标题栏（git 差异弹窗）。
 * singleSide：只有一侧有内容时只画那一栏（今天无生产调用方，保留是因为已测的 DOM 形态）。
 */

/** 可渲染的行：普通 diff 行 + 多处编辑之间的省略间隔行 */
export type SideBySideRow =
  | DiffRow
  | {
      type: 'gap'
    }

// diff 是自定义布局，无法整段塞进 Monaco，故用 Monarch 词法器逐行切词后上色。

type DiffToken = { offset: number; type: string }

const _lineTokenCache = new Map<string, DiffToken[]>()

/** 用 Monarch 对单行切词（每行独立起点） */
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

/**
 * token 类型 → 颜色，按类型记忆（逐个 token 扫 40 条规则在大文件上是一笔真开销，实测 50ms → 1.3ms）。
 */
const _tokenStyleCache = new Map<
  string,
  { color?: string; fontStyle?: string }
>()

/** 按主题规则匹配 token 颜色（越具体优先），结果按类型记忆 */
function diffTokenStyle(
  tokenType: string,
): { color?: string; fontStyle?: string } {
  const hit = _tokenStyleCache.get(tokenType)
  if (hit) return hit
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
  const style = { color: best?.foreground, fontStyle: best?.fontStyle }
  _tokenStyleCache.set(tokenType, style)
  return style
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

/** 根据文件名推断 Monaco language id（与 code-block 同一映射） */
export function diffLanguageFromName(fileName: string | null): string | undefined {
  const base = (fileName || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : base
  return toMonacoLang(ext)
}

/** diff 的一栏：左=原文件 / 右=新文件 */
export type DiffSide = 'old' | 'new'

/**
 * 某一栏的纯文本（菜单「全选 → 复制」用，不序列化 DOM 选区 —— 那会把行号拼进去）。
 * 换行标记 ↵ 是展示标记，不进剪贴板。
 */
function diffSideText(rows: SideBySideRow[], side: DiffSide): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.type === 'gap') continue
    const parts = side === 'old' ? row.left : row.right
    // 单侧行：这一侧本来就没有这一行（新增行的左半 / 删除行的右半）
    if (parts.length === 0) continue
    lines.push(
      parts.map((part) => (part.value === NL_MARK ? '' : part.value)).join(''),
    )
  }
  return lines.join('\n')
}

/**
 * 节点落在哪一栏（右键落点 / 选区起点）；两栏之外返回 null。两栏列头也带 --old / --new。
 */
function diffSideOf(node: Node | null): DiffSide | null {
  let el = node instanceof Element ? node : (node?.parentElement ?? null)
  while (el) {
    if (
      el.classList.contains('diff-line--old') ||
      el.classList.contains('diff-col-header--old')
    ) {
      return 'old'
    }
    if (
      el.classList.contains('diff-line--new') ||
      el.classList.contains('diff-col-header--new')
    ) {
      return 'new'
    }
    el = el.parentElement
  }
  return null
}

/**
 * 一行里的其中一半（左半进左栏 / 右半进右栏）。两栏行按序号一一对应，行高由行盒决定。
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

  // 多处编辑之间的省略间隔行：两侧各画一个 ⋯
  if (row.type === 'gap') {
    return (
      <div className={`diff-line diff-line--${side} diff-line--gap`}>
        <span className="diff-linenum"></span>
        <span className="diff-code">⋯</span>
      </div>
    )
  }

  const lineNum = isOld ? row.leftLineNo : row.rightLineNo
  const parts = isOld ? row.left : row.right
  // 高亮：这一侧的内容真的变了才高亮（removed 只影响左半、added 只影响右半）
  const highlight =
    row.type === 'modified' || (isOld ? row.type === 'removed' : row.type === 'added')
  const highlightClass = highlight
    ? isOld
      ? ' diff-line--highlight-old'
      : ' diff-line--highlight-new'
    : ''
  // 字符级底色只给 modified 行：整行新增 / 删除没有「哪几个字」可言，套上会让它们深一档
  const charLevel = row.type === 'modified'

  return (
    <div className={`diff-line diff-line--${side}${highlightClass}`}>
      <span className="diff-linenum">{lineNum ?? ''}</span>
      <span className="diff-code">
        {parts.length === 0
          ? ' '
          : parts.map((part, i) =>
              // 未改动片段不包节点（节点数也少一截）
              part.type === 'equal' || !charLevel ? (
                <DiffCode key={i} text={part.value} language={language} />
              ) : (
                <span
                  key={i}
                  className={`diff-part diff-part--${part.type}${
                    part.value === NL_MARK ? ' diff-part--nl' : ''
                  }`}>
                  <DiffCode text={part.value} language={language} />
                </span>
              ),
            )}
      </span>
    </div>
  )
}

/**
 * diff 正文（文件头 + 两栏列头与行）。原位与全屏各一份：内容宽度由行数据算出（--diff-max-ch），
 * 两份天然一致，isFull 只切类名。
 */
function DiffContent({
  diffRows,
  fileName,
  stat,
  actions,
  fullscreen,
  onToggleFullscreen,
  showHeader,
  singleSide,
  isFull,
  blockRef,
  onContextMenu,
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
  /** 是否画文件头；调用方已写路径时关掉 */
  showHeader: boolean
  /** 只有一侧有内容时只画这一栏 */
  singleSide?: DiffSide
  /** 是否渲染为全屏形态 */
  isFull: boolean
  /** 原位那份的根节点 ref（全屏副本不接，避免 ref 被覆盖） */
  blockRef?: React.Ref<HTMLDivElement>
  /** 右键（原位 / 全屏两份共用一个菜单状态，故回传事件） */
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}) {
  // 有汇总统计说明是多处编辑合并展示，行号区间不连续，隐藏区间
  const showStat = stat != null

  // diff 代码行用该语言做 Monaco 词法着色
  const codeLang = diffLanguageFromName(fileName)

  // 单栏：只画有内容的那一侧，另一栏连表头一起不画
  const single = singleSide ?? null
  const showOld = single === null || single === 'old'
  const showNew = single === null || single === 'new'

  // 从 diffRows 推导起始行号与行数（仅单段 diff 时展示区间）
  const startLine = (() => {
    if (showStat) return null
    for (const row of diffRows) {
      if (row.type === 'gap') continue
      if (row.leftLineNo != null) return row.leftLineNo
      if (row.rightLineNo != null) return row.rightLineNo
    }
    return 1
  })()
  /** 行数按「这一侧有内容的行」数 */
  const counted = showStat
    ? []
    : diffRows.filter((r): r is DiffRow => r.type !== 'gap')
  const oldLineCount = counted.filter((r) => r.left.length > 0).length
  const newLineCount = counted.filter((r) => r.right.length > 0).length

  // 横向滚动范围由最长一行决定（为什么不用 max-content 见 utils/diff::maxDiffWidthCh）
  const maxWidthCh = maxDiffWidthCh(diffRows)

  /** 左右栏各自的滚动容器（同步滚动用；单栏时另一侧为 null） */
  const paneOldRef = useRef<HTMLDivElement | null>(null)
  const paneNewRef = useRef<HTMLDivElement | null>(null)

  /**
   * 一栏滚动 → 另一栏跟着走。先比对再写：写下去会让对方也发一次 scroll，值相等直接返回不会来回弹。
   */
  function syncPanes(e: React.UIEvent<HTMLDivElement>) {
    const src = e.currentTarget
    const dst =
      src === paneOldRef.current ? paneNewRef.current : paneOldRef.current
    if (!dst) return
    if (dst.scrollTop !== src.scrollTop) dst.scrollTop = src.scrollTop
    if (dst.scrollLeft !== src.scrollLeft) dst.scrollLeft = src.scrollLeft
  }

  return (
    <div
      className={`diff-side-by-side${isFull ? ' is-fullscreen' : ''}${
        single ? ' is-single' : ''
      }`}
      ref={isFull ? undefined : blockRef}
      onContextMenu={onContextMenu}>
      {/* 文件头（固定，不随内容滚动）—— 调用方已经有了自己的标题栏时才画 */}
      {showHeader && (
        <div className="diff-header">
          <span className="diff-header-name">{fileName}</span>
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
      )}

      {/* 两栏各一个滚动容器：超长行不折行、一栏一条横向滚动条，位置互相跟随；内容宽由 --diff-max-ch 给出 */}
      <div
        className="diff-body"
        style={{ '--diff-max-ch': String(maxWidthCh) } as React.CSSProperties}>
        {/*
         * 左栏整栏在前、右栏在后（DOM 顺序）：浏览器选区是文档顺序上的连续区间，交错渲染会让
         * 选区跨行时带上另一栏，复制出来也是交错的。
         */}
        {showOld && (
          <div
            className="diff-pane diff-pane--old"
            ref={paneOldRef}
            onScroll={syncPanes}>
            <div className="diff-pane-inner">
              {/* 列头长在这一栏的滚动容器里：纵向吸顶，横向跟着内容走、标签粘左边缘 */}
              <div className="diff-col-header diff-col-header--old">
                <span className="diff-col-header-label">
                  {t('原文件')}
                  {!showStat && startLine != null && (
                    <span className="diff-col-range">
                      Ln {startLine}–{startLine + oldLineCount - 1}
                    </span>
                  )}
                </span>
              </div>
              {diffRows.map((row, i) => (
                <DiffHalf
                  key={`old-${i}`}
                  side="old"
                  row={row}
                  language={codeLang}
                />
              ))}
            </div>
          </div>
        )}
        {showNew && (
          <div
            className="diff-pane diff-pane--new"
            ref={paneNewRef}
            onScroll={syncPanes}>
            <div className="diff-pane-inner">
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
              {diffRows.map((row, i) => (
                <DiffHalf
                  key={`new-${i}`}
                  side="new"
                  row={row}
                  language={codeLang}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 左右对比 diff，内置全屏：原位照常渲染（卸载会让虚拟列表条目变矮、锚点跑偏），
 * 另用 portal 把铺满形态挂 body。
 */
export function SideBySideDiff({
  diffRows,
  fileName,
  stat,
  actions = [] as Action[],
  autoCenter = false,
  showHeader = true,
  singleSide,
}: {
  diffRows: SideBySideRow[]
  fileName: string | null
  /** 汇总统计（多处编辑合并后展示新增/减少行数） */
  stat?: { delCount: number; insCount: number }
  /** 自定义操作按钮 */
  actions?: Action[]
  /** 用户展开该 diff 时是否滑到视口中间 */
  autoCenter?: boolean
  /**
   * 是否画文件头，默认画。关掉的场景：调用方标题栏已写了路径，再画一遍就重复。
   */
  showHeader?: boolean
  /**
   * 只有一侧有内容时只画这一栏；调用方按内容判（singleSideOf）。
   */
  singleSide?: DiffSide
}) {
  // 全屏按钮在文件头右侧（与 CodeBlock 一致）
  const [fullscreen, setFullscreen] = useState(false)
  // 「打开即居中」只能在顶层无条件调用，不能放进 EditFileMessage 的类方法
  const rootRef = useAutoCenter(autoCenter)
  /**
   * diff 专属右键菜单：窗口全局 preventDefault 了原生 contextmenu，而 diff 内容最常被拖选，
   * 只能自补「复制 / 全选」。target 记右键落在哪一栏。
   */
  const menu = useContextMenu<DiffSide>()
  /** 右键那一刻的那一份实例（全选只在它里面选） */
  const menuRootRef = useRef<HTMLDivElement | null>(null)
  /**
   * 菜单要复制的文本，开菜单那一刻快照：菜单项是 button，mousedown 会把 window 选区弄丢。
   */
  const menuTextRef = useRef('')

  // Esc 退出全屏（与 CodeBlock / TerminalBlock 一致）
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  /** 开菜单：先定作用哪一栏并快照选区文本 */
  function openMenu(e: React.MouseEvent<HTMLDivElement>) {
    menuRootRef.current = e.currentTarget
    // 右键落点优先；否则看选区在哪一栏；都没有则单栏按那一栏、双栏按原文件
    const side =
      diffSideOf(e.target as Node) ??
      diffSideOf(window.getSelection()?.anchorNode ?? null) ??
      singleSide ??
      'old'
    menuTextRef.current = window.getSelection?.()?.toString() ?? ''
    menu.openAt(e, side)
  }

  /**
   * 全选只选一侧：从该栏第一个 .diff-code 选到最后一个。行号被罩住但不进文本（文本由 diffSideText 生成）。
   */
  function selectAllDiff(side: DiffSide) {
    const codes = menuRootRef.current?.querySelectorAll(
      `.diff-line--${side} .diff-code`,
    )
    if (codes && codes.length > 0) {
      const range = document.createRange()
      range.setStartBefore(codes[0])
      range.setEndAfter(codes[codes.length - 1])
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    menuTextRef.current = diffSideText(diffRows, side)
  }

  /** 菜单项渲染时现算：复制读快照，全选只作用于右键那一侧 */
  function diffMenuItems(side: DiffSide): ContextMenuItem[] {
    return [
      {
        key: 'copy',
        label: t('复制'),
        onClick: async () => {
          const text = menuTextRef.current
          if (!text) {
            showToast(t('请先选择要复制的内容'))
            return
          }
          showToast(
            (await copyText(text)) ? t('已复制到剪贴板') : t('复制失败'),
          )
        },
      },
      {
        key: 'select-all',
        // 标签写明会选哪一栏：菜单只有两项，不该靠猜
        label: side === 'old' ? t('全选原文件') : t('全选新文件'),
        onClick: () => selectAllDiff(side),
        // 全选后通常紧接着复制，菜单保持打开
        keepOpen: true,
      },
    ]
  }

  const renderContent = (isFull: boolean) => (
    <DiffContent
      diffRows={diffRows}
      fileName={fileName}
      stat={stat}
      actions={actions}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen(!fullscreen)}
      showHeader={showHeader}
      singleSide={singleSide}
      isFull={isFull}
      blockRef={rootRef}
      onContextMenu={openMenu}
    />
  )

  return (
    <>
      {/* 原位 diff */}
      {renderContent(false)}
      {fullscreen &&
        createPortal(
          <div className="diff-fullscreen-layer">{renderContent(true)}</div>,
          document.body,
        )}
      {/* 右键菜单：复制（选区优先）/ 全选（只选右键那一侧）；挂 body，全屏浮层里也能用 */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={diffMenuItems(menu.state.target)}
          onClose={menu.close}
        />
      )}
    </>
  )
}
