/**
 * 代码主题契约：调色板（唯一色源）→ Monaco 主题 / CSS 变量。
 *
 * 守五件事：
 *  1. 每个主题都过可读性底线：正文 ≥ 4.5:1、注释 ≥ 3:1；暗色主题还要保证注释在**改动底色**上
 *     仍然看得见（历史缺陷：新增行的绿底上注释只有 1.31:1，等于没有字）；
 *  2. 差异底色必须是半透明源色（A=0x80）：Monaco 把选区画在改动底色下面，不透明就直接盖掉选区；
 *     差异选区的强化色只推一档 —— 它必须仍是“选区色”，而不是正文色（权重写反就成两姨）；
 *  3. 两个构建器（Monaco / CSS）必须从同一份调色板出值 —— 曾经的分叉表现为「流式 `<pre>` 底色
 *     #11111b、终态 Monaco #282c34」，消息结束时闪一下；
 *  4. 组件里不许再出现主题 id 字面量（`'virlen-dark'`）—— 一旦写死，设置页选了别的主题也不生效；
 *  5. 代码块容器高度 = Monaco 的内容高度（行数 × 行高 + 上下 padding）：多 1px 是一截多余底色，
 *     少 1px 就多出 1px 可滚范围 —— 「不需要滚动的高度，滚轮却能推开一点」。
 *
 * 为什么能直接 import：改造后主题数据在 `src/domain/code-display`（不引 monaco 运行时），
 * 不像旧的 `setupMonaco.ts` 那样「一进 jsdom 就崩」而只能读源码文本。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CODE_FONT_STACKS,
  CODE_LINE_HEIGHT_MAX,
  CODE_LINE_HEIGHT_MIN,
  CODE_PREVIEW_PADDING,
  CODE_THEMES,
  DEFAULT_CODE_DISPLAY_SETTINGS,
  buildCodeCssVars,
  buildMonacoThemeData,
  codeLineHeightPx,
  codePreviewHeight,
  diffHeadersOf,
  diffOf,
  resolveCodeDisplay,
  resolveCodeThemeId,
} from '@/domain/code-display'

const THEME_IDS = Object.keys(CODE_THEMES)

type Rgb = [number, number, number]

function parseColor(hex: string): [number, number, number, number] {
  const h = hex.slice(1)
  const at = (i: number): number =>
    Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return [at(0), at(1), at(2), h.length === 8 ? at(3) / 255 : 1]
}

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const [r, g, b] = parseColor(hex)
    .slice(0, 3)
    .map((v) => v / 255)
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 对比度 */
function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

/** CSS 合成口径：out = α × 上层 + (1 − α) × 底下那层 */
function over(top: string, bottom: Rgb): Rgb {
  const [r, g, b, a] = parseColor(top)
  return [
    Math.round(a * r + (1 - a) * bottom[0]),
    Math.round(a * g + (1 - a) * bottom[1]),
    Math.round(a * b + (1 - a) * bottom[2]),
  ]
}

const rgb = (hex: string): Rgb => parseColor(hex).slice(0, 3) as Rgb
const toHex = (c: Rgb): string =>
  '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

const HEX6 = /^#[0-9a-f]{6}$/
const HEX8 = /^#[0-9a-f]{6}([0-9a-f]{2})$/

