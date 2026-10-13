/**
 * ContextMenu（全应用唯一一份右键菜单）的层级契约。
 *
 * 背景：菜单的 z-index 是「跟别的浮层比出来」的值，写低了不报错，只会在某个场景下**静默被盖住**。
 * 真踩过的两次：
 *   ① Modal 从 800 调到 1300 之后，弹窗里的右键菜单（「导入知识库」的消息列表）整个被遮罩挡住；
 *   ② 全屏代码块浮层 500 —— 菜单写低就点不到。
 * 所以这里跨文件取**真实值**做序关系断言（不写死数字）：以后谁再调 Modal / Toast，这里都会跟着守住。
 *
 * jsdom 不跑 scss，这类问题在组件测试里完全看不见（口径同 shared-font-size-contract）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  return readFileSync(p, 'utf8')
}

/** 编译 scss 并取指定选择器上的 z-index（先摘掉 @charset，否则会并进首条选择器） */
function zIndexOf(file: string, selector: string): number {
  const css = sass
    .compileString(readProjectFile(file))
    .css.replace(/@charset\s+"[^"]*";/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
    if (!selectors.includes(selector)) continue
    const hit = m[2].match(/(?:^|;)\s*z-index:\s*(\d+)/)
    if (hit) return Number(hit[1])
  }
  throw new Error(`${file} 里没找到 ${selector} 的 z-index`)
}

const MENU = zIndexOf('src/ui/components/shared/ContextMenu/style.scss', '.context-menu')
const MODAL = zIndexOf('src/ui/components/shared/Modal/style.scss', '.modal-overlay')
const TOAST = zIndexOf(
  'src/ui/components/shared/Toast/style.module.scss',
  '.toast-view',
)
const FULLSCREEN = zIndexOf(
  'src/ui/pages/chat/components/message/code-block.scss',
  '.code-block-fullscreen-layer',
)

describe('ContextMenu：与其它浮层的层级序关系', () => {
  it('高于 Modal 遮罩 —— 弹窗里的右键菜单不该被盖住', () => {
    expect(MENU).toBeGreaterThan(MODAL)
  })

  it('高于全屏代码块浮层 —— 终端 / 代码块里也要能右键', () => {
    expect(MENU).toBeGreaterThan(FULLSCREEN)
  })

  it('低于 Toast —— 提示不能被菜单压住', () => {
    expect(MENU).toBeLessThan(TOAST)
  })
})
