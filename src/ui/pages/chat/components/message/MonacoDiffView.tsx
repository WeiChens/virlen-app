/**
 * Monaco 差异视图（只读），用于 git 差异弹窗与聊天里的 edit_file 片段。
 *
 * 选 Monaco 因为弹窗手里已是两侧全文，且真虚拟化（万行级切文件不掉帧）。
 * 两侧都有内容 → DiffEditor；只有一侧 → 单栏 Editor + 整行装饰（染色 / 删色）。
 *
 * 注意：
 * - 两栏各占一半，关掉分栏拖拽，否则列头与正文错位；
 * - 打开就落到第一处改动，否则满屏未改动行；
 * - 右键菜单自己画（Monaco 的会吃掉 React 的 onContextMenu）；
 * - **只有画文件头的形态（聊天里的 `edit_file`）才有内置全屏**：Monaco 实例不能搬家
 *   （换容器 = 重建），全屏是**再建一个实例**挂在 body 上，原位那份照常留着 ——
 *   卸载它会让虚拟列表条目变矮、锚点跳动（与 `CodeBlock` / `SideBySideDiff` 同口径）。
 *   git 弹窗不画文件头，它自己就是放大形态（另有自己的放大开关），故不提供这个按钮。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DiffEditor, Editor } from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'
import { t } from '@/ui/i18n'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import { useCodeDisplay } from '@/ui/hooks/useCodeDisplay'
import {
  DEFAULT_CODE_DISPLAY_SETTINGS,
  codeLineHeightPx,
  type ResolvedCodeDisplay,
} from '@/domain/code-display'
import { diffLanguageFromName, type DiffSide } from './SideBySideDiff'
import type { Action } from './code-block'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import '@/monaco/setupMonaco'
// 共享的「差异外壳」样式（.diff-header* / .diff-col-header*）还在 SideBySideDiff.scss，必须自己引，
// 否则列头与文件头会掉回浏览器默认样式。
import './SideBySideDiff.scss'
import './MonacoDiffView.scss'

/** 这一侧的行数（与 Monaco 口径一致：末尾换行也算一行） */
function lineCount(text: string): number {
  return text === '' ? 1 : text.split('\n').length
}

/**
 * 差异编辑器（两栏 / 单栏共用）的上下内边距（px）。
 *
 * 底部比顶部多 4px：横向滚动条是浮在内容上的（不占布局），而它一旦出现就压在正文最后
 * 10px 上 —— 底 padding 不够高的话，最后一行会被它盖住一条。
 * ⚠️ 与 `monacoDiffHeight` 同一处取值：autoHeight 的容器高度 = 行数 × 行高 + 这两个数。
 */
export const MONACO_DIFF_PADDING = { top: 6, bottom: 10 } as const

/**
 * autoHeight 的高度 = 行数 × 行高 + 上下 padding。调用方取两侧行数较多的那一边（少算一行会顶出滚动区）。
 *
 * ⚠️ 行高必须走 codeLineHeightPx（与 Monaco 的 `lineHeight` 同一个函数）：两处各算一遍的话，
 *    设置里一调行高，算出来的格子高度就与真实排版对不上，末尾几行被裁掉。
 * ⚠️ 高度必须与 Monaco 的内容高度**逐像素相等**（多出来的就是多余底色，少 1px 就多出 1px 可滚
 *    范围 —— 滚轮能把内容推开一点，与代码块那条同源）；横向滚动条那 10px 也不许叠进来
 *（`ignoreHorizontalScrollbarInContentHeight: true`，见下方选项）。
 */
export function monacoDiffHeight(
  lines: number,
  fontSize: number,
  lineHeight: number = DEFAULT_CODE_DISPLAY_SETTINGS.codeLineHeight,
): number {
  return (
    lines * codeLineHeightPx(fontSize, lineHeight) +
    MONACO_DIFF_PADDING.top +
    MONACO_DIFF_PADDING.bottom
  )
}

