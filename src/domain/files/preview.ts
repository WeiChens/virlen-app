/**
 * 工作目录文件的「打开方式」判定（纯函数）—— 双击行为与右侧面板共用这一份。
 *
 * 九类：文本（可编辑）/ 图片 / 音频 / 视频 / PDF（按页栅格化）/ 文档（文稿演示 → Markdown）/
 * 表格（工作表 → 网格）/ 3D 模型（three 解析后渲染）/ 其它（不支持预览，交给系统程序）。
 *
 * ⚠️ 判定只按扩展名，**不读文件头**：读文件头要么多一次 IPC，要么把整个文件读进来才知道类型，
 * 对「双击打开」这个动作太重。未知扩展名一律按文本试读（Rust 侧会拒绝二进制），
 * 已知的二进制容器（zip / office / 可执行文件）直接归「其它」，不去误读。
 */

/** 打开方式 */
export type FilePreviewKind =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  /** 页面栅格化渲染（前端 pdfjs，见 `workspace-file/pdf-view.tsx`） */
  | 'pdf'
  /** 文稿 / 演示：正文由 Rust 抽成 Markdown，面板直接渲染 */
  | 'document'
  /** 表格：每张工作表一份网格（表名可切换） */
  | 'sheet'
  /** 3D 模型：字节交给 three 的加载器（见 `workspace-file/model-loaders.ts`） */
  | 'model'
  | 'other'

/** 走 blob URL 的那几类（图片 / 音频 / 视频） */
export type MediaPreviewKind = 'image' | 'audio' | 'video'

/**
 * 文本文件里**还能切到预览**的那几种（其余文本只有编辑模式）：
 * - markdown：交给聊天同一套渲染器（react-markdown + GFM）；
 * - html：沙箱 iframe 渲染（脚本不执行）；
 * - svg：当图片渲染（`<img>` 里的 SVG 不会跑脚本）；
 * - csv / tsv：把**草稿**解析成表格（所见即当前所改，解析在 `domain/files/delimited.ts`）。
 */
export type TextPreviewKind = 'markdown' | 'html' | 'svg' | 'csv' | 'tsv' | null

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

/** PDF：面板按页栅格化（前端 pdfjs）—— 不进编辑器、也不当字节媒体交给 `<video>` */
const PDF_EXT = new Set(['pdf'])

/**
 * 文稿 / 演示：正文由 Rust `cmd_preview_document` 抽成 Markdown（与 `parse_document` 同一份抽取）。
 * 含 `doc` / `ppt` 旧二进制：同一个 `office_oxide` 路径，不额外写代码。
 */
const DOCUMENT_EXT = new Set(['docx', 'doc', 'pptx', 'ppt'])

/** 表格：每张工作表一份行×列网格，面板画成表 + 表名切换 */
const SHEET_EXT = new Set(['xlsx', 'xls'])

/**
 * 能预览的 3D 模型扩展名（**唯一源**：加载器注册表用 `Record<ModelExtension, …>` 对齐它，
 * 少一个或拼错一个都会被 TS 挡在编译期；见 `workspace-file/model-loaders.ts`）。
 *
 * ⚠️ 故意**不含 `pdb`**：它同时是「蛋白质结构」与「MSVC 程序数据库」，后者在 `BINARY_EXT` 里，
 * 当模型解析会让 .pdb 二进制文件变成一个空白场景 —— 宁可不开这个预览。
 */
export type ModelExtension =
  | 'glb'
  | 'gltf'
  | 'fbx'
  | 'obj'
  | 'stl'
  | 'ply'
  | 'dae'
  | '3ds'
  | '3mf'
  | 'amf'
  | 'wrl'
  | 'vrml'
  | 'pcd'

export const MODEL_EXTENSIONS: readonly ModelExtension[] = [
  'glb',
  'gltf',
  'fbx',
  'obj',
  'stl',
  'ply',
  'dae',
  '3ds',
  '3mf',
  'amf',
  'wrl',
  'vrml',
  'pcd',
]

const MODEL_EXT = new Set<string>(MODEL_EXTENSIONS)

/**
 * 明确不能当文本读的容器 / 可执行文件：体积大、内容无意义。
 * 不在表里的未知扩展名仍按文本试读 —— `LICENSE` / `Makefile` / `.gitignore` 这类没有扩展名，
 * 只靠白名单会把它们挡在外面。
 *
 * ⚠️ `pdf` 与 Office 六种**不在**这里：它们有自己的预览通道（见上面三个 `*_EXT`），
 * 写进本表等于让「能预览」的文件又退回「交给系统程序」。
 */
const BINARY_EXT = new Set([
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
  pdf: 'application/pdf',
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
  if (PDF_EXT.has(ext)) return 'pdf'
  if (DOCUMENT_EXT.has(ext)) return 'document'
  if (SHEET_EXT.has(ext)) return 'sheet'
  // 模型必须排在文本之前：obj / stl / ply / dae 的字节其实也是文本（或全 ASCII），
  // 否则它们会落进编辑器被当成源码打开
  if (MODEL_EXT.has(ext)) return 'model'
  if (BINARY_EXT.has(ext)) return 'other'
  return 'text'
}

/** 文本文件的预览形态（`null` = 只有编辑模式） */
export function textPreviewKindOf(name: string): TextPreviewKind {
  const ext = extensionOf(name)
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html'
  if (ext === 'svg') return 'svg'
  // 表格文件仍是**可编辑文本**（Monaco 里改）+ 表格预览：两份能力不互相排斐
  if (ext === 'csv') return 'csv'
  if (ext === 'tsv') return 'tsv'
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

/** 路径 → 段（去掉空段与 `.`；两种分隔符都认） */
function pathSegments(value: string): string[] {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
}

/**
 * 文件相对「根目录」的子目录（POSIX 风格、无首尾斜杠；不在根内返回空串）。
 *
 * 为什么需要它：HTML 预览把**工作区**登记为可读根（沙箱范围就是这么大），但页面里的
 * `./app.css` 是相对**文件自身目录**的 —— 协议基址必须补上这一段，否则子目录里的页面
 * 所有相对资源都 404（见 `workspace-file/index.tsx` 与 `preview-asset.ts`）。
 */
export function relativeDirOf(filePath: string, root: string): string {
  const file = pathSegments(filePath)
  const base = pathSegments(root)
  // 文件与根同层（或更浅）= 没有子目录；`file.length - 1` 是文件名本身，不算目录
  if (base.length === 0 || file.length <= base.length) return ''
  // 大小写不敏感地比较（Windows 驱动盘符 / 目录名大小写会变）。这里只用来拼一个 URL，
  // 猜错最多是 404 —— 真正的「是否在根内」由 Rust 侧 `inside()` 按平台判定。
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (!base.every((segment, index) => same(segment, file[index]))) return ''
  return file.slice(base.length, -1).join('/')
}
