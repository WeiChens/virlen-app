/**
 * monaco-editor 0.52+ 的 npm 包通过 package.json exports 限制了深路径模块，
 * 内部的 Monarch tokenizer（*.js）没有配套 .d.ts。这里给出最小类型声明，
 * 让 TS 能编译通过（真正的类型来自 monaco.languages.*）。
 *
 * 声明清单与 src/monaco/setupMonaco.ts 中静态 import 的语言一一对应。
 */
declare module 'monaco-editor/languages/definitions/typescript/typescript.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/javascript/javascript.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/python/python.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/rust/rust.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/go/go.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/java/java.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/cpp/cpp.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/csharp/csharp.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/ruby/ruby.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/shell/shell.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/powershell/powershell.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/yaml/yaml.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/html/html.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/xml/xml.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/css/css.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/scss/scss.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/less/less.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/sql/sql.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/markdown/markdown.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/dockerfile/dockerfile.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/graphql/graphql.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/kotlin/kotlin.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/scala/scala.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/swift/swift.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/php/php.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
declare module 'monaco-editor/languages/definitions/ini/ini.js' {
  export const conf: Record<string, unknown>
  export const language: Record<string, unknown>
}
