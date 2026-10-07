/**
 * phone-control 设置页的「类名 ↔ 样式定义」契约（§26）。
 *
 * 缺陷背景（真机反馈「配对确认弹窗没有 CSS 样式」）：`phone-control-settings.tsx` 用的是
 * `btn` / `btn--primary` / `btn--danger` / `btn--small`，而**本页样式与全局样式里都没有这些类的
 * 定义**（全项目仅此处在用裸 `btn`；其它页用的是 `btn-cancel` / `btn-secondary` 等各自作用域内的
 * 类名）→ 本页所有按钮一直是浏览器默认外观，配对确认弹窗（「拒绝 / 允许」）里最刺眼。
 *
 * 三条口径说明（都是为了让这条用例真的能拦住缺陷，而不是写成"看起来在测"）：
 *  1. **用 sass 编译产物**而不是正则扫 scss：嵌套的 `&__x` / `&--y` 只有编译后才是真类名，
 *     正则扫描会把 `.phone-control__confirm` 误判成「未定义」（源文件里写作 `&__confirm`）。
 *  2. **只认「本页样式 + 全局样式」**，不用全项目类名并集：并集会放过**同名但作用域不匹配**的
 *     类名 —— 那正是本缺陷溜到真机的原因（`btn` 在别的容器下有同名规则，在本页一条都不匹配）。
 *  3. 只扫**纯静态** `className="…"` 字面量：模板串里混着表达式（`${e.kind === 'approval' ? …}`），
 *     静态分析会把比较值（`approval`）也当成类名。
 *
 * 取文件用 `node:fs`（cwd 相对）而不是 vite 的 `?raw`：实测 `?raw` 对 `.tsx` 正常，但对 `.scss`
 * 会被 vitest 的 CSS 打桩拦成空串 —— 那会让本用例"永远通过"，属于假绿灯。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'
import type { PhoneControlStatus } from '@/bridge'

/** 读项目内文件；cwd 不对时给出可读错误（而不是让下游拿到空串后"静默通过"） */
function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `本用例需要以 virlen-app 为工作目录运行：找不到 ${rel}（当前 cwd = ${process.cwd()}）`,
    )
  }
  return readFileSync(p, 'utf8')
}

const pageTsx = readProjectFile('src/ui/pages/Settings/phone-control-settings.tsx')
const pageScss = readProjectFile('src/ui/pages/Settings/phone-control-settings.scss')
/** 全局样式：`ui/App.tsx` 在入口处引入，全应用可见。
 *  theme.scss 必须**编译**后再查变量：品牌令牌现在由 SCSS 函数派生（`@include accent-vars`），
 *  源码里根本没有 `--primary: #…` 这种字面声明，拿原文做「幽灵变量」检查会把它们全判成未定义。 */
const globalCss = [
  readProjectFile('src/ui/App.css'),
  sass
    .compileString(readProjectFile('src/ui/styles/theme.scss'))
    .css.replace(/@charset\s+"[^"]*";/g, ''),
].join('\n')

/**
 * 状态胶囊的修饰符清单。
 *
 * 写成 `Record<PhoneControlStatus, true>` 而不是普通数组：这样**联合类型新增一个状态、这里忘了补**
 * （或者多出一个不存在的状态）都是编译错误。配合下面的断言，把「加了状态却忘了样式」变成可发现的失败 ——
 * tsx 里的 `phone-control__status--${s.status}` 是模板串，静态扫描盖不到它。
 */
const STATUS_MODIFIERS: Record<PhoneControlStatus, true> = {
  disabled: true,
  waiting: true,
  verifying: true,
  connected: true,
  rejected: true,
  error: true,
}

/** 明确豁免：确实无需样式的纯结构类（每条都要写清理由） */
const ALLOWED_WITHOUT_STYLE = new Set<string>([
  // 审计区的 <section> 容器：只承担语义分组，视觉由 __audit-head / __audit-list 承担
  'phone-control__audit',
])

function classesIn(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1]))
}

/**
 * 去掉块注释。
 *
 * 必需：注释里出现的类名 / 变量名不该被当成「定义」或「使用」——
 * 本文件就踩过：修复注释里写了「原为 `var(--bg-elevated, …)`」，变量检查因之误报。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** tsx 里纯静态的 className 字面量（`className="a b"`），不含模板串 */
function staticClassesIn(tsx: string): string[] {
  const out: string[] = []
  for (const m of stripComments(tsx).matchAll(/className="([^"{}]+)"/g)) {
    out.push(...m[1].split(/\s+/))
  }
  return out.filter((c) => /^[a-zA-Z][\w-]*$/.test(c))
}

describe('phone-control 设置页 —— 类名与样式定义成对', () => {
  const pageCss = sass.compileString(pageScss).css

  it('tsx 里每个静态类名都能在本页 scss（编译后）或全局样式中找到定义', () => {
    // 前置：源码真的读到了（否则下面的断言会因"空集合"而假通过）
    expect(pageCss.length).toBeGreaterThan(200)
    expect(staticClassesIn(pageTsx).length).toBeGreaterThan(10)

    const defined = classesIn(pageCss)
    for (const c of classesIn(globalCss)) defined.add(c)

    const missing = [...new Set(staticClassesIn(pageTsx))].filter(
      (c) => !defined.has(c) && !ALLOWED_WITHOUT_STYLE.has(c),
    )
    expect(missing).toEqual([])
  })

  it('scss 里引用的 CSS 变量都真的已定义（防「幽灵变量」静默降级为 fallback）', () => {
    // 本缺陷的第二根因就是这个：`var(--bg-elevated, #1c1c22)` —— `--bg-elevated` 全项目
    // 从未定义，于是弹窗永远是近黑底（亮色主题下标题不可读），而**编译 / 类型检查都不报错**。
    // 口径：变量只需在全局样式（theme.scss 编译产物 / App.css）里有定义；若将来本页需要用 JS 内联的
    // 变量（如 `--x` 由 TS 写入），请加白名单并注明理由，不要删这条断言。
    const definedVars = new Set(
      [...stripComments(globalCss).matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]),
    )
    const usedVars = [
      ...new Set([...stripComments(pageScss).matchAll(/var\((--[a-zA-Z][\w-]*)/g)].map((m) => m[1])),
    ]
    expect(usedVars.filter((v) => !definedVars.has(v))).toEqual([])
  })

  it('每种连接状态都有胶囊样式（防「加了状态却让它裸奔」）', () => {
    for (const status of Object.keys(STATUS_MODIFIERS)) {
      expect(pageCss, `缺少 .phone-control__status--${status} 的样式`).toContain(
        `.phone-control__status--${status}`,
      )
    }
  })

  it('按钮基础款与三个修饰符都有**本页作用域**的规则（防「按钮裸奔」回归）', () => {
    for (const c of ['btn', 'btn--primary', 'btn--danger', 'btn--small']) {
      expect(pageCss, `缺少 .phone-control .${c} 的样式`).toContain(`.phone-control .${c}`)
    }
  })
})
