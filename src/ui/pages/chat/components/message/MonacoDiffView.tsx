/**
 * Monaco 差异视图（只读），用于 git 差异弹窗与聊天里的 edit_file 片段。
 *
 * 选 Monaco 因为弹窗手里已是两侧全文，且真虚拟化（万行级切文件不掉帧）。
 * 两侧都有内容 → DiffEditor；只有一侧 → 单栏 Editor + 整行装饰（染色 / 删色）。
 *
 * 注意：
 * - 两栏各占一半，关掉分栏拖拽，否则列头与正文错位；
 * - 打开就落到第一处改动，否则满屏未改动行；
 * - 右键菜单自己画（Monaco 的会吃掉 React 的 onContextMenu）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { diffLanguageFromName, type DiffSide } from './SideBySideDiff'
import type { Action } from './code-block'
import '@/monaco/setupMonaco'
// 共享的「差异外壳」样式（.diff-header* / .diff-col-header*）还在 SideBySideDiff.scss，必须自己引，
// 否则列头与文件头会掉回浏览器默认样式。
import './SideBySideDiff.scss'
import './MonacoDiffView.scss'

/** 这一侧的行数（与 Monaco 口径一致：末尾换行也算一行） */
function lineCount(text: string): number {
  return text === '' ? 1 : text.split('\n').length
}

/** 正文与界面字号对齐：只在挂载时量一次（弹窗短生命周期，不适合跟随热变更）。 */
function initialFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    '--font-size-sm',
  )
  const size = Number.parseFloat(raw)
  return Number.isFinite(size) && size > 0 ? size : 12
}

/** 行高倍率 1.55，与 .diff-side-by-side 的 --diff-line-height 一致。 */
function lineHeightOf(fontSize: number): number {
  return Math.round(fontSize * 1.55)
}

/**
 * autoHeight 的高度 = 行数 × 行高 + 上下 padding。调用方取两侧行数较多的那一边（少算一行会顶出滚动区）。
 */
export function monacoDiffHeight(lines: number, fontSize: number): number {
  return lines * lineHeightOf(fontSize) + 12
}

/** 两种形态共用的只读预览选项（无语言服务，悬浮 / 补全 / 跳转一律关掉）。 */
function baseEditorOptions(fontSize: number): MonacoNs.editor.IEditorOptions {
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

    fontSize,
    lineHeight: lineHeightOf(fontSize),
    fontFamily:
      "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace",
    padding: { top: 6, bottom: 6 },
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      useShadows: false,
      // 编辑器自身滚到头时把滚轮让给外层（与 CodeEditor 一致）
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      arrowSize: 6,
    },
  }
}

export function MonacoDiffView({
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
}: {
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
}) {
  const [fontSize] = useState(initialFontSize)

  /** 展开即居中的根节点 ref（autoCenter 不传时 hook 内部早退） */
  const rootRef = useAutoCenter(!!autoCenter)

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
      const fallback = 'on' as const
      editor.getOriginalEditor().updateOptions({
        lineNumbers: hasLineNumbers ? stableLineNumbers.old : fallback,
      })
      editor.getModifiedEditor().updateOptions({
        lineNumbers: hasLineNumbers ? stableLineNumbers.new : fallback,
      })
    },
    [hasLineNumbers, stableLineNumbers],
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
      ...baseEditorOptions(fontSize),
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
    [fontSize],
  )

  /** 单栏视图选项：只有一份内容，对比专属开关一概不传。 */
  const singleOptions = useMemo(
    (): MonacoNs.editor.IStandaloneEditorConstructionOptions => ({
      ...baseEditorOptions(fontSize),
      // 行号映射（没给就是 Monaco 默认 1..N），回调身份稳定
      lineNumbers:
        hasLineNumbers && singleSide ? stableLineNumbers[singleSide] : undefined,
    }),
    [fontSize, hasLineNumbers, singleSide, stableLineNumbers],
  )

  /** autoHeight 的高度，写到编辑器格子的 --mono-diff-h */
  const autoHeightStyle = useMemo((): React.CSSProperties | undefined => {
    if (!autoHeight) return undefined
    const lines = Math.max(lineCount(oldText), lineCount(newText))
    return {
      '--mono-diff-h': `${monacoDiffHeight(lines, fontSize)}px`,
    } as React.CSSProperties
  }, [autoHeight, oldText, newText, fontSize])

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
        autoHeight ? ' is-autoheight' : ''
      }`}
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
            theme="virlen-dark"
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
            theme="virlen-dark"
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

export default MonacoDiffView