/** 两种形态共用的只读预览选项（无语言服务，悬浮 / 补全 / 跳转一律关掉）。 */
function baseEditorOptions(
  display: ResolvedCodeDisplay,
): MonacoNs.editor.IEditorOptions {
  return {
    readOnly: true,
    // 长行横向滚动（与 DOM 版同口径：折行会把超长行挤成多行）
    wordWrap: 'off',

    minimap: { enabled: false },
    folding: false,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    links: false,
    guides: { indentation: false, bracketPairs: false },
    renderLineHighlight: 'none',
    glyphMargin: false,
    // 车道宽度：预览 / 单栏没行装饰，留一条缝；差异编辑器要在上面画 +/-（见 diffOptions）
    lineDecorationsWidth: 6,
    lineNumbersMinChars: 3,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    // 右键菜单自己画：Monaco 那份是英文，还会吃掉 React 的 onContextMenu
    contextmenu: false,

    fontSize: display.fontSize,
    lineHeight: display.lineHeightPx,
    fontFamily: display.fontFamily,
    fontLigatures: display.ligatures,
    padding: { top: MONACO_DIFF_PADDING.top, bottom: MONACO_DIFF_PADDING.bottom },
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      useShadows: false,
      // 编辑器自身滚到头时把滚轮让给外层（与 CodeEditor 一致）
      alwaysConsumeMouseWheel: false,
      // ⚠️ 横向滚动条不许把自己那 10px 加进内容高度：autoHeight 的容器是按「行数 × 行高 + padding」
      // 算死的，多出来的 10px 就成了「不需要滚动也能滚一点」，两栏还会各冒出一条只能拖 10px 的
      // 幽灵纵向滚动条（0.56 `viewLayout.js::_getContentHeight`）。
      // 代价是滚动条浮在内容上 —— 所以底 padding（10px）要够高，见 MONACO_DIFF_PADDING。
      ignoreHorizontalScrollbarInContentHeight: true,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      arrowSize: 6,
    },
  }
}

/** `MonacoDiffView` 的全部入参（原位与全屏两份实例共用同一份）。 */
type MonacoDiffViewProps = {
  /** 旧侧全文（Rust 已归一化成 LF） */
  oldText: string
  /** 新侧全文（同上） */
  newText: string
  /** 只用来推断词法语言（与聊天里的 diff 用同一套映射） */
  fileName: string
  /** 只有一侧有内容时保留的那一侧（只画这一栏，整份按全新增 / 全删除着色） */
  singleSide?: DiffSide
  /** 挂载 / 展开时滚到视口中间（只有用户主动点开的消息需要，git 弹窗不传） */
  autoCenter?: boolean
  /** 画文件头（文件名 + `actions`）；git 弹窗的路径在弹窗头，不传 */
  showHeader?: boolean
  /** 文件头右侧的动作按钮（与 `SideBySideDiff` 同形状） */
  actions?: Action[]
  /**
   * 高度按行数算（上限 --mono-diff-max-h = 450px）；不传 = 铺满父元素高度（git 弹窗）。
   * 全屏那份不吃这一档：它铺满整块浮层。
   */
  autoHeight?: boolean
  /**
   * 逐行行号映射：合成文本第 N 行 → 要显示的行号（聊天片段用它还原绝对行号），缺省 1..N。
   */
  lineNumbers?: Partial<Record<DiffSide, (line: number) => string>>
  /**
   * 列头右侧说明（代替默认 Ln 1–N）：undefined = 默认，null = 不显示。
   */
  colHeaderNote?: Partial<Record<DiffSide, React.ReactNode>>
}

/**
 * 正文（原位 / 全屏各一份实例）。
 * ⚠️ refs（差异编辑器、单栏编辑器、装饰集合、行号映射）必须留在这一层：
 * 提上去共用一份的话，全屏那份后挂载会把原位那份的引用顶掉，右键菜单与定位就作用到看不见的实例上。
 */
