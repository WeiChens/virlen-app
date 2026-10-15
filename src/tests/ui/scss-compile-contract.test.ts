/**
 * SCSS 编译契约：`src` 下每一份 `.scss` 都必须能被 dart-sass 编译通过。
 *
 * 为什么需要：SCSS 是**构建期**才编译的，写坏了不会让 tsc / vitest 红 —— 它只会让
 * `pnpm dev` / `tauri dev` 整个起不来（Vite 报 `[sass] expected selector` 之类），
 * 到那时人已经在「界面怎么白了」的现场。这条测试把这类错误拦在测试期。
 *
 * 真实案例（本测试的由来）：变更列表把 git 的状态字母直接拼进类名，未跟踪文件得到 `s-?`，
 * 而 `?` 在选择器里必须转义成 `\?` —— 写成 `&.s-?` 时 Sass 抛 `expected selector`，
 * 整份样式（不只那一行）编译失败。
 *
 * 只编译、不校验产物内容：产物口径由各自的契约测试（如 `accent-color-contract`）负责。
 * 项目里的 SCSS 只用 `sass:` 内建模块，没有 Vite 别名导入，所以可以脱离 Vite 直接编译。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as sass from 'sass'

/** 递归收集 `src` 下所有 scss（含 `.module.scss`） */
function collectScss(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.scss'))
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

describe('SCSS 编译契约', () => {
  const files = collectScss('src')

  it('至少找得到待编译的样式文件（防止路径写错后本测试空转）', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it.each(files)('%s 能编译', (file) => {
    const result = sass.compileString(readFileSync(file, 'utf8'), {
      // 静默弃用告警（那些是项目历史写法的问题，不该让本测试红）
      logger: sass.Logger.silent,
      // 与文件同目录解析相对导入
      url: new URL(`file://${file.replace(/\\/g, '/')}`),
    })
    expect(result.css).toBeTypeOf('string')
  })
})
