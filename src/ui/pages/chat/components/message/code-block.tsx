// @ts-nocheck
/**
 * CodeBlock — 代码块（Monaco 只读预览 + 复制按钮 + actions）。
 *
 * 正常 → Monaco 只读预览（virlen-dark 主题）；streaming / 超大文件(>100K 字符) → `<pre>` 纯文本
 * fallback，避免流式闪烁与长任务阻塞。
 */
import {
  useState,
  useEffect,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useRef,
} from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import CopySvg from '@/ui/components/icons/CopySvg'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import CodePreview, {
  type CodePreviewApi,
} from '@/ui/components/code-preview/CodePreview'
import './code-block.scss'
import { openPath } from '@tauri-apps/plugin-opener'
import { resolve } from '@tauri-apps/api/path'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import ContextMenu, {
  useContextMenu,
} from '@/ui/components/shared/ContextMenu'
import { textMenuItems } from '@/ui/components/shared/ContextMenu/menus'

/** 获取语言显示名称 */
function getLanguageDisplay(lang: string | undefined): string {
  if (!lang) return ''
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TSX',
    js: 'JavaScript',
    jsx: 'JSX',
    py: 'Python',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    cs: 'C#',
    rb: 'Ruby',
    php: 'PHP',
    swift: 'Swift',
    kt: 'Kotlin',
    scala: 'Scala',
    sql: 'SQL',
    sh: 'Shell',
    bash: 'Bash',
    powershell: 'PowerShell',
    ps1: 'PowerShell',
    yaml: 'YAML',
    yml: 'YAML',
    json: 'JSON',
    xml: 'XML',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    less: 'Less',
    sass: 'Sass',
    md: 'Markdown',
    dockerfile: 'Dockerfile',
    docker: 'Docker',
    graphql: 'GraphQL',
    gql: 'GraphQL',
    toml: 'TOML',
    ini: 'INI',
    diff: 'Diff',
    makefile: 'Makefile',
    tex: 'LaTeX',
    latex: 'LaTeX',
  }
  return map[lang.toLowerCase()] || lang
}

/** 已知文件扩展名集合（用于路径检测） */
const KNOWN_EXTENSIONS = new Set([
  // 源码
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'd.ts',
  'd.mts',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'hxx',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'vue',
  'svelte',
  'astro',
  // 配置
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'npmrc',
  'gitignore',
  'editorconfig',
  'babelrc',
  'eslintrc',
  'prettierrc',
  'stylelintrc',
  'commitlintrc',
  // 样式
  'css',
  'scss',
  'sass',
  'less',
  'styl',
  // 文档
  'md',
  'mdx',
  'txt',
  'markdown',
  'rst',
  'adoc',
  // Web
  'html',
  'htm',
  'svg',
  'xml',
  'xhtml',
  'ejs',
  'hbs',
  'pug',
  // Shell
  'sh',
  'bash',
  'zsh',
  'fish',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  // 其他常见
  'log',
  'out',
  'tmp',
  'bak',
  'swp',
  'sql',
  'db',
  'sqlite',
  'makefile',
  'dockerfile',
  'procfile',
])

/**
 * 字符串是否看起来像文件路径（仅格式检测，不查磁盘）：绝对 / 相对路径、含分隔符的路径、
 * 或带已知扩展名的纯文件名。
 */
