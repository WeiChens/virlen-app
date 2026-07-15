/**
 * canvas-code-renderer — 基于 Canvas 2D API 的代码语法高亮渲染器
 *
 * ## 设计
 * - 纯函数，无 React/框架耦合
 * - 一次 tokenize，多次 paint
 * - 与 CSS overlay 共用「统一字体渲染引擎」
 *
 * ## 字体渲染同步策略
 * Canvas 2D 与 CSS 默认使用不同的文本渲染引擎（Windows: GDI vs DirectWrite）。
 * 通过在 Canvas 和 CSS 上同时设置 textRendering/fontKerning 等属性，
 * 强制两者使用相同的渲染路径，使字符宽度一致。
 *
 * ## 字号动态读取
 * 默认字号读取 CSS 变量 `--font-size-md`，跟随用户字体大小设置。
 */

/**
 * 读取 CSS 变量 `--font-size-md` 的像素值（例如 "13px" → 13）。
 * 若无法读取（非浏览器环境），返回 13 作为兜底。
 */
function getDefaultFontSize(): number {
  if (typeof document === 'undefined') return 13
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-size-md')
    .trim()
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? 13 : parsed
}

import Prism from 'prismjs'
import type { Token } from 'prismjs'

import 'prismjs/components/prism-typescript.min.js'
import 'prismjs/components/prism-javascript.min.js'
import 'prismjs/components/prism-jsx.min.js'
import 'prismjs/components/prism-tsx.min.js'
import 'prismjs/components/prism-python.min.js'
import 'prismjs/components/prism-rust.min.js'
import 'prismjs/components/prism-go.min.js'
import 'prismjs/components/prism-java.min.js'
import 'prismjs/components/prism-c.min.js'
import 'prismjs/components/prism-cpp.min.js'
import 'prismjs/components/prism-csharp.min.js'
import 'prismjs/components/prism-ruby.min.js'
import 'prismjs/components/prism-bash.min.js'
import 'prismjs/components/prism-powershell.min.js'
import 'prismjs/components/prism-yaml.min.js'
import 'prismjs/components/prism-json.min.js'
import 'prismjs/components/prism-markup.min.js'
import 'prismjs/components/prism-css.min.js'
import 'prismjs/components/prism-scss.min.js'
import 'prismjs/components/prism-sql.min.js'
import 'prismjs/components/prism-markdown.min.js'
import 'prismjs/components/prism-diff.min.js'
import 'prismjs/components/prism-docker.min.js'
import 'prismjs/components/prism-graphql.min.js'
import 'prismjs/components/prism-toml.min.js'
import 'prismjs/components/prism-kotlin.min.js'
import 'prismjs/components/prism-scala.min.js'
import 'prismjs/components/prism-swift.min.js'
import 'prismjs/components/prism-php.min.js'
import 'prismjs/components/prism-latex.min.js'
import 'prismjs/components/prism-ini.min.js'
import 'prismjs/components/prism-makefile.min.js'

// ───────────────────────── 类型定义 ─────────────────────────

interface FlatToken {
  text: string
  color: string
}

export interface RenderOptions {
  code: string
  language?: string
  fontSize?: number
  fontFamily?: string
  showLineNumbers?: boolean
  startLineNumber?: number
  lineHeight?: number
  /** 容器宽度（CSS 像素），用于决定 canvas 的渲染宽度。
   *  传此值可避免离屏 canvas 无法获取父容器宽度的问题。
   *  若不传，则回退到 canvas.parentElement?.clientWidth 或 800。 */
  containerWidth?: number
}

// ───────────────────────── One Dark 主题 ─────────────────────────

const BG_COLOR = '#282c34'
const GUTTER_BG = '#21252b'
const GUTTER_COLOR = '#495162'
const DEFAULT_COLOR = '#abb2bf'

const TOKEN_COLORS: Record<string, string> = {
  comment: '#5c6370',
  prolog: '#5c6370',
  doctype: '#5c6370',
  cdata: '#5c6370',
  punctuation: '#abb2bf',
  property: '#e06c75',
  tag: '#e06c75',
  boolean: '#e06c75',
  deleted: '#e06c75',
  number: '#d19a66',
  constant: '#d19a66',
  symbol: '#d19a66',
  selector: '#98c379',
  'attr-name': '#98c379',
  string: '#98c379',
  char: '#98c379',
  builtin: '#98c379',
  inserted: '#98c379',
  operator: '#56b6c2',
  entity: '#56b6c2',
  url: '#56b6c2',
  atrule: '#61afef',
  'attr-value': '#61afef',
  function: '#61afef',
  keyword: '#c678dd',
  regex: '#98c379',
  important: '#e06c75',
  variable: '#e06c75',
  bold: '#e06c75',
  italic: '#c678dd',
  'class-name': '#e5c07b',
}

