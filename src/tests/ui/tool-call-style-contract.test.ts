// @vitest-environment node
/**
 * tool-call 目录的「样式跟随设置」契约。
 *
 * 缺陷背景（本次优化的动机）：这批工具消息组件（知识库 / 文件 / 搜索 / 记忆 …）的折叠态一行、
 * 展开态纯文本原本是一堆**内联样式**：
 *   · `style={{ color: '#999', fontSize: 12 }}` —— 内联 px 用不了 `var()`，
 *     用户在「设置 → 字体大小」里改小/中/大，这几十处纹丝不动，而且 `#999` / `#888` /
 *     `#333` 这些灰在暗色主题下也不会换（`--text-tertiary` 早就因为对比度改成 #767676 了）；
 *   · `style={{ color: '#5b5eff' }}` / `color: selected ? '#fff' : …` ——
 *     写死的旧靛蓝与白字，换主题色后只有这几处还是老色（品牌底上的白字在浅色主题色下还会糊成一片）；
 *   · `style={{ fontSize: 12 }}` 这类内联字号旁边，`style.scss` 里也混着 17 处 px 字号
 *     （10 / 11 / 12 / 13px）与 `var(--font-size-sm, 13px)` 这种**已经漂移的兜底** ——
 *     与 `shared-font-size-contract.test.ts` 记的是同一类缺陷，只是换了目录。
 * 更隐蔽的一条：`KnowledgeBaseMessage.tsx` 里 9 个 `kb-*` 类名在样式表里**根本没有定义**，
 * 全靠内联样式撑着 —— 只删内联（或只删样式）都会留下一排没样式的裸文字。
 *
 * 这些都是纯 CSS / 内联样式问题：jsdom 不加载 scss、也看不见内联色值，组件测试断言不到
 * （样式被删掉时组件测试照样全绿）。所以这里直接扫源码 + 用 `sass.compileString` 编译真实样式，
 * 口径与 `shared-font-size-contract.test.ts` / `parse-document-style-contract.test.ts` 一致。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const DIR = 'src/ui/pages/chat/components/tool-call'
const TOOL_CALL_SCSS = `${DIR}/style.scss`
const THEME_SCSS = 'src/ui/styles/theme.scss'

/** 读项目内文件；cwd 不对时给出可读错误（而不是让下游拿到空串后「静默通过」） */
function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `本用例需要以 virlen-app 为工作目录运行：找不到 ${rel}（当前 cwd = ${process.cwd()}）`,
    )
  }
  return readFileSync(p, 'utf8')
}

/** 去掉块注释与行注释（注释里引用的旧写法不该被当成「使用」） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const tsxFiles = readdirSync(resolve(process.cwd(), DIR))
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => `${DIR}/${f}`)
/** 键是相对路径，值是**去掉注释**的源码（注释里 `fontSize: 12` 式的引用不算违规） */
const tsxSources = new Map(tsxFiles.map((f) => [f, stripComments(readProjectFile(f))] as const))

const toolCallCss = stripComments(
  sass.compileString(readProjectFile(TOOL_CALL_SCSS)).css.replace(/@charset\s+"[^"]*";/g, ''),
)
const themeCss = sass
  .compileString(readProjectFile(THEME_SCSS))
  .css.replace(/@charset\s+"[^"]*";/g, '')

/** 取「选择器列表里**恰好含有**该选择器」的规则体里某个声明的所有值（按出现顺序） */
function declAll(selector: string, prop: string): string[] {
  const values: string[] = []
  for (const rule of toolCallCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim())
    if (!selectors.includes(selector)) continue
    for (const part of rule[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      if (part.slice(0, i).trim() === prop) values.push(part.slice(i + 1).trim())
    }
  }
  return values
}

/** 同 declAll，但只取最后一个（后写的覆盖先写的） */
function decl(selector: string, prop: string): string | undefined {
  return declAll(selector, prop).pop()
}

/**
 * 点号选择器在编译产物里是否出现过。
 * 用文本匹配而不是「取规则体」：调用方挂的类名常常只出现在嵌套规则里
 * （`.kb-search-result-item .kb-search-result-id`），按整选择器取会判成「没定义」。
 */
function definesClass(name: string): boolean {
  return toolCallCss.includes(`.${name}`)
}

/** 从 tsx 源码里取 `className` 的静态片段（模板插值无法在源码阶段判定，整段跳过） */
function classNameTokens(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    for (const token of (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/)) {
      if (!token || token.includes('${')) continue
      out.push(token)
    }
  }
  return out
}

