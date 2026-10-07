/**
 * 主题色（品牌色）契约 —— 「设置 → 通用 → 主题色」动一个色，整套品牌令牌都要跟着动。
 *
 * 这套颜色的**唯一色源**是品牌基色，派生有两条路：
 *  ① 构建期：`ui/styles/theme.scss` 的 SCSS 函数算默认档与预设色板（`[data-accent='<name>']`）；
 *  ② 运行期：用户在取色器里选的**任意颜色**只有运行期才知道，由 `ui/theme/accentPalette.ts`
 *     用**同一套系数**算出来，经 `hooks/useAccentColor.ts` 注入 <style>。
 *
 * 两条路各算一遍 = 一个天然的漂移点（改了 SCSS 忘了改 TS，预设色就与自定义色不是同一套观感）。
 * 所以本文件把 theme.scss **编译出来**，与 TS 的产物**逐令牌对拍** —— 这是本特性的主契约。
 *
 * 另外三条守卫都是"改一处漏一处"型的缺陷：
 *  · 品牌底上的文字还写着 `color: #fff` → 用户把主题色调浅后白字糊在亮底上（自动转黑失效）；
 *  · 还留着硬编码 `rgba(79, 70, 229, …)`（旧的靛蓝焦点环）→ 换色后只有那一圈还是老色；
 *  · 派生出来的前景对比度低于 AA → 用户气泡 / 主按钮上的字读不清。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as sass from 'sass'

import {
  ACCENT_PRESETS,
  ACCENT_TOKEN_NAMES,
  DEFAULT_ACCENT,
  accentTokens,
  accentStyleText,
  contrastRatio,
  normalizeHex,
  relativeLuminance,
  type AccentTokens,
} from '@/ui/theme/accentPalette'
import { applyAccentColor } from '@/ui/hooks/useAccentColor'

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

const THEME_SCSS = 'src/ui/styles/theme.scss'
const themeScss = readProjectFile(THEME_SCSS)
const themeCss = sass
  .compileString(themeScss)
  .css.replace(/@charset\s+"[^"]*";/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 取「选择器列表里恰好含有该选择器」的规则体里的品牌令牌。
 * 注意：sass 编译会把属性选择器的引号去掉（`[data-theme='dark']` → `[data-theme=dark]`），
 * 所以这里两边都去引号再比。
 */
