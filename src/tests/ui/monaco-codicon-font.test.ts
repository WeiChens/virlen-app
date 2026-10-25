// @vitest-environment node
/**
 * codicon 图标字体（Monaco 精简构建）—— 守「图标在界面上不是豆腐块」这条线。
 *
 * 为什么值得一份用例：图标本体是 Monaco 主题样式表按图标注册表生成的**字符**
 * （`.codicon-history:before { content: '\ea82' }`，一直会注入，看着“图标规则都在”），
 * 而把那些字符变成图形的 `codicon.css`（`@font-face` + `.codicon[class*='codicon-'] { font: … codicon }`）
 * 只被**完整入口**（`editor.main.js` / `vs/index.js`）引用 —— 我们走 `editor.api.js`，漏掉它**不报错**、
 * 不崩、构建也成功，只是界面上出现一个个方块（就是实测反馈那件事，见 §11.53 ㉞）。
 *
 * 所以这里把三方钉在一起：`vite.config.ts` 的别名 → 包里真实存在的 `codicon.css` / `codicon.ttf`
 * → `setupMonaco.ts` 的 import。Monaco 升级挪了目录 / 改了文件名，这里当场红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SETUP = 'src/monaco/setupMonaco.ts'
const VITE_CONFIG = 'vite.config.ts'
const MONACO_PKG = 'node_modules/monaco-editor/package.json'

/** 别名值（根相对，如 `/node_modules/...`，与 `vite.config.ts` 里 `'@': '/src'` 同一写法） */
function codiconAlias(): string {
  const matched = readFileSync(VITE_CONFIG, 'utf8').match(
    /'@mono-codicon':\s*'([^']+)'/,
  )
  expect(matched).not.toBeNull()
  return matched![1]
}

describe('codicon 图标字体（Monaco 精简构建）', () => {
  it('setupMonaco 显式引了字体 css（只有主题样式表 = 只有字符、没有字体）', () => {
    expect(readFileSync(SETUP, 'utf8')).toContain(
      "import '@mono-codicon/codicon.css'",
    )
  })

  it('别名落在那份真实存在的资源上（Monaco 挪目录就得改别名）', () => {
    expect(codiconAlias()).toBe(
      '/node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon',
    )
    // 别名值是根相对的（Vite 的 root = 项目根），这里同样相对项目根解析
    const dir = codiconAlias().slice(1)
    expect(existsSync(join(dir, 'codicon.css'))).toBe(true)
    expect(existsSync(join(dir, 'codicon.ttf'))).toBe(true)

    // 「字符 → 图形」的全部就这两条：字体名必须与图标规则里那个 `font-family: 'codicon'` 对得上
    const css = readFileSync(join(dir, 'codicon.css'), 'utf8')
    expect(css).toMatch(/@font-face\s*\{[^}]*font-family:\s*["']codicon["']/)
    expect(css).toMatch(/url\(\s*\.\/codicon\.ttf\s*\)/)
    expect(css).toMatch(
      /\.codicon\[class\*=['"]codicon-['"]\]\s*\{[^}]*font:\s*[^;]*codicon/,
    )
  })

  it('别名不是多余的：包的 exports 把任意子路径重写成 esm/vs/*.js，深层的 .css 解析不到', () => {
    expect(readFileSync(MONACO_PKG, 'utf8')).toMatch(
      /"\.\/\*":\s*"\.\/esm\/vs\/\*\.js"/,
    )
  })
})
