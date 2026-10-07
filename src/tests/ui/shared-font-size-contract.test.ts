/**
 * shared 组件（`src/ui/components/shared`）的「字号跟随」契约。
 *
 * 缺陷背景（本次优化的动机）：
 * 用户在「设置 → 字体大小」切小/中/大，靠的是 `<html data-font-size>` 覆盖
 * `ui/styles/theme.scss` 里的 `--font-size-*` 一组变量（见 hooks/useFontSize.ts）。
 * 也就是说：**组件里只要写了 px 字号，那处就永远不跟着变**。
 * 这批组件里踩过的坑：
 *   ① hardcode 的字号 —— UpdateModal 里 17 处、MessageBox/Select/Tooltip/Slider/RadioGroup/ImagePreview 若干；
 *   ② `var(--font-size-xs, 12px)` 这种 px 兜底 —— 兜底值和令牌实际值早就漂了
 *      （FileChip/QuoteChip/SkillChip 的 xs 兜底写 12px，而 xs 实际是 11px），
 *      主题变量一旦没生效就按错的值渲染；
 *   ③ tsx 内联 `style={{ fontSize: '13px' }}` —— 内联 px 用不了 `var()`，改字号这两行纹丝不动；
 *   ④ 承载文字的盒子写死高度（chip 24px、下拉每行按 34px 估算）——
 *      字号调大后文字被挤住 / 下拉被视口裁掉。
 *
 * 这些都是**纯 CSS / 几何**问题：jsdom 不加载 scss，组件测试看不见，样式改回去照样全绿。
 * 所以这里用 `sass.compileString` 编译真实样式再断言，口径与
 * `memory-settings-style-contract.test.ts` / `phone-control-style-contract.test.ts` 一致。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as sass from 'sass'
import { dropdownContentHeight } from '@/ui/components/shared/Select'

const SHARED_DIR = 'src/ui/components/shared'

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

/**
 * 去掉块注释与行注释。
 * 必需：修复说明里引用旧写法时，注释里的 `font-size: 12px`、`fontSize: '13px'`
 * 会被下面的「源码扫描」当成违规（本文件自己也踩过这个坑）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 递归收集目录下所有文件（返回相对 cwd 的 posix 路径，便于断言里写清是哪个组件） */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(relative(process.cwd(), p).replace(/\\/g, '/'))
  }
  return out
}

const allFiles = walk(resolve(process.cwd(), SHARED_DIR))
const scssFiles = allFiles.filter((f) => f.endsWith('.scss'))
const tsxFiles = allFiles.filter((f) => f.endsWith('.tsx'))

/** 每个 scss 的编译产物（键是相对路径）。编译失败说明引入了 `@use`/`@import`，需要显式加载路径 */
const compiled = new Map<string, string>(
  scssFiles.map((f) => {
    /* `@charset "UTF-8";`（源文件带中文注释时 sass 就会输出）会被贴在**第一条规则**前面，
       不摘掉的话那条规则的选择器会变成 `@charset "UTF-8"; .xxx`，断言永远匹配不上 */
    const css = sass.compileString(readProjectFile(f)).css.replace(/@charset\s+"[^"]*";/g, '')
    return [f, css] as const
  }),
)