describe('代码主题调色板', () => {
  it('内置至少 6 个主题，默认主题在其中', () => {
    expect(THEME_IDS.length).toBeGreaterThanOrEqual(6)
    expect(THEME_IDS).toContain(DEFAULT_CODE_DISPLAY_SETTINGS.codeThemeId)
    // 亮暗两档都有：设置页要能同时给出深色 / 浅色选择
    expect(THEME_IDS.some((id) => CODE_THEMES[id].kind === 'dark')).toBe(true)
    expect(THEME_IDS.some((id) => CODE_THEMES[id].kind === 'light')).toBe(true)
  })

  it.each(THEME_IDS)('%s：颜色字段齐全且都是 6 位十六进制', (id) => {
    const p = CODE_THEMES[id]
    const singles = [
      p.bg,
      p.fg,
      p.gutterBg,
      p.gutterFg,
      p.comment,
      p.string,
      p.number,
      p.keyword,
      p.type,
      p.func,
      p.variable,
      p.tag,
      p.operator,
      p.selection,
      p.lineHighlight,
      p.cursor,
      p.ui.lineNumberActive,
      p.ui.indentActive,
      p.ui.whitespace,
      p.ui.slider,
      p.ui.sliderHover,
      p.ui.sliderActive,
    ]
    const bad = singles.filter((c) => !HEX6.test(c))
    expect(bad).toEqual([])
    expect(p.label.length).toBeGreaterThan(0)
  })

  it.each(THEME_IDS)('%s：正文 ≥ 4.5:1、注释 ≥ 3:1', (id) => {
    const p = CODE_THEMES[id]
    expect({
      theme: id,
      body: contrast(p.fg, p.bg) >= 4.5,
    }).toMatchObject({ body: true })
    expect({
      theme: id,
      comment: contrast(p.comment, p.bg) >= 3,
      ratio: Number(contrast(p.comment, p.bg).toFixed(2)),
    }).toMatchObject({ comment: true })
  })

  it.each(THEME_IDS)('%s：差异底色是半透明源色，且真的染出了色', (id) => {
    const p = CODE_THEMES[id]
    const diff = diffOf(p)
    const bg = rgb(p.bg)
    for (const [name, source] of Object.entries(diff)) {
      const m = HEX8.exec(source)
      expect({ name, source, alpha: m?.[1] }).toMatchObject({ alpha: '80' })
      const composed = over(source, bg)
      // 与底色至少有一个通道差 ≥ 8：低于这个量级，改动行在视觉上等于没有底色
      const maxDelta = Math.max(
        ...composed.map((v, i) => Math.abs(v - bg[i])),
      )
      expect({ name, maxDelta, visible: maxDelta >= 8 }).toMatchObject({
        visible: true,
      })
    }
  })

  it.each(THEME_IDS)('%s：注释在改动底色上仍读得出来', (id) => {
    const p = CODE_THEMES[id]
    const diff = diffOf(p)
    const line = { old: rgb(toHex(over(diff.oldLine, rgb(p.bg)))), new: rgb(toHex(over(diff.newLine, rgb(p.bg)))) }
    // 字符级底色叠在自己那一行的行底色上（Monaco 就是这么两层叠的）
    const backdrops: [string, Rgb][] = [
      ['oldLine', line.old],
      ['newLine', line.new],
      ['oldChar', over(diff.oldChar, line.old)],
      ['newChar', over(diff.newChar, line.new)],
    ]
    /* 暗色主题守 3:1（历史缺陷就在这儿）；亮色档的改动底色本身是浅色薄涂，
       2.5:1 是「仍能辨认」的底线 —— 要求 4.5 会把亮色主题的注释压成近黑，反而失真。 */
    const min = p.kind === 'dark' ? 3 : 2.5
    for (const [name, backdrop] of backdrops) {
      const ratio = contrast(p.comment, toHex(backdrop))
      expect({
        theme: id,
        name,
        ratio: Number(ratio.toFixed(2)),
        ok: ratio >= min,
      }).toMatchObject({ ok: true })
    }
  })
})

