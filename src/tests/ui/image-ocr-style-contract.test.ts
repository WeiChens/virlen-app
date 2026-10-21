/**
 * 图片预览 OCR 文字层的「样式契约」。
 *
 * 为什么需要这个文件：jsdom 不加载 scss，`image-ocr-layer.test.tsx` 那套 DOM 用例
 * **看不见样式**——把这行 clip 改回 `overflow: visible` 照样全绿，而用户一眼就能看出不对。
 * 口径与 `shared-font-size-contract.test.ts` / `memory-settings-style-contract.test.ts` 一致：
 * 用 `sass.compile` 编译真实样式再断言。
 *
 * 缺陷背景（本次修复的动机）：**拖选出来的蓝色高亮比 hover 的蓝色高一截**。
 * 原因：浏览器画选区高亮走的是**字形上下沿**（ascent + descent ≈ 1.15em），
 * 而这一行文字所在的盒子是 `height` = OCR det 框高、`line-height: 1`（= 1em），
 * 于是高亮上下各溢出一截，看上去「选中的蓝色区域比 hover 的蓝色区域高」。
 * 修法：`.image-ocr-run` 用 `overflow: hidden` 把高亮裁回框内 ——
 * 这样 hover / 选区 / det 框是同一个矩形，三种视觉反馈口径一致。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

const STYLE_PATH = 'src/ui/components/shared/ImageOcr/style.scss'

/** 编译出来的 CSS（sass 会展开嵌套，规则都是平铺的，可以直接按选择器取值） */
const css = sass.compile(resolve(process.cwd(), STYLE_PATH)).css

/** 取某条规则的声明块（找不到就报错，避免「选择器改名后静默通过」） */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`${STYLE_PATH} 里找不到 ${selector}`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('OCR 文字层：hover / 选区 / det 框必须一样大', () => {
  it('.image-ocr-run 必须裁掉溢出（否则选区高亮比框高一截）', () => {
    const block = rule('.image-ocr-run')
    expect(block).toMatch(/overflow:\s*hidden/)
    // 反面：溢出是这次缺陷的成因，不能再改回 visible
    expect(block).not.toMatch(/overflow:\s*visible/)
  })

  it('这一行的盒子就是框本身：字号取 --ocr-line、行高 1（几何量，不跟字体设置走）', () => {
    const block = rule('.image-ocr-run')
    expect(block).toMatch(/font-size:\s*var\(--ocr-line\)/)
    expect(block).toMatch(/line-height:\s*1(;|\s)/)
    // 文字透明：看得见的只有高亮（压在图上真实文字上，不必重画一遍）
    expect(block).toMatch(/color:\s*transparent/)
  })

  it('hover 与 ::selection 都在同一个盒子上染色（同一矩形、只是浓度不同）', () => {
    expect(rule('.image-ocr-run:hover')).toMatch(/background:\s*rgba\(/)
    const selection = rule('.image-ocr-run::selection')
    expect(selection).toMatch(/background:\s*rgba\(/)
    expect(selection).toMatch(/color:\s*transparent/)
  })
})

describe('OCR 文字层：其余口径', () => {
  it('层本身不吃事件（空白处的拖动 / 滚轮缩放照旧给图片）', () => {
    expect(rule('.image-ocr-layer')).toMatch(/pointer-events:\s*none/)
    // 但必须能选中、能复制
    expect(rule('.image-ocr-layer')).toMatch(/user-select:\s*text/)
  })

  it('文字行自己吃事件（文字上拖动 = 选中，不是平移图片）', () => {
    expect(rule('.image-ocr-run')).toMatch(/pointer-events:\s*auto/)
  })

  it('字号唯一例外用几何单位，不写 px', () => {
    // 见 style.scss 顶部注释：这一处字号是几何量（--ocr-line = cqh/cqw）
    expect(rule('.image-ocr-run')).not.toMatch(/font-size:\s*\d+px/)
  })
})