describe('tool-call —— 内联样式不再绕过主题令牌', () => {
  it('前置：目录与样式都读到了（否则下面的断言会「空集合」假通过）', () => {
    expect(tsxFiles.length).toBeGreaterThanOrEqual(30)
    expect(toolCallCss.length).toBeGreaterThan(20000)
    expect(themeCss.length).toBeGreaterThan(4000)
  })

  it('tsx 里没有内联数值字号（内联 px 用不了 var()，改字号永远跟不动）', () => {
    const offenders: string[] = []
    for (const [file, src] of tsxSources) {
      for (const m of src.matchAll(/fontSize\s*:\s*['"`]?\s*\d+(\.\d+)?(px)?\s*['"`]?/g)) {
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('tsx 里没有写死的色值（换主题色 / 切暗色时只有这几处还是老色）', () => {
    const offenders: string[] = []
    for (const [file, src] of tsxSources) {
      for (const m of src.matchAll(
        /(?:^|[\s{,])(color|background|backgroundColor|borderColor|fill)\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/g,
      )) {
        offenders.push(`${file}: ${m[0].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('style.scss 的字号一律走 --font-size-* 令牌（不许 px，也不许会漂移的 px 兜底）', () => {
    const offenders: string[] = []
    for (const m of stripComments(readProjectFile(TOOL_CALL_SCSS)).matchAll(
      /font-size\s*:\s*([^;{}\n]+)/g,
    )) {
      const value = m[1].trim()
      if (!/^var\(--font-size-[a-z0-9]+\)$/.test(value)) offenders.push(`font-size: ${value}`)
    }
    expect(offenders).toEqual([])
  })

  it('用到的字号令牌都在主题里定义过（防幽灵令牌静默降级成继承字号）', () => {
    const defined = new Set([...themeCss.matchAll(/(--font-size-[a-z0-9]+)\s*:/g)].map((m) => m[1]))
    const used = new Set([...toolCallCss.matchAll(/var\((--font-size-[a-z0-9]+)/g)].map((m) => m[1]))
    expect(used.size).toBeGreaterThan(2)
    expect([...used].filter((v) => !defined.has(v))).toEqual([])
  })

  it('折叠态短文本只有一处字号来源：片段类不另钉字号（钉了就比同行的强调文本还大）', () => {
    expect(decl('.tool-call-message .tool-call-short-text', 'font-size')).toBe(
      'var(--font-size-2xs)',
    )
    for (const selector of [
      '.tool-short-row',
      '.tool-short-em',
      '.tool-short-muted',
      '.tool-short-danger',
    ]) {
      expect(declAll(selector, 'font-size'), `${selector} 不该另写字号`).toEqual([])
    }
  })

  it('共用片段都在、且取色走令牌（强调 / 弱化 / 危险三种语义）', () => {
    expect(decl('.tool-short-row', 'display')).toBe('flex')
    expect(decl('.tool-short-em', 'color')).toBe('var(--accent-color)')
    expect(decl('.tool-short-em', 'font-weight')).toBe('500')
    expect(decl('.tool-short-muted', 'color')).toBe('var(--text-tertiary)')
    expect(decl('.tool-short-danger', 'color')).toBe('var(--color-danger)')
  })

  it('展开态纯文本：字号走令牌、保留换行、长串就地折行', () => {
    expect(decl('.tool-plain-text', 'font-size')).toBe('var(--font-size-sm)')
    expect(decl('.tool-plain-text', 'white-space')).toBe('pre-wrap')
    expect(decl('.tool-plain-text', 'overflow-wrap')).toBe('anywhere')
    expect(decl('.tool-plain-text', 'margin')).toBe('0')
    // 路径清单（delete_file）沿用同一套字号
    expect(decl('.tool-plain-row', 'font-size')).toBe('var(--font-size-sm)')
  })

  it('品牌底上的前景走 --primary-fg（user_choice 选中项原先把 #fff 写在内联里）', () => {
    const OPTION = '.tool-call-expand-view .UserChoiceMessageOption'
    expect(decl(OPTION, 'color')).toBe('var(--text-primary)')
    expect(decl(OPTION, 'background-color')).toBe('var(--bg-secondary)')
    expect(decl(`${OPTION}.is-selected`, 'color')).toBe('var(--primary-fg)')
    expect(decl(`${OPTION}.is-selected`, 'background-color')).toBe('var(--accent-color)')
    // 类名真的挂上去了（选中态是 tsx 里拼出来的）
    expect(tsxSources.get(`${DIR}/UserChoiceMessage.tsx`)).toContain('is-selected')
  })

  it('tsx 里用到的 tool-call 自有类名都有定义（防「组件写了类名、样式没跟上」）', () => {
    // 只查本样式表**自己拥有的族**：其它前缀（custom-select / code-block / error …）
    // 的定义在别的样式表里，混进来只会得到一堆与本事无关的噪音。
    const OWN_PREFIXES = [
      'tool-',
      'kb-',
      'doc-',
      'web-fetch',
      'web-search',
      'skill-source',
      'service-',
      'execute-',
    ]
    const offenders: string[] = []
    for (const [file, src] of tsxSources) {
      for (const token of classNameTokens(src)) {
        if (!OWN_PREFIXES.some((p) => token.startsWith(p))) continue
        if (!definesClass(token)) offenders.push(`${file}: ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('样式表里不留「取了名字却没人挂」的 kb-* 类（原 9 个死类名已完成闭环）', () => {
    const used = new Set<string>()
    for (const src of tsxSources.values()) for (const token of classNameTokens(src)) used.add(token)

    const declared = new Set(
      [...toolCallCss.matchAll(/\.(kb-[a-z0-9-]+)/g)].map((m) => m[1]),
    )
    expect(declared.size).toBeGreaterThan(10)
    expect([...declared].filter((c) => !used.has(c))).toEqual([])
  })
})
