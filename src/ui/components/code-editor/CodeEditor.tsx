/**
 * CodeEditor —— 可编辑的精简版 Monaco（带语法高亮的小代码输入框）
 *
 * 与 `CodePreview`（只读：隐藏光标、关右键菜单、关输入）相对：本组件用于**真正输入**，
 * 保留编辑与**自绘的右键菜单**（剪切 / 复制 / 粘贴 / 全选：Monaco 精简入口没带 `contrib/contextmenu`，
 * 原生菜单又被自绘窗口全局拦掉了，不补就什么都弹不出来），
 * 还有 Ctrl/Cmd+F 查找（右上角搜索框 + 全文命中高亮，就是 VS Code 那套控件），
 * 只减掉噪音与体积（小地图 / 折叠 / 行高亮）。
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
import { useEffect, useReducer, useRef } from 'react'

// 必须最先引入：精简 monaco + 高亮注册 + 代码主题注册（monaco 命名空间也从这里拿）
import { monaco } from '@/monaco/setupMonaco'
// 查找框的两处水土不服（气泡被裁 / 跟着滚动滚走）：统一在 `monaco/findWidget` 里收口
import { tameFindWidget } from '@/monaco/findWidget'
/**
 * Ctrl/Cmd+F 的查找控件（右上角搜索框 + 命中高亮）在 Monaco 里是 **contrib**：
 * 精简入口 `editor.api.js` 只导出 API、一个 contrib 都不带（完整入口 `editor.main.js` 里那行
 * `import './contrib/find/browser/findController.js'` 才有它），所以得自己按需引一次。
 *
 * ⚠️ 必须在编辑器实例创建**之前**求值（模块顶层即可）：contrib 是构造编辑器时按注册表取的，
 *    晚于构造引进来不生效 —— 表现是「Ctrl+F 没反应」，且不报任何错。
 * 只有可编辑的编辑器需要它（`CodePreview` 只读预览不加）；代价实测 +82 kB / gzip +20 kB，
 * 跟组件进同一份产物（不额外发请求）。
 */
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import { useCodeDisplay } from '@/ui/hooks/useCodeDisplay'
import {
  codeLineHeightPx,
  type ResolvedCodeDisplay,
} from '@/domain/code-display'
import ContextMenu, { useContextMenu } from '@/ui/components/shared/ContextMenu'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'
import { t } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { copyText, readClipboardText } from '@/utils/clipboard'
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
    // 右键菜单自绘（见 `buildMenuItems`）：Monaco 自己的菜单 contrib 精简入口没带，
    // 这里显式关掉，免得将来谁把它引进来时弹出两套菜单
    contextmenu: false,
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

/**
 * 右键菜单四项：剪切 / 复制 / 粘贴 / 全选。
 *
 * 走自己的剪贴板工具（`utils/clipboard`）而不是 Monaco 的 `clipboardCutAction` /
 * `clipboardPasteAction`：精简入口 `editor.api.js` 同样不带 `contrib/clipboard`，那两个 action
 * 根本不存在（与查找框同一类坑），而输入框右键菜单已经在用这套工具（见 `ContextMenu/editable.ts`）。
 *
 * 禁用态在**渲染时**现算：菜单开着时选区会变（「全选」→ 紧接着「复制」），由组件里那条
 * `onDidChangeCursorSelection` 订阅排队重算。
 */