/** 取「选择器列表里**恰好含有**该选择器」的规则体，返回某个声明的所有值（按出现顺序） */
function declAll(file: string, selector: string, prop: string): string[] {
  const css = compiled.get(file)
  if (css === undefined) throw new Error(`未编译的样式文件：${file}`)
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

/** 同 declAll，但只取最后一个（后写的覆盖先写的） */
function decl(file: string, selector: string, prop: string): string | undefined {
  return declAll(file, selector, prop).pop()
}

const globalCss = [readProjectFile('src/ui/App.css'), readProjectFile('src/ui/styles/theme.scss')].join(
  '\n',
)

/** 取某个状态块（`:root` / `[data-font-size='small']` / `[data-font-size='large']`）里的字号令牌 */
function fontTokensOf(selector: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rule of stripComments(globalCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim())
    if (!selectors.includes(selector)) continue
    for (const part of rule[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      const name = part.slice(0, i).trim()
      if (name.startsWith('--font-size-')) map.set(name, part.slice(i + 1).trim())
    }
  }
  return map
}

const mediumTokens = fontTokensOf(':root')
const smallTokens = fontTokensOf("[data-font-size='small']")
const largeTokens = fontTokensOf("[data-font-size='large']")

describe('shared 组件 —— 字号跟随用户设置（小/中/大）的样式契约', () => {
  it('前置：样式真的编译出来了（否则下面的断言会因「空产物」假通过）', () => {
    expect(scssFiles.length).toBeGreaterThanOrEqual(13)
    expect(mediumTokens.size).toBeGreaterThanOrEqual(10)
    for (const [file, css] of compiled) expect(css.length, `${file} 编译产物为空`).toBeGreaterThan(0)
  })

  it('主题三档字号令牌都齐、且小 < 中 < 大（令牌本身必须真的会动）', () => {
    const names = [...mediumTokens.keys()]
    expect(names).toContain('--font-size-xs')
    expect(names).toContain('--font-size-base')
    expect(smallTokens.size, 'small 档缺令牌').toBe(names.length)
    expect(largeTokens.size, 'large 档缺令牌').toBe(names.length)
    const px = (m: Map<string, string>, n: string) => Number.parseInt(m.get(n) ?? '', 10)
    for (const n of names) {
      for (const [state, map] of [
        ['small', smallTokens],
        ['medium', mediumTokens],
        ['large', largeTokens],
      ] as const) {
        expect(Number.isNaN(px(map, n)), `${n} 在 ${state} 档不是 px 数值`).toBe(false)
      }
      expect(px(smallTokens, n), `${n} 没有随 small 变小`).toBeLessThan(px(mediumTokens, n))
      expect(px(largeTokens, n), `${n} 没有随 large 变大`).toBeGreaterThan(px(mediumTokens, n))
    }
  })

  it('shared 组件里不存在硬编码 px 字号（存在即「不跟随设置」）', () => {
    const offenders: string[] = []
    for (const file of scssFiles) {
      const src = stripComments(readProjectFile(file))
      // 只看 font-size 声明：`font: inherit` 这类简写不受影响
      for (const m of src.matchAll(/font-size\s*:\s*([^;{}]+)/g)) {
        const value = m[1].trim()
        if (/\d(px|rem|em|pt)\b/.test(value) || /^\d+(\.\d+)?$/.test(value)) {
          offenders.push(`${file}: font-size: ${value}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('shared 组件的 tsx 里不存在内联 px 字号（内联写法用不了 var()）', () => {
    const offenders: string[] = []
    for (const file of tsxFiles) {
      const src = stripComments(readProjectFile(file))
      for (const m of src.matchAll(/fontSize\s*:\s*[`'"]?\s*\d+(\.\d+)?(px)?\s*[`'"]?/g)) {
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('`var(--font-size-*)` 不再带 px 兜底（兜底值不跟主题走，早晚漂移）', () => {
    const offenders: string[] = []
    for (const file of [...scssFiles, ...tsxFiles]) {
      const src = stripComments(readProjectFile(file))
      for (const m of src.matchAll(/var\(--font-size-[\w-]+\s*,[^)]*\)/g)) {
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('shared 组件用到的所有字号令牌都已在主题里定义（防幽灵令牌静默降级）', () => {
    const used = new Set<string>()
    for (const file of [...scssFiles, ...tsxFiles]) {
      const src = stripComments(readProjectFile(file))
      for (const m of src.matchAll(/var\((--font-size-[\w-]+)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(4)
    expect([...used].filter((v) => !mediumTokens.has(v))).toEqual([])
  })

  it('承载文字的组件都显式指定了令牌字号（不靠隐式继承）', () => {
    const expected: [string, string, string][] = [
      // 输入框/气泡里的三种 chip
      ['src/ui/components/shared/FileChip/style.scss', '.file-chip', 'var(--font-size-xs)'],
      ['src/ui/components/shared/QuoteChip/style.scss', '.quote-chip', 'var(--font-size-xs)'],
      ['src/ui/components/shared/SkillChip/style.scss', '.skill-chip', 'var(--font-size-sm)'],
      [
        'src/ui/components/shared/SkillChip/style.scss',
        '.skill-chip.is-card .skill-chip-desc',
        'var(--font-size-xs)',
      ],
      // ✕ 按钮的 ✕ 也是文字，同样跟随
      ['src/ui/components/shared/FileChip/style.scss', '.file-chip .file-chip-remove', 'var(--font-size-2xs)'],
      ['src/ui/components/shared/QuoteChip/style.scss', '.quote-chip .quote-chip-remove', 'var(--font-size-2xs)'],
      ['src/ui/components/shared/SkillChip/style.scss', '.skill-chip .skill-chip-remove', 'var(--font-size-2xs)'],
      // 弹窗家族
      ['src/ui/components/shared/MessageBox/style.scss', '.message-box-content .text', 'var(--font-size-sm)'],
      ['src/ui/components/shared/MessageBox/style.scss', '.message-box-content .bottom-view .confirm', 'var(--font-size-sm)'],
      ['src/ui/components/shared/Modal/style.scss', '.modal-overlay .modal-content .modal-header h3', 'var(--font-size-base)'],
      ['src/ui/components/shared/Modal/style.scss', '.modal-overlay .modal-content .modal-header .modal-close', 'var(--font-size-3xl)'],
      ['src/ui/components/shared/Modal/style.scss', '.modal-overlay .modal-content .modal-footer button', 'var(--font-size-md)'],
      ['src/ui/components/shared/ErrorBoundary/style.scss', '.error-boundary .error-boundary-title', 'var(--font-size-xl)'],
      ['src/ui/components/shared/ErrorBoundary/style.scss', '.error-boundary .eb-btn', 'var(--font-size-md)'],
      // 表单控件 / 浮层
      ['src/ui/components/shared/RadioGroup/style.scss', '.RadioGroup .RadioGroup__item', 'var(--font-size-sm)'],
      ['src/ui/components/shared/Select/style.scss', '.custom-select', 'var(--font-size-md)'],
      ['src/ui/components/shared/Select/style.scss', '.custom-select .custom-select__value', 'var(--font-size-md)'],
      ['src/ui/components/shared/Select/style.scss', '.custom-select__dropdown .custom-select__option', 'var(--font-size-md)'],
      ['src/ui/components/shared/Slider/style.scss', '.slider-component', 'var(--font-size-sm)'],
      ['src/ui/components/shared/Tooltip/style.scss', '.tooltip-bubble', 'var(--font-size-xs)'],
      ['src/ui/components/shared/ContextMenu/style.scss', '.context-menu .context-menu-item', 'var(--font-size-sm)'],
      ['src/ui/components/shared/Toast/style.module.scss', '.toast-view .box', 'var(--font-size-base)'],
      // 更新弹窗（原 17 处硬编码 px 字号的大头）
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .top .title', 'var(--font-size-lg)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .header .new-version-badge', 'var(--font-size-base)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .header .version-label', 'var(--font-size-md)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .header .policy-hint', 'var(--font-size-md)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .changelog-section .changelog-content', 'var(--font-size-md)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .btn-update', 'var(--font-size-base)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .actions .btn-force-update', 'var(--font-size-base)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .bottom-row .btn-text', 'var(--font-size-sm)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .download-section .download-title', 'var(--font-size-xl)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .download-section .progress-info', 'var(--font-size-sm)'],
      ['src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .download-section .download-done-hint', 'var(--font-size-md)'],
      // 图片预览（工具栏 / 索引的窄屏降档由下一条用例覆盖）
    ]
    for (const [file, selector, value] of expected) {
      expect(decl(file, selector, 'font-size'), `${file} → ${selector}`).toBe(value)
    }
  })

  it('ImagePreview 工具栏与索引字号在窄屏降一档（媒体查询覆盖 base → sm）', () => {
    expect(declAll('src/ui/components/shared/ImagePreview/style.scss', '.image-preview-toolbar .toolbar-scale', 'font-size')).toEqual([
      'var(--font-size-base)',
      'var(--font-size-sm)',
    ])
    expect(declAll('src/ui/components/shared/ImagePreview/style.scss', '.image-preview-index', 'font-size')).toEqual([
      'var(--font-size-base)',
      'var(--font-size-sm)',
    ])
  })

  it('承载文字的盒子高度用 em 挂在字号上（字号变大只撑高、不裁文字）', () => {
    const expected: [string, string, string, string][] = [
      // chip：24px @ medium（2.2em × 11px / 2em × 12px）→ 小 22px / 大 26.4px
      ['src/ui/components/shared/FileChip/style.scss', '.file-chip', 'min-height', '2.2em'],
      ['src/ui/components/shared/QuoteChip/style.scss', '.quote-chip', 'min-height', '2.2em'],
      ['src/ui/components/shared/SkillChip/style.scss', '.skill-chip', 'min-height', '2em'],
      // ✕ 按钮方框 = 1.6em × 自身字号（2xs）→ medium 16px
      ['src/ui/components/shared/FileChip/style.scss', '.file-chip .file-chip-remove', 'width', '1.6em'],
      ['src/ui/components/shared/SkillChip/style.scss', '.skill-chip .skill-chip-remove', 'height', '1.6em'],
      // 引用条高度跟正文走（1.1em × 11px ≈ 12px）
      ['src/ui/components/shared/QuoteChip/style.scss', '.quote-chip .quote-chip-bar', 'height', '1.1em'],
      // 滑块：轨道高 1.5em（medium = 18px），文字不另写 px
      ['src/ui/components/shared/Slider/style.scss', '.slider-component', 'height', '1.5em'],
      // 下拉触发器：34px = 2.6em @ md（em 看的是自身 font-size，所以本体也必须持有符牌）
      ['src/ui/components/shared/Select/style.scss', '.custom-select', 'min-height', '2.6em'],
      ['src/ui/components/shared/Select/style.scss', '.custom-select', 'font-size', 'var(--font-size-md)'],
      // 弹窗关闭按钮方框 = 1em × 3xl（medium = 20px）
      ['src/ui/components/shared/Modal/style.scss', '.modal-overlay .modal-content .modal-header .modal-close', 'min-width', '1em'],
      ['src/ui/components/shared/Modal/style.scss', '.modal-overlay .modal-content .modal-header .modal-close', 'min-height', '1em'],
      // 气泡最大宽度跟字号走（260px = 24em @ xs）
      ['src/ui/components/shared/Tooltip/style.scss', '.tooltip-bubble', 'max-width', '24em'],
    ]
    for (const [file, selector, prop, value] of expected) {
      expect(decl(file, selector, prop), `${file} → ${selector} { ${prop} }`).toBe(value)
    }
  })

  it('固定高度必须给出「长大」的余地（min-* 而非 height），且不只靠 min 压覆盖方', () => {
    // 标题行只给下限，字号变大时自己撑开
    expect(decl('src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .top', 'min-height')).toBe('45px')
    expect(decl('src/ui/components/shared/UpdateModal/UpdateModal.scss', '.UpdateModal-component .UpdateModal .top', 'height')).toBeUndefined()
    // MessageBox 的按钮：ripple-button 自带 height: 35px，min-height 压不住它（height 优先于 min-height）
    for (const sel of ['.message-box-content .bottom-view .cancel', '.message-box-content .bottom-view .confirm']) {
      expect(decl('src/ui/components/shared/MessageBox/style.scss', sel, 'height'), sel).toBe('auto')
      expect(decl('src/ui/components/shared/MessageBox/style.scss', sel, 'min-height'), sel).toBe('26px')
      // 26px = 12px 字号 + 7px×2 内边距：字号变大时按钮自己长高
      expect(decl('src/ui/components/shared/MessageBox/style.scss', sel, 'line-height'), sel).toBe('1')
    }
  })

  it('组件里不再有「画死的整块高度」（字号一大就把文字挤住）', () => {
    const expectedHeightless = [
      ['src/ui/components/shared/FileChip/style.scss', '.file-chip'],
      ['src/ui/components/shared/QuoteChip/style.scss', '.quote-chip'],
      ['src/ui/components/shared/SkillChip/style.scss', '.skill-chip'],
      ['src/ui/components/shared/MessageBox/style.scss', '.message-box-content .bottom-view .confirm'],
    ] as const
    for (const [file, selector] of expectedHeightless) {
      const h = decl(file, selector, 'height')
      // 允许 `auto`（显式把高度交回内容）与完全不写，但不允许任何 px / em 固定值
      expect(h === undefined || h === 'auto', `${file} → ${selector} 不该写死 height（实际 ${h}）`).toBe(true)
    }
  })

  it('UpdateModal 的策略提示颜色由样式类管（tsx 里不再内联色值/字号）', () => {
    const file = 'src/ui/components/shared/UpdateModal/UpdateModal.scss'
    expect(decl(file, '.UpdateModal-component .UpdateModal .header .policy-hint.is-force', 'color')).toBe('#e74c3c')
    expect(decl(file, '.UpdateModal-component .UpdateModal .header .policy-hint.is-recommended', 'color')).toBe('#f39c12')
    const tsx = readProjectFile('src/ui/components/shared/UpdateModal/UpdateModal.tsx')
    expect(tsx).toContain('policy-hint is-force')
    expect(tsx).toContain('policy-hint is-recommended')
  })

  it('Select 下拉高度按实测量行高估算，不再写死「每行 34px」', () => {
    const tsx = stripComments(readProjectFile('src/ui/components/shared/Select/index.tsx'))
    // 写死行高的痕迹：options.length * 34
    expect(tsx).not.toMatch(/options\.length\s*\*\s*\d/)
    expect(tsx).toContain('getBoundingClientRect().height')
    // 纯函数本身要真的跟着行高（= 跟着字号）变：字号大一档，面板就高一档
    const count = 5
    expect(dropdownContentHeight(38, count)).toBeGreaterThan(dropdownContentHeight(34, count))
    expect(dropdownContentHeight(34, count)).toBe(34 * count + 2 * (count - 1) + 8)
    // 行数为 0 时不产生负的行间隔
    expect(dropdownContentHeight(34, 0)).toBe(8)
  })
})
