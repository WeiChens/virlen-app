/**
 * Monaco 精简构建 —— 只做“代码预览 / 语法高亮”。
 *
 * 我们不引用 monaco-editor 根入口（esm/vs/index.js，等同 editor.main），因为它会
 * 把 TS/JS/CSS/HTML/JSON 的完整语言服务（LSP client + Web Worker）一起打进来，
 * 产物里就会出现 ts.worker.js / css.worker.js 等文件。
 *
 * 而一个“只读预览”只需要：
 *   1. 编辑器本体：editor.api.js（standalone 编辑器，自带 CodeEditorWidget）
 *   2. 各语言的 Monarch tokenizer：纯正则“切词”着色，零语言服务、零 worker
 *
 * 因此产物中不再出现任何语言服务的 worker，体积也更小。
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api.js'

// ── Monarch 词法定义（conf=语言配置 / language=tokenizer，纯高亮）──
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

// 0.56 的 npm 包内没有内置 JSON 的 monarch tokenizer（JSON 只由语言服务提供），
// 这里手动注册一个轻量 tokenizer，保证 JSON 也能高亮。
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

// Monaco 没有内置 diff 词法，聊天里 `diff` 代码块（EditFile diff 预览）很常见，
// 注册一个简单的行首符号 tokenizer 实现 diff 着色。
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

/** 注册一个“仅高亮”的语言（带防重复注册，兼容 HMR） */
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

// ── One Dark 主题（与旧 Canvas 渲染配色一致：背景 #282c34 / 行号 #495162）──
export const virlenDarkTheme: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'abb2bf', background: '282c34' },
    { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
    { token: 'string', foreground: '98c379' },
    { token: 'string.escape', foreground: '98c379' },
    { token: 'regexp', foreground: '98c379' },
    { token: 'number', foreground: 'd19a66' },
    { token: 'keyword', foreground: 'c678dd' },
    { token: 'keyword.control', foreground: 'c678dd' },
    { token: 'keyword.operator', foreground: '56b6c2' },
    { token: 'operator', foreground: '56b6c2' },
    { token: 'delimiter', foreground: 'abb2bf' },
    { token: 'delimiter.bracket', foreground: 'abb2bf' },
    { token: 'delimiter.curly', foreground: 'abb2bf' },
    { token: 'delimiter.square', foreground: 'abb2bf' },
    { token: 'delimiter.parenthesis', foreground: 'abb2bf' },
    { token: 'punctuation', foreground: 'abb2bf' },
    { token: 'punctuation.definition', foreground: 'abb2bf' },
    { token: 'type', foreground: 'e5c07b' },
    { token: 'type.identifier', foreground: 'e5c07b' },
    { token: 'class', foreground: 'e5c07b' },
    { token: 'class.name', foreground: 'e5c07b' },
    { token: 'function', foreground: '61afef' },
    { token: 'entity.name.function', foreground: '61afef' },
    { token: 'entity.name.type', foreground: 'e5c07b' },
    { token: 'tag', foreground: 'e06c75' },
    { token: 'attribute.name', foreground: '98c379' },
    { token: 'attribute.value', foreground: '61afef' },
    { token: 'variable', foreground: 'e06c75' },
    { token: 'variable.name', foreground: 'e06c75' },
    { token: 'constant', foreground: 'd19a66' },
    { token: 'constant.language', foreground: 'd19a66' },
    { token: 'parameter', foreground: 'abb2bf' },
    { token: 'property', foreground: 'e06c75' },
    { token: 'meta', foreground: 'abb2bf' },
    { token: 'annotation', foreground: 'e5c07b' },
    { token: 'string.key.json', foreground: 'e06c75' },
    { token: 'diff.header', foreground: '61afef' },
    { token: 'diff.hunk', foreground: '56b6c2' },
    { token: 'diff.inserted', foreground: '98c379' },
    { token: 'diff.deleted', foreground: 'e06c75' },
    { token: 'diff.context', foreground: 'abb2bf' },
  ],
  colors: {
    'editor.background': '#282c34',
    'editor.foreground': '#abb2bf',
    'editorLineNumber.foreground': '#495162',
    'editorLineNumber.activeForeground': '#c8ccd4',
    'editorGutter.background': '#21252b',
    'editorCursor.foreground': '#528bff',
    'editor.selectionBackground': '#3e4451',
    'editor.inactiveSelectionBackground': '#3e445166',
    'editor.lineHighlightBackground': '#2c313a',
    'editorIndentGuide.background1': '#2c313a',
    'editorIndentGuide.activeBackground1': '#3a3f4b',
    'editorWhitespace.foreground': '#4b5263',
    'editorWidget.background': '#21252b',
    'editorWidget.border': '#181a1f',
    'scrollbarSlider.background': '#4b526366',
    'scrollbarSlider.hoverBackground': '#5a6274aa',
    'scrollbarSlider.activeBackground': '#6a7286aa',
    'scrollbar.shadow': '#00000000',
    'minimap.background': '#21252b',
    'editorOverviewRuler.border': '#00000000',
    'focusBorder': '#00000000',
    // 片段代码常有多余的右括号 } ) ]，保持与普通文本同色，避免“红色报错感”
    'editorBracketHighlight.unexpectedBracket.foreground': '#abb2bf',
    'editorBracketHighlight.foreground1': '#abb2bf',
    'editorBracketHighlight.foreground2': '#abb2bf',
    'editorBracketHighlight.foreground3': '#abb2bf',
    'editorBracketHighlight.foreground4': '#abb2bf',
    'editorBracketHighlight.foreground5': '#abb2bf',
    'editorBracketHighlight.foreground6': '#abb2bf',
    'editorBracketHighlight.background1': '#00000000',
    'editorBracketHighlight.background2': '#00000000',
    'editorBracketHighlight.background3': '#00000000',
    'editorBracketHighlight.background4': '#00000000',
    'editorBracketHighlight.background5': '#00000000',
    'editorBracketHighlight.background6': '#00000000',
  },
}

// 注册 One Dark 主题（HMR 重复执行 defineTheme 也会安全覆盖，无需判重）
monaco.editor.defineTheme('virlen-dark', virlenDarkTheme)

// 让 @monaco-editor/react 使用这份精简版 monaco 实例
loader.config({ monaco } as Parameters<typeof loader.config>[0])

export { monaco }