function isValidPath(str: string): boolean {
  const s = String(str).trim()
  if (!s || s.length > 512) return false

  // 排除 URL
  if (/^(https?|ftp|file):\/\//i.test(s)) return false
  // 排除纯数字、版本号 (1.2.3)
  if (/^\d+(\.\d+)+$/.test(s)) return false
  // 排除特殊符号开头
  if (/^[\s\-–—*•·]/.test(s)) return false

  // Windows 绝对路径: C:\xxx 或 C:/xxx
  if (/^[A-Za-z]:[/\\]/.test(s)) return true

  // Unix 绝对路径: /xxx
  if (s.startsWith('/')) return true

  // 相对路径: ./xxx 或 ../xxx
  if (s.startsWith('./') || s.startsWith('../')) return true

  // 包含路径分隔符: a/b 或 a\b
  if (s.includes('/') || s.includes('\\')) {
    if (s.endsWith('/') || s.endsWith('\\')) return false
    return /^[\w.\-~/\\:@]+$/.test(s)
  }

  // 纯文件名（无分隔符）：必须有已知扩展名
  const dotIndex = s.lastIndexOf('.')
  if (dotIndex > 0 && dotIndex < s.length - 1) {
    const ext = s.slice(dotIndex + 1).toLowerCase()
    const name = s.slice(0, dotIndex)
    if (KNOWN_EXTENSIONS.has(ext) && /^[\w.~-]+$/.test(name)) return true
  }

  return false
}

// Monaco 代码预览

/** 代码字号档位（默认 medium），比 UI 正文 --font-size-md 大 1~3px */
const CODE_FONT_PX: Record<'small' | 'medium' | 'large', number> = {
  small: 12,
  medium: 13,
  large: 14,
}

/** 读 CSS 变量 --font-size-md 的像素值（行内代码用，跟随用户字号设置） */
function getUiMdFontPx(): number {
  if (typeof document === 'undefined') return 13
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-size-md')
    .trim()
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? 13 : parsed
}

/** 代码块默认字号：读全局「字体大小」设置（small/medium/large）；settingsState 是 observable，
 * observer 包裹后改动即时生效。 */
function getDefaultCodeFontSize(): number {
  const level = settingsState.value.fontSize ?? 'medium'
  return CODE_FONT_PX[level] ?? CODE_FONT_PX.medium
}

/** 字号：explicit 目前不影响结果，一律取当前档位值（见 CODE_FONT_PX） */
function resolveCodeFontPx(explicit?: number): number {
  const base = getDefaultCodeFontSize()
  if (explicit == null || explicit <= 0) return base
  return base
}

/**
 * 语言别名 → Monaco 语言 id。monaco 0.56 精简构建只注册了 src/monaco/setupMonaco.ts 里的语言，
 * 未覆盖的返回 undefined（按纯文本显示）。注：C 复用 cpp、TOML 走 ini（monaco 无独立 tokenizer）。
 */
const MONACO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rs: 'rust',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  powershell: 'powershell',
  ps1: 'powershell',
  psm1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  sql: 'sql',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  toml: 'ini',
  diff: 'diff',
}

export function toMonacoLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  return MONACO_LANG[lang.toLowerCase()]
}
/** 大文件保护：超过该字符数改为纯文本 fallback，避免 Monaco 长任务阻塞 */
const LARGE_CODE_LIMIT = 100 * 1000

/**
 * MonacoCodeView — 用 CodePreview(Monaco) 渲染「代码正文」。高度 = 行数 * lineHeight + padding
 * （与编辑器 options 的 lineHeight 一致）；纵向滚动交给外层 .code-block-wrapper，Monaco
 * 自身不溢出，配合 scrollbar.alwaysConsumeMouseWheel=false 才不会吞掉消息列表的滚轮。
 */
function MonacoCodeView({
  language,
  code,
  fontSize,
  showLineNumbers,
  startLineNumber,
  onSelectionChange,
  onApiReady,
}: {
  language?: string
  code: string
  fontSize?: number
  showLineNumbers?: boolean
  startLineNumber?: number
  onSelectionChange?: (selectedText: string) => void
  onApiReady?: (api: CodePreviewApi | null) => void
}) {
  const fontPx = resolveCodeFontPx(fontSize)
  const lineH = Math.max(16, Math.round(fontPx * 1.5))
  const lineCount = code ? code.split('\n').length : 1
  const height = Math.max(lineH + 16, 5 + (lineCount + 1) * lineH)

  return (
    <CodePreview
      code={code}
      language={toMonacoLang(language)}
      theme="virlen-dark"
      height={height}
      showLineNumbers={showLineNumbers}
      startLineNumber={startLineNumber}
      fontSize={fontPx}
      onSelectionChange={onSelectionChange}
      onApiReady={onApiReady}
    />
  )
}

// CodeBlock

async function tryOpen(path: string) {
  if (await tryCanonicalize(path)) {
    openPath(path)
  } else {
    const workspace = sessionStore.value.sessions.find(
      (item) => item.id == chatState.value.currentSessionId,
    )?.workspace
    if (!workspace) return
    const absPath = await resolve(workspace, path)
    const flag = await tryCanonicalize(absPath)
    if (!flag) return
    openPath(absPath)
  }
}
/** 自定义操作按钮 */
export interface Action {
  title: string
  onClick: () => void
  iconRender?: () => ReactElement
}

/**
 * CodeBlock 组件 Props。继承 HTMLAttributes<HTMLElement>：其余原生属性（react-markdown
 * 的 node 等）会经 ...props 透传到内联 <code>。
 */
