/**
 * CodePreview —— 基于 Monaco（VS Code 编辑核心）的只读代码预览：带语法高亮，类似 VS Code 阅读模式。
 *
 * 相比完整编辑器做了简化：Monaco 走「精简构建」（只加载编辑器本体 + 各语言 Monarch 词法高亮，
 * 无语言服务 → 没有 Web Worker 与诊断）；编辑器完全只读（domReadOnly，屏蔽输入 / 光标 / 编辑）；
 * 无光标、无右键菜单、无悬浮。
 *
 * 聊天流式列表适配：`height` 让容器内容等高（按行数算时用 `domain/code-display::codePreviewHeight`，
 * 多 1px 是多余底色、少 1px 就多出 1px 可滚范围）；`alwaysConsumeMouseWheel=false` +
 * `ignoreHorizontalScrollbarInContentHeight=true` 使滚动到边界后滚轮冒泡给外层消息列表；
 * startLineNumber 用于展示文件片段的行号。
 *
 * **纵向滚动归 Monaco 自己**（`maxContentHeight`）：内容高于上限时容器钉在上限、由内置滚动条滚，
 * 外层（聊天代码块）不再套一层 `overflow: auto` —— 外层滚动那版里 Ctrl+F 的查找框会跟着滚出视野
 *（机制见 `src/monaco/findWidget.ts`）。没超过上限时高度仍严格等于内容高度，滚动条不出现。
 *
 * 用法：`<CodePreview code={code} language="typescript" height={320} />`
 */
import type { OnMount } from '@monaco-editor/react'
import Editor from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

// 必须先引入：精简版 monaco + 语言高亮注册 + 代码主题注册（色源在 domain/code-display）
import '@/monaco/setupMonaco'
import { useCodeDisplay } from '@/ui/hooks/useCodeDisplay'
import {
  CODE_PREVIEW_PADDING,
  codeLineHeightPx,
  type ResolvedCodeDisplay,
} from '@/domain/code-display'
// 查找框的两处水土不服（气泡被裁 / 跟着滚动滚走）：只读预览同样吃得到 Ctrl+F（contrib 是全局注册的）
import { tameFindWidget } from '@/monaco/findWidget'
import './code-preview.scss'

/**
 * 行号列与正文之间的横向间距（px），即 Monaco 的 lineDecorationsWidth。
 *
 * 它属于行号区（.margin）宽度，不处理的话行号区底色会一直铺到正文第一列，看着只是「行号区变宽」。
 * 故拆两段：贴着行号的一小段仍留行号区底色（GUTTER_INNER_PAD），其余由 CSS 把行号区底色挖掉
 *（见 code-preview.scss 的 .margin 规则）露出编辑器底色，视觉上就成了正文自己的左侧留白。
 */
const GUTTER_TO_CONTENT_GAP = 14
/** 上述间距中仍然保留行号区底色的一小段（px） */
const GUTTER_INNER_PAD = 5
/** 需要挖掉行号区底色、改由编辑器底色绘制的宽度（px） */
const GUTTER_BG_CUTOUT = GUTTER_TO_CONTENT_GAP - GUTTER_INNER_PAD

/** 对外暴露的命令式 API（挂载后经 onApiReady 下发，卸载时下发 null），供外层做「全选 → 复制」 */
export interface CodePreviewApi {
  /** 全选编辑器内容（并把焦点移入编辑器，选区会经 onSelectionChange 上报） */
  selectAll: () => void
  /**
   * 滚回顶部。DOM 与 Monaco 实例都是复用的：内容换人时不归零，会停在上一个文件同一条滚动偏移上
   *（`CodeBlock` 的 contentKey 用）。
   */
  scrollToTop: () => void
}

