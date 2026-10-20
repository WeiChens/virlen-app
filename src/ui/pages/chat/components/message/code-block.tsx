// @ts-nocheck
/**
 * 代码块：Monaco 只读预览 + 复制 / 全屏 / 自定义动作。
 * 流式输出或超大文件（>100K 字符）退为 <pre>，避免闪烁与长任务阻塞。
 */
import {
  useState,
  useEffect,
  useCallback,
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
import { chatState, sessionStore } from '@/ui/store'
import { useCodeDisplay } from '@/ui/hooks/useCodeDisplay'
import { codeLineHeightPx, codePreviewHeight } from '@/domain/code-display'
import { t } from '@/ui/i18n'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import ContextMenu, {
  useContextMenu,
} from '@/ui/components/shared/ContextMenu'
import { textMenuItems } from '@/ui/components/shared/ContextMenu/menus'

/** 语言显示名 */
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

/** 已知文件扩展名（用于路径检测） */
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
 * 是否看起来像文件路径（仅格式检测）：绝对 / 相对路径、含分隔符、或带已知扩展名的文件名。
 */
function isValidPath(str: string): boolean {
  const s = String(str).trim()
  if (!s || s.length > 512) return false

  // 排除 URL / 版本号 / 项目符号开头
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

/**
 * 读 CSS 变量 --font-size-md（**行内代码**用）。
 *
 * 行内代码嵌在正文里，跟的是界面字号；代码块（block）跟的是独立的「代码显示」字号，
 * 两者不要混 —— 否则用户只想把代码调大时，正文里的 `inline code` 也跟着变。
 */
function getUiMdFontPx(): number {
  if (typeof document === 'undefined') return 13
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-size-md')
    .trim()
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? 13 : parsed
}

/**
 * 语言别名 → Monaco 语言 id。未注册的语言返回 undefined（按纯文本显示）；
 * C 复用 cpp、TOML 走 ini。
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
/** 超过该字符数改为纯文本，避免 Monaco 长任务阻塞 */
const LARGE_CODE_LIMIT = 100 * 1000

/** 代码块头部高度兜底（px）：与 code-block.scss 对齐（上下 padding 6×2 + 按钮 26），挂载后实测校正 */
const HEADER_FALLBACK_PX = 38

/** 代码区至少保留的高度（px）：窗口极小时也不至于给 Monaco 算出负数 */
const MIN_BODY_HEIGHT_PX = 120

/** 窗口自绘标题栏高度（`--window-top-bar-height`）：全屏代码块要从可用高度里让出它 */
function topBarHeightPx(): number {
  if (typeof document === 'undefined') return 30
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--window-top-bar-height')
    .trim()
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 30
}

/**
 * `maxHeight`（px 数或 CSS 长度）→ 像素。
 *
 * 只认 px / vh / vw（`450` / `600` / `'55vh'` 就是本项目全部调用点的写法）：其余写法算不准就返回
 * null，表示「不限制」—— 宁可不夹，也不要拿一个错的数字把代码裁掉。
 */
function maxHeightToPx(
  value: number | string | undefined,
  viewport: { width: number; height: number },
): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const matched = /^(-?\d*\.?\d+)\s*(px|vh|vw)$/i.exec(String(value).trim())
  if (!matched) return null
  const amount = Number(matched[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = matched[2].toLowerCase()
  if (unit === 'vh') return (viewport.height * amount) / 100
  if (unit === 'vw') return (viewport.width * amount) / 100
  return amount
}

/** 视口尺寸 + 标题栏高度（resize 时重算：`55vh` 与全屏可用高度都随窗口变） */
function useViewportMetrics(): { width: number; height: number; topBar: number } {
  const [metrics, setMetrics] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
    topBar: topBarHeightPx(),
  }))
  useEffect(() => {
    const handleResize = (): void =>
      setMetrics({
        width: window.innerWidth,
        height: window.innerHeight,
        topBar: topBarHeightPx(),
      })
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  return metrics
}

/**
 * 代码块头部实测高度。
 *
 * 全屏要把它从可用高度里扣掉（否则最后一行会被容器裁掉）；CSS 里它是固定值，但不写死在这里 ——
 * 改 padding / 按钮尺寸时不会静默错几像素。
 */
function useHeaderHeightPx(): {
  headerRef: (el: HTMLDivElement | null) => void
  headerHeight: number
} {
  const [headerHeight, setHeaderHeight] = useState(HEADER_FALLBACK_PX)
  const observerRef = useRef<ResizeObserver | null>(null)

  const headerRef = useCallback((el: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const sync = (): void => {
      const next = el.offsetHeight
      if (next > 0) setHeaderHeight((prev) => (prev === next ? prev : next))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    observerRef.current = new ResizeObserver(sync)
    observerRef.current.observe(el)
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return { headerRef, headerHeight }
}

/**
 * 用 CodePreview(Monaco) 渲染代码正文。高度按行数算（首帧估值），纵向滚动在 Monaco 内部：
 * 内容超过 `maxContentHeight` 时容器钉在上限、由内置滚动条滚（外层不再套滚动容器）。
 *
 * ⚠️ 高度必须走 `codePreviewHeight`（= Monaco 的内容高度：行数 × 行高 + 上下 padding）：
 *    未超上限时它就是实际高度 —— 多 1px 是一截多余底色，少 1px 会把最后一行裁掉
 *    （那时按设计不开滚动条，连拖都拖不到）。
 * ⚠️ lineHeightPx 由调用方从同一份解析结果传入（不要在这里再乘一次倍率）：
 *    容器高度是按它算的，与 Monaco 的 lineHeight 必须同一个数。
 */
function MonacoCodeView({
  language,
  code,
  fontSize,
  lineHeightPx,
  showLineNumbers,
  startLineNumber,
  maxContentHeight,
  onSelectionChange,
  onApiReady,
}: {
  language?: string
  code: string
  fontSize: number
  lineHeightPx: number
  showLineNumbers?: boolean
  startLineNumber?: number
  /** 代码区高度上限（px）：超出部分交给 Monaco 内置滚动条 */
  maxContentHeight?: number
  onSelectionChange?: (selectedText: string) => void
  onApiReady?: (api: CodePreviewApi | null) => void
}) {
  const lineCount = code ? code.split('\n').length : 1
  const height = codePreviewHeight(lineCount, lineHeightPx)

  return (
    <CodePreview
      code={code}
      language={toMonacoLang(language)}
      // 首帧用估算值，之后由编辑器自己报（Monaco 认 `\r\n` / `\r` / `\n` 三种行尾，
      // 我们只能按 `split('\n')` 数 —— CRLF 末尾剩一个裸 `\r` 时会少算一行）
      fitContent
      height={height}
      maxContentHeight={maxContentHeight}
      showLineNumbers={showLineNumbers}
      startLineNumber={startLineNumber}
      fontSize={fontSize}
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
 * CodeBlock Props。继承 HTMLAttributes 是为了把 react-markdown 的 node 等属性透传到内层 <code>。
 */
export interface CodeBlockProps extends HTMLAttributes<HTMLElement> {
  /** 语言 class（react-markdown 约定） */
  className?: string
  /** 代码内容 */
  children: ReactNode
  /** 最大高度（CSS 长度），限的是**代码区**（不含头部）；超出部分由 Monaco 内置滚动条承担 */
  maxHeight?: number | string
  /** 代码块宽度 */
  width?: number | string
  /** 字体大小（px）；不传则用「设置 → 代码显示」的字号 */
  fontSize?: number
  /** 文件名，用于推断代码语言 */
  fileName?: string
  /**
   * 自定义文件名区域渲染（多文件切换需要塞下拉时用）。
   */
  fileNameRender?: (fileName?: string) => ReactNode
  /** 内容标识：变化时滚回顶部（DOM 与 Monaco 实例复用，不归零会停在同一像素偏移） */
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
  showLineNumbers,
  startLineNumber = 1,
  streaming,
  actions = [] as Action[],
  autoCenter = false,
  inlineCode = false,
  ...props
}: CodeBlockProps) {
  // 以下 hooks 必须在提前 return 之前：行内 / 块状共用同一 fiber，少调一个就 React #300
  /** 代码显示设置（字号 / 行高 / 字族 / 主题）：显式传 fontSize 时以 props 为准 */
  const display = useCodeDisplay()
  const fontPx = fontSize && fontSize > 0 ? fontSize : display.fontSize
  const lineHeightPx = codeLineHeightPx(fontPx, display.lineHeight)
  const [copied, setCopied] = useState(false)
  // 全屏态：同理
  const [fullscreen, setFullscreen] = useState(false)
  // 「打开即居中」同理必须在提前 return 之前调用：行内 / 块状共用一个 fiber（react-markdown
  // 的 `code` 覆盖组件把它们渲染在同一位置，流式「前缀冻结」还会让尾部首块在两种形态间切换），
  // 某次渲染少调一个 hook 就会抛 React #300（行内路径 autoCenter=false，effect 本身不做任何事）。
  const rootRef = useAutoCenter(autoCenter)
  /** 视口尺寸（`55vh` 换算 + 全屏可用高度）与头部实测高度 */
  const metrics = useViewportMetrics()
  const { headerRef, headerHeight } = useHeaderHeightPx()
  /**
   * 代码块专属右键菜单：Monaco 选区不进 window.getSelection()，气泡菜单的复制会拿到整条正文。
   */
  const menu = useContextMenu()
  /**
   * Monaco 当前选区文本（用 ref：菜单项渲染时现算，无需重渲染）。<pre> 路径恒为空串，由 window 选区接管。
   */
  const monacoSelectionRef = useRef('')
  /** 命令式 API 分原位 / 全屏两份：全屏时原位仍挂载，不区分会把全选作用到看不见那份 */
  const monacoApiNormalRef = useRef<CodePreviewApi | null>(null)
  const monacoApiFullRef = useRef<CodePreviewApi | null>(null)
  /** <pre> 回退节点（全选时用 DOM 选区），分原位 / 全屏 */
  const preNormalRef = useRef<HTMLPreElement | null>(null)
  const preFullRef = useRef<HTMLPreElement | null>(null)

  /** 内容换人就滚回顶部（钩子必须写在提前 return 之前） */
  useEffect(() => {
    if (contentKey === undefined) return
    // 纵向滚动现在在 Monaco 内部（超上限时），DOM 那行只是 fallback 路径的保险
    const el = rootRef.current
    if (el) el.scrollTop = 0
    monacoApiNormalRef.current?.scrollToTop()
    monacoApiFullRef.current?.scrollToTop()
  }, [contentKey])

  // Esc 退出全屏
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  let match = /language-(\w+)/.exec(className || '')
  // fileName 可能带路径，语言推断只取最后一段
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
  /* fence 里的 `showLineNumbers` 在 hooks 之后才解析出来，所以「最终值」放在这里：
     props 显式传了就以 props 为准，否则跟设置走 */
  const withLineNumbers = showLineNumbers ?? display.showLineNumbers
  /* ⚠️ 剥掉末尾那一个换行要认三种行尾：只写 `/\n$/` 的话，CRLF 文件（`…\r\n`）会剩下一个裸 `\r`，
     Monaco 把它也当换行 → 模型多一行（最后一行空），高度算式少算一行 → 多出 16px 可滚范围 */
  const code = String(children).replace(/(\r\n|\r|\n)$/, '')

  // 行内代码
  if (inlineCode && !match && !code.includes('\n')) {
    const isPath = isValidPath(code)
    return (
      <code
        className={`inline-code${isPath ? ' clickable' : ''}`}
        style={{ fontSize: `${getUiMdFontPx()}px` }}
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
   * 全选代码：Monaco 走命令式 API（选区经 onSelectionChange 上报，紧接着的复制才拿得到）；
   * <pre> 用 DOM Range。优先取全屏那份。
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

  /**
   * 代码区（不含头部）的高度上限（px）：全屏 = 视口 − 标题栏 − 头部；普通 = `maxHeight`。
   *
   * null = 不限制（内容多高块就多高，没有滚动条），对应旧行为里没传 maxHeight 的普通代码块。
   */
  function bodyMaxHeightPx(isFull: boolean): number | null {
    if (isFull) {
      // −1：留 1px 余量，别让取整误差把最后一行顶出全屏层（那边溢出了就是被裁）
      return Math.max(
        Math.floor(metrics.height - metrics.topBar - headerHeight) - 1,
        MIN_BODY_HEIGHT_PX,
      )
    }
    return maxHeightToPx(maxHeight, metrics)
  }

  /** 渲染代码块本体；isFull 用于全屏浮层（不限宽度，高度按视口算） */
  function renderBlock(isFull: boolean) {
    const bodyMax = bodyMaxHeightPx(isFull)
    return (
      <div
        ref={rootRef}
        className={`code-block-wrapper${isFull ? ' is-fullscreen' : ''} ${props.className || ''}`}
        style={{
          // 高度上限落在「代码区」上（见 bodyMax），**外层不再自己滚**：外层滚动那版会把
          // Ctrl+F 的查找框一起滚出视野（见 monaco/findWidget），也给不出库自带的滚动条
          width: !isFull && width ? width : undefined,
          ...(props?.style || {})
        }}
        onContextMenu={(e) => menu.openAt(e, undefined)}>
        <div className="code-block-header" ref={isFull ? undefined : headerRef}>
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
        {/* 流式输出 / 超大文件 → <pre> 纯文本 fallback */}
        {streaming || code.length > LARGE_CODE_LIMIT ? (
          <div
            className="code-streaming-fallback"
            style={{
              // 回退层自己滚：外层不再承担滚动（内置滚动条只在 Monaco 路径里存在）
              maxHeight: bodyMax ?? undefined,
              overflow: bodyMax ? 'auto' : undefined,
            }}>
            <pre
              ref={(el) => {
                if (isFull) preFullRef.current = el
                else preNormalRef.current = el
              }}
              className="code-fallback"
              style={{ fontSize: `${fontPx}px`, lineHeight: display.lineHeight }}>
              <code>{code}</code>
            </pre>
          </div>
        ) : (
          <MonacoCodeView
            fontSize={fontPx}
            lineHeightPx={lineHeightPx}
            language={language}
            code={code}
            showLineNumbers={withLineNumbers}
            startLineNumber={startLineNumber}
            maxContentHeight={bodyMax ?? undefined}
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
      {/* 原位代码块全屏时也照常渲染：卸载会让虚拟列表条目变矮 → 锚点跳动 */}
      {renderBlock(false)}
      {fullscreen &&
        createPortal(
          <div className="code-block-fullscreen-layer">{renderBlock(true)}</div>,
          document.body,
        )}
      {/* 右键菜单：复制代码 / 全选（选区优先）；挂 body，浮层里也能用 */}
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
