import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import type { DiffRow } from '@/utils/diff'
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
 * SideBySideDiff —— edit_file 的「原文件 / 新文件」左右对比视图（含词法着色与全屏）。
 *
 * 行数据由 EditFileMessage 准备（多处编辑合并成行是 edit_file 的 uiData 结构知识），
 * 本组件只负责「给什么行就画什么行」。
 */

/** SideBySideDiff 可渲染的行：普通 diff 行 + 多处编辑之间的省略间隔行 */
export type SideBySideRow =
  | DiffRow
  | {
      type: 'gap'
    }

// diff 是「左右栏 + 逐行红/绿底 + 行号」的自定义布局，无法整段塞进 Monaco 编辑器，
// 故用 Monaco 的 Monarch 词法器逐行切词，再按 virlen-dark 主题规则上色，视觉上与 CodePreview 一致。

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

/** diff 的一栏：左=原文件 / 右=新文件 */
type DiffSide = 'old' | 'new'

/**
 * 某一栏的纯文本（左栏不含新增行、右栏不含删除行，与 DiffHalf 的取值口径一致）。
 * 菜单的「全选 → 复制」用它，而不是把 DOM 选区序列化一遍 —— 后者会把行号一起拼进去
 *（`Range.toString()` 不认 `user-select: none`）。
 */
function diffSideText(rows: SideBySideRow[], side: DiffSide): string {
  const key = side === 'old' ? 'oldLine' : 'newLine'
  const lines: string[] = []
  for (const row of rows) {
    if (row.type === 'gap') continue
    if (side === 'old' && row.type === 'insert') continue
    if (side === 'new' && row.type === 'delete') continue
    lines.push(row[key] ?? '')
  }
  return lines.join('\n')
}

/**
 * 节点落在哪一栏（右键落点、选区起点都可能在其中）；两栏之外（文件头等）返回 null。
 * 双栏表头的两个格子也带 --old / --new，右键表头一样能看出意图。
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
 * 一行里的其中一半（左半=原文件 / 右半=新文件）：两半是**同一个 grid 行的两个格子**，所以
 * 两侧列宽天然各占一半（不必量宽），且一侧折行时另一侧跟着变高，左右不会逐行错位。
 *
 * 格子位置一律靠内联 grid-column / grid-row 指定，不吃 DOM 顺序（理由见 DiffContent 的渲染注释）。
 */