describe('差异列头与选区（DOM 侧）', () => {
  it.each(THEME_IDS)('%s：列头文字在列头底色上过 AA', (id) => {
    const p = CODE_THEMES[id]
    const headers = diffHeadersOf(p)
    // 列头底色必须与正文底分得开（否则「原文件 / 新文件」那行在视觉上消失）
    expect(headers.oldBg).not.toBe(p.bg)
    expect(headers.newBg).not.toBe(p.bg)

    for (const [side, bg, fg] of [
      ['old', headers.oldBg, headers.oldFg],
      ['new', headers.newBg, headers.newFg],
    ] as const) {
      const ratio = contrast(fg, bg)
      expect({
        theme: id,
        side,
        ratio: Number(ratio.toFixed(2)),
        ok: ratio >= 4.5,
      }).toMatchObject({ ok: true })
    }
  })

  it('CSS 变量里带出四个列头令牌与选区强化色（列头以前写死在 SCSS 里，不跟主题）', () => {
    const p = CODE_THEMES['virlen-dark']
    const vars = buildCodeCssVars(p, {
      fontSize: 13,
      lineHeight: 1.5,
      fontFamily: CODE_FONT_STACKS.consolas,
    })
    const headers = diffHeadersOf(p)
    expect(vars['--diff-old-header-bg']).toBe(headers.oldBg)
    expect(vars['--diff-old-header-color']).toBe(headers.oldFg)
    expect(vars['--diff-new-header-bg']).toBe(headers.newBg)
    expect(vars['--diff-new-header-color']).toBe(headers.newFg)
  })

  it.each(THEME_IDS)(
    '%s：差异选区只推一档（不是正文色），且改动行上仍看得出',
    (id) => {
      const p = CODE_THEMES[id]
      const strong = buildCodeCssVars(p, {
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: CODE_FONT_STACKS.consolas,
      })['--code-selection-strong']
      expect({ theme: id, strong }).toMatchObject({ strong: expect.stringMatching(HEX6) })
      expect(strong).not.toBe(p.selection)

      // 方向：深色底往亮处推、浅色底只轻轻压一点
      // （真实缺陷：权重写反 → 深色主题一片浅灰 #939aa7、浅色主题一块近黑 #444f5d）
      const delta = luminance(strong) - luminance(p.selection)
      expect({ theme: id, dark: p.kind === 'dark', ok: p.kind === 'dark' ? delta > 0 : delta < 0 })
        .toMatchObject({ ok: true })

      // 但它必须离正文色够远：写反时它几乎等于正文字色，选中区域里的字就跟不上底色了
      const textRatio = contrast(p.fg, strong)
      expect({
        theme: id,
        ratio: Number(textRatio.toFixed(2)),
        ok: textRatio >= 3,
      }).toMatchObject({ ok: true })

      // 改动行上仍分得出“选中 / 未选中”：底色是半透明的，选区被它再叠一层
      const diff = diffOf(p)
      for (const [side, source] of [
        ['old', diff.oldLine],
        ['new', diff.newLine],
      ] as const) {
        const onBg = over(source, rgb(p.bg))
        const onSel = over(source, rgb(strong))
        const maxDelta = Math.max(
          ...onBg.map((v, i) => Math.abs(v - onSel[i])),
        )
        expect({ theme: id, side, maxDelta, ok: maxDelta >= 15 }).toMatchObject({
          ok: true,
        })
      }
    },
  )
})

describe('Monaco 主题构建器', () => {
  it.each(THEME_IDS)('%s：与调色板自洽（底色 / 行号区 / 差异六色）', (id) => {
    const p = CODE_THEMES[id]
    const data = buildMonacoThemeData(p)
    const diff = diffOf(p)

    expect(data.base).toBe(p.kind === 'dark' ? 'vs-dark' : 'vs')
    expect(data.colors['editor.background']).toBe(p.bg)
    expect(data.colors['editor.foreground']).toBe(p.fg)
    expect(data.colors['editorGutter.background']).toBe(p.gutterBg)
    expect(data.colors['editorLineNumber.foreground']).toBe(p.gutterFg)
    expect(data.colors['diffEditor.removedLineBackground']).toBe(diff.oldLine)
    expect(data.colors['diffEditor.insertedLineBackground']).toBe(diff.newLine)
    expect(data.colors['diffEditor.removedTextBackground']).toBe(diff.oldChar)
    expect(data.colors['diffEditor.insertedTextBackground']).toBe(diff.newChar)
    expect(data.colors['diffEditorGutter.removedLineBackground']).toBe(
      diff.oldNum,
    )
    expect(data.colors['diffEditorGutter.insertedLineBackground']).toBe(
      diff.newNum,
    )

    // 语义 token 一个都不能少：少一条就有一整类代码变回纯白 / 纯黑
    const tokens = new Set(data.rules.map((r) => r.token))
    for (const token of [
      'comment',
      'string',
      'number',
      'keyword',
      'type',
      'function',
      'variable',
      'tag',
      'operator',
      'diff.inserted',
      'diff.deleted',
    ]) {
      expect({ token, present: tokens.has(token) }).toMatchObject({
        present: true,
      })
    }

    // rules 里的前景色不带 `#`（Monaco 的约定），带上去会被静默忽略
    const badRules = data.rules
      .map((r) => r.foreground)
      .filter((c): c is string => c !== undefined && !/^[0-9a-f]{6}$/.test(c))
    expect(badRules).toEqual([])
  })
})