export interface CodeBlockProps extends HTMLAttributes<HTMLElement> {
  /** 语言 class（react-markdown 约定，如 `language-ts`） */
  className?: string
  /** 代码内容 */
  children: ReactNode
  /** 最大高度（px），超出自动滚动 */
  maxHeight?: number | string
  /** 代码块宽度 */
  width?: number | string
  /** 字体大小（px）；当前实现按「字体大小」设置取档位值：small 12 / medium 13 / large 14 */
  fontSize?: number
  /** 文件名，用于推断代码语言 */
  fileName?: string
  /**
   * 自定义「文件名区域」渲染（提供后替代默认的纯文本文件名）。
   * 文件名由 CodeBlock 自己画在头部，调用方换不掉（多文件切换要在这里塞一个下拉），故留这个插槽。
   */
  fileNameRender?: (fileName?: string) => ReactNode
  /**
   * 内容标识（如「当前展示哪个文件」）。变化时把滚动位置归零 —— 内容是原地替换的
   * （DOM 与 Monaco 实例都复用），不归零会停在新内容的同一像素偏移上，看着像没切换。
   */
  contentKey?: string | number
  /** 是否显示行号（默认 true） */
  showLineNumbers?: boolean
  /** 起始行号（默认 1） */
  startLineNumber?: number
  /** 流式输出中 → 纯文本 fallback（避免 Monaco 每次 chunk 重建） */
  streaming?: boolean
  /** 自定义操作按钮 */
  actions?: Action[]
  /** 是否自动居中 */
  autoCenter?: boolean
  /** 是否有行内代码 */
  inlineCode?: boolean
}

