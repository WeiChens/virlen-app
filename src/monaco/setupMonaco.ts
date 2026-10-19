/**
 * Monaco 精简构建 —— 只做代码预览与语法高亮。
 *
 * 不引 monaco-editor 根入口（会把 TS/JS/CSS/HTML/JSON 的完整语言服务与 worker 一起打进来）。
 * 只读预览只需要：编辑器本体（editor.api.js）、各语言 Monarch tokenizer、
 * 通用 editor worker（只有差异计算要它）、codicon 图标字体（得自己引）。
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import {
  CODE_THEMES,
  DEFAULT_CODE_THEME_ID,
  buildMonacoThemeData,
} from '@/domain/code-display'

/**
 * codicon 图标字体 —— 精简构建必须自己引，否则界面上全是豆腐块。
 *
 * 图标字符一直会注入，但只有当 codicon.css 里的 @font-face 与 .codicon 规则存在时才长得像图标；
 * 这两条只被完整入口引，editor.api.js 这条链没有它。
 */
// ⚠️ 只能经别名引：包的 exports 把任意子路径重写成 esm/vs/*.js（别名见 vite.config.ts）
import '@mono-codicon/codicon.css'
// 通用 editor worker（差异计算用）；子入口写法与 editor.api.js 同理（见 monacoInternal.d.ts）
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'

// ── Monarch 词法定义（conf = 语言配置 / language = tokenizer，纯高亮）──
import { conf as tsConf, language as tsLanguage } from 'monaco-editor/languages/definitions/typescript/typescript.js'
import { conf as jsConf, language as jsLanguage } from 'monaco-editor/languages/definitions/javascript/javascript.js'
import { conf as pyConf, language as pyLanguage } from 'monaco-editor/languages/definitions/python/python.js'
import { conf as rsConf, language as rsLanguage } from 'monaco-editor/languages/definitions/rust/rust.js'
import { conf as goConf, language as goLanguage } from 'monaco-editor/languages/definitions/go/go.js'
import { conf as javaConf, language as javaLanguage } from 'monaco-editor/languages/definitions/java/java.js'
import { conf as cppConf, language as cppLanguage } from 'monaco-editor/languages/definitions/cpp/cpp.js'
import { conf as csConf, language as csLanguage } from 'monaco-editor/languages/definitions/csharp/csharp.js'
import { conf as rbConf, language as rbLanguage } from 'monaco-editor/languages/definitions/ruby/ruby.js'
import { conf as shellConf, language as shellLanguage } from 'monaco-editor/languages/definitions/shell/shell.js'
import { conf as psConf, language as psLanguage } from 'monaco-editor/languages/definitions/powershell/powershell.js'
import { conf as yamlConf, language as yamlLanguage } from 'monaco-editor/languages/definitions/yaml/yaml.js'
import { conf as htmlConf, language as htmlLanguage } from 'monaco-editor/languages/definitions/html/html.js'
import { conf as xmlConf, language as xmlLanguage } from 'monaco-editor/languages/definitions/xml/xml.js'
import { conf as cssConf, language as cssLanguage } from 'monaco-editor/languages/definitions/css/css.js'
import { conf as scssConf, language as scssLanguage } from 'monaco-editor/languages/definitions/scss/scss.js'
import { conf as lessConf, language as lessLanguage } from 'monaco-editor/languages/definitions/less/less.js'
import { conf as sqlConf, language as sqlLanguage } from 'monaco-editor/languages/definitions/sql/sql.js'
import { conf as mdConf, language as mdLanguage } from 'monaco-editor/languages/definitions/markdown/markdown.js'
import { conf as dfConf, language as dfLanguage } from 'monaco-editor/languages/definitions/dockerfile/dockerfile.js'
import { conf as gqlConf, language as gqlLanguage } from 'monaco-editor/languages/definitions/graphql/graphql.js'
import { conf as ktConf, language as ktLanguage } from 'monaco-editor/languages/definitions/kotlin/kotlin.js'
import { conf as scalaConf, language as scalaLanguage } from 'monaco-editor/languages/definitions/scala/scala.js'
import { conf as swiftConf, language as swiftLanguage } from 'monaco-editor/languages/definitions/swift/swift.js'
import { conf as phpConf, language as phpLanguage } from 'monaco-editor/languages/definitions/php/php.js'
import { conf as iniConf, language as iniLanguage } from 'monaco-editor/languages/definitions/ini/ini.js'