// ───────────────────────── 语言别名 ─────────────────────────

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  docker: 'docker',
  gql: 'graphql',
  cpp: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  html: 'markup',
  xml: 'markup',
}

// ───────────────────────── 语言加载 ─────────────────────────
// 所有语言组件已在文件顶部静态导入，无需动态加载。
// 这里只需检查 Prism.languages 是否已注册即可。

const loadedLangs = new Set<string>()

function ensureLanguage(lang: string): void {
  if (loadedLangs.has(lang)) return
  if (Prism.languages[lang]) {
    loadedLangs.add(lang)
    return
  }
}

// ───────────────────────── Token 扁平化 ─────────────────────────

function flattenTokens(
  tokens: (string | Token)[],
  inheritedColor?: string,
): FlatToken[] {
  const result: FlatToken[] = []

  for (const t of tokens) {
    if (typeof t === 'string') {
      result.push({ text: t, color: inheritedColor || DEFAULT_COLOR })
    } else {
      const color = TOKEN_COLORS[t.type] || inheritedColor || DEFAULT_COLOR
      if (typeof t.content === 'string') {
        result.push({ text: t.content, color })
      } else if (Array.isArray(t.content)) {
        result.push(...flattenTokens(t.content, color))
      } else if (t.content && typeof t.content === 'object') {
        result.push(...flattenTokens([t.content as Token], color))
      }
    }
  }

  return result
}

// ───────────────────────── 主渲染 ─────────────────────────

/**
 * 将代码渲染到 canvas 上。
 * 返回渲染总高度（px）。
 *
 * 字体渲染同步：
 * 设置 textRendering / fontKerning 等属性，使 Canvas 与 CSS overlay
 * 使用相同的文本渲染路径，消除字符宽度差异。
 */
