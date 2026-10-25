// @vitest-environment node
/**
 * read_file 多文件下拉的样式契约（选项单行 / 面板按内容撑宽 / 面板跟代码块一起深色）。
 *
 * 缺陷背景（本次 UI 优化的动机，来自截图反馈）：
 *   ① 文件名下拉的选项会**折行** —— 「src/tests/ui/code-block-fullscreen.test.tsx」在面板里断成两行，
 *      同一份列表里有的行一行、有的两行，扫读时没有对齐线；
 *   ② 面板是 shared Select 的**浅色皮肤**（白底 + 品牌色选中），而它长在代码块头部（深色）下面 ——
 *      深色块上裂开一块白。
 *
 * 改法：Select 新增两个 opt-in 能力（默认行为不变）——
 *   · `dropdownWidth="content"`：宽度 `max-content` + 内联 min/max 夹逼（上限 500px），
 *     配 `.custom-select__dropdown.is-content-width` 让选项单行 + 省略号；
 *   · `dropdownClassName`：面板经 Portal 挂在 body 上、不在调用方子树里，深色皮肤只能靠这个抓手。
 *
 * 这些都是**纯 CSS / 布局**问题：jsdom 不加载 scss、也量不到文字宽度，组件测试断言不到；
 * 样式被删掉时组件测试照样全绿（"看起来在测"的假绿灯）。
 * 所以这里用 `sass.compileString` 编译真实样式再断言，口径与 `memory-settings-style-contract.test.ts`
 * / `phone-control-style-contract.test.ts` 一致。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'
import {
  DROPDOWN_CONTENT_MAX_WIDTH,
  clampDropdownLeft,
  dropdownContentMaxWidth,
} from '@/ui/components/shared/Select'
import {
  CODE_FONT_STACKS,
  CODE_THEMES,
  buildCodeCssVars,
} from '@/domain/code-display'

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

/** 去掉块注释与行注释（注释里引用的旧写法不该被当成「使用」） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 取「选择器列表里**恰好含有**该选择器」的规则体里某个声明的值（后写的覆盖先写的）。
 * 用完整选择器而不是后缀匹配：后缀匹配会让「另一条规则恰好也以它结尾」蒙混过关。
 */
