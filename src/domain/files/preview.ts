/**
 * 工作目录文件的「打开方式」判定（纯函数）—— 双击行为与右侧面板共用这一份。
 *
 * 四类：文本（可编辑）/ 图片 / 音频 / 视频 / 其它（不支持预览，交给系统程序）。
 *
 * ⚠️ 判定只按扩展名，**不读文件头**：读文件头要么多一次 IPC，要么把整个文件读进来才知道类型，
 * 对「双击打开」这个动作太重。未知扩展名一律按文本试读（Rust 侧会拒绝二进制），
 * 已知的二进制容器（zip / pdf / office / 可执行文件）直接归「其它」，不去误读。
 */

/** 打开方式 */
export type FilePreviewKind = 'text' | 'image' | 'audio' | 'video' | 'other'

/**
 * 文本文件里**还能切到预览**的那三种（其余文本只有编辑模式）：
 * - markdown：交给聊天同一套渲染器（react-markdown + GFM）；
 * - html：沙箱 iframe 渲染（脚本不执行）；
 * - svg：当图片渲染（`<img>` 里的 SVG 不会跑脚本）。
 */
export type TextPreviewKind = 'markdown' | 'html' | 'svg' | null

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
])

const AUDIO_EXT = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'flac',
  'aac',
  'opus',
  'weba',
])

const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'])

/**
 * 明确不能当文本读的容器 / 可执行文件：体积大、内容无意义。
 * 不在表里的未知扩展名仍按文本试读 —— `LICENSE` / `Makefile` / `.gitignore` 这类没有扩展名，
 * 只靠白名单会把它们挡在外面。
 */
const BINARY_EXT = new Set([
  'pdf',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'zst',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'class',
  'jar',
  'war',
  'o',
  'a',
  'lib',
  'obj',
  'pdb',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'sqlite',
  'db',
  'wasm',
  'psd',
  'ai',
  'sketch',
])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
}

/** Monaco 语言 id（只覆盖 `src/monaco/setupMonaco.ts` 注册过的那批） */
const LANGUAGE_BY_EXT: Record<string, string> = {
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
  go: 'go',
  java: 'java',
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  rbw: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'xml',
  svg: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  graphql: 'graphql',
  gql: 'graphql',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sc: 'scala',
  swift: 'swift',
  php: 'php',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  toml: 'ini',
  json: 'json',
  jsonc: 'json',
  diff: 'diff',
  patch: 'diff',
}

/** 特殊文件名 → Monaco 语言（没有扩展名，只能按名字认） */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
}

/** 取小写扩展名（`a.tar.gz` 只认 `gz`；无扩展名返回空串） */
export function extensionOf(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  // `.gitignore` 这类点开头且无第二段的，不算扩展名
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 这个文件该怎么打开 */
export function previewKindOf(name: string): FilePreviewKind {
  const ext = extensionOf(name)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (BINARY_EXT.has(ext)) return 'other'
  return 'text'
}

/** 文本文件的预览形态（`null` = 只有编辑模式） */
export function textPreviewKindOf(name: string): TextPreviewKind {
  const ext = extensionOf(name)
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html'
  if (ext === 'svg') return 'svg'
  return null
}

/** 媒体类型（未识别的扩展名回退到 application/octet-stream） */
export function mimeOf(name: string): string {
  return MIME_BY_EXT[extensionOf(name)] || 'application/octet-stream'
}

/** Monaco 语言 id（认不出就是 plaintext） */
export function monacoLanguageOf(name: string): string {
  const base = (name.replace(/\\/g, '/').split('/').pop() || '').toLowerCase()
  if (LANGUAGE_BY_NAME[base]) return LANGUAGE_BY_NAME[base]
  return LANGUAGE_BY_EXT[extensionOf(name)] || 'plaintext'
}