export function renderCodeToCanvas(
  canvas: HTMLCanvasElement,
  options: RenderOptions,
): number {
  const {
    code,
    language,
    fontSize = getDefaultFontSize(),
    // ★ 必须包含等宽中文字体（DengXian），否则 Canvas 和 CSS 会回退到不同中文字体导致字宽不一致
    fontFamily = "'JetBrains Mono','Fira Code','Cascadia Code','SF Mono',Consolas,'DengXian',monospace",
    showLineNumbers = false,
    startLineNumber = 1,
    lineHeight = 1.55,
  } = options

  // 1. 语言加载
  const rawLang = language || 'plain'
  const canonical =
    rawLang === 'plain' || rawLang === 'text'
      ? 'plain'
      : LANG_ALIASES[rawLang] || rawLang

  if (canonical !== 'plain') {
    ensureLanguage(canonical)
  }

  const lang =
    canonical !== 'plain' && Prism.languages[canonical] ? canonical : 'plain'

  // 2. Tokenize
  let flatTokens: FlatToken[]
  if (lang === 'plain') {
    flatTokens = [{ text: code, color: DEFAULT_COLOR }]
  } else {
    const raw = Prism.tokenize(code, Prism.languages[lang])
    flatTokens = flattenTokens(raw)
  }

  // 3. 按行拆分
  const lines = splitTokensIntoLines(flatTokens)

  // 4. 计算度量
  const dpr = (window.devicePixelRatio || 1) * 2
  const lineH = Math.round(fontSize * lineHeight)
  const paddingX = 16
  const paddingY = 14
  const lastLineNum = startLineNumber + lines.length - 1
  const gutterW = showLineNumbers
    ? Math.max(40, String(lastLineNum).length * (fontSize * 0.6) + 24)
    : 0
  const totalHeight = paddingY * 2 + lines.length * lineH

  // 5. 设置 canvas 尺寸（含横向滚动：canvas 宽度 = max(父容器, 代码内容宽度)）
  // ★ 优先使用显式传入的 containerWidth（解决离屏 canvas 无法获取父容器大小的问题）
  const parentW =
    options.containerWidth ??
    canvas.parentElement?.clientWidth ??
    canvas.clientWidth ??
    800
  const ctx = canvas.getContext('2d')
  if (!ctx) return totalHeight

  // 先设置字体才能 measureText
  ctx.font = `${fontSize}px ${fontFamily}`
  ctx.textBaseline = 'middle'
  // ★★★ 不用固定字符宽度网格，改用 measureText 测量每行实际像素宽度 ★★★
  // 中文（CJK）在等宽字体中宽度约为英文的 2 倍，固定 charWidth 会算少
  const maxLineWidth = lines.reduce((max, line) => {
    const lineWidth = line.reduce(
      (w, ft) => w + ctx.measureText(ft.text).width,
      0,
    )
    return Math.max(max, lineWidth)
  }, 0)
  // 总内容宽度 = 行号区 + 左侧padding + 最长行实际宽度 + 右侧padding
  const contentWidth = Math.max(
    parentW,
    gutterW + paddingX + maxLineWidth + paddingX,
  )

  canvas.width = Math.round(contentWidth * dpr)
  canvas.height = Math.round(totalHeight * dpr)
  canvas.style.width = `${contentWidth}px`
  canvas.style.height = `${totalHeight}px`
  ctx.scale(dpr, dpr)

  // ★★★ 重新设置字体（canvas.width = ... 会重置所有 ctx 状态！） ★★★
  ctx.font = `${fontSize}px ${fontFamily}`
  ctx.textBaseline = 'middle'

  // ── 字体渲染同步（关键！与 CSS overlay 保持一致） ──
  // 强制 Canvas 使用几何精度渲染，禁用字距调整
  // 注：部分属性（textRendering/fontKerning）可能不被所有浏览器支持
  // 不支持的浏览器会静默忽略，不影响渲染
  try {
    ctx.textRendering = 'geometricPrecision' as any
  } catch {}
  try {
    ;(ctx as any).fontKerning = 'none'
  } catch {}

  // 6. 背景
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, contentWidth, totalHeight)

  // 7. 行号区
  if (showLineNumbers && gutterW > 0) {
    ctx.fillStyle = GUTTER_BG
    ctx.fillRect(0, 0, gutterW, totalHeight)

    ctx.fillStyle = GUTTER_COLOR

    for (let i = 0; i < lines.length; i++) {
      const y = paddingY + i * lineH + lineH / 2
      const num = String(startLineNumber + i)
      ctx.fillText(num, gutterW - ctx.measureText(num).width - 10, y)
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.beginPath()
    ctx.moveTo(gutterW + 0.5, 0)
    ctx.lineTo(gutterW + 0.5, totalHeight)
    ctx.stroke()
  }

  // 8. 代码
  // 逐 token 用 measureText 测量实际像素宽度定位（兼容中英文混排）
  // 中文（CJK）在等宽字体中宽度约为英文的 2 倍，不能用固定 charWidth 网格
  const contentX = gutterW + paddingX

  for (let i = 0; i < lines.length; i++) {
    const y = paddingY + i * lineH + lineH / 2
    let x = contentX

    for (const ft of lines[i]) {
      ctx.fillStyle = ft.color
      ctx.fillText(ft.text, x, y)
      x += ctx.measureText(ft.text).width
    }
  }

  return totalHeight
}

// ───────────────────────── 行拆分 ─────────────────────────

function splitTokensIntoLines(tokens: FlatToken[]): FlatToken[][] {
  const lines: FlatToken[][] = []
  let currentLine: FlatToken[] = []
  let buffer = ''

  function flushBuffer() {
    if (buffer) {
      currentLine.push({ text: buffer, color: DEFAULT_COLOR })
      buffer = ''
    }
  }

  for (const ft of tokens) {
    const parts = ft.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        flushBuffer()
        lines.push(currentLine)
        currentLine = []
      }
      if (parts[i]) {
        if (buffer) {
          currentLine.push({ text: buffer, color: DEFAULT_COLOR })
          buffer = ''
        }
        currentLine.push({ text: parts[i], color: ft.color })
      }
    }
  }
  flushBuffer()

  if (lines.length === 0) {
    lines.push(currentLine.length > 0 ? currentLine : [])
  } else if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  return lines
}