export interface CodePreviewProps {
  /** 要展示的代码文本 */
  code: string
  /** Monaco 语言 id，例如 typescript / javascript / python / html / css / json / markdown */
  language?: string
  /** 预览高度（px 或 CSS 字符串）。默认 '100%'，由外部容器决定 */
  height?: number | string
  /**
   * 显式指定 Monaco 主题 id；不传则用「设置 → 代码显示」里的当前主题。
   * 只在确实需要固定外观的特殊场景传值（普通调用点一律跟随设置）。
   */
  theme?: string
  /** 是否显示小地图（默认 false，预览更干净） */
  showMinimap?: boolean
  /** 是否显示行号（默认 true） */
  showLineNumbers?: boolean
  /** 起始行号（默认 1）。行号按 startLineNumber + i - 1 显示 */
  startLineNumber?: number
  /** 字体大小（px，默认取「代码显示」设置） */
  fontSize?: number
  /** 完整 font stack（默认取「代码显示」设置；传值就得是整串，不只是字体名） */
  fontFamily?: string
  /** 样式覆盖用 class */
  className?: string
  /** 传入扩展名/路径可让 Monaco 推断语言 */
  path?: string
  /**
   * 选区文本变化回调（含空串）。Monaco 的选区不进 `window.getSelection()`，外层（CodeBlock 的
   * 右键菜单 / 复制）拿「用户选中的代码」只能靠它上报（只读预览取 getValueInRange(selection)）。
   */
  onSelectionChange?: (selectedText: string) => void
  /**
   * 挂载完毕下发命令式 API（卸载时回调 null）。不用 forwardRef：本组件被大量只读预览复用，
   * 回调下发更轻，且卸载时能顺带清空，避免外层拿到已 dispose 的编辑器。
   */
  onApiReady?: (api: CodePreviewApi | null) => void
  /**
   * 高度改由编辑器自己报（`getContentHeight()`），`height` 只当**首帧估计**。
   *
   * 给「高度本来就该等于内容高度」的只读预览用（聊天代码块）。为什么不能只靠外部算：
   * Monaco 的行数认 `\r\n` / `\r` / `\n` 三种行尾，而我们只能按字符串数 —— CRLF 文件把末尾
   * `\r\n` 剥成只剩 `\r` 时，我们数 16 行、模型是 17 行（最后一行空），容器就矮一行：
   * 矮的那 16px 会把最后一行裁掉（没超 `maxContentHeight` 时不开滚动条，连滚都滚不到）。
   */
  fitContent?: boolean
  /**
   * 「代码区」的高度上限（px，仅 `fitContent` 时生效）：高度 = min(内容高度, 这里)。
   *
   * 超过上限就说明内容高于可视区 —— 此时高度钉在上限，**纵向滚动交给 Monaco 内置滚动条**
   *（`scrollbar.vertical: 'auto'`），外层不需要（也不应该）再套一层滚动容器。
   * 没超过时不显示滚动条：高度与内容高度差 1px 也不会冒出一条拖不动的幽灵滚动条。
   */
  maxContentHeight?: number
}

/**
 * 预览固定选项：只读 + 关闭一切“编辑/输入”能力。
 * 字号 / 字族 / 行高 / 连字 / 行号来自解析后的代码显示设置（props 显式传值时优先）。
 */
function buildPreviewOptions(
  props: CodePreviewProps,
  display: ResolvedCodeDisplay,
  scrollable: boolean,
): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  const {
    showMinimap = false,
    showLineNumbers = display.showLineNumbers,
    startLineNumber = 1,
    fontSize = display.fontSize,
    fontFamily = display.fontFamily,
  } = props

  const lineHeight = codeLineHeightPx(fontSize, display.lineHeight)

  return {
    // ── 只读 / 无输入 ──
    readOnly: true,
    domReadOnly: true, // DOM 层面也不可编辑，彻底屏蔽输入法/键盘
    cursorStyle: 'line',
    hideCursorInOverviewRuler: true,

    // ── 关闭“编辑器”类交互 ──
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    parameterHints: { enabled: false },
    inlayHints: { enabled: 'off' },
    contextmenu: false,
    links: false,
    hover: { enabled: 'off' },
    suggest: { showWords: false },
    colorDecorators: false,

    // 展示的常是「片段」（起始 / 结尾可能处于代码结构中间，多出 } ) ] 或 >），开启 bracket 高亮会把
    // 配不上的括号画成红色（unexpected bracket），看着像语法报错，故彻底关掉染色与匹配提示。
    bracketPairColorization: { enabled: false },
    matchBrackets: 'never',

    // ── 外观 ──
    minimap: { enabled: showMinimap, renderCharacters: false },
    lineNumbers: showLineNumbers
      ? (line: number) => String(line + startLineNumber - 1)
      : 'off',
    // 行号列与正文间的唯一可用间距（padding 选项只支持 top/bottom）；其中「露出编辑器底色」的
    // 那段由 CSS 处理，见 code-preview.scss。
    lineDecorationsWidth: showLineNumbers ? GUTTER_TO_CONTENT_GAP : GUTTER_INNER_PAD,
    fontSize,
    fontFamily,
    fontLigatures: display.ligatures,
    lineHeight,
    renderLineHighlight: 'none',
    renderWhitespace: 'none',
    renderControlCharacters: false,
    scrollBeyondLastLine: false,
    // 查找控件是全局注册的（`CodeEditor.tsx` 顶层引了 find contrib，注册表不区分实例），
    // 所以只读预览里按 Ctrl+F 也会开查找框。它默认 `addExtraSpaceOnTop: true` —— 会在第一行前
    // 插一个 33px 的 view zone（编辑器内容变高），而本组件高度跟着 `getContentHeight()` 走，
    // 于是「没超高上限」的代码块一按 Ctrl+F 就长高 33px。关掉它，查找框直接压在首行上
    //（超高上限的那块本来就能往下滚，遮住首行不影响看后面的代码）。
    find: { addExtraSpaceOnTop: false },
    smoothScrolling: true,
    automaticLayout: true,
    // ⚠️ 上下 padding 与「代码块容器高度」共用一处（codePreviewHeight）：未超上限时容器的目标值
    // 就是 Monaco 的内容高度，两个数各写一份就会错开 1px（多出 1px 可滚范围 / 裁掉最后一行）。
    padding: { top: CODE_PREVIEW_PADDING.top, bottom: CODE_PREVIEW_PADDING.bottom },
    tabSize: 2,
    folding: false,
    overviewRulerBorder: false,
    roundedSelection: false,
    scrollbar: {
      // 纵向滚动归 Monaco：只在「内容高于上限」时开（见 maxContentHeight）。
      // 不开的另一半同样重要 —— 高度 = 内容高度时若差 1px，'auto' 会冒出一条拖不动的幽灵滚动条。
      vertical: scrollable ? 'auto' : 'hidden',
      horizontal: 'auto',
      useShadows: false,
      // 滚到边界后把滚轮让给外层消息列表（聊天流场景必须）；编辑器内部还有可滚距离时它自己吃。
      alwaysConsumeMouseWheel: false,
      // ⚠️ 横向滚动条是浮在内容上的（不占布局），但它默认还会把自己那 10px 加进**内容高度**
      //（0.56 `viewLayout.js::_getContentHeight`：`linesTotalHeight + horizontalScrollbarSize`）——
      // 于是「按行数算出来的等高容器」凭空多出 10px 可滚范围，滚轮一推内容就上移一小截
      //（就是「不需要滚动的高度也会滚一点」）。置 true 关掉这一档。
      // 前提：底 padding（12px）≥ 滚动条高度（10px），否则最后一行会被它压住。
      ignoreHorizontalScrollbarInContentHeight: true,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      arrowSize: 6,
    },
  }
}