function DiffContent({
  oldText,
  newText,
  fileName,
  singleSide,
  autoCenter,
  showHeader,
  actions,
  autoHeight,
  lineNumbers,
  colHeaderNote,
  isFull,
  fullscreen,
  onToggleFullscreen,
}: MonacoDiffViewProps & {
  /** 是否渲染在全屏浮层里（决定类名与高度口径：浮层里不吃 autoHeight 的封顶） */
  isFull: boolean
  /** 当前是否已处于全屏（只用来切按钮图标 / 提示；原位那份也读同一个值） */
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  const display = useCodeDisplay()
  const fontSize = display.fontSize
  /** 浮层里高度由浮层决定，不许再按行数算 */
  const isAutoHeight = !!autoHeight && !isFull

  /** 展开即居中的根节点 ref（autoCenter 不传时 hook 内部早退；全屏那份不抢滚列表） */
  const rootRef = useAutoCenter(!!autoCenter && !isFull)

  /** 差异编辑器实例：只为「打开 / 换文件就落到第一处改动」 */
  const diffRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(null)
  /** 单栏编辑器实例：右键菜单要读选区、要全选 */
  const singleRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null)
  /** 单栏形态的整份底色装饰（换文件 / 换侧要重设） */
  const tintRef = useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null)

  /** 单栏形态要显示的那一份全文（哪一侧由 `singleSide` 定） */
  const singleText = singleSide === 'old' ? oldText : newText
  const language = diffLanguageFromName(fileName) ?? 'plaintext'

  /**
   * 交给 Monaco 的行号回调必须身份稳定：它一变 Monaco 就会重排布局 ——
   * 聊天里每次流式重渲染都换一份映射，会变成「一边打字一边重排」。
   */
  const lineNumbersRef = useRef(lineNumbers)
  lineNumbersRef.current = lineNumbers
  const stableLineNumbers = useRef({
    old: (line: number): string => lineNumbersRef.current?.old?.(line) ?? String(line),
    new: (line: number): string => lineNumbersRef.current?.new?.(line) ?? String(line),
  }).current
  const hasLineNumbers = lineNumbers != null

  /** 把行号映射装到两栏（各栏各有自己的行号） */
  const applyLineNumbers = useCallback(
    (editor: MonacoNs.editor.IStandaloneDiffEditor): void => {
      const fallback = display.showLineNumbers ? ('on' as const) : ('off' as const)
      editor.getOriginalEditor().updateOptions({
        lineNumbers: hasLineNumbers ? stableLineNumbers.old : fallback,
      })
      editor.getModifiedEditor().updateOptions({
        lineNumbers: hasLineNumbers ? stableLineNumbers.new : fallback,
      })
    },
    [hasLineNumbers, stableLineNumbers, display.showLineNumbers],
  )

  useEffect(() => {
    if (diffRef.current) applyLineNumbers(diffRef.current)
  }, [applyLineNumbers, singleSide])

  /**
   * 打开 / 换文件都滚到第一处改动（Monaco 默认从第 1 行开始，改动在后半段时满屏都像没高亮）。
   * revealFirstDiff 内部已 waitForDiff，不必自己处理时序。
   */
  useEffect(() => {
    if (singleSide) return
    diffRef.current?.revealFirstDiff()
  }, [oldText, newText, singleSide])

  /** 形态切换时清掉已卸载那个实例的引用。 */
  useEffect(() => {
    if (singleSide) {
      diffRef.current = null
    } else {
      singleRef.current = null
      tintRef.current = null
    }
  }, [singleSide])

  /**
   * 单栏形态：整份内容染成全新增 / 全删除。用差异编辑器自己那两条类名，配色与两栏同源。
   */
  const paintWholeTint = useCallback(
    (editor: MonacoNs.editor.IStandaloneCodeEditor): void => {
      const model = editor.getModel()
      if (!model) return
      const removed = singleSide === 'old'
      const decoration: MonacoNs.editor.IModelDeltaDecoration = {
        range: model.getFullModelRange(),
        options: {
          isWholeLine: true,
          className: removed ? 'line-delete' : 'line-insert',
          marginClassName: removed ? 'gutter-delete' : 'gutter-insert',
        },
      }
      if (tintRef.current) tintRef.current.set([decoration])
      else tintRef.current = editor.createDecorationsCollection([decoration])
    },
    [singleSide],
  )

  /**
   * 单栏形态：内容 / 侧变了就重画底色。挂在父组件 effect 里安全：子组件 effect 先跑，
   * 此时模型里已是新内容。
   */
  useEffect(() => {
    if (singleSide && singleRef.current) paintWholeTint(singleRef.current)
  }, [singleSide, oldText, newText, paintWholeTint])

  /** 差异视图选项：两栏恒等宽 + 只读。 */
  const diffOptions = useMemo(
    (): MonacoNs.editor.IDiffEditorConstructionOptions => ({
      ...baseEditorOptions(display),
      // 「旧侧能不能改」是独立开关，只读视图要一起关
      originalEditable: false,
      // 两栏恒等宽：关掉分栏拖拽，列头才不会与下面两栏错位
      enableSplitViewResizing: false,
      // 窄窗口下 Monaco 会自动切成内联差异，与左右对比 + 两个列头对不上
      useInlineViewWhenSpaceIsLimited: false,
      renderSideBySide: true,
      // 只读：回退箭头与 gutter 菜单都没有意义
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      /**
       * 行装饰车道宽 12 = 标记推进宽 11px + 1px 间隔。车道窄于标记时，标记右半边会被正文底色盖掉。
       */
      lineDecorationsWidth: 12,
      // 概览条只属于差异编辑器（单栏 Editor 没这个选项，故不放进 baseEditorOptions）
      renderOverviewRuler: false,
      // 不折叠未改动行
      hideUnchangedRegions: { enabled: false },
      // 行尾空格也算差异（git 照实显示）
      ignoreTrimWhitespace: false,
      diffWordWrap: 'off',
    }),
    // display 一变（字号 / 字族 / 行高 / 连字）就要重算：局部依赖 fontSize 会漏掉只改连字的情况
    [display],
  )

  /** 单栏视图选项：只有一份内容，对比专属开关一概不传。 */
  const singleOptions = useMemo(
    (): MonacoNs.editor.IStandaloneEditorConstructionOptions => ({
      ...baseEditorOptions(display),
      // 行号映射（没给就是 Monaco 默认 1..N），回调身份稳定
      lineNumbers:
        hasLineNumbers && singleSide
          ? stableLineNumbers[singleSide]
          : display.showLineNumbers
            ? undefined
            : 'off',
    }),
    [display, hasLineNumbers, singleSide, stableLineNumbers],
  )

  /** autoHeight 的高度，写到编辑器格子的 --mono-diff-h */
  const autoHeightStyle = useMemo((): React.CSSProperties | undefined => {
    if (!isAutoHeight) return undefined
    const lines = Math.max(lineCount(oldText), lineCount(newText))
    return {
      '--mono-diff-h': `${monacoDiffHeight(lines, fontSize, display.lineHeight)}px`,
    } as React.CSSProperties
  }, [isAutoHeight, oldText, newText, fontSize, display.lineHeight])

  /**
   * 右键菜单（复制 / 全选），与 SideBySideDiff 对齐：复制读开菜单那一刻的快照，
   * 全选只作用于右键那一栏、菜单保持打开。
   */
  const menu = useContextMenu<DiffSide>()
  /**
   * 菜单要复制的文本，开菜单那一刻快照：菜单项是 button，点下去编辑器就失焦，再读选区未必读得到。
   */
  const menuTextRef = useRef('')

  /** 某一栏的编辑器（两栏形态给对应那栏；单栏形态就是唯一那一个） */
  function editorOf(
    side: DiffSide,
  ): MonacoNs.editor.IStandaloneCodeEditor | null {
    const diff = diffRef.current
    if (!diff) return singleRef.current
    return side === 'old' ? diff.getOriginalEditor() : diff.getModifiedEditor()
  }

  /**
   * 右键落在哪一栏：两栏各有自己的 DOM 根（按包含关系判），列头按类名判。
   */
  function sideAt(node: Node | null): DiffSide | null {
    const diff = diffRef.current
    if (diff && node) {
      if (diff.getOriginalEditor().getDomNode()?.contains(node)) return 'old'
      if (diff.getModifiedEditor().getDomNode()?.contains(node)) return 'new'
    }
    const el = node instanceof Element ? node : (node?.parentElement ?? null)
    if (el?.closest('.diff-col-header--old')) return 'old'
    if (el?.closest('.diff-col-header--new')) return 'new'
    return null
  }

  /** 某一栏当前选中的文本（无选区返回空串） */
  function selectionTextOf(side: DiffSide): string {
    const editor = editorOf(side)
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!model || !selection || selection.isEmpty()) return ''
    return model.getValueInRange(selection)
  }

  /** 全选某一栏：选区铺满整个模型 */
  function selectAllOf(side: DiffSide): void {
    const editor = editorOf(side)
    const model = editor?.getModel()
    if (!editor || !model) return
    editor.setSelection(model.getFullModelRange())
    editor.focus()
    menuTextRef.current = model.getValue()
  }

  /** 开菜单：先定作用哪一栏并快照选中文本 */
  function openMenu(e: React.MouseEvent<HTMLDivElement>): void {
    const side = singleSide ?? sideAt(e.target as Node) ?? 'old'
    menuTextRef.current = selectionTextOf(side)
    menu.openAt(e, side)
  }

  /** 菜单项在渲染时现算（与项目其它右键菜单同一约定） */
  function menuItems(side: DiffSide): ContextMenuItem[] {
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
          showToast((await copyText(text)) ? t('已复制到剪贴板') : t('复制失败'))
        },
      },
      {
        key: 'select-all',
        // 标签写明选哪一栏；单栏形态写栏名反而让人以为还有另一栏
        label: singleSide
          ? t('全选')
          : side === 'old'
            ? t('全选原文件')
            : t('全选新文件'),
        onClick: () => selectAllOf(side),
        // 全选后通常紧接着复制，菜单保持打开
        keepOpen: true,
      },
    ]
  }

  /** 列头说明：undefined 用默认、null 不显示 */
  function rangeOf(side: DiffSide, fallback: string): React.ReactNode {
    const note = colHeaderNote?.[side]
    return note === undefined ? fallback : note
  }

  return (
    <div
      className={`git-mono-diff${showHeader ? ' has-header' : ''}${
        isAutoHeight ? ' is-autoheight' : ''
      }${isFull ? ' is-fullscreen' : ''}`}
      ref={rootRef}
      onContextMenu={openMenu}>
      {/* 文件头（可选）：样式也在同一份 SCSS 里 */}
      {showHeader && (
        <div className="diff-header">
          <span className="diff-header-name">{fileName}</span>
          <div className="diff-actions">
            {(actions ?? []).map((action) => (
              <button
                key={action.title}
                className="diff-action-btn"
                onClick={action.onClick}
                title={action.title}>
                {action.iconRender ? action.iconRender() : null}
              </button>
            ))}
            {/* 内置全屏（与 DOM 版同一个类名 / 图标）：排在调用方动作之后，与 CodeBlock 的头部同序 */}
            <button
              className="diff-action-btn diff-fullscreen-btn"
              onClick={onToggleFullscreen}
              title={fullscreen ? t('退出全屏') : t('全屏')}>
              {fullscreen ? <ExitFullScreenSvg /> : <FullScreenSvg />}
            </button>
          </div>
        </div>
      )}
      {singleSide ? (
        /* 单栏形态（新增 / 删除 / 未跟踪）：列头横跨两列 */
        <div
          className={`diff-col-header diff-col-header--${singleSide} diff-col-header--single`}>
          <span className="diff-col-header-label">
            {singleSide === 'old' ? t('原文件') : t('新文件')}
            <span className="diff-col-range">
              {rangeOf(singleSide, `Ln 1–${lineCount(singleText)}`)}
            </span>
          </span>
        </div>
      ) : (
        <>
          {/* 列头（原文件 / 新文件 + Ln 区间）：两栏各占一半 */}
          <div className="diff-col-header diff-col-header--old">
            <span className="diff-col-header-label">
              {t('原文件')}
              <span className="diff-col-range">
                {rangeOf('old', `Ln 1–${lineCount(oldText)}`)}
              </span>
            </span>
          </div>
          <div className="diff-col-header diff-col-header--new">
            <span className="diff-col-header-label">
              {t('新文件')}
              <span className="diff-col-range">
                {rangeOf('new', `Ln 1–${lineCount(newText)}`)}
              </span>
            </span>
          </div>
        </>
      )}
      <div className="git-mono-diff-editor" style={autoHeightStyle}>
        {singleSide ? (
          /* keepCurrentModel 默认 false：模型随组件销毁（切文件只 setValue）。
             不传 path 时每次挂载都建独立模型，不会与两栏那份互相顶掉。 */
          <Editor
            value={singleText}
            language={language}
            theme={display.themeId}
            options={singleOptions}
            onMount={(editor) => {
              singleRef.current = editor
              paintWholeTint(editor)
            }}
          />
        ) : (
          /* keepCurrent*Model 都关掉：两侧 model 随组件销毁（切文件只 setValue） */
          <DiffEditor
            original={oldText}
            modified={newText}
            language={language}
            theme={display.themeId}
            options={diffOptions}
            keepCurrentOriginalModel={false}
            keepCurrentModifiedModel={false}
            onMount={(editor) => {
              diffRef.current = editor
              applyLineNumbers(editor)
              editor.revealFirstDiff()
            }}
          />
        )}
      </div>
      {/* 菜单自己 portal 到 body（z-index 2000 > Modal 1300） */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={menuItems(menu.state.target)}
          onClose={menu.close}
        />
      )}
    </div>
  )
}