function tokensOf(selector: string): Partial<AccentTokens> {
  const want = selector.replace(/['"]/g, '')
  const out: Record<string, string> = {}
  for (const rule of themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim().replace(/['"]/g, ''))
    if (!selectors.includes(want)) continue
    for (const part of rule[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      const name = part.slice(0, i).trim()
      if (ACCENT_TOKEN_NAMES.includes(name as never)) out[name] = part.slice(i + 1).trim()
    }
  }
  return out as Partial<AccentTokens>
}

/** 遍历 src 下所有样式文件 */
function walkStyles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkStyles(p, out)
    else if (p.endsWith('.scss') || p.endsWith('.css')) out.push(p)
  }
  return out
}

/** `#rrggbb` → 亮度/对比度计算要的 RGB */
function rgbOf(hex: string) {
  const h = normalizeHex(hex)
  if (!h) throw new Error(`不是合法颜色：${hex}`)
  return {
    r: Number.parseInt(h.slice(1, 3), 16),
    g: Number.parseInt(h.slice(3, 5), 16),
    b: Number.parseInt(h.slice(5, 7), 16),
  }
}

/** 预设色板（从 theme.scss 的 $accent-presets 里解出来，用来和 TS 清单对拍） */
const scssPresets = (() => {
  const raw = stripComments(themeScss)
  const start = raw.indexOf('$accent-presets: (')
  const end = raw.indexOf(');', start)
  expect(start, 'theme.scss 里找不到 $accent-presets').toBeGreaterThan(-1)
  return [...raw.slice(start, end).matchAll(/'([a-z-]+)':\s*(#[0-9a-fA-F]{6})/g)].map((m) => ({
    name: m[1],
    color: m[2].toLowerCase(),
  }))
})()

describe('主题色 —— SCSS（构建期）与 TS（运行期）必须算出同一套令牌', () => {
  it('前置：theme.scss 真的编译出了令牌块（否则下面的对拍会因「空产物」假通过）', () => {
    expect(themeCss.length).toBeGreaterThan(4000)
    expect(Object.keys(tokensOf(':root')).length).toBe(ACCENT_TOKEN_NAMES.length)
    expect(Object.keys(tokensOf('[data-theme=dark]')).length).toBe(ACCENT_TOKEN_NAMES.length)
    expect(scssPresets.length).toBe(ACCENT_PRESETS.length)
  })

  it('默认档（内置靛蓝）：亮 / 暗两块与 TS 派生逐令牌一致', () => {
    expect(tokensOf(':root')).toEqual(accentTokens(DEFAULT_ACCENT, 'light'))
    expect(tokensOf('[data-theme=dark]')).toEqual(accentTokens(DEFAULT_ACCENT, 'dark'))
  })

  it('亮色档的 `:root` 与 `[data-theme=light]` 是同一套值（首帧没有 data-theme 时不能闪默认色）', () => {
    expect(tokensOf('[data-theme=light]')).toEqual(tokensOf(':root'))
  })

  it('令牌清单两侧一致：不多不少（CSS 加了令牌而 TS 没跟上 = 自定义色少一个令牌）', () => {
    for (const selector of [':root', '[data-theme=dark]']) {
      const keys = Object.keys(tokensOf(selector)).sort()
      expect(keys, selector).toEqual([...ACCENT_TOKEN_NAMES].sort())
    }
  })

  it('预设色板：清单（名称 + 色值 + 顺序）与 theme.scss 的 map 一致', () => {
    expect(ACCENT_PRESETS.map((p) => ({ name: p.name, color: p.color }))).toEqual(scssPresets)
  })

  it('每个预设色板：亮 / 暗两个 data-accent 块都与 TS 派生一致', () => {
    expect(scssPresets.length).toBeGreaterThanOrEqual(8)
    for (const { name, color } of scssPresets) {
      const lightForced = tokensOf(`:root[data-accent=${name}]`)
      const lightThemed = tokensOf(`[data-theme=light][data-accent=${name}]`)
      const dark = tokensOf(`[data-theme=dark][data-accent=${name}]`)
      expect(Object.keys(lightForced).length, `${name} 亮色档令牌不全`).toBe(ACCENT_TOKEN_NAMES.length)
      expect(lightForced, `${name}（亮）`).toEqual(accentTokens(color, 'light'))
      expect(lightThemed, `${name}（亮，显式 data-theme）`).toEqual(accentTokens(color, 'light'))
      expect(dark, `${name}（暗）`).toEqual(accentTokens(color, 'dark'))
      // 预设色全部是「白字可用」的中深色：观感统一，不至于十颗色板里三颗要黑字
      expect(lightForced['--primary-fg'], `${name} 亮色档前景`).toBe('#ffffff')
    }
  })

  it('派生方向与主题相反：亮色压暗（hover 更暗）、暗色提亮（hover 更亮）', () => {
    for (const color of ['#4f46e5', '#dc2626', '#0e7490']) {
      const light = accentTokens(color, 'light')
      const dark = accentTokens(color, 'dark')
      const lum = (hex: string) => relativeLuminance(rgbOf(hex))
      expect(lum(light['--primary-hover']), `${color} 亮色 hover 应更暗`).toBeLessThan(
        lum(light['--primary']),
      )
      expect(lum(dark['--primary-hover']), `${color} 暗色 hover 应更亮`).toBeGreaterThan(
        lum(dark['--primary']),
      )
      expect(lum(dark['--primary']), `${color} 暗色主色应比亮色主色亮`).toBeGreaterThan(
        lum(light['--primary']),
      )
    }
  })

  it('品牌底上的前景（fill / bar）对比度：预设色板过 AA，任意色不低于算法下界', () => {
    const contrastOf = (a: string, b: string) => contrastRatio(rgbOf(a), rgbOf(b))

    // ① 预设色板是我们实际发货的颜色，两颗底色上的字都必须过 AA（4.5:1）
    for (const { name, color } of ACCENT_PRESETS) {
      for (const theme of ['light', 'dark'] as const) {
        const t = accentTokens(color, theme)
        expect(
          contrastOf(t['--primary-fill'], t['--primary-fg']),
          `预设「${name}」/${theme}：气泡底色 ${t['--primary-fill']} 上的 ${t['--primary-fg']}`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastOf(t['--primary-bar'], t['--primary-bar-fg']),
          `预设「${name}」/${theme}：标题栏 ${t['--primary-bar']} 上的 ${t['--primary-bar-fg']}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }

    // ② 任意色：算法只保证「黑 / 白里挑对比度更高的那一档」。候选是 #ffffff 与 #1a1a1a
    //    （不是纯黑 —— #1a1a1a 与亮色主题的 --text-primary 同源，纯黑太刺），
    //    两者对比度相等的平衡点落在 4.17:1，所以**下界是 4.17 而不是 4.5**
    //    （要 4.5 得把候选换成纯黑）。实测中间那段颜色（如 #22d3ee）正好落在 4.2:1 附近。
    const floor = 4.17
    const samples = [
      '#fde047', // 亮黄：必须自动转黑字
      '#22d3ee', // 亮青：落在下界附近的典型例子
      '#ffffff', // 纯白（极端）
      '#111827', // 近黑（极端）
      '#94a3b8', // 中间灰
      '#7c3aed',
      '#c9c9c9',
      '#0891b2',
    ]
    for (const color of samples) {
      for (const theme of ['light', 'dark'] as const) {
        const t = accentTokens(color, theme)
        expect(
          contrastOf(t['--primary-fill'], t['--primary-fg']),
          `${color} / ${theme}：气泡底色 ${t['--primary-fill']} 上的 ${t['--primary-fg']}`,
        ).toBeGreaterThanOrEqual(floor)
        expect(
          contrastOf(t['--primary-bar'], t['--primary-bar-fg']),
          `${color} / ${theme}：标题栏 ${t['--primary-bar']} 上的 ${t['--primary-bar-fg']}`,
        ).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('浅色自动转黑字、深色保持白字（自动前景的语义本身）', () => {
    expect(accentTokens('#fde047', 'light')['--primary-fg']).toBe('#1a1a1a')
    expect(accentTokens('#ffffff', 'light')['--primary-fg']).toBe('#1a1a1a')
    expect(accentTokens('#111827', 'light')['--primary-fg']).toBe('#ffffff')
    expect(accentTokens(DEFAULT_ACCENT, 'light')['--primary-fg']).toBe('#ffffff')
    expect(accentTokens('#fde047', 'dark')['--primary-fg']).toBe('#1a1a1a')
    expect(accentTokens(DEFAULT_ACCENT, 'dark')['--primary-fg']).toBe('#ffffff')
  })

  it('默认档的观感保持不变：亮色主色=内置靛蓝，暗色档与改动前的硬编码值逐通道相差 ≤ 10', () => {
    const light = accentTokens(DEFAULT_ACCENT, 'light')
    const dark = accentTokens(DEFAULT_ACCENT, 'dark')
    expect(light['--primary']).toBe('#4f46e5')
    expect(light['--primary-bar']).toBe('#4f46e5')
    expect(light['--primary-fill']).toBe('#4f46e5')
    expect(light['--primary-fg']).toBe('#ffffff')

    // 改动前 theme.scss（原 theme.css）里手写的暗色档值（原样抄在这里：它们是"派生公式能不能替代手挑值"的对照）。
    // 容差分开看：主色系 ≤ 10（肉眼不可辨）；fill / bar 是手挑值再叠一层派生，
    // 容许到 25 —— 但仍要守住"不能整块跑掉"（换个公式就超了）。
    const beforeDark: Record<string, string> = {
      '--primary': '#706af0',
      '--primary-hover': '#8b86f7',
      '--primary-soft': '#302f59',
      '--primary-bar': '#322f6c',
      '--primary-fill': '#4541a5',
      '--primary-fg': '#ffffff',
    }
    const tolerance: Record<string, number> = { '--primary-bar': 25, '--primary-fill': 25 }
    for (const [name, prev] of Object.entries(beforeDark)) {
      const now = rgbOf(dark[name as keyof AccentTokens])
      const then = rgbOf(prev)
      const delta = Math.max(Math.abs(now.r - then.r), Math.abs(now.g - then.g), Math.abs(now.b - then.b))
      expect(
        delta,
        `${name}: 派生值 ${dark[name as keyof AccentTokens]} 与旧值 ${prev} 相差 ${delta}`,
      ).toBeLessThanOrEqual(tolerance[name] ?? 10)
    }
  })

  it('亮色档品牌主色的对比度达到 AA（--primary 也当文本色用：链接 / 强调文字）', () => {
    for (const { name, color } of ACCENT_PRESETS) {
      const { '--primary': primary } = accentTokens(color, 'light')
      expect(
        contrastRatio(rgbOf(primary), rgbOf('#ffffff')),
        `预设「${name}」在白底上只有 ${contrastRatio(rgbOf(primary), rgbOf('#ffffff')).toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('主题色 —— 运行期注入（**色板之外**的任意颜色走这条路）', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-accent')
    document.getElementById('virlen-accent-color')?.remove()
  })

  it('注入的样式表带 --brand 与亮 / 暗两条规则，且选择器压得住主题里的默认块', () => {
    applyAccentColor('#0ea5e9')
    const el = document.getElementById('virlen-accent-color')
    expect(el).not.toBeNull()
    const css = el!.textContent ?? ''
    expect(css).toContain('--brand: #0ea5e9')
    expect(css).toContain(":root[data-theme='light']")
    expect(css).toContain(":root[data-theme='dark']")
    // 亮 / 暗必须都在：切主题时不该再重算一次（否则会有"先套旧色再纠正"的一帧）
    const light = accentTokens('#0ea5e9', 'light')
    const dark = accentTokens('#0ea5e9', 'dark')
    expect(css).toContain(`--primary: ${light['--primary']}`)
    expect(css).toContain(`--primary: ${dark['--primary']}`)
  })

  it('浅色也能用：注入的就是黑字那套', () => {
    applyAccentColor('#fde047')
    const css = document.getElementById('virlen-accent-color')!.textContent ?? ''
    expect(css).toContain('--primary-fg: #1a1a1a')
  })

  it('恢复默认（空串 / 非法值）会把覆盖样式整个删掉，回落到 theme.scss 的内置靛蓝', () => {
    applyAccentColor('#0ea5e9')
    expect(document.getElementById('virlen-accent-color')).not.toBeNull()
    applyAccentColor('')
    expect(document.getElementById('virlen-accent-color')).toBeNull()
    applyAccentColor('不是颜色')
    expect(document.getElementById('virlen-accent-color')).toBeNull()
  })

  it('反复改色只复用同一个 <style>，不会往 head 里堆一份又一份', () => {
    for (const c of ['#0ea5e9', '#e11d48', '#16a34a']) applyAccentColor(c)
    expect(document.querySelectorAll('#virlen-accent-color').length).toBe(1)
  })

  it('`accentStyleText` 只接受规范化后的颜色（非法值由 normalizeHex 拦下）', () => {
    expect(() => accentStyleText('rgb(1,2,3)')).toThrow()
    expect(accentStyleText('#ABC')).toContain('--brand: #aabbcc')
  })

  it('normalizeHex：支持 #abc / abc / #AABBCC，拒绝其它写法', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc')
    expect(normalizeHex('abc')).toBe('#aabbcc')
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('  #4f46e5 ')).toBe('#4f46e5')
    for (const bad of ['', '#', '#ab', '#abcd', '#12345', 'red', 'rgb(1,2,3)', '#gggggg']) {
      expect(normalizeHex(bad), bad).toBeNull()
    }
  })
})

describe('主题色 —— 「改一处漏一处」的守卫', () => {
  it('品牌底上不再有硬编码白字 / 白色图标（一律 var(--primary-fg)，浅色主题色才能自动转黑）', () => {
    const offenders: string[] = []
    for (const file of walkStyles(resolve(process.cwd(), 'src'))) {
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/)
      lines.forEach((line, i) => {
        // color: 与 fill: 都算：SVG 图标写死白色时，浅色主题色下同样看不见
        if (!/^\s*(color|fill):\s*(#fff\b|#ffffff\b|white\b)/.test(line)) return
        const ctx = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
        if (!/--accent-color|--primary|--btn-bg-primary|--accent-bg/.test(ctx)) return
        offenders.push(`${relative(process.cwd(), file).replace(/\\/g, '/')}:${i + 1} ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('不再有硬编码的靛蓝焦点环（旧 rgba(79, 70, 229, …)，换主题色时不会跟着变）', () => {
    const offenders: string[] = []
    for (const file of walkStyles(resolve(process.cwd(), 'src'))) {
      const src = stripComments(readFileSync(file, 'utf8'))
      if (/rgba?\(\s*79,\s*70,\s*229/.test(src)) {
        offenders.push(relative(process.cwd(), file).replace(/\\/g, '/'))
      }
    }
    expect(offenders).toEqual([])
  })

  it('标题栏前景走 --primary-bar-fg（否则浅色主题色下标题与图标看不见）', () => {
    expect(themeScss).toContain('--window-topbar-color: var(--primary-bar-fg)')
    const windowLayout = stripComments(readProjectFile('src/ui/layout/WindowLayout/WindowLayout.scss'))
    expect(windowLayout).toContain('fill: var(--primary-bar-fg)')
    expect(windowLayout).not.toMatch(/fill:\s*(white|#fff)/)
  })

  it('用户气泡的文字走 --primary-fg（聊天里最大的一块品牌色）', () => {
    const bubble = readProjectFile('src/ui/pages/chat/components/message/message-bubble.scss')
    expect(bubble).toContain('background: var(--btn-bg-primary, #4f46e5)')
    expect(bubble).toContain('color: var(--primary-fg)')
  })
})

describe('主题色 —— 预设色板走构建期那条路（零注入）', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-accent')
    document.getElementById('virlen-accent-color')?.remove()
  })

  it('选中预设 = 只切 <html data-accent>，不注入任何样式（令牌由 theme.scss 提供）', () => {
    for (const preset of ACCENT_PRESETS) {
      applyAccentColor(preset.color)
      expect(document.documentElement.getAttribute('data-accent')).toBe(preset.name)
      expect(document.getElementById('virlen-accent-color')).toBeNull()
    }
  })

  it('色板之外的任意色会先清掉 data-accent（否则静态块与注入值会打架）', () => {
    applyAccentColor('#2563eb') // 蓝：预设
    expect(document.documentElement.getAttribute('data-accent')).toBe('blue')

    applyAccentColor('#0ea5e9') // 天蓝：不在色板里
    expect(document.documentElement.getAttribute('data-accent')).toBeNull()
    expect(document.getElementById('virlen-accent-color')).not.toBeNull()
  })

  it('恢复默认：属性与覆盖样式都撤掉，回落到 theme.scss 的内置酭蓝', () => {
    applyAccentColor('#2563eb')
    applyAccentColor('')
    expect(document.documentElement.getAttribute('data-accent')).toBeNull()
    expect(document.getElementById('virlen-accent-color')).toBeNull()
  })
})
