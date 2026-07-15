// @ts-nocheck
/**
 * CodeBlock — 代码块组件（Canvas 渲染 + 复制按钮 + IntersectionObserver 懒加载）
 *
 * ## 渲染策略
 * - 可视区域内 → Canvas 2D API 渲染（1 个 DOM 节点，无 reconciliation 开销）
 * - 不可见时 → <pre> 纯文本 fallback（不触发 canvas 初始化）
 * - 大文件 > 100K 字符 → 纯文本 fallback（避免阻塞）
 *
 * ## 设计原则
 * - 复用 MarkdownRenderer 传入的 props 结构（react-markdown code component）
 * - 保持与 react-syntax-highlighter 相同的视觉风格（One Dark）
 * - 不引入额外运行时依赖
 */
import { useState, useEffect, useRef } from 'react'
import CopySvg from '@/ui/components/icons/CopySvg'
import { renderCodeToCanvas } from './canvas-code-renderer'
import './code-block.scss'
import { openPath } from '@tauri-apps/plugin-opener'
import { resolve } from '@tauri-apps/api/path'
import { chatState, sessionStore } from '@/ui/store'

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

// ==================== Canvas 代码渲染 ====================

/**
 * CanvasHighlightedCode — 纯 Canvas 语法高亮 + 选中
 *
 * 渲染策略：
 *  - [不可见] <pre> 纯文本 fallback，不初始化 canvas
 *  - [可见]   <canvas> 渲染，调用 renderCodeToCanvas
 *  - 大文件 > 100K 字符 → 纯文本 fallback（避免长任务阻塞）
 *
 * 选中方案：纯 Canvas 实现（mousedown/mousemove/mouseup），无 DOM overlay。
 */
/** 读取 CSS 变量 --font-size-md 的像素值，跟随用户字体大小设置 */
function getDefaultCodeFontSize(): number {
  if (typeof document === 'undefined') return 13
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-size-md')
    .trim()
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? 13 : parsed
}

function CanvasHighlightedCode({
  language,
  code,
  fontSize = getDefaultCodeFontSize(),
  showLineNumbers = false,
  startLineNumber = 1,
}: {
  language?: string
  code: string
  fontSize?: number
  showLineNumbers?: boolean
  startLineNumber?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 复用离屏 canvas，避免重复创建/GC */
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const [renderFailed, setRenderFailed] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)

  // ── ResizeObserver：监听容器宽度变化 → 触发 canvas 重绘 ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      if (w > 0) setContainerWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ── 行高 / 间距（与 canvas-code-renderer 完全一致） ──
  const lineHeight = 1.55
  const lineH = Math.round(fontSize * lineHeight)
  const padY = 14
  const padX = 16
  const gutterCharWidth = fontSize * 0.6
  const lineCount = code ? code.split('\n').length : 1
  const lastLineNum = startLineNumber + lineCount - 1
  const gutterW = showLineNumbers
    ? Math.max(40, String(lastLineNum).length * gutterCharWidth + 24)
    : 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false

    const doRender = () => {
      // 大文件保护
      if (code.length > 1000 * 100) return

      try {
        setRenderFailed(false)

        // 用离屏 canvas 完成渲染，避免中途清空可见 canvas
        // 通过 ref 持有一个实例反复使用，避免重复创建/GC 开销
        if (!offscreenRef.current) {
          offscreenRef.current = document.createElement('canvas')
        }
        const offscreen = offscreenRef.current
        renderCodeToCanvas(offscreen, {
          code,
          language,
          fontSize,
          showLineNumbers,
          startLineNumber,
          containerWidth: containerWidth > 0 ? containerWidth : undefined,
        })

        // 渲染完成后检查是否已被取消（更新的渲染已启动）
        if (cancelled) return

        // 原子化 swap：将离屏结果绘制到可见 canvas
        const ctx = canvas.getContext('2d')
        if (ctx) {
          canvas.width = offscreen.width
          canvas.height = offscreen.height
          canvas.style.width = offscreen.style.width
          canvas.style.height = offscreen.style.height
          ctx.drawImage(offscreen, 0, 0)
        }
      } catch {
        if (!cancelled) setRenderFailed(true)
      }
    }

    doRender()

    return () => {
      cancelled = true // cleanup：标记当前渲染已取消
    }
  }, [
    code,
    language,
    fontSize,
    showLineNumbers,
    startLineNumber,
    containerWidth,
  ])

  return (
    <div ref={containerRef} className="code-canvas-wrap">
      <canvas ref={canvasRef} className="code-canvas" />
      <pre
        className="code-select-overlay"
        aria-hidden="true"
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: `${lineH}px`,
          paddingTop: `${padY}px`,
          paddingRight: `${padX}px`,
          paddingBottom: `${padY}px`,
          paddingLeft: gutterW > 0 ? `${gutterW + padX}px` : `${padX}px`,
        }}
        onDoubleClick={() => {
          // 浏览器双击默认选中「单词 + 末尾空格」，修正为仅选中单词
          requestAnimationFrame(() => {
            const sel = window.getSelection()
            if (!sel || !sel.rangeCount) return
            const range = sel.getRangeAt(0)
            const text = range.toString()
            if (text.length > 0 && text[text.length - 1] === ' ') {
              range.setEnd(range.endContainer, range.endOffset - 1)
              sel.removeAllRanges()
              sel.addRange(range)
            }
          })
        }}>
        {code}
      </pre>
    </div>
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
/** 代码块组件 */
export default function CodeBlock({
  className,
  children,
  maxHeight,
  width,
  fontSize,
  fileName,
  showLineNumbers = true,
  startLineNumber = 1,
  streaming,
  ...props
}: any) {
  let match = /language-(\w+)/.exec(className || '')
  let language = match ? match[1] : fileName?.split('.').pop()
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
        style={{ fontSize: `${fontSize || getDefaultCodeFontSize()}px` }}
        {...props}
        onClick={isPath ? () => tryOpen(code) : undefined}>
        {children}
      </code>
    )
  }

  const displayLang = getLanguageDisplay(language)
  const [copied, setCopied] = useState(false)

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
        overflowY: maxHeight ? 'auto' : undefined,
      }}>
      <div className="code-block-header">
        <span className="code-language">{displayLang}</span>
        <button className="code-copy-btn" onClick={handleCopy} title="复制代码">
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
      </div>
      {/* 流式输出中 → 常规 pre/code 渲染（避免 canvas 闪烁） */}
      {streaming ? (
        <div className="code-canvas-wrap code-streaming-fallback">
          <pre
            className="code-fallback"
            style={{ fontSize: `${fontSize || getDefaultCodeFontSize()}px` }}>
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <CanvasHighlightedCode
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
