import { describe, expect, it } from 'vitest'
import { navDelta, wrapIndex } from '@/ui/components/shared/keyboardNav'

/**
 * 弹窗键盘导航的「按键 → 往第几项走」规则。
 *
 * 需求原文：enter 确定、esc 取消、tab 切换项、上下左右切换项。
 * 这里钉住的正是「Tab 与方向键等价」这条约定 —— 一旦有人把 ↑ 的方向改反，
 * 或让 Tab 带上 shiftKey 之外的区别，会先在这里炸。
 */
describe('navDelta — 按键的移动意图', () => {
  it('↓ / → 是下一项，↑ / ← 是上一项', () => {
    expect(navDelta('ArrowDown')).toBe(1)
    expect(navDelta('ArrowRight')).toBe(1)
    expect(navDelta('ArrowUp')).toBe(-1)
    expect(navDelta('ArrowLeft')).toBe(-1)
  })

  it('Tab 与方向键等价：Tab 下一项、Shift+Tab 上一项', () => {
    expect(navDelta('Tab')).toBe(1)
    expect(navDelta('Tab', true)).toBe(-1)
  })

  it('确定 / 取消 / 普通字符不算「切换项」（shift 也不影响方向键）', () => {
    expect(navDelta('Enter')).toBe(0)
    expect(navDelta('Escape')).toBe(0)
    expect(navDelta('a')).toBe(0)
    expect(navDelta('ArrowDown', true)).toBe(1)
  })
})

describe('wrapIndex — 环形移动', () => {
  it('在范围内前后移动', () => {
    expect(wrapIndex(0, 1, 3)).toBe(1)
    expect(wrapIndex(2, -1, 3)).toBe(1)
  })

  it('首尾相接（最后一项 ↓ 回到第一项、第一项 ↑ 去最后一项）', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0)
    expect(wrapIndex(0, -1, 3)).toBe(2)
  })

  it('焦点不在列表内（-1：停在弹窗容器上）时，前进取第一项、后退取最后一项', () => {
    expect(wrapIndex(-1, 1, 3)).toBe(0)
    expect(wrapIndex(-1, -1, 3)).toBe(2)
  })

  it('越界的下标同样按「不在列表内」处理，且空列表返回 -1', () => {
    expect(wrapIndex(9, 1, 3)).toBe(0)
    expect(wrapIndex(0, 1, 0)).toBe(-1)
  })
})