function DiffHalf({
  side,
  row,
  rowIndex,
  language,
}: {
  side: 'old' | 'new'
  row: SideBySideRow
  /** 该行在 diffRows 里的下标：决定落在第几个 grid 行（表头占第 1 行，故 +2） */
  rowIndex: number
  language?: string
}) {
  const isOld = side === 'old'

  // 左半恒第 1 列、右半恒第 2 列；同一 rowIndex 的两半落在同一 grid 行
  const place: React.CSSProperties = {
    gridColumn: isOld ? 1 : 2,
    gridRow: rowIndex + 2,
  }

  // 多处编辑之间的省略间隔行：两侧各画一个 ⋯（与整行底色一起连成一条横带）
  if (row.type === 'gap') {
    return (
      <div
        className={`diff-line diff-line--${side} diff-line--gap`}
        style={place}>
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
    <div
      className={`diff-line diff-line--${side}${highlightClass}`}
      style={place}>
      <span className="diff-linenum">{lineNum ?? ''}</span>
      <span className="diff-code">
        <DiffCode text={line != null ? line || ' ' : ''} language={language} />
      </span>
    </div>
  )
}

/**
 * diff 正文（文件头 / 双栏表头 / 每一行的左右两半）。「原位」与「全屏」各渲染一份：
 * 两边可用宽度不同，列宽交给 CSS grid 1fr 1fr 按各自容器算（故无需 JS 量宽）；
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
  /** 是否渲染为全屏形态 */
  isFull: boolean
  /** 原位那份的根节点 ref（居中用；全屏副本不接，避免 ref 被覆盖） */
  blockRef?: React.Ref<HTMLDivElement>
  /** 右键（挂在根上）：原位 / 全屏两份实例共用一个菜单状态，故回传事件给 SideBySideDiff */
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
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
      ref={isFull ? undefined : blockRef}
      onContextMenu={onContextMenu}>
      {/* 文件头（固定，不随内容滚动） */}
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

      {/* 唯一的滚动容器（只纵向）：双栏表头 + 每一行的左右两半都在里面；超长行在各自那半折行，故横向不滚 */}
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

        {/*
         * 每一行：左半、右半靠内联 grid-column / grid-row 落进同一个 grid 行（不是靠 DOM 顺序排布）。
         * 因此这里按「左栏全部 → 右栏全部」两段渲染：浏览器选区是**文档顺序上的连续区间**，
         * 若交错渲染（old1,new1,old2,new2…），从左边第 1 行拖到第 5 行的选区会连中间那几段右半
         * 一起框住 —— 看着是「选左边带出了右边」，Ctrl+C 拿到的也是两栏交错的内容。
         */}
        {diffRows.map((row, i) => (
          <DiffHalf
            key={`old-${i}`}
            side="old"
            row={row}
            rowIndex={i}
            language={codeLang}
          />
        ))}
        {diffRows.map((row, i) => (
          <DiffHalf
            key={`new-${i}`}
            side="new"
            row={row}
            rowIndex={i}
            language={codeLang}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * 左右对比 diff，内置「全屏」动作：与 CodeBlock / 终端块同构 —— 原位照常渲染（不能卸载，
 * 否则虚拟列表条目变矮、重测量把滚动锚点带偏），另用 createPortal 把铺满形态挂到 body，
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
  // 全屏态由组件自身管理，按钮在文件头右侧（与 CodeBlock 一致）
  const [fullscreen, setFullscreen] = useState(false)
  // 「打开即居中」的 hook 只能在顶层无条件调用，不能放进 EditFileMessage 的类方法里
  const rootRef = useAutoCenter(autoCenter)
  /**
   * diff 专属右键菜单：自绘窗口全局 preventDefault 了原生 contextmenu（见 ContextMenu 头注释），
   * 而 diff 是普通 DOM、内容又最常被拖选复制 —— 只能自补「复制 / 全选」。挂根上（文件头 /
   * 双栏表头 / 代码区都能右键），openAt 顺手拦下事件，外层消息行不再接管。
   * target 记「右键落在哪一栏」（菜单项渲染时现算标签与作用对象）。
   */
  const menu = useContextMenu<DiffSide>()
  /** 右键那一刻的那一份实例（原位 / 全屏是两棵子树）：「全选」只在这一份里选 */
  const menuRootRef = useRef<HTMLDivElement | null>(null)
  /**
   * 本次菜单要复制的文本，开菜单那一刻就快照好：菜单项是 `<button>`，mousedown 会把 window
   * 选区一起弄丢（同 §11.38 输入框右键菜单的坑），菜单项点击时再读选区就只剩空的了。
   * 「全选」把它换成该栏文本 —— 用户看到选中的，就是「复制」会拿到的东西。
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

  /** 开菜单：先定「作用哪一栏」并快照选区文本（理由见 menuTextRef） */
  function openMenu(e: React.MouseEvent<HTMLDivElement>) {
    menuRootRef.current = e.currentTarget
    // 右键落点优先；落在两栏之外（文件头 / 间隔行）就看选区在哪一栏；都没有则按原文件
    const side =
      diffSideOf(e.target as Node) ??
      diffSideOf(window.getSelection()?.anchorNode ?? null) ??
      'old'
    menuTextRef.current = window.getSelection?.()?.toString() ?? ''
    menu.openAt(e, side)
  }

  /**
   * 全选（菜单项）：只选一侧 —— 从该栏第一个 `.diff-code` 选到最后一个（双栏表头在它们之前）。
   * 行号虽被这一区间罩住，但不会进文本：待复制文本由 diffSideText 生成、不序列化 DOM 选区。
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

  /** 菜单项在渲染时现算（与项目其它右键菜单一致）：复制读快照，全选只作用于右键那一侧 */
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
        // 标签写明会选哪一栏：菜单只有两项，用户不该靠猜
        label: side === 'old' ? t('全选原文件') : t('全选新文件'),
        onClick: () => selectAllDiff(side),
        // 全选后通常紧接着「复制」，菜单保持打开（与代码块 / 终端同一约定）
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
      isFull={isFull}
      blockRef={rootRef}
      onContextMenu={openMenu}
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
      {/* 右键菜单：复制（选区优先，无选区时提示先选）/ 全选（只选右键那一侧）；挂 body，全屏浮层里也能用 */}
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