// 0.56 的 npm 包里没有内置 JSON 的 monarch tokenizer（JSON 只由语言服务提供），手注册一个轻量的。
const jsonConf: monaco.languages.LanguageConfiguration = {
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
}

const jsonLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.json',
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
  ],
  tokenizer: {
    root: [
      { include: '@ws' },
      [/[{}[\]]/, '@brackets'],
      [/:/, 'delimiter.colon'],
      [/,/, 'delimiter.comma'],
      [/"/, { token: 'string', next: '@string' }],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
    ],
    ws: [[/[ \t\r\n]+/, '']],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string', next: '@pop' }],
    ],
  },
}

// Monaco 没有内置 diff 词法，聊天里 diff 代码块很常见，注册一个行首符号 tokenizer 实现着色。
const diffConf: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '' },
  brackets: [],
  autoClosingPairs: [],
  surroundingPairs: [],
}

const diffLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.diff',
  tokenizer: {
    root: [
      [/^(\+\+\+|---)( .*)?$/, 'diff.header'],
      [/^@@[^\n]*$/, 'diff.hunk'],
      [/^\+[^\n]*$/, 'diff.inserted'],
      [/^-[^\n]*$/, 'diff.deleted'],
      [/^\s*$/, ''],
      [/^[^\n]*$/, 'diff.context'],
    ],
  },
}

/** 注册一个「仅高亮」的语言（带防重复注册，兼容 HMR） */
function registerPreviewLanguage(
  id: string,
  extensions: string[],
  aliases: string[],
  conf: Record<string, unknown>,
  language: Record<string, unknown>,
): void {
  if (monaco.languages.getLanguages().some((l) => l.id === id)) {
    return
  }
  monaco.languages.register({ id, extensions, aliases })
  monaco.languages.setMonarchTokensProvider(
    id,
    language as monaco.languages.IMonarchLanguage,
  )
  monaco.languages.setLanguageConfiguration(
    id,
    conf as monaco.languages.LanguageConfiguration,
  )
}