describe('CSS 变量构建器（DOM 侧同一份色源）', () => {
  it('字体参数原样透传，颜色取自调色板', () => {
    const p = CODE_THEMES['virlen-dark']
    const vars = buildCodeCssVars(p, {
      fontSize: 15,
      lineHeight: 1.7,
      fontFamily: CODE_FONT_STACKS.jetbrains,
    })
    expect(vars['--code-body-bg']).toBe(p.bg)
    expect(vars['--code-body-color']).toBe(p.fg)
    expect(vars['--code-font-size']).toBe('15px')
    expect(vars['--code-line-height']).toBe('1.7')
    expect(vars['--code-font-family']).toBe(CODE_FONT_STACKS.jetbrains)
    // 头栏与正文面必须分得开，否则「头栏」在视觉上消失
    expect(vars['--code-header-bg']).not.toBe(p.bg)
  })

  it('--diff-* 与 Monaco 的六个差异色逐值相同（两套界面不许分叉）', () => {
    for (const id of THEME_IDS) {
      const p = CODE_THEMES[id]
      const vars = buildCodeCssVars(p, {
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: CODE_FONT_STACKS.consolas,
      })
      const colors = buildMonacoThemeData(p).colors
      expect(vars['--diff-old-line-bg']).toBe(
        colors['diffEditor.removedLineBackground'],
      )
      expect(vars['--diff-new-line-bg']).toBe(
        colors['diffEditor.insertedLineBackground'],
      )
      expect(vars['--diff-old-linenum-bg']).toBe(
        colors['diffEditorGutter.removedLineBackground'],
      )
      expect(vars['--diff-new-linenum-bg']).toBe(
        colors['diffEditorGutter.insertedLineBackground'],
      )
    }
  })
})

