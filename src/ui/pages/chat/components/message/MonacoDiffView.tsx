/**
 * MonacoDiffView —— git 差异弹窗的差异正文（Monaco 的 diff 编辑器，只读）。
 *
 * 为什么这一份改用 Monaco（试点，见 `docs/agents/14-git-management.md` §11.53 ㉖）：
 * - 弹窗手里本来就有**两侧全文**（`GitDiffSides.old_text / new_text`，Rust 已归一化成 LF），
 *   正是 Monaco 的输入形态：不用先把两侧比成行，切文件只是 `setValue`；
 * - 它是**真虚拟化**（只渲染可见行）—— 现有 DOM 版靠 `content-visibility` 跳过屏外行的布局，
 *   但屏外行的 DOM 仍在，万行级文件切换仍有 200~300ms（实测见 §11.53 ㉔）；
 * - 自带 diff 内核、行内（字符级）高亮、行号、查找。
 *
 * ⚠️ 两栏同步滚动**不因此变快**：Monaco 的 diff 编辑器同样是「监听一栏滚动 → 写另一栏
 * scrollTop / scrollLeft」（0.56 `diffEditorViewZones.js`），仍是合成线程滚动的固有那一帧
 * （评估结论见 §11.53 ㉖）。要真正零延迟，只能让同一个轴共用一个真滚动容器。
 *
 * 两种形态：
 * - **两侧都有内容**（修改）：`DiffEditor`，左右两栏各一个模型，自带行内（字符级）高亮；
 * - **只有一侧有内容**（新增 / 删除 / 未跟踪，判定 `domain/git::singleSideOf`）：单栏只读 `Editor`
 *   + 一条整行装饰，把**整份内容**染成全新增（绿）/ 全删除（红）。
 *   ⚠️ 单侧不用 Monaco 的两栏表达：它的两栏恒在（空的那一侧是空模型），表达不了「空的那一侧整栏不画」
 *   （P1.4 口径 4，实测反馈点名要的形态）。
 *
 * 两个列头沿用 `.diff-col-*` 那套类名（样式在 `SideBySideDiff.scss`，与调用方一致）。
 * 两栏各占一半，所以把 Monaco 的分栏拖拽关掉 —— 否则拖过分栏，列头就与下面的两栏错位了；
 * 单栏形态的那一个列头横跨两列。
 *
 * ⚠️ 打开就落到第一处改动（`revealFirstDiff`）：Monaco 默认从第 1 行开始显示，改动在文件后半段时
 * 打开弹窗满屏都是未改动行 —— 看上去和「没有高亮」一模一样（实测反馈就是这样）。
 *
 * ⚠️ 右键菜单自己画（`contextmenu: false` + 项目统一的 `ContextMenu`）：Monaco 自带的那份是英文、
 * 与本项目皮肤也不搭；更要紧的是 `contextmenu: true` 时它会 `preventDefault + stopPropagation`
 * （0.56 `contextmenu.js::_onContextMenu`），React 这边的 `onContextMenu` 根本收不到 ——
 * 两条路只能选一条，这里选「与 `SideBySideDiff` 逐条对齐」的那条（复制 / 全选 + i18n）。
 *
 * 两处调用方（结构规则在 `MonacoDiffView.scss`，这里只管差异的正交能力）：
 * - **git 差异弹窗**（`GitDiffModal`）：铺满弹窗高度，不画文件头、不居中；
 * - **聊天的 `edit_file` 消息**（`EditFileMessage`）：`autoHeight`（高度按行数算）+ `showHeader` + `actions`
 *   + `autoCenter` + `lineNumbers` + `colHeaderNote` —— 那份差异是**片段**，行号与标题都得由它翻译进来。
 *   ⚠️ 聊天里没有全屏（DOM 版有）：Monaco 的实例不能搬家，全屏得再建一个实例，本轮不做。
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
// ⚠️ 共享的那套「差异外壳」样式（`.diff-header*` / `.diff-col-header*` / `.diff-range`）今天还在
// `SideBySideDiff.scss` 里（两个组件画的是同一套头部），所以本组件必须自己引它 ——
// 不引就静默失效：列头与文件头会掉回浏览器默认样式（DOM 版那条 import 链已经不经过本组件了）。
// 若哪天 DOM 版被删除，把这几条规则搬到 `MonacoDiffView.scss` 即可。
import './SideBySideDiff.scss'
import './MonacoDiffView.scss'

/** 这一侧的行数（与 Monaco 的行号口径一致：末尾那个换行也算一行） */
function lineCount(text: string): number {
  return text === '' ? 1 : text.split('\n').length
}