registerPreviewLanguage('typescript', ['.ts', '.tsx', '.mts', '.cts'], ['TypeScript', 'ts', 'typescript'], tsConf, tsLanguage)
registerPreviewLanguage('javascript', ['.js', '.jsx', '.mjs', '.cjs'], ['JavaScript', 'js', 'javascript'], jsConf, jsLanguage)
registerPreviewLanguage('python', ['.py', '.pyw', '.pyi'], ['Python', 'py'], pyConf, pyLanguage)
registerPreviewLanguage('rust', ['.rs'], ['Rust', 'rs'], rsConf, rsLanguage)
registerPreviewLanguage('go', ['.go'], ['Go', 'go'], goConf, goLanguage)
registerPreviewLanguage('java', ['.java'], ['Java', 'java'], javaConf, javaLanguage)
registerPreviewLanguage('cpp', ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'], ['C++', 'C', 'cpp', 'c'], cppConf, cppLanguage)
registerPreviewLanguage('csharp', ['.cs'], ['C#', 'csharp', 'cs'], csConf, csLanguage)
registerPreviewLanguage('ruby', ['.rb', '.rbw'], ['Ruby', 'rb'], rbConf, rbLanguage)
registerPreviewLanguage('shell', ['.sh', '.bash', '.zsh'], ['Shell', 'sh', 'bash', 'shell'], shellConf, shellLanguage)
registerPreviewLanguage('powershell', ['.ps1', '.psm1'], ['PowerShell', 'powershell', 'ps1'], psConf, psLanguage)
registerPreviewLanguage('yaml', ['.yaml', '.yml'], ['YAML', 'yaml', 'yml'], yamlConf, yamlLanguage)
registerPreviewLanguage('html', ['.html', '.htm', '.xhtml'], ['HTML', 'html'], htmlConf, htmlLanguage)
registerPreviewLanguage('xml', ['.xml', '.svg', '.xsd', '.xsl'], ['XML', 'xml'], xmlConf, xmlLanguage)
registerPreviewLanguage('css', ['.css'], ['CSS', 'css'], cssConf, cssLanguage)
registerPreviewLanguage('scss', ['.scss'], ['SCSS', 'scss'], scssConf, scssLanguage)
registerPreviewLanguage('less', ['.less'], ['Less', 'less'], lessConf, lessLanguage)
registerPreviewLanguage('sql', ['.sql'], ['SQL', 'sql'], sqlConf, sqlLanguage)
registerPreviewLanguage('markdown', ['.md', '.markdown'], ['Markdown', 'markdown'], mdConf, mdLanguage)
registerPreviewLanguage('dockerfile', ['Dockerfile', 'dockerfile'], ['Dockerfile', 'dockerfile', 'docker'], dfConf, dfLanguage)
registerPreviewLanguage('graphql', ['.graphql', '.gql'], ['GraphQL', 'graphql', 'gql'], gqlConf, gqlLanguage)
registerPreviewLanguage('kotlin', ['.kt', '.kts'], ['Kotlin', 'kotlin', 'kt'], ktConf, ktLanguage)
registerPreviewLanguage('scala', ['.scala', '.sc'], ['Scala', 'scala'], scalaConf, scalaLanguage)
registerPreviewLanguage('swift', ['.swift'], ['Swift', 'swift'], swiftConf, swiftLanguage)
registerPreviewLanguage('php', ['.php'], ['PHP', 'php'], phpConf, phpLanguage)
registerPreviewLanguage('ini', ['.ini', '.cfg', '.conf', '.properties', '.toml'], ['INI', 'ini', 'properties', 'toml'], iniConf, iniLanguage)

// JSON / Diff 用内置/手动 tokenizer
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'], aliases: ['JSON', 'json'] })
monaco.languages.setMonarchTokensProvider('json', jsonLanguage)
monaco.languages.setLanguageConfiguration('json', jsonConf)

monaco.languages.register({ id: 'diff', extensions: ['.diff', '.patch'], aliases: ['Diff', 'diff'] })
monaco.languages.setMonarchTokensProvider('diff', diffLanguage)
monaco.languages.setLanguageConfiguration('diff', diffConf)

// ── 代码主题（One Dark / One Light / GitHub / Monokai / Solarized）──
//
// ⚠️ 唯一色源在 src/domain/code-display/themes.ts：本文件只负责把每个调色板注册进 Monaco。
//    加主题 = 往那张表里加一项，这里不用动；组件也禁止再写死主题名（见 code-theme-contract 用例）。
for (const [themeId, palette] of Object.entries(CODE_THEMES)) {
  monaco.editor.defineTheme(themeId, buildMonacoThemeData(palette))
}

/**
 * 默认主题数据（兼容别名）。
 * 仍有调用点按名字取 rules（SideBySideDiff 的逐 token 上色），故保留导出。
 */
export const virlenDarkTheme = buildMonacoThemeData(
  CODE_THEMES[DEFAULT_CODE_THEME_ID],
)

// ── 通用 editor worker ──
// diff 编辑器算差异走 editorWorkerService.computeDiff；不配这一段 monaco 会静默回退主线程，
// 大文件会卡住 UI。只含通用 worker，语言服务的 worker 仍不进产物。
;(globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

// 让 @monaco-editor/react 使用这份精简版 monaco 实例
loader.config({ monaco } as Parameters<typeof loader.config>[0])

export { monaco }
