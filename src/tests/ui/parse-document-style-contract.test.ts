/**
 * parse_document 多文档下拉的样式契约（紧凑 ghost 触发器 / 宽度跟内容走 / 不回写共享 Select）。
 *
 * 缺陷背景（本次 UI 优化的动机）：多份文档原先各堆一张卡，改为「一张卡 + 文件名下拉切换」
 * （与 read_file 的多文件同款）后，共享 Select 直接放进卡片头部条会出两个问题：
 *   ① 它默认 `min-height: 2.6em`（medium 下 34px），而头部条含内边距只有 ~29px ——
 *      控件比整条还高，头部被撑高一档，与同排的徽标不在一条线上；
 *   ② 托盘式外观（边框 + 输入框底色）把「文件名」这个视觉焦点变成一个表单控件。
 *
 * 改法：只在调用方这一层加 `.custom-select.doc-file-switcher` 覆盖 —— 压扁（缩到共享值之下）、
 * ghost（无边框 / 透明底，hover 与展开才浮一层底色）、文件名加粗 + 省略号、
 * 宽度跟内容走（短名旁不留空框）且封顶（长路径不把徽标挤到换行）。共享 Select 一个字节不改。
 *
 * 这些都是**纯 CSS / 布局**问题：jsdom 不加载 scss、也量不到布局，组件测试断言不到；样式被删掉时
 * 组件测试照样全绿（"看起来在测"的假绿灯）。所以这里用 `sass.compileString` 编译真实样式再断言，
 * 口径与 `read-file-style-contract.test.ts` / `memory-settings-style-contract.test.ts` 一致。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

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

/** 多文档下拉的触发器类名（面板没有换肤，沿用共享 Select 的浅色皮肤 —— 卡片头部本来就是浅色） */
const SWITCHER = '.custom-select.doc-file-switcher'
/** 共享组件的两个基准：默认高度与被覆盖的字号规则 */
const BASE = '.custom-select'
const BASE_VALUE = '.custom-select .custom-select__value'

const TOOL_CALL_SCSS = 'src/ui/pages/chat/components/tool-call/style.scss'
const SELECT_SCSS = 'src/ui/components/shared/Select/style.scss'
const parseDocTsx = readProjectFile(
  'src/ui/pages/chat/components/tool-call/ParseDocumentMessage.tsx',
)
const toolCallCss = sass
  .compileString(readProjectFile(TOOL_CALL_SCSS))
  .css.replace(/@charset\s+"[^"]*";/g, '')
const selectCss = sass
  .compileString(readProjectFile(SELECT_SCSS))
  .css.replace(/@charset\s+"[^"]*";/g, '')
const themeCss = sass
  .compileString(readProjectFile('src/ui/styles/theme.scss'))
  .css.replace(/@charset\s+"[^"]*";/g, '')
/** 全局样式（`ui/App.tsx` 在入口处引入）：变量定义去这里查（theme.scss 必须编译后再查） */
const globalCss = [readProjectFile('src/ui/App.css'), themeCss].join('\n')

describe('多文档下拉 —— 压扁的 ghost 触发器（不把卡片头部撑高）', () => {
  it('前置：样式真的编译出来了，且调用方真的挂了类名', () => {
    expect(toolCallCss.length).toBeGreaterThan(5000)
    expect(selectCss.length).toBeGreaterThan(500)
    expect(parseDocTsx).toContain('className="doc-file-switcher"')
  })

  it('比共享 Select 矮一档：头部条不被控件撑高', () => {
    // 前提：共享组件的高度确实是那条「会把头部撑高」的值（它变了这条契约要重看）
    const base = decl(selectCss, BASE, 'min-height')
    const compact = decl(toolCallCss, SWITCHER, 'min-height')
    expect(base).toBeTruthy()
    expect(compact).toBeTruthy()
    expect(Number.parseFloat(compact!)).toBeLessThan(Number.parseFloat(base!))
    // min-height 用的是 em：本体字号必须同时钉住，否则 em 会按继承字号算
    expect(decl(toolCallCss, SWITCHER, 'font-size')).toBe('var(--font-size-sm)')
  })

  it('ghost：无边框 / 透明底，hover 与展开才浮一层底色（不用品牌色）', () => {
    expect(decl(toolCallCss, SWITCHER, 'border-color')).toBe('transparent')
    expect(decl(toolCallCss, SWITCHER, 'background')).toBe('transparent')
    for (const sel of [
      `${SWITCHER}:hover`,
      `${SWITCHER}:focus-visible`,
      `${SWITCHER}.is-open`,
    ]) {
      expect(decl(toolCallCss, sel, 'background'), `${sel} 缺少底色`).toBe(
        'var(--hover-bg, #f0f0f0)',
      )
      // 默认那圈 focus-shadow 是给独立控件的，紧凑头部条里会顶出一道边
      expect(decl(toolCallCss, sel, 'box-shadow')).toBe('none')
    }
  })

  it('文件名仍是视觉焦点：加粗 + 单行省略；宽度跟内容走但有上限', () => {
    expect(decl(toolCallCss, `${SWITCHER} .custom-select__value`, 'font-weight')).toBe('600')
    expect(decl(toolCallCss, `${SWITCHER} .custom-select__value`, 'font-size')).toBe(
      'var(--font-size-sm)',
    )
    // 省略号来自共享组件的规则（这里只钉住前提：它还在）
    expect(decl(selectCss, BASE_VALUE, 'white-space')).toBe('nowrap')
    expect(decl(selectCss, BASE_VALUE, 'text-overflow')).toBe('ellipsis')
    // 不主动加宽（短名旁留一大块空框很难看），空间不够时可缩
    expect(decl(toolCallCss, SWITCHER, 'flex')).toBe('0 1 auto')
    expect(decl(toolCallCss, SWITCHER, 'min-width')).toBe('0')
    // 封顶：再长的路径也不该把同排的徽标挤到换行（完整路径在面板里看）
    expect(decl(toolCallCss, SWITCHER, 'max-width')).toBe('min(420px, 60%)')
  })

  it('长路径的面板按内容撑开（不靠触发器那点宽度折行）', () => {
    expect(parseDocTsx).toContain('dropdownWidth="content"')
  })

  it('用到的变量都在全局样式里有定义（防幽灵变量静默降级为兜底值）', () => {
    const definedVars = new Set(
      [...stripComments(globalCss).matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]),
    )
    for (const v of ['--font-size-sm', '--hover-bg']) {
      expect(definedVars.has(v), `全局样式里没有定义 ${v}`).toBe(true)
    }
  })
})