export default function CodePreview(props: CodePreviewProps) {
  // 主题 / 字号 / 字族 / 行高 / 连字 / 行号统一从「代码显示」设置解析（props 显式传值时优先）
  const display = useCodeDisplay()
  const {
    code,
    language,
    theme = display.themeId,
    height = '100%',
    className = '',
  } = props
  /** fitContent 时由编辑器报的内容高度（null = 还没量到，先用调用方给的 height） */
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)

  /**
   * 自然高度（= 内容高度）与最终渲染高度。
   *
   * `maxContentHeight` 只夹「已经量出来的数字高度」：字符串高度（'100%'）交给 CSS，不夹。
   * `scrollable` 决定要不要开内置滚动条 —— 夹到了就是内容超了，让 Monaco 自己滚。
   */
  const naturalHeight = props.fitContent ? (measuredHeight ?? height) : height
  const scrollable =
    typeof naturalHeight === 'number' &&
    typeof props.maxContentHeight === 'number' &&
    naturalHeight > props.maxContentHeight
  const renderedHeight = scrollable ? props.maxContentHeight : naturalHeight

  // 预览固定只读；即使外层误改 props 也会被 updateOptions 兜底
  const handleMount: OnMount = (editor) => {
    editor.updateOptions({ readOnly: true, domReadOnly: true })
    // 查找框要夹进可见交集（超上限时纵向滚动已在 Monaco 内部，但编辑器被消息列表 / 弹窗
    // 裁掉上半时仍需兜底）；顺带断掉三个开关的气泡（销毁钩子也在里面接）
    tameFindWidget(editor)
    // 选区变化 → 上报文本（Monaco 选区不入 window.getSelection，外层菜单靠它）
    editor.onDidChangeCursorSelection(() => {
      if (!props.onSelectionChange) return
      const selection = editor.getSelection()
      const model = editor.getModel()
      props.onSelectionChange(
        selection && model ? model.getValueInRange(selection) : '',
      )
    })
    // 高度以编辑器为准：行数只能由 Monaco 说了算（行尾 / 空行的算法与我们不同，见 fitContent 注释）
    if (props.fitContent) {
      const syncHeight = () => {
        const next = editor.getContentHeight()
        setMeasuredHeight((prev) => (prev === next ? prev : next))
      }
      syncHeight()
      editor.onDidContentSizeChange((e) => {
        if (e.contentHeightChanged) syncHeight()
      })
    }
    // 下发命令式 API（全选等）——卸载时由下面的 effect 回调 null
    props.onApiReady?.({
      selectAll: () => {
        const model = editor.getModel()
        if (!model) return
        editor.setSelection(model.getFullModelRange())
        editor.focus()
      },
      scrollToTop: () => editor.setScrollTop(0),
    })
  }

  // 卸载时清空 API，避免外层持有已 dispose 的编辑器。用 ref 取最新的 onApiReady
  //（它在父组件里通常是内联箭头，每次渲染都会变）。
  const onApiReadyRef = useRef(props.onApiReady)
  onApiReadyRef.current = props.onApiReady
  useEffect(() => {
    return () => onApiReadyRef.current?.(null)
  }, [])

  return (
    <div
      className={`code-preview ${className}`}
      style={
        {
          // 让 lineDecorationsWidth 撑出的留白落在「正文底色」上，而不是把行号区画宽
          '--code-preview-gutter-cutout': `${GUTTER_BG_CUTOUT}px`,
        } as CSSProperties
      }>
      <div
        className="code-preview-measure"
        aria-hidden="true"
        style={{ fontSize: props.fontSize ?? display.fontSize }}>
        {code}
      </div>
      <Editor
        height={renderedHeight}
        path={props.path}
        language={language ?? 'plaintext'}
        value={code}
        theme={theme}
        onMount={handleMount}
        options={buildPreviewOptions(props, display, scrollable)}
      />
    </div>
  )
}