function CodeBlock({
  className,
  children,
  maxHeight,
  width,
  fontSize,
  fileName,
  fileNameRender,
  contentKey,
  showLineNumbers = true,
  startLineNumber = 1,
  streaming,
  actions = [] as Action[],
  autoCenter = false,
  inlineCode = false,
  ...props
}: CodeBlockProps) {
  // 复制态：行内 / 块状两条渲染路径共用同一组 hooks，必须都在提前 return 之前
  const [copied, setCopied] = useState(false)
  // 全屏态：同理
  const [fullscreen, setFullscreen] = useState(false)
  // 「打开即居中」同理必须在提前 return 之前调用：行内 / 块状共用一个 fiber（react-markdown
  // 的 `code` 覆盖组件把它们渲染在同一位置，流式「前缀冻结」还会让尾部首块在两种形态间切换），
  // 某次渲染少调一个 hook 就会抛 React #300（行内路径 autoCenter=false，effect 本身不做任何事）。
  const rootRef = useAutoCenter(autoCenter)
  /**
   * 代码块专属右键菜单：气泡菜单的「复制」取的是整条气泡正文，而 Monaco 的选区不进
   * `window.getSelection()`，右键代码块再复制会拿到整条气泡 —— 这里拦下事件
   * （`openAt` 会 preventDefault + stopPropagation，气泡不再接管）。
   * 同样必须在提前 return 之前调用（行内 / 块状共用同一 fiber）。
   */
  const menu = useContextMenu()
  /**
   * Monaco 当前选区文本（onSelectionChange 上报）。用 ref 而非 state：菜单项渲染时现算，读取无需重渲染。
   * Monaco 右键不改选区，故右键那一刻读到的就是用户框选内容；无选区为空串（菜单回退整段代码）。
   * <pre> 回退路径不经过 Monaco，恒为空串，由 window 选区接管。
   */
  const monacoSelectionRef = useRef('')
  /** 命令式 API（Monaco 全选）分原位 / 全屏两份：全屏时原位仍挂载，不区分会把全选作用到看不见那份 */
  const monacoApiNormalRef = useRef<CodePreviewApi | null>(null)
  const monacoApiFullRef = useRef<CodePreviewApi | null>(null)
  /** 流式/超大文件的 <pre> 回退节点（全选时用其 DOM 选区），同样分原位 / 全屏 */
  const preNormalRef = useRef<HTMLPreElement | null>(null)
  const preFullRef = useRef<HTMLPreElement | null>(null)

  /**
   * 内容换人（多文件切换）→ 滚回顶部。与 autoCenter / 右键菜单同理写在提前 return 之前：
   * 行内与块状两条路径共用同一 fiber，少调一个 hook 就是 React #300（见 code-block-hooks.test.tsx）。
   * `contentKey === undefined`（多数调用点不传）时全程不动滚动。
   */
  useEffect(() => {
    if (contentKey === undefined) return
    const el = rootRef.current
    if (el) el.scrollTop = 0
  }, [contentKey])

  // Esc 退出全屏（与 ImagePreview 等浮层一致）
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  let match = /language-(\w+)/.exec(className || '')
  // fileName 可能带路径（如 "src/foo.ts"），语言推断只取最后一段
  let language = match
    ? match[1]
    : fileName?.split(/[\\/]/).pop()?.split('.').pop()
  // 从 fence info string 解析参数，如 ```tsx showLineNumbers
  if (language && language.includes(' ')) {
    const parts = language.split(/\s+/)
    language = parts[0]
    if (parts.includes('showLineNumbers')) {
      showLineNumbers = true
    }
  }
  const code = String(children).replace(/\n$/, '')

  // 行内代码
  if (inlineCode && !match && !code.includes('\n')) {
    const isPath = isValidPath(code)
    return (
      <code
        className={`inline-code${isPath ? ' clickable' : ''}`}
        style={{ fontSize: `${fontSize || getUiMdFontPx()}px` }}
        {...props}
        onClick={isPath ? () => tryOpen(code) : undefined}>
        {children}
      </code>
    )
  }

  const displayLang = getLanguageDisplay(language)

  function handleCopy() {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1000)
      })
      .catch(() => {
        const textarea = document.createElement('textarea')
        textarea.value = code
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        setCopied(true)
        setTimeout(() => setCopied(false), 1000)
      })
  }

  /**
   * 全选代码（菜单项）：Monaco 走命令式 API（选区经 onSelectionChange 上报，紧接着的
   * 「复制代码」才拿得到）；<pre> 回退用 DOM Range 选中节点内容。优先取全屏那份。
   */
  function selectAllCode() {
    const api = monacoApiFullRef.current ?? monacoApiNormalRef.current
    if (api) {
      api.selectAll()
      return
    }
    const el = preFullRef.current ?? preNormalRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  /** 渲染代码块本体：`isFull` 用于全屏浮层（不限 maxHeight/width，由 CSS 铺满），其余结构与原位一致 */
  function renderBlock(isFull: boolean) {
    return (
      <div
        ref={rootRef}
        className={`code-block-wrapper${isFull ? ' is-fullscreen' : ''}`}
        style={{
          maxHeight: !isFull && maxHeight ? maxHeight : undefined,
          width: !isFull && width ? width : undefined,
          overflow: isFull || maxHeight ? 'auto' : 'visible',
        }}
        onContextMenu={(e) => menu.openAt(e, undefined)}>
        <div className="code-block-header">
          <div className="code-block-header-info">
            <span className="code-language">{displayLang}</span>
            {fileNameRender
              ? fileNameRender(fileName)
              : fileName && (
                  <span className="code-file-name" title={fileName}>
                    {fileName}
                  </span>
                )}
          </div>
          <div className="actions-list">
            {
              actions.map((action, index) => {
                if (!action.iconRender)
                  console.error(`action ${action.title} should have iconRender`)
                return (
                  <button className="action-btn" key={action.title} onClick={action.onClick} title={action.title}>
                    {action.iconRender ? action.iconRender() : <CopySvg />}
                  </button>
                )
              })
            }
            <button
              className="code-copy-btn"
              onClick={handleCopy}
              title={t('复制代码')}>
              {copied ? (
                <svg viewBox="0 0 1160 1024" width="14" height="14">
                  <path
                    d="M1098.5472 34.133333C766.498133 240.64 525.653333 501.486933 416.9728 632.149333L151.552 421.205333 34.133333 516.983467 492.3392 989.866667c78.6432-204.868267 328.772267-605.252267 634.0608-889.856L1098.5472 34.133333z"
                    fill="var(--color-success, #4ade80)"
                  />
                </svg>
              ) : (
                <CopySvg fill="var(--code-header-color)" />
              )}
            </button>
            <button
              className="code-fullscreen-btn action-btn"
              onClick={() => setFullscreen(!fullscreen)}
              title={fullscreen ? t('退出全屏') : t('全屏')}>
              {fullscreen ? <ExitFullScreenSvg /> : <FullScreenSvg />}
            </button>

          </div>
        </div>
        {/* 流式输出 / 超大文件 → 常规 pre/code 纯文本 fallback */}
        {streaming || code.length > LARGE_CODE_LIMIT ? (
          <div className="code-streaming-fallback">
            <pre
              ref={(el) => {
                if (isFull) preFullRef.current = el
                else preNormalRef.current = el
              }}
              className="code-fallback"
              style={{ fontSize: `${resolveCodeFontPx(fontSize)}px` }}>
              <code>{code}</code>
            </pre>
          </div>
        ) : (
          <MonacoCodeView
            fontSize={fontSize}
            language={language}
            code={code}
            showLineNumbers={showLineNumbers}
            startLineNumber={startLineNumber}
            onSelectionChange={(text) => {
              monacoSelectionRef.current = text
            }}
            onApiReady={(api) => {
              if (isFull) monacoApiFullRef.current = api
              else monacoApiNormalRef.current = api
            }}
          />
        )}
      </div>
    )
  }

  return (
    <>
      {/* 原位代码块全屏时也照常渲染：卸载会让虚拟列表条目变矮 → 重测量 → 锚点跳动 */}
      {renderBlock(false)}
      {fullscreen &&
        createPortal(
          <div className="code-block-fullscreen-layer">{renderBlock(true)}</div>,
          document.body,
        )}
      {/* 代码块右键菜单：复制代码 / 全选（选区优先）；挂 body，浮层里也能用 */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={textMenuItems(() => monacoSelectionRef.current || code, {
            copyLabel: t('复制代码'),
            selectAll: selectAllCode,
          })}
          onClose={menu.close}
        />
      )}
    </>
  )
}

export default observer(CodeBlock)