/**
 * 差异正文入口：原位一份 + （仅画文件头的形态）全屏浮层里再加一份。
 *
 * 为什么不能只建一份：Monaco 实例不能搬家（换容器 = 重建），而原位那份又不能卸 ——
 * 它身处虚拟列表的消息条目里，一卸条目就变矮、锚点跟着跳（与 `CodeBlock` / `SideBySideDiff` 同口径）。
 */
export function MonacoDiffView(props: MonacoDiffViewProps) {
  const [fullscreen, setFullscreen] = useState(false)
  /**
   * 只有画文件头才提供全屏：git 弹窗本来就在自己那个放大形态里（且另有自己的放大开关），
   * 再给它一个全屏按钮与弹窗头打架。
   */
  const open = fullscreen && !!props.showHeader
  const toggleFullscreen = useCallback(() => setFullscreen((v) => !v), [])

  // Esc 退出全屏（与 CodeBlock / SideBySideDiff 一致）
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  return (
    <>
      {/* 原位那份全屏时也照常渲染（理由见上面的组件注释） */}
      <DiffContent
        {...props}
        isFull={false}
        fullscreen={open}
        onToggleFullscreen={toggleFullscreen}
      />
      {open &&
        createPortal(
          <div className="diff-fullscreen-layer">
            <DiffContent
              {...props}
              isFull
              fullscreen
              onToggleFullscreen={toggleFullscreen}
            />
          </div>,
          document.body,
        )}
    </>
  )
}

export default MonacoDiffView