describe('解析层', () => {
  it('默认值 = 改造前的外观（升级零感知）', () => {
    expect(DEFAULT_CODE_DISPLAY_SETTINGS).toMatchObject({
      codeThemeMode: 'fixed',
      codeThemeId: 'virlen-dark',
      codeFontSize: 13,
      codeFontFamily: 'consolas',
      codeLineHeight: 1.5,
      codeFontLigatures: false,
      codeShowLineNumbers: true,
    })
    const resolved = resolveCodeDisplay(DEFAULT_CODE_DISPLAY_SETTINGS, 'light')
    expect(resolved.themeId).toBe('virlen-dark')
    expect(resolved.fontSize).toBe(13)
    expect(resolved.lineHeightPx).toBe(codeLineHeightPx(13, 1.5))
    expect(resolved.fontFamily).toBe(CODE_FONT_STACKS.consolas)
  })

  it('越界 / 脏数据都回落到可用值（绝不把 NaN 递给 Monaco）', () => {
    expect(resolveCodeDisplay({ codeFontSize: 4 }, 'dark').fontSize).toBe(
      CODE_FONT_SIZE_MIN,
    )
    expect(resolveCodeDisplay({ codeFontSize: 99 }, 'dark').fontSize).toBe(
      CODE_FONT_SIZE_MAX,
    )
    expect(
      resolveCodeDisplay({ codeFontSize: Number.NaN }, 'dark').fontSize,
    ).toBe(DEFAULT_CODE_DISPLAY_SETTINGS.codeFontSize)
    expect(
      resolveCodeDisplay({ codeLineHeight: 0.2 }, 'dark').lineHeight,
    ).toBe(CODE_LINE_HEIGHT_MIN)
    expect(resolveCodeDisplay({ codeLineHeight: 9 }, 'dark').lineHeight).toBe(
      CODE_LINE_HEIGHT_MAX,
    )
    // 未知 id 一律回落（设置里存了旧 id / 手改坏了都不该白屏）
    expect(resolveCodeDisplay({ codeFontFamily: 'nope' }, 'dark').fontFamily).toBe(
      CODE_FONT_STACKS.consolas,
    )
    expect(resolveCodeDisplay({ codeThemeId: 'nope' }, 'dark').themeId).toBe(
      'virlen-dark',
    )
  })

  it('follow 档按应用亮暗自动选主题；fixed 档保持所选', () => {
    expect(resolveCodeThemeId({ codeThemeMode: 'follow' }, 'light')).toBe(
      'virlen-light',
    )
    expect(resolveCodeThemeId({ codeThemeMode: 'follow' }, 'dark')).toBe(
      'virlen-dark',
    )
    expect(
      resolveCodeThemeId(
        { codeThemeMode: 'fixed', codeThemeId: 'monokai' },
        'light',
      ),
    ).toBe('monokai')
  })

  it('行高像素值：不低于字号 + 2，且随倍率单调增', () => {
    for (const size of [CODE_FONT_SIZE_MIN, 13, CODE_FONT_SIZE_MAX]) {
      expect(codeLineHeightPx(size, CODE_LINE_HEIGHT_MIN)).toBeGreaterThanOrEqual(
        size + 2,
      )
      expect(codeLineHeightPx(size, CODE_LINE_HEIGHT_MAX)).toBeGreaterThan(
        codeLineHeightPx(size, CODE_LINE_HEIGHT_MIN),
      )
    }
  })

  it('每个字族都以 monospace 兜底（缺字体时不至于掉成衬线体）', () => {
    for (const [id, stack] of Object.entries(CODE_FONT_STACKS)) {
      expect({ id, ok: /monospace$/.test(stack) }).toMatchObject({ ok: true })
    }
  })

  /**
   * 代码块容器高度契约（「不需要滚动的高度，滚轮却能推开一点」的回归）。
   *
   * Monaco 的内容高度 = 行数 × 行高 + 上下 padding（0.56 `linesLayout.js::getLinesTotalHeight`）；
   * 容器彼它矮 1px 就多出 1px 可滚范围（`scrollbar.vertical: 'hidden'` 下没滚动条，滚轮照样能滚），
   * 高出来则是多余底色。所以「容器高度 == 内容高度」是条等式，必须逐像素对得上。
   */
  it('代码块高度 = Monaco 内容高度（行数 × 行高 + 上下 padding）', () => {
    expect(CODE_PREVIEW_PADDING).toMatchObject({ top: 12, bottom: 12 })
    for (const lines of [1, 2, 12, 400]) {
      for (const size of [CODE_FONT_SIZE_MIN, 13, CODE_FONT_SIZE_MAX]) {
        for (const ratio of [CODE_LINE_HEIGHT_MIN, 1.5, CODE_LINE_HEIGHT_MAX]) {
          const lh = codeLineHeightPx(size, ratio)
          expect(codePreviewHeight(lines, lh)).toBe(
            lines * lh + CODE_PREVIEW_PADDING.top + CODE_PREVIEW_PADDING.bottom,
          )
        }
      }
    }
  })

  it('旧的 `5 + (行数 + 1) × 行高` 估算在小行高下会矮几像素（那几像素就是「滚一点」）', () => {
    const old = (lines: number, lh: number): number =>
      Math.max(lh + 16, 5 + (lines + 1) * lh)
    // 字号 11 + 行高 1.2 → 行高 13：旧公式矮 6px —— 容器少 6px，Monaco 就多出 6px 可滚范围
    const small = codeLineHeightPx(CODE_FONT_SIZE_MIN, CODE_LINE_HEIGHT_MIN)
    expect(old(10, small) - codePreviewHeight(10, small)).toBe(-6)
    // 默认字号（行高 20）下它只是「多凑了 1px」（一截多余底色），所以这个坑改小字号 / 行高后才露出来
    expect(old(10, 20) - codePreviewHeight(10, 20)).toBe(1)
  })
})

/* ============================================================================
 * 源码扫描：主题 id 只许出现在域层
 * ========================================================================= */

const UI_ROOT = resolve(process.cwd(), 'src/ui')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** 去掉注释：注释里提到旧写法（`theme="virlen-dark"`）不该算违规 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('主题 id 的硬编码防线', () => {
  it('src/ui 下的代码里不允许出现主题 id 字面量（组件一律跟着设置走）', () => {
    const offenders: string[] = []
    for (const file of walk(UI_ROOT)) {
      if (!/\.tsx?$/.test(file)) continue
      const src = stripComments(readFileSync(file, 'utf8'))
      if (/['"]virlen-dark['"]/.test(src)) {
        offenders.push(relative(process.cwd(), file))
      }
    }
    expect(offenders).toEqual([])
    // 正向对照：域层确实写着这个 id，说明扫描不是空跑
    expect(
      readFileSync('src/domain/code-display/themes.ts', 'utf8'),
    ).toContain("'virlen-dark'")
  })
})
