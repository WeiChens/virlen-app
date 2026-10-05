/**
 * memory 面板「列表交互」的样式契约。
 *
 * 缺陷背景（本次 UI 优化的动机）：记忆列表**每条都常驻 4 个按钮**（编辑 / 升降级 / 停用 / 删除）
 * —— 记忆是「逐日变多」的数据，列表的常态是**读**，一排排按钮只会让正文被挤到角落；
 * 而真正高频的「清理一批」反而没有入口。
 *
 * 改完之后的规则是：行内操作**默认隐形**（悬停 / 键盘聚焦才显形），多选走复选框 + 吸顶批量栏。
 * 但这三件事**全是纯 CSS 行为** —— jsdom 不加载 scss，组件测试断言不到；样式被删掉时
 * 组件测试照样全绿（那就是"看起来在测"的假绿灯）。
 *
 * 所以这里用 `sass.compileString` 编译真实样式再断言，口径与 `phone-control-style-contract.test.ts`
 * 一致（用编译产物而不是正则扫源码：嵌套的 `&:hover` / `&.is-selected` 只有编译后才是真选择器）。
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

const scss = readProjectFile('src/ui/pages/Settings/memory-settings.scss')
const tsx = readProjectFile('src/ui/pages/Settings/memory-settings.tsx')
const css = sass.compileString(scss).css
/** 全局样式（`ui/App.tsx` 在入口处引入，全应用可见）：变量定义去这里查 */
const globalCss = [
  readProjectFile('src/ui/App.css'),
  readProjectFile('src/ui/styles/theme.css'),
].join('\n')

/**
 * 去掉块注释与行注释。
 *
 * 必需：注释里出现的变量名 / 表达式不该被当成「使用」或「定义」—— 本文件就踩过：
 * 修复说明里引用了旧写法，变量检查因之误报（scss 用的是 `//` 行注释，只剥块注释盖不到）。
 * 行注释的正则排除了 `://`，免得把 `url(http://…)` 里的协议头后半行吃掉。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 取「选择器列表里**恰好含有**该选择器」的规则体，再取某个声明的值（后写的覆盖先写的）。
 *
 * 用完整选择器（`.memory-settings .memory-item .memory-item-actions` 这种全路径）而不是后缀匹配：
 * 后缀匹配会让「另一条规则恰好也以它结尾」蒙混过关，契约就失效了。
 */
function decl(css: string, selector: string, prop: string): string | null {
  let value: string | null = null
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim())
    if (!selectors.includes(selector)) continue
    for (const part of rule[2].split(';')) {
      const i = part.indexOf(':')
      if (i < 0) continue
      if (part.slice(0, i).trim() === prop) value = part.slice(i + 1).trim()
    }
  }
  return value
}

describe('memory 面板 —— 列表交互的样式契约', () => {
  it('前置：样式真的编译出来了（否则下面的断言会因"空产物"假通过）', () => {
    expect(css.length).toBeGreaterThan(500)
    expect(tsx).toContain('memory-item-actions')
  })

  it('行内操作默认隐形（不是每条都挂着删除 / 停用），悬停或键盘聚焦才显形', () => {
    const hidden = '.memory-settings .memory-item .memory-item-actions'
    expect(decl(css, hidden, 'opacity')).toBe('0')
    // 隐形时也不能被点到：否则「移到按钮位置立刻点下去」会命中一个还看不见的按钮
    expect(decl(css, hidden, 'pointer-events')).toBe('none')

    // `:focus-within` 是给键盘留的生路（只靠 hover，键盘永远 Tab 不到这些按钮）
    for (const shown of [
      '.memory-settings .memory-item:hover .memory-item-actions',
      '.memory-settings .memory-item:focus-within .memory-item-actions',
    ]) {
      expect(decl(css, shown, 'opacity'), shown).toBe('1')
      expect(decl(css, shown, 'pointer-events'), shown).toBe('auto')
    }
  })

  it('批量栏吸顶：滚到列表底部勾选后也能就地操作', () => {
    expect(decl(css, '.memory-settings .memory-sticky', 'position')).toBe('sticky')
    expect(decl(css, '.memory-settings .memory-sticky', 'top')).toBe('0')
  })

  it('渲染时才出现的类名都有样式（选中行 / 批量栏 / 复选框 / 本区计数）', () => {
    for (const [selector, prop] of [
      ['.memory-settings .memory-item.is-selected', 'background'],
      ['.memory-settings .memory-batch-bar', 'background'],
      ['.memory-settings .memory-batch-bar .memory-batch-count', 'font-weight'],
      ['.memory-settings .memory-check', 'accent-color'],
      ['.memory-settings .memory-section .memory-section-title .memory-section-picked', 'color'],
    ] as const) {
      expect(decl(css, selector, prop), `${selector} 缺少 ${prop}`).toBeTruthy()
    }
  })

  it('用到的 CSS 变量都真的已定义（防「幽灵变量」静默降级为 fallback）', () => {
    const definedVars = new Set(
      [...stripComments(globalCss).matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]),
    )
    const usedVars = [
      ...new Set([...stripComments(scss).matchAll(/var\((--[a-zA-Z][\w-]*)/g)].map((m) => m[1])),
    ]
    expect(usedVars.length).toBeGreaterThan(5)
    expect(usedVars.filter((v) => !definedVars.has(v))).toEqual([])
  })
})
