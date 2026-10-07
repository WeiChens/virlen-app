/**
 * CodePreview —— 基于 Monaco（VS Code 编辑核心）的只读代码预览：带语法高亮，类似 VS Code 阅读模式。
 *
 * 相比完整编辑器做了简化：Monaco 走「精简构建」（只加载编辑器本体 + 各语言 Monarch 词法高亮，
 * 无语言服务 → 没有 Web Worker 与诊断）；编辑器完全只读（domReadOnly，屏蔽输入 / 光标 / 编辑）；
 * 无光标、无右键菜单、无悬浮。
 *
 * 聊天流式列表适配：`height` 让容器内容等高或受控；scrollbar.alwaysConsumeMouseWheel=false
 * 使自身无纵向溢出时滚轮冒泡给外层消息列表；startLineNumber 用于展示文件片段的行号。
 *
 * 用法：`<CodePreview code={code} language="typescript" height={320} />`
 */
import type { OnMount } from '@monaco-editor/react'
import Editor from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'
import type { CSSProperties } from 'react'
import { useEffect, useRef } from 'react'

// 必须先引入：精简版 monaco + 语言高亮注册 + One Dark 主题
import '@/monaco/setupMonaco'
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
}

export interface CodePreviewProps {
  /** 要展示的代码文本 */
  code: string
  /** Monaco 语言 id，例如 typescript / javascript / python / html / css / json / markdown */
  language?: string
  /** 预览高度（px 或 CSS 字符串）。默认 '100%'，由外部容器决定 */
  height?: number | string
  /** Monaco 主题：'virlen-dark'（默认） | 'vs-dark' | 'light' | 'hc-black' */
  theme?: string
  /** 是否显示小地图（默认 false，预览更干净） */
  showMinimap?: boolean
  /** 是否显示行号（默认 true） */
  showLineNumbers?: boolean
  /** 起始行号（默认 1）。行号按 startLineNumber + i - 1 显示 */
  startLineNumber?: number
  /** 字体大小（px，默认 15） */
  fontSize?: number
  /** 代码字体（默认 Consolas） */
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
}

/** 预览固定选项：只读 + 关闭一切“编辑/输入”能力 */
function buildPreviewOptions(
  props: CodePreviewProps,
): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  const {
    showMinimap = false,
    showLineNumbers = true,
    startLineNumber = 1,
    fontSize = 15,
    fontFamily = 'Consolas',
  } = props

  const lineHeight = Math.max(16, Math.round(fontSize * 1.5))

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
    fontFamily: `${fontFamily}, 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace`,
    fontLigatures: false,
    lineHeight,
    renderLineHighlight: 'none',
    renderWhitespace: 'none',
    renderControlCharacters: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
    tabSize: 2,
    folding: false,
    overviewRulerBorder: false,
    roundedSelection: false,
    scrollbar: {
      // 垂直滚动交给外层 .code-block-wrapper（maxHeight 场景）/ 消息列表：内置垂直滚动条在
      //「内容高度≈可视高度」时会变成拖不动的幽灵滚动条，与外层重复。
      vertical: 'hidden',
      horizontal: 'auto',
      useShadows: false,
      // 自身无可滚方向时不要吞掉滚轮，让外层消息列表能正常滚动（聊天流场景必须）。
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      arrowSize: 6,
    },
  }
}

export default function CodePreview(props: CodePreviewProps) {
  const {
    code,
    language,
    theme = 'virlen-dark',
    height = '100%',
    className = '',
  } = props

  // 预览固定只读；即使外层误改 props 也会被 updateOptions 兜底
  const handleMount: OnMount = (editor) => {
    editor.updateOptions({ readOnly: true, domReadOnly: true })
    // 选区变化 → 上报文本（Monaco 选区不入 window.getSelection，外层菜单靠它）
    editor.onDidChangeCursorSelection(() => {
      if (!props.onSelectionChange) return
      const selection = editor.getSelection()
      const model = editor.getModel()
      props.onSelectionChange(
        selection && model ? model.getValueInRange(selection) : '',
      )
    })
    // 下发命令式 API（全选等）——卸载时由下面的 effect 回调 null
    props.onApiReady?.({
      selectAll: () => {
        const model = editor.getModel()
        if (!model) return
        editor.setSelection(model.getFullModelRange())
        editor.focus()
      },
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
        style={{ fontSize: props.fontSize ?? 15 }}>
        {code}
      </div>
      <Editor
        height={height}
        path={props.path}
        language={language ?? 'plaintext'}
        value={code}
        theme={theme}
        onMount={handleMount}
        options={buildPreviewOptions(props)}
      />
    </div>
  )
}
