/**
 * CodeEditor —— 可编辑的精简版 Monaco（带语法高亮的小代码输入框）
 *
 * 与 `CodePreview`（只读：隐藏光标、关右键菜单、关输入）相对：本组件用于**真正输入**，
 * 保留编辑与右键菜单，只减掉噪音与体积（小地图 / 折叠 / 行高亮）。
 * 典型用途：设置 → 安全 → 忽略沙盒命令的 JS 规则。
 *
 * 精简构建只注册 Monarch 词法高亮（见 `src/monaco/setupMonaco.ts`），不打包语言服务（无 Worker），
 * 所以没有补全、没有语法诊断 —— 错误由业务侧自行校验（如 `security/sandbox-ignore-rules.ts`）。
 *
 * 用法：<CodeEditor value={code} onChange={setCode} language="javascript" height={160} />
 */
import type { OnMount } from '@monaco-editor/react'
import Editor from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'
import { useRef } from 'react'

// 必须最先引入：精简 monaco + 高亮注册 + 代码主题注册（monaco 命名空间也从这里拿）
import { monaco } from '@/monaco/setupMonaco'
import { useCodeDisplay } from '@/ui/hooks/useCodeDisplay'
import {
  codeLineHeightPx,
  type ResolvedCodeDisplay,
} from '@/domain/code-display'
import './style.scss'

export interface CodeEditorProps {
  /** 代码文本（受控） */
  value: string
  /** 内容变化回调 */
  onChange: (value: string) => void
  /** Monaco 语言 id，例如 javascript / typescript / json。默认 javascript */
  language?: string
  /** 编辑器高度（px 或 CSS 字符串）。默认 180 */
  height?: number | string
  /** 字号（px，默认取「代码显示」设置） */
  fontSize?: number
  /** 只读（默认 false） */
  readOnly?: boolean
  /** 无障碍标签（Monaco 会把 aria-label 落在输入区） */
  ariaLabel?: string
  /** 样式覆盖用 class */
  className?: string
  /** Ctrl/Cmd+S 保存（工作目录文件面板用；不传则不接管这个快捷键） */
  onSave?: () => void
}

function buildEditorOptions(
  props: CodeEditorProps,
  display: ResolvedCodeDisplay,
): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  const {
    fontSize = display.fontSize,
    readOnly = false,
    ariaLabel,
  } = props

  return {
    readOnly,
    domReadOnly: readOnly,
    ariaLabel,

    // 关掉重量级能力：体量 / 噪音都大，且无语言服务时本就没有内容
    minimap: { enabled: false },
    folding: false,
    stickyScroll: { enabled: false },
    // 无语言服务：补全 / 参数提示 / 悬浮只会显示「无内容」
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

    fontSize,
    fontFamily: display.fontFamily,
    fontLigatures: display.ligatures,
    lineHeight: codeLineHeightPx(fontSize, display.lineHeight),
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
  // 主题 / 字号 / 字族 / 行高 / 连字与代码预览共用同一套解析（设置 → 代码显示）
  const display = useCodeDisplay()
  const {
    value,
    onChange,
    language = 'javascript',
    height = 180,
    readOnly = false,
    className = '',
  } = props

  // addCommand 注册后闭包不会更新：保存回调走 ref，始终指向最新一次渲染
  const onSaveRef = useRef(props.onSave)
  onSaveRef.current = props.onSave

  const handleMount: OnMount = (editor) => {
    // 挂载时按 props 兜底一次，避免复用实例残留上一次的只读态
    editor.updateOptions({ readOnly, domReadOnly: readOnly })

    // Ctrl/Cmd+S：Monaco 自己接管并阻止浏览器默认（否则会弹「保存网页」）
    if (onSaveRef.current) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        onSaveRef.current?.(),
      )
    }
  }

  return (
    <div className={`code-editor${className ? ` ${className}` : ''}`}>
      <Editor
        height={height}
        language={language}
        value={value}
        theme={display.themeId}
        onMount={handleMount}
        onChange={(v) => onChange(v ?? '')}
        options={buildEditorOptions(props, display)}
      />
    </div>
  )
}
