/**
 * memory 列表弹窗的样式契约（表格化 + 筛选 + 分页）。
 *
 * 缺陷背景（本次 UI 优化的动机）：
 * ① 卡片式列表把结构化字段（分类 / 级别 / 记录日 / 来源日 / 使用次数）挤成一行行小标签，横向还空着一大片；
 * ② 每行都常驻 4 个操作按钮，正文被挤到角落；
 * ③ 列表常驻设置页，把开关 / 预算 / 整理这些设置项一路顶出视野。
 *
 * 改完之后的规则是：**紧凑表格**（小字号 + 单行省略 + 悬停看全文，一屏看更多）、
 * **行内不再有任何操作按钮**（动作走「点行编辑」+「勾选 + 批量栏」）、**列表只在弹窗里**、
 * 表头吸顶由「表格自己滚」保证；工具栏分两行 —— **两个下拉筛选在第二行左侧、批量栏常驻在右侧**
 * （未选中时按钮全禁用，选中才亮底）。
 *
 * 这些**全是纯 CSS / 布局行为** —— jsdom 不加载 scss，组件测试断言不到；样式被删掉时
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
/** 列表本体（表格 / 批量栏 / 分页）在弹窗组件里：设置页只留设置项 + 一个入口按钮 */
const listTsx = readProjectFile('src/ui/pages/Settings/memory/MemoryListModal.tsx')
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
 * 用完整选择器（`.memory-settings .memory-table .memory-cell-summary` 这种全路径）而不是后缀匹配：
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