function buildMenuItems(
  editor: MonacoNs.editor.ICodeEditor,
  readOnly: boolean,
): ContextMenuItem[] {
  const model = editor.getModel()
  const selection = editor.getSelections()?.[0] ?? null
  const hasSelection = !!selection && !selection.isEmpty()
  const selectedText = (): string =>
    model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : ''

  /** 粘贴落点：有选区就替换选区，否则插在光标处 */
  const pasteRange = (): MonacoNs.IRange | null => {
    if (selection) return selection
    const position = editor.getPosition()
    if (!position) return null
    return {
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    }
  }

  /** 落一次编辑：前后各一个 undo 停顿，Ctrl+Z 能单独拓回来 */
  const applyEdit = (range: MonacoNs.IRange, text: string): void => {
    editor.pushUndoStop()
    editor.executeEdits('code-editor-context-menu', [
      { range, text, forceMoveMarkers: true },
    ])
    editor.pushUndoStop()
    editor.focus()
  }

  return [
    {
      key: 'cut',
      label: t('剪切'),
      disabled: readOnly || !hasSelection,
      onClick: async () => {
        const text = selectedText()
        if (!text || !selection) return
        // 先确认写进了剪贴板再删 —— 否则这段文字直接从用户眼前消失
        if (!(await copyText(text))) {
          showToast(t('复制失败'))
          return
        }
        applyEdit(selection, '')
      },
    },
    {
      key: 'copy',
      label: t('复制'),
      disabled: !hasSelection,
      onClick: async () => {
        const text = selectedText()
        if (!text) return
        editor.focus()
        showToast((await copyText(text)) ? t('已复制到剪贴板') : t('复制失败'))
      },
    },
    {
      key: 'paste',
      label: t('粘贴'),
      disabled: readOnly,
      onClick: async () => {
        const range = pasteRange()
        if (!range) return
        const text = await readClipboardText()
        // 读不到文本（剪贴板为空 / 是图片 / 无权限）→ 静默不动，与输入框右键「粘贴」同一约定
        if (!text) return
        applyEdit(range, text)
      },
    },
    {
      key: 'select-all',
      label: t('全选'),
      divider: true,
      disabled: !model || model.getValueLength() === 0,
      // 全选后通常紧接着「复制」，菜单保持打开（与输入框 / 终端菜单同一约定）
      keepOpen: true,
      onClick: () => {
        if (!model) return
        editor.setSelection(model.getFullModelRange())
        editor.focus()
      },
    },
  ]
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

  /**
   * 右键菜单：自绘窗口全局 preventDefault 了原生菜单，Monaco 自己的菜单又没在精简构建里
   *（`contrib/contextmenu` 没引）—— 两样都没有，右键就是「什么都不发生」。
   * target = 在哪个编辑器实例上点的，菜单项渲染时按它的选区现算。
   */
  const menu = useContextMenu<MonacoNs.editor.ICodeEditor>()
  /** 菜单开着时选区会变（「全选」→ 紧接着「复制」）：订一次选区变化，让禁用态跟着刷新 */
  const [, bumpSelection] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!menu.state) return
    const subscription = menu.state.target.onDidChangeCursorSelection(() =>
      bumpSelection(),
    )
    return () => subscription.dispose()
  }, [menu.state])

  const handleMount: OnMount = (editor) => {
    // 挂载时按 props 兜底一次，避免复用实例残留上一次的只读态
    editor.updateOptions({ readOnly, domReadOnly: readOnly })

    // Ctrl/Cmd+S：Monaco 自己接管并阻止浏览器默认（否则会弹「保存网页」）
    if (onSaveRef.current) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        onSaveRef.current?.(),
      )
    }

    /**
     * 查找框（Ctrl/Cmd+F）的两个已知问题统一在 `monaco/findWidget` 里处理（销毁钩子也在那里接）：
     * ① 三个开关的悬浮气泡被 `overflow: hidden` 切一半（源头断掉 `mouseover`）；
     * ② 编辑器比可视区高时搜索框会被滚出视野（夹进可见交集）。
     */
    tameFindWidget(editor)

    /**
     * 右键菜单：挂在编辑器容器上、**捕获阶段** —— 抢在 Monaco 内部的任何处理之前，
     * 不会因为中间有东西 stopPropagation 就弹不出来；顺手拦掉浏览器原生菜单。
     */
    const node = editor.getDomNode()
    const onContextMenu = (event: MouseEvent): void => {
      // 查找框里是真正的 <input>：那里右键该走它自己的菜单，
      // 不能把「粘贴」落到编辑器正文上（落点是错的，用户会莫名多出一段代码）
      const clicked = event.target
      if (clicked instanceof Element && clicked.closest('.find-widget')) return

      event.preventDefault()
      event.stopPropagation()
      // 右键落在选区外：把光标挪过去 —— 之后的「粘贴」就落在右键处（与 VS Code 一致）
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
      const selection = editor.getSelection()
      if (
        target?.position &&
        (!selection || !selection.containsPosition(target.position))
      ) {
        editor.setPosition(target.position)
      }
      menu.openAt(event, editor)
    }
    node?.addEventListener('contextmenu', onContextMenu, true)
    editor.onDidDispose(() =>
      node?.removeEventListener('contextmenu', onContextMenu, true),
    )
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
      {/* 右键菜单（portal 挂 body）：剪切 / 复制 / 粘贴 / 全选 */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={buildMenuItems(menu.state.target, readOnly)}
          onClose={menu.close}
        />
      )}
    </div>
  )
}
