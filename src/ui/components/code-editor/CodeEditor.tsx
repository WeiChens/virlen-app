/**
 * CodeEditor —— 可编辑的精简版 Monaco 编辑器（带语法高亮的小代码输入框）
 *
 * 与 `CodePreview`（只读预览：隐藏光标、关右键菜单、关输入）相对：本组件用于
 * **真正输入代码**，因此保留编辑能力与右键菜单，只做“减法”——关掉小地图 / 折叠 /
 * 行高亮，控制视觉噪音与体积。典型用途：设置 → 安全 → 忽略沙盒命令的 JS 规则。
 *
 * 项目用的是 Monaco 精简构建（见 `src/monaco/setupMonaco.ts`）：只注册各语言的 Monarch
 * 词法高亮，不打包 TS/JS 语言服务（无 Web Worker）。所以这里没有智能补全、没有语法诊断 ——
 * 错误由业务侧自行校验后提示（如 `domain/security/sandbox-ignore-rules.ts` 的 `testSandboxRule`）。
 *
 * 用法：
 *   <CodeEditor value={code} onChange={setCode} language="javascript" height={160} />
 */
import type { OnMount } from '@monaco-editor/react'
import Editor from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'

// 必须先引入：精简版 monaco + 语言高亮注册 + One Dark 主题
import '@/monaco/setupMonaco'
import './style.scss'

/** 编辑器固定主题（与聊天里的代码预览一致，亮暗主题下都是这套配色） */
const CODE_EDITOR_THEME = 'virlen-dark'

export interface CodeEditorProps {
  /** 代码文本（受控） */
  value: string
  /** 内容变化回调 */
  onChange: (value: string) => void
  /** Monaco 语言 id，例如 javascript / typescript / json。默认 javascript */
  language?: string
  /** 编辑器高度（px 或 CSS 字符串）。默认 180 */
  height?: number | string
  /** 字号（px，默认 13） */
  fontSize?: number
  /** 只读（默认 false） */
  readOnly?: boolean
  /** 无障碍标签（Monaco 会把 aria-label 落在输入区） */
  ariaLabel?: string
  /** 样式覆盖用 class */
  className?: string
}

function buildEditorOptions(
  props: CodeEditorProps,
): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  const { fontSize = 13, readOnly = false, ariaLabel } = props

  return {
    readOnly,
    domReadOnly: readOnly,
    ariaLabel,

    // ── 关掉“重量级”编辑器能力（体积 / 噪音 / 无语言服务时无意义）──
    minimap: { enabled: false },
    folding: false,
    stickyScroll: { enabled: false },
    // 精简构建没有语言服务：补全 / 参数提示 / 悬浮都只会显示“无内容”，直接关掉
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    parameterHints: { enabled: false },
    hover: { enabled: 'off' },
    links: false,
    codeLens: false,
    colorDecorators: false,
    renderLineHighlight: 'line',
    renderWhitespace: 'selection',
    matchBrackets: 'always',
    bracketPairColorization: { enabled: true },
    guides: { indentation: false, bracketPairs: false },

    // ── 输入体验 ──
    fontSize,
    fontFamily:
      "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace",
    lineHeight: Math.max(16, Math.round(fontSize * 1.55)),
    tabSize: 2,
    insertSpaces: true,
    wordWrap: 'off',
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    autoSurround: 'languageDefined',
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    automaticLayout: true,
    padding: { top: 10, bottom: 10 },
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    roundedSelection: false,
    contextmenu: true,
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      useShadows: false,
      // 编辑器自身滚到头时把滚轮让给外层（设置页 / 弹窗可滚动）
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      arrowSize: 6,
    },
  }
}

export default function CodeEditor(props: CodeEditorProps) {
  const {
    value,
    onChange,
    language = 'javascript',
    height = 180,
    readOnly = false,
    className = '',
  } = props

  const handleMount: OnMount = (editor) => {
    // 每次挂载都按 props 兜底一次（避免外部复用实例时残留上一次的只读态）
    editor.updateOptions({ readOnly, domReadOnly: readOnly })
  }

  return (
    <div className={`code-editor${className ? ` ${className}` : ''}`}>
      <Editor
        height={height}
        language={language}
        value={value}
        theme={CODE_EDITOR_THEME}
        onMount={handleMount}
        onChange={(v) => onChange(v ?? '')}
        options={buildEditorOptions(props)}
      />
    </div>
  )
}