describe('memory 列表弹窗 —— 表格 / 筛选 / 分页的样式契约', () => {
  it('前置：样式真的编译出来了（否则下面的断言会因"空产物"假通过）', () => {
    expect(css.length).toBeGreaterThan(500)
    expect(listTsx).toContain('memory-table')
  })

  it('列表只在弹窗里：表格 DOM 在弹窗组件，设置页只放一个入口按钮', () => {
    expect(tsx).toContain('MemoryListModal')
    expect(tsx).not.toContain('memory-table')
    expect(listTsx).toContain('memory-cell-summary')
  })

  it('行内不再有任何操作按钮（升级 / 降级 / 停用 / 删除全走批量栏）', () => {
    // 这条契约以前是「按钮默认隐形、悬停才显形」；现在按钮**根本不存在**了 ——
    // 用代码扫一遍比看样式更直接（样式没了组件测试也不会红）
    expect(listTsx).not.toContain('memory-item-actions')
    expect(listTsx).not.toContain('handleToggleLevel')
    expect(listTsx).not.toContain('handleDelete')
    // 编辑入口改成了「点整行」
    expect(listTsx).toContain('点击整行可编辑')
  })

  it('表格紧凑：小字号 + 单行省略（一屏看更多的关键）', () => {
    expect(decl(css, '.memory-settings .memory-table', 'font-size')).toBe('var(--font-size-xs)')
    expect(decl(css, '.memory-settings .memory-table', 'table-layout')).toBe('fixed')
    for (const [selector, prop, value] of [
      ['.memory-settings .memory-table th', 'text-overflow', 'ellipsis'],
      ['.memory-settings .memory-table td', 'text-overflow', 'ellipsis'],
      ['.memory-settings .memory-table th', 'white-space', 'nowrap'],
      ['.memory-settings .memory-table tbody tr', 'cursor', 'pointer'],
    ] as const) {
      expect(decl(css, selector, prop), `${selector} 缺少 ${prop}`).toBe(value)
    }
  })

  it('表格自己滚动 + 表头吸顶（模态框 body 交出滚动权，否则两段 sticky 会互相压住）', () => {
    expect(decl(css, '.memory-settings .memory-table-wrap', 'overflow')).toBe('auto')
    expect(decl(css, '.memory-settings .memory-table thead th', 'position')).toBe('sticky')
    expect(decl(css, '.memory-settings .memory-table thead th', 'top')).toBe('0')
    // 工具栏与批量栏在滚动区**外面**：批量栏必须在任何滚动位置都可见
    expect(decl(css, '.memory-settings .memory-toolbar', 'border-bottom')).toBeTruthy()
    // body 必须交出滚动权（选择器带 `.modal-content` 才能稳定压过 Modal 自带样式）
    expect(
      decl(css, '.memory-settings .modal-content.memory-list-modal .modal-body', 'overflow'),
    ).toBe('hidden')
    expect(
      decl(css, '.memory-settings .modal-content.memory-list-modal .modal-body', 'padding'),
    ).toBe('0')
  })

  it('工具栏第二行：左边两个下拉筛选 + 右边常驻的批量栏', () => {
    // 两个筛选下拉同住一行、都在左侧筛选组里；搜索与导出 / 新增留在第一行
    expect(decl(css, '.memory-settings .memory-toolbar .memory-action-row', 'display')).toBe('flex')
    expect(
      decl(css, '.memory-settings .memory-toolbar .memory-action-row .memory-filter-selects', 'display'),
    ).toBe('flex')
    // 下拉前面得有小字标签（共享 Select 本身不带标签，不写就不知道这两框筛的是什么）
    expect(
      decl(css, '.memory-settings .memory-toolbar .memory-action-row .memory-filter-label', 'color'),
    ).toBeTruthy()
    // 批量栏常驻（因此底色不能常驻，否则页面上永远挂着一块主色块），用 margin-left:auto 贴右
    expect(decl(css, '.memory-settings .memory-batch-bar', 'margin-left')).toBe('auto')
    expect(decl(css, '.memory-settings .memory-batch-bar.is-active', 'background')).toBeTruthy()
    // 组件侧：两个下拉与批量栏真的在第二行（结构对不上时样式再对也没用）
    expect(listTsx).toContain('memory-action-row')
    expect(listTsx).toContain('memory-filter-kind')
    expect(listTsx).toContain('memory-filter-level')
  })

  it('渲染时才出现的类名都有样式（选中行 / 停用行 / 复选框 / 批量栏 / 分页 / 筛选）', () => {
    for (const [selector, prop] of [
      ['.memory-settings .memory-table tbody tr.is-selected', 'background'],
      ['.memory-settings .memory-table tbody tr.is-off', 'opacity'],
      ['.memory-settings .memory-batch-bar.is-active', 'background'],
      ['.memory-settings .memory-batch-bar .memory-batch-count', 'font-weight'],
      ['.memory-settings .memory-check', 'accent-color'],
      ['.memory-settings .memory-table .memory-cell-state', 'color'],
      // 项目路径列（新字段）：也要有样式，否则会在表格里用默认色 / 默认宽度（一屏变窄）
      ['.memory-settings .memory-table .memory-cell-project', 'color'],
      ['.memory-settings .memory-table .memory-col-project', 'width'],
      // 编辑弹窗里的作用域输入框（只在 kind = project 时渲染）
      ['.memory-settings .memory-form .memory-form-scope .memory-form-path', 'border'],
      ['.memory-settings .memory-toolbar .memory-filter-row .memory-search', 'border'],
      ['.memory-settings .memory-pager .memory-pager-page', 'font-variant-numeric'],
    ] as const) {
      expect(decl(css, selector, prop), `${selector} 缺少 ${prop}`).toBeTruthy()
    }
  })

  it('分页控件在模态框 footer 里，且尺寸不被 Modal 的「大按钮」规则顶掉', () => {
    // Modal 的 `.modal-footer button` 是给「取消 / 确定」准备的（8px 20px）；分页是密集小控件。
    // 契约就用覆盖后的值：说明覆盖规则真的写下了（且选择器比 Modal 那条更具体）。
    expect(
      decl(css, '.memory-settings .modal-content.memory-list-modal .modal-footer button', 'padding'),
    ).toBe('4px 10px')
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