/**
 * 正文字号跟界面字号走：`--font-size-sm` 就是差异正文的字号（见 `SideBySideDiff.scss`），
 * 而 Monaco 的字号只能在创建时给 —— 只在挂载时量一次（弹窗是短生命周期，开着改界面字号不在支持范围）。
 */
function initialFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    '--font-size-sm',
  )
  const size = Number.parseFloat(raw)
  return Number.isFinite(size) && size > 0 ? size : 12
}

/**
 * 行高与字号同一个倍率（1.55，与 `.diff-side-by-side` 的 `--diff-line-height` 一致）。
 * `autoHeight` 算高度与 Monaco 的 `lineHeight` 选项共用这一处，改倍率时两处自动同步。
 */
function lineHeightOf(fontSize: number): number {
  return Math.round(fontSize * 1.55)
}

/**
 * `autoHeight` 的高度：行数 × 行高 + 上下 padding（`padding` 选项 6 + 6）。
 * ⚠️ 聊天里两侧取**行数多的一边** —— 少算一行就会把最后一行顶到滚动区外。
 * 导出给用例：jsdom 对内联 CSS 自定义变量的支持不稳，直接验这个纯函数更牢。
 */
export function monacoDiffHeight(lines: number, fontSize: number): number {
  return lines * lineHeightOf(fontSize) + 12
}

/**
 * 两种形态共用的那套「只读预览」选项（与聊天里的代码预览同一口径：没有语言服务，
 * 悬浮 / 补全 / 跳转本就没有内容，一律减掉）。
 */
