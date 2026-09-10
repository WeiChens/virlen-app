/**
 * CodePreview —— 基于 Monaco Editor（VS Code 编辑核心）的“代码预览”组件
 *
 * 用途：只读地展示带语法高亮的代码（类似 VS Code 阅读模式）。
 *
 * 相比完整编辑器，它是精简版：
 *   1. Monaco 采用“精简构建”（见 src/monaco/setupMonaco.ts）：
 *      只加载编辑器本体 + 各语言 Monarch 词法高亮，
 *      不打包 TS/JS/CSS/HTML/JSON 语言服务，因此没有任何 Web Worker、
 *      也没有“爆红”诊断。
 *   2. 编辑器配置为完全只读：禁用输入 / 光标 / 编辑（domReadOnly）。
 *   3. 更清爽：隐藏光标、无右键菜单、无悬浮，专注展示代码。
 *
 * 针对聊天流式列表的适配：
 *   - 传 height 让容器“内容等高”或受控高度；配 scrollbar.alwaysConsumeMouseWheel=false，
 *     当编辑器自身无纵向溢出时滚轮会冒泡给外层消息列表，不吞滚动。
 *   - startLineNumber 用于行号从指定行显示（读文件片段）。
 *
 * 用法：
 *   <CodePreview code={code} language="typescript" height={320} />
 */
import type { OnMount } from '@monaco-editor/react'
import Editor from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'
import type { CSSProperties } from 'react'

// 必须先引入：精简版 monaco + 语言高亮注册 + One Dark 主题
import '@/monaco/setupMonaco'
import './code-preview.scss'

/**
 * 行号列与代码正文之间的横向间距（px）—— 即 Monaco 的 lineDecorationsWidth。
 *
 * 注意：它属于「行号区」(.margin) 的宽度（layoutInfo: contentLeft = 行号列宽 + lineDecorationsWidth），
 * 如果不做处理，行号区底色（editorGutter.background）会一直铺到正文第一列，
 * 于是这段留白看上去只是“行号区变宽了”，正文依旧紧贴着行号区的色块边界。
 * 因此把它拆成两段：
 *   - 贴着行号的一小段（GUTTER_INNER_PAD）仍留在行号区底色内，避免数字贴着色块边界；
 *   - 剩下的一段由 CSS 把行号区底色“挖掉”（见 code-preview.scss 的 .margin 规则），
 *     露出编辑器底色 —— 视觉上就成了正文自己的左侧留白。
 */
const GUTTER_TO_CONTENT_GAP = 14
/** 上述间距中仍然保留行号区底色的一小段（px） */
const GUTTER_INNER_PAD = 5
/** 需要挖掉行号区底色、改由编辑器底色绘制的宽度（px） */
const GUTTER_BG_CUTOUT = GUTTER_TO_CONTENT_GAP - GUTTER_INNER_PAD

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

    // ── 不把括号当“错误”处理 ──
    // 读文件/搜索常展示“片段”，起始/结尾可能处于代码结构中间（多余的 } ) ] 或 >），
    // 若开启 bracket 高亮，Monaco 会把“配不上的括号”画成红色（unexpected bracket），
    // 看起来就像语法报错。这里彻底关掉括号染色与匹配提示。
    bracketPairColorization: { enabled: false },
    matchBrackets: 'never',

    // ── 外观 ──
    minimap: { enabled: showMinimap, renderCharacters: false },
    lineNumbers: showLineNumbers
      ? (line: number) => String(line + startLineNumber - 1)
      : 'off',
    // 行号列与正文之间的横向留白：Monaco 默认只有 10px，正文几乎贴着行号列。
    // 这是布局里唯一夹在“行号列”和“正文”之间的间距（padding 选项只支持 top/bottom），
    // 所以只能靠它撑开；其中“露出编辑器底色”的那段由 CSS 处理，见 code-preview.scss。
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
      // 垂直滚动完全交给外层 .code-block-wrapper（maxHeight 场景）/ 消息列表：
      // Monaco 内置垂直滚动条在“内容高度≈可视高度”时会变成拖不动的幽灵滚动条，
      // 和外层滚动条重复，因此直接隐藏，避免出现两根垂直滚动条。
      vertical: 'hidden',
      horizontal: 'auto',
      useShadows: false,
      // 关键：编辑器自身没有可滚动的方向时不要吞掉滚轮事件，
      // 让外层消息列表能正常滚动（聊天流场景必须）。
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
  }

  return (
    <div
      className={`code-preview ${className}`}
      style={
        {
          // 供 code-preview.scss 使用：把行号区底色从右侧挖掉这一段宽度，
          // 让 lineDecorationsWidth 撑出的留白落在“正文底色”上，而不是把行号区画宽。
          '--code-preview-gutter-cutout': `${GUTTER_BG_CUTOUT}px`,
        } as CSSProperties
      }>
      {/* 隐形“撑宽层”：
       * fit-content 父容器（如 .tool-call-expand-view）会按最长代码行的固有宽度决定自身宽度；
       * Monaco 是虚拟布局、无法贡献该固有宽度，因此放一个 height:0 的原始文本层来撑宽，
       * 等价于旧 Canvas 渲染里透明的 .code-select-overlay <pre>。不参与选中/可见。
       * font-size 与 Monaco 一致，保证估算的“最长行宽”准确。 */}
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
