// @ts-nocheck
/**
 * CodeBlock — 代码块组件（Monaco 只读预览 + 复制按钮 + actions）
 *
 * ## 渲染策略
 * - 正常显示 → Monaco Editor 只读预览（VSCode 阅读模式；精简构建见 src/monaco/setupMonaco.ts）
 * - streaming / 超大文件(>100K 字符) → <pre> 纯文本 fallback（避免流式闪烁与长任务阻塞）
 *
 * ## 设计原则
 * - 复用 MarkdownRenderer / 工具消息传入的 props 结构，外层 UI（header/复制/actions）保持不变
 * - 仅替换“代码正文 view”：由 Prism→Canvas 渲染换成 Monaco；配色沿用 One Dark（virlen-dark 主题）
 */
import {
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { observer } from 'mobx-react-lite'
import CopySvg from '@/ui/components/icons/CopySvg'
import CodePreview from '@/ui/components/code-preview/CodePreview'
import './code-block.scss'
import { openPath } from '@tauri-apps/plugin-opener'
import { resolve } from '@tauri-apps/api/path'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'

// ==================== 工具函数 ====================

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
 * 判断字符串是否看起来像一个有效文件路径（仅格式检测，不查磁盘）。
 * 匹配以下模式：
 *  - Windows 绝对路径:  C:\...  C:/...
 *  - Unix 绝对路径:     /home/...
 *  - 相对路径:          ./xxx  ../xxx
 *  - 含路径分隔符:      src/main.ts  folder\file.txt
 *  - 纯文件名（已知扩展名）:  package.json  index.ts
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

// ==================== Monaco 代码预览 ====================

/**
 * 代码字号档位（默认 medium）。
 * 比 UI 正文 --font-size-md 大 1~3px，保证代码块在聊天里更清晰可读。
 */
const CODE_FONT_PX: Record<'small' | 'medium' | 'large', number> = {
  small: 12,
  medium: 13,
  large: 14,
}

/** 读取 CSS 变量 --font-size-md 的像素值（正文/行内代码用，跟随用户字号设置） */
function getUiMdFontPx(): number {
  if (typeof document === 'undefined') return 13
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-size-md')
    .trim()
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? 13 : parsed
}

/**
 * 代码块默认字号：读取全局「字体大小」设置（small/medium/large）。
 * 读取的是 observable（settingsState），组件用 observer 包裹后改动会即时生效。
 */
function getDefaultCodeFontSize(): number {
  const level = settingsState.value.fontSize ?? 'medium'
  return CODE_FONT_PX[level] ?? CODE_FONT_PX.medium
}

/**
 * 解析代码块字号。
 * - 未显式传入：取当前字号档位的代码字号（15 / 13 / 17）；
 * - 显式传入 px：当作「medium 基线」设计值，等比缩放到当前档位，
 *   保证紧凑视图（如工具消息）也随设置联动：如 11 → small 10 / medium 11 / large 12。
 */
function resolveCodeFontPx(explicit?: number): number {
  const base = getDefaultCodeFontSize()
  if (explicit == null || explicit <= 0) return base
  return base
}

/**
 * 语言别名 → Monaco 语言 id。
 * monaco 0.56 精简构建只注册了 src/monaco/setupMonaco.ts 里的语言；
 * 未覆盖的语言返回 undefined（按纯文本显示）。
 * 注：monaco 没有独立 C/TOML tokenizer，C 复用 cpp，TOML 走 ini。
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
 * MonacoCodeView — 用 CodePreview(Monaco) 渲染“代码正文”。
 *
 * 高度 = 内容行数 * lineHeight + padding（与编辑器 options 里的 lineHeight 一致）；
 * 外层 .code-block-wrapper 负责纵向滚动（maxHeight 场景），因此 Monaco 自身无纵向溢出，
 * 配合 scrollbar.alwaysConsumeMouseWheel=false，滚轮不会吞掉外层消息列表的滚动。
 */
function MonacoCodeView({
  language,
  code,
  fontSize,
  showLineNumbers,
  startLineNumber,
}: {
  language?: string
  code: string
  fontSize?: number
  showLineNumbers?: boolean
  startLineNumber?: number
}) {
  const fontPx = resolveCodeFontPx(fontSize)
  const lineH = Math.max(16, Math.round(fontPx * 1.5))
  const lineCount = code ? code.split('\n').length : 1
  // Monaco 内容末尾可能多渲染一行“光标空行”，因此按 (lineCount+1) 行计算高度；
  // 底部多留一点余量覆盖横向滚动条占位：Monaco 垂直滚动条已隐藏，纵向靠外层容器滚动，
  // 容器高度必须 >= 编辑器内容高度，否则末行会被裁掉且无处可滚。
  const height = Math.max(lineH + 16, 36 + (lineCount + 1) * lineH)

  return (
    <CodePreview
      code={code}
      language={toMonacoLang(language)}
      theme="virlen-dark"
      height={height}
      showLineNumbers={showLineNumbers}
      startLineNumber={startLineNumber}
      fontSize={fontPx}
    />
  )
}

// ==================== CodeBlock ====================

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
 * CodeBlock 组件 Props。
 * 继承 HTMLAttributes<HTMLElement>：其余原生属性（如 react-markdown 的 node、内联代码属性）
 * 会通过 ...props 透传到内联 <code> 元素。
 */
export interface CodeBlockProps extends HTMLAttributes<HTMLElement> {
  /** 代码语言 class（react-markdown 约定，如 `language-ts`） */
  className?: string
  /** 代码内容 */
  children: ReactNode
  /** 最大高度（px），超出自动滚动 */
  maxHeight?: number | string
  /** 代码块宽度 */
  width?: number | string
  /** 字体大小（px，作为 medium 基线），默认按当前「字体大小」设置取档位值：small 13 / medium 15 / large 17 */
  fontSize?: number
  /** 文件名，用于推断代码语言 */
  fileName?: string
  /** 是否显示行号（默认 true） */
  showLineNumbers?: boolean
  /** 起始行号（默认 1） */
  startLineNumber?: number
  /** 流式输出中 → 纯文本 fallback（避免 Monaco 每次 chunk 重建） */
  streaming?: boolean
  /** 自定义操作按钮 */
  actions?: Action[]
}

/** 代码块组件 */
function CodeBlock({
  className,
  children,
  maxHeight,
  width,
  fontSize,
  fileName,
  showLineNumbers = true,
  startLineNumber = 1,
  streaming,
  actions = [] as Action[],
  ...props
}: CodeBlockProps) {
  // 复制态放在最前面：行内/块状代码两条渲染路径共用同一组 hooks（规则一致性）
  const [copied, setCopied] = useState(false)

  let match = /language-(\w+)/.exec(className || '')
  // fileName 可能携带路径（如 "src/foo.ts"），语言推断仅取最后一段
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
  if (!match && !code.includes('\n')) {
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

  return (
    <div
      className="code-block-wrapper"
      style={{
        maxHeight: maxHeight ? maxHeight : undefined,
        width: width ? width : undefined,
        overflow: maxHeight ? 'auto' : 'visible',
      }}>
      <div className="code-block-header">
        <div className="code-block-header-info">
          <span className="code-language">{displayLang}</span>
          {fileName && (
            <span className="code-file-name" title={fileName}>
              {fileName}
            </span>
          )}
        </div>
        <div className='actions-list'>
          <button className="code-copy-btn" onClick={handleCopy} title={t('复制代码')}>
            {copied ? (
              <svg viewBox="0 0 1160 1024" width="14" height="14">
                <path
                  d="M1098.5472 34.133333C766.498133 240.64 525.653333 501.486933 416.9728 632.149333L151.552 421.205333 34.133333 516.983467 492.3392 989.866667c78.6432-204.868267 328.772267-605.252267 634.0608-889.856L1098.5472 34.133333z"
                  fill="var(--color-success, #4ade80)"
                />
              </svg>
            ) : (
              <CopySvg fill="var(--text-tertiary, #aeaeae)" />
            )}
          </button>
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
        </div>
      </div>
      {/* 流式输出 / 超大文件 → 常规 pre/code 纯文本 fallback */}
      {streaming || code.length > LARGE_CODE_LIMIT ? (
        <div className="code-streaming-fallback">
          <pre
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
        />
      )}
    </div>
  )
}

export default observer(CodeBlock)