function baseEditorOptions(fontSize: number): MonacoNs.editor.IEditorOptions {
  return {
    readOnly: true,
    // 长行交给横向滚动（与 DOM 版 P1.7 同一口径：折行会把一行超长内容挤进同一栏的几行）
    wordWrap: 'off',

    minimap: { enabled: false },
    folding: false,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    links: false,
    guides: { indentation: false, bracketPairs: false },
    renderLineHighlight: 'none',
    glyphMargin: false,
    // 行号与正文之间的车道：预览 / 单栏没有行装饰，留一条缝就够；
    // 差异编辑器要在车道上画 +/- 标记，尺寸另有讲究（见 `diffOptions` 里的覆盖）
    lineDecorationsWidth: 6,
    lineNumbersMinChars: 3,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    // 右键菜单自己画（见文件头 ⚠️）：Monaco 那份是英文，还会把 React 的 onContextMenu 吃掉
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
  /**
   * 只有一侧有内容时**保留的那一侧**（`domain/git::singleSideOf`）：只画这一栏，整份内容按
   * 「全新增 / 全删除」着色。两侧都有内容时不传（左右两栏对照）。
   */
  singleSide?: DiffSide
  /**
   * 挂载 / 展开时把这块内容滚到视口中间（只有「用户主动点开」的消息需要，git 弹窗不传）。
   * ⚠️ hook 只能写在组件顶层 —— 调用方（`EditFileMessage` 是类方法）没法自己调，由这里代劳。
   */
  autoCenter?: boolean
  /** 画文件头（文件名 + `actions`）；git 弹窗的路径在弹窗头，不传 */
  showHeader?: boolean
  /** 文件头右侧的动作按钮（与 `SideBySideDiff` 同形状） */
  actions?: Action[]
  /**
   * 高度按行数算（`行数 × 行高 + 上下 padding`，上限 `--mono-diff-max-h`＝450px）。
   * 不传 = 铺满父元素高度（git 弹窗：高度由弹窗给）。
   */
  autoHeight?: boolean
  /**
   * 逐行行号映射：合成文本的第 N 行 → 要显示的行号（聊天里的片段视图用它还原文件里的绝对行号）。
   * 缺省 = Monaco 自己的 1..N。
   */
  lineNumbers?: Partial<Record<DiffSide, (line: number) => string>>
  /**
   * 列头右侧的说明（代替默认的 `Ln 1–N`）：`undefined` = 用默认值，`null` = 不显示
   * （聊天里多处编辑合并后行号区间不连续，与 DOM 版一样不显示区间）。
   */
  colHeaderNote?: Partial<Record<DiffSide, React.ReactNode>>
}) {
  const [fontSize] = useState(initialFontSize)

  /** 「展开即居中」的根节点 ref（`autoCenter` 不传时 hook 内部直接早退，不滚） */
  const rootRef = useAutoCenter(!!autoCenter)

  /** 差异编辑器的实例 —— 只为「打开 / 换文件就落到第一处改动」（见下面那个 effect） */
  const diffRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(null)
  /** 单栏编辑器的实例 —— 右键菜单要读它的选区、要给它「全选」 */
  const singleRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null)
  /** 单栏形态的「整份底色」（换文件 / 换侧要重设） */
  const tintRef = useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null)

  /** 单栏形态要显示的那一份全文（哪一侧由 `singleSide` 定） */
  const singleText = singleSide === 'old' ? oldText : newText
  const language = diffLanguageFromName(fileName) ?? 'plaintext'

  /**
   * ⚠️ 交给 Monaco 的行号回调必须**身份稳定**：它一变（函数不等）Monaco 就认为配置变了，会重排
   * 行号栏与布局 —— 聊天里每次流式重渲染都会换一份映射，那会变成「一边打字一边重排」。
   * 所以这里只建一次（读 ref），内容变了让回调自己读最新值。
   */
  const lineNumbersRef = useRef(lineNumbers)
  lineNumbersRef.current = lineNumbers
  const stableLineNumbers = useRef({
    old: (line: number): string => lineNumbersRef.current?.old?.(line) ?? String(line),
    new: (line: number): string => lineNumbersRef.current?.new?.(line) ?? String(line),
  }).current
  const hasLineNumbers = lineNumbers != null

  /** 把行号映射装到两栏上（**两栏各有自己的行号**，只能分别 updateOptions） */
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
   * 打开 / 换文件都滚到第一处改动。
   *
   * 为什么必须有：Monaco 默认从第 1 行开始显示 —— 改动落在文件后半段时，打开弹窗满屏都是未改动行，
   * 看上去与「没有高亮」没有区别（VS Code 打开差异也是落在第一处改动上）。
   * `revealFirstDiff()` 内部先 `waitForDiff()` 再 `_goTo(mappings[0])`，所以不必自己处理
   * 「差异还没算完」这个时序。
   *
   * ⚠️ 换文件时两侧文本变了（`@monaco-editor/react` 走 `setValue`，不重建编辑器），要再定位一次；
   * 首次挂载时这里还拿不到实例（库要等 loader 解析完才建编辑器），由 `onMount` 兜住。
   * 单栏形态（整份都是改动）第 1 行就是第一处改动，不必定位。
   */
  useEffect(() => {
    if (singleSide) return
    diffRef.current?.revealFirstDiff()
  }, [oldText, newText, singleSide])

  /**
   * 形态切换时清掉没用的那个实例：切到单栏时差异编辑器已经卸载（反方向同理）——
   * 留着旧引用只会在 dispose 之后再被叫一次。
   */
  useEffect(() => {
    if (singleSide) {
      diffRef.current = null
    } else {
      singleRef.current = null
      tintRef.current = null
    }
  }, [singleSide])

  /**
   * 单栏形态：把整份内容染成「全新增 / 全删除」。
   *
   * 用的是 Monaco 差异编辑器**自己**那两条类名（`line-insert` / `line-delete` 染正文、
   * `gutter-insert` / `gutter-delete` 染行号栏，见 0.56 `diffEditor/registrations.contribution.js`）
   * —— 配色与两栏版**同源**（同一组 `--vscode-diffEditor-*` 主题变量），不会出现「单栏的绿不是两栏的绿」。
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
   * 单栏形态：内容 / 侧变了就重画整份底色。
   * ⚠️ 挂在**父组件**的 effect 里是安全的：子组件的 effect 先跑（`@monaco-editor/react` 用 effect
   * 把 `value` 同步进模型），所以 `getFullModelRange()` 读到的必定是新内容的全长。
   */
  useEffect(() => {
    if (singleSide && singleRef.current) paintWholeTint(singleRef.current)
  }, [singleSide, oldText, newText, paintWholeTint])

  /** 差异视图的选项：两栏恒等宽 + 只读；共用项见 `baseEditorOptions` */
  const diffOptions = useMemo(
    (): MonacoNs.editor.IDiffEditorConstructionOptions => ({
      ...baseEditorOptions(fontSize),
      // 「旧侧能不能改」是 Monaco 的独立开关，只读视图里必须一起关掉
      originalEditable: false,
      // 两栏恒等宽：关掉分栏拖拽，上面的两个列头才不会与下面的两栏错位
      enableSplitViewResizing: false,
      // 窄窗口下 Monaco 会自动切成「内联差异」（只剩一栏），与「左右对比 + 两个列头」对不上
      useInlineViewWhenSpaceIsLimited: false,
      renderSideBySide: true,
      // 只读：两栏之间的「回退箭头」、gutter 菜单都没有意义
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      /**
       * 行装饰车道：差异编辑器把「新增行 / 删除行」的 +/- 标记就画在这条车道上
       * （`.codicon-diff-insert` / `.codicon-diff-remove`，字号被 Monaco 自己钉成 11px：`diffEditor/style.css`
       * 的 `font-size: 11px !important`；字形墨迹 9.64px、左边界正好是 0）。
       * ⚠️ 车道的右边界**就是**正文左边界（`contentLeft = decorationsLeft + lineDecorationsWidth`），而正文层
       * 排在行号栏**之后**（0.56 `view.js`：`.margin` 先 append、带不透明底色的 `.monaco-scrollable-element`
       * 后 append）—— 车道比标记窄，标记的右半边就被正文底色盖掉：实测 6px 车道只看得见左边的 6/9.64，
       * 看着就是「图标只显示了一半」。12 = 标记推进宽度 11px + 与正文之间 1px。
       */
      lineDecorationsWidth: 12,
      // 概览条只在**差异**编辑器上有（单栏的 `Editor` 没这个选项，所以它留在这一份里，
      // 不进 `baseEditorOptions`：那是 `IEditorOptions`，多一个键就是类型错误）
      renderOverviewRuler: false,
      // 不折叠未改动行（实测反馈：不要用 … 省略相同的部分）
      hideUnchangedRegions: { enabled: false },
      // 行尾空格也算是差异（旧视图逐字符比、git 也照实显示）
      ignoreTrimWhitespace: false,
      diffWordWrap: 'off',
    }),
    [fontSize],
  )

  /** 单栏视图的选项：只有一份内容，「对比」专属的那几个开关一概不传 */
  const singleOptions = useMemo(
    (): MonacoNs.editor.IStandaloneEditorConstructionOptions => ({
      ...baseEditorOptions(fontSize),
      // 行号映射（没给就是 Monaco 默认的 1..N）；回调身份稳定，见上面 ⚠️
      lineNumbers:
        hasLineNumbers && singleSide ? stableLineNumbers[singleSide] : undefined,
    }),
    [fontSize, hasLineNumbers, singleSide, stableLineNumbers],
  )

  /** `autoHeight` 的高度（见 `monacoDiffHeight`）：写在编辑器格子的 `--mono-diff-h` 上 */
  const autoHeightStyle = useMemo((): React.CSSProperties | undefined => {
    if (!autoHeight) return undefined
    const lines = Math.max(lineCount(oldText), lineCount(newText))
    return {
      '--mono-diff-h': `${monacoDiffHeight(lines, fontSize)}px`,
    } as React.CSSProperties
  }, [autoHeight, oldText, newText, fontSize])

  /**
   * 右键菜单（复制 / 全选）：与 `SideBySideDiff` 逐条对齐 —— 复制读开菜单那一刻的快照，
   * 「全选」只作用于右键那一栏、菜单保持打开（全选后通常紧接着复制）。
   */
  const menu = useContextMenu<DiffSide>()
  /**
   * 本次菜单要复制的文本，开菜单那一刻就快照好：菜单项是 `<button>`，点下去编辑器就失焦了 ——
   * 菜单项点击时再读选区未必还读得到（同 `SideBySideDiff` 的 `menuTextRef`）。
   */
  const menuTextRef = useRef('')

  /** 某一栏的编辑器（两栏形态给差异编辑器的那一栏；单栏形态就是唯一那一个） */
  function editorOf(
    side: DiffSide,
  ): MonacoNs.editor.IStandaloneCodeEditor | null {
    const diff = diffRef.current
    if (!diff) return singleRef.current
    return side === 'old' ? diff.getOriginalEditor() : diff.getModifiedEditor()
  }

  /**
   * 右键落在哪一栏：Monaco 的两栏各有自己的 DOM 根（按包含关系判），列头按类名判 ——
   * 右键表头一样能看出意图（与 DOM 版的 `diffSideOf` 同一取舍）。都没命中就交给调用处兜底。
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

  /** 某一栏当前选中的文本（Monaco 的选区；没有选区就是空串） */
  function selectionTextOf(side: DiffSide): string {
    const editor = editorOf(side)
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!model || !selection || selection.isEmpty()) return ''
    return model.getValueInRange(selection)
  }

  /** 全选某一栏：把 Monaco 的选区铺满整个模型（用户接着按 Ctrl+C 拿到的也是同一份文本） */
  function selectAllOf(side: DiffSide): void {
    const editor = editorOf(side)
    const model = editor?.getModel()
    if (!editor || !model) return
    editor.setSelection(model.getFullModelRange())
    editor.focus()
    menuTextRef.current = model.getValue()
  }

  /** 开菜单：先定「作用哪一栏」并快照选中文本（理由见 menuTextRef） */
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
        // 标签写明会选哪一栏；单栏形态只有一栏，写栏名反而让人以为还有另一栏
        label: singleSide
          ? t('全选')
          : side === 'old'
            ? t('全选原文件')
            : t('全选新文件'),
        onClick: () => selectAllOf(side),
        // 全选后通常紧接着「复制」，菜单保持打开（与代码块 / 终端同一约定）
        keepOpen: true,
      },
    ]
  }

  /** 列头右侧的说明：`undefined` 用默认、`null` 不显示（见 `colHeaderNote` 的说明） */
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
      {/* 文件头（可选）：与 DOM 版同一个写头，样式也在同一份 SCSS 里（`.diff-header`） */}
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
        /* 单栏形态（新增 / 删除 / 未跟踪）：那一个列头横跨两列、文案随保留的那一侧走 */
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
          {/* 列头（原文件 / 新文件 + Ln 区间）：两栏各占一半，与下面 Monaco 的两栏对齐 */}
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
          /* keepCurrentModel 默认 false：模型随这个组件一起销毁（切文件只 setValue，不重建）。
             不传 path：@monaco-editor/react 不给 path 时每次挂载都建一个独立模型
             （`inmemory://model/N`），两栏那份与它不会互相顶掉。 */
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
          /* keepCurrent*Model 都关掉：两侧 model 随这个组件一起销毁（切文件只 setValue，不重建） */
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
      {/* 菜单自己 portal 到 body（z-index 2000 > Modal 1300），不会被弹窗遮罩压住 */}
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