function declAll(css: string, selector: string, prop: string): string[] {
  const values: string[] = []
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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

/** 同 declAll，但只取最后一个 */
function decl(css: string, selector: string, prop: string): string | null {
  return declAll(css, selector, prop).pop() ?? null
}

/** 面板（Portal 挂 body）与触发器的类名：两侧各一份，配对断言时用 */
const PANEL = '.custom-select__dropdown.code-file-panel'
const SWITCHER = '.custom-select.code-file-switcher'

const TOOL_CALL_SCSS = 'src/ui/pages/chat/components/tool-call/style.scss'
const SELECT_SCSS = 'src/ui/components/shared/Select/style.scss'
const readFileTsx = readProjectFile('src/ui/pages/chat/components/tool-call/ReadFileMessage.tsx')
const selectTsx = readProjectFile('src/ui/components/shared/Select/index.tsx')
const toolCallCss = sass.compileString(readProjectFile(TOOL_CALL_SCSS)).css
const selectCss = sass.compileString(readProjectFile(SELECT_SCSS)).css
const themeCss = sass
  .compileString(readProjectFile('src/ui/styles/theme.scss'))
  .css.replace(/@charset\s+"[^"]*";/g, '')
/** 全局样式（`ui/App.tsx` 在入口处引入）：变量定义去这里查（theme.scss 必须编译后再查，见契约头注释） */
const globalCss = [readProjectFile('src/ui/App.css'), themeCss].join('\n')

/** sRGB 相对亮度（WCAG 口径）：用来钉住「面板贴的是深色底」这个前提 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 主题里某个令牌的**全部**取值（亮色档 + 暗色档，按出现顺序） */
function tokenValues(name: string): string[] {
  return [...stripComments(themeCss).matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map(
    (m) => m[1],
  )
}

describe('文件名下拉 —— 选项单行 + 面板按内容撑宽（上限 500px）', () => {
  it('前置：样式真的编译出来了（否则下面的断言会因"空产物"假通过）', () => {
    expect(toolCallCss.length).toBeGreaterThan(5000)
    expect(selectCss.length).toBeGreaterThan(500)
    expect(readFileTsx).toContain('code-file-switcher')
  })

  it('content 模式的选项不折行，放不下时打省略号（折行会让面板里行高不齐）', () => {
    const option = '.custom-select__dropdown.is-content-width .custom-select__option'
    expect(decl(selectCss, option, 'white-space')).toBe('nowrap')
    expect(decl(selectCss, option, 'overflow')).toBe('hidden')
    expect(decl(selectCss, option, 'text-overflow')).toBe('ellipsis')
  })

  it('面板宽度由内容撑开：max-content + 上下限夹逼，上限默认 500px', () => {
    expect(DROPDOWN_CONTENT_MAX_WIDTH).toBe(500)
    // 组件侧：content 模式下给面板的是 max-content（不是写死像素），另配 min/max 夹逼
    expect(selectTsx).toContain("width: 'max-content'")
    expect(selectTsx).toContain('minWidth: rect.width')
    expect(selectTsx).toContain('maxWidth: dropdownContentMaxWidth(')

    // 视口够宽 → 用调用方给的上限；窄视口 → 不让面板顶出视口；触发器本身就更宽 → 至少不窄于触发器
    expect(dropdownContentMaxWidth(120, 500, 1024)).toBe(500)
    expect(dropdownContentMaxWidth(120, 500, 400)).toBe(384)
    expect(dropdownContentMaxWidth(600, 500, 400)).toBe(600)
  })

  it('面板比触发器宽时往回收，不会顶出视口右缘（未溢出时原地不动）', () => {
    expect(clampDropdownLeft(900, 500, 1024)).toBe(516)
    expect(clampDropdownLeft(10, 500, 1024)).toBe(10)
    // 面板比视口还宽：贴左至少保证开头可见（不再往左溢出到负坐标）
    expect(clampDropdownLeft(10, 2000, 1024)).toBe(8)
    // 量不到视口（jsdom / SSR）→ 原值，不做无谓移动
    expect(clampDropdownLeft(42, 500, 0)).toBe(42)
  })

  it('调用方真的开了这两个能力（开了才谈得上上面的样式生效）', () => {
    expect(readFileTsx).toContain('className="code-file-switcher"')
    expect(readFileTsx).toContain('dropdownClassName="code-file-panel"')
    expect(readFileTsx).toContain('dropdownWidth="content"')
  })
})

describe('文件名下拉 —— 面板跟代码块一起走代码主题', () => {
  it('面板与选项都取代码块自己的令牌（现在只有一份兜底，亮暗不再各写一遍）', () => {
    const headerBg = tokenValues('--code-header-bg')
    // 色源搬到 domain/code-display 后由运行期注入（:root[data-code-theme]），
    // theme.scss 只留一份首帧兜底 —— 所以这里恰好一个值
    expect(headerBg).toHaveLength(1)
    // 兜底值 = 主题里同一个色：令牌万一没生效也不至于换一个色
    expect(decl(toolCallCss, PANEL, 'background')).toBe(`var(--code-header-bg, ${headerBg[0]})`)
    expect(decl(toolCallCss, PANEL, 'border-color')).toBe(
      'color-mix(in srgb, var(--code-header-color) 22%, transparent)',
    )
    expect(decl(toolCallCss, PANEL, 'box-shadow')).toBeTruthy()
    expect(decl(toolCallCss, `${PANEL} .custom-select__option`, 'color')).toBe(
      'var(--code-header-color, #abb2bf)',
    )
    // 与触发器同档字号：面板是触发器的展开，字大一号会像换了控件
    expect(decl(toolCallCss, `${PANEL} .custom-select__option`, 'font-size')).toBe('var(--font-size-xs)')
    expect(decl(toolCallCss, SWITCHER, 'font-size')).toBe('var(--font-size-xs)')
  })

  it('hover / 选中用「相对头部文字色的透明层」分层，不用品牌色', () => {
    // ⚠️ 不能用白度（rgba(255,255,255,x)）：代码主题可能是浅色的，白层叠白底 = 看不见
    const LAYER = /^color-mix\(in srgb, var\(--code-header-color\) (\d+)%, transparent\)$/
    for (const sel of [
      `${PANEL} .custom-select__option:hover`,
      `${PANEL} .custom-select__option.is-active`,
      `${PANEL} .custom-select__option.is-selected`,
    ]) {
      const bg = decl(toolCallCss, sel, 'background')
      expect(bg, `${sel} 缺少背景`).toBeTruthy()
      expect(bg, `${sel} 仍在用白度分层`).toMatch(LAYER)
    }
    // 选中比 hover 更浓一档（否则"当前展示的是谁"看不出来）
    const pct = (v: string): number => Number(LAYER.exec(v)![1])
    const selected = decl(toolCallCss, `${PANEL} .custom-select__option.is-selected`, 'background')!
    const hover = decl(toolCallCss, `${PANEL} .custom-select__option:hover`, 'background')!
    expect(pct(selected)).toBeGreaterThan(pct(hover))
    // 选中项只加重底色与字重，文案色仍是头部色（写死 #e9edf5 在浅色主题下会糊在白底上）
    expect(decl(toolCallCss, `${PANEL} .custom-select__option.is-selected`, 'color')).toBeFalsy()
    expect(decl(toolCallCss, `${PANEL} .custom-select__option.is-selected`, 'font-weight')).toBe('600')
  })

  it('前提：每个代码主题的头部文字在头部底色上都过 AA（面板与列头共用这套令牌）', () => {
    // 以前只查深色主题（面板是“深色皮肤”），现在浅色主题也会拿这套令牌，
    // 所以改成「全部主题都过 AA」，否则浅色主题下面板文字会读不出来。
    const cases = Object.entries(CODE_THEMES).map(([id, palette]) => {
      const vars = buildCodeCssVars(palette, {
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: CODE_FONT_STACKS.consolas,
      })
      return { id, bg: vars['--code-header-bg'], fg: vars['--code-header-color'] }
    })

    const bgs = tokenValues('--code-header-bg')
    const fgs = tokenValues('--code-header-color')
    expect(bgs).toHaveLength(1)
    expect(fgs).toHaveLength(1)
    cases.push({ id: 'theme.scss 兜底', bg: bgs[0], fg: fgs[0] })

    for (const { id, bg, fg } of cases) {
      expect(
        contrastRatio(fg, bg),
        `${id} 的面板文字 ${fg} 在 ${bg} 上只有 ${contrastRatio(fg, bg).toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('触发器仍是「头部里的 ghost」，没被这轮改动带跑', () => {
    expect(decl(toolCallCss, SWITCHER, 'border-color')).toBe('transparent')
    expect(decl(toolCallCss, SWITCHER, 'background')).toBe(
      'color-mix(in srgb, var(--code-header-color) 10%, transparent)',
    )
    expect(decl(toolCallCss, `${SWITCHER} .custom-select__value`, 'color')).toBe(
      'var(--code-header-color, #abb2bf)',
    )
  })

  it('用到的变量都在全局样式里有定义（防幽灵变量静默降级为兜底值）', () => {
    const definedVars = new Set(
      [...stripComments(globalCss).matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]),
    )
    for (const v of ['--code-header-bg', '--code-header-color', '--font-size-xs']) {
      expect(definedVars.has(v), `全局样式里没有定义 ${v}`).toBe(true)
    }
  })
})
