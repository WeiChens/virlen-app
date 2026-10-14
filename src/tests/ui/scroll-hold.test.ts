/**
 * 「按住滚动偏移」状态机（message-list/scroll-hold.ts）
 *
 * 背景：气泡的「显示更多 / 收起」改了行高，而列表在贴底状态下有跟底语义 —— 条目尺寸变化会把
 * 「高度差」补偿进 scrollTop，展开一条超长消息时那笔补偿正好等于被展开出来的整块高度，
 * 结果就是阅读位置被甩到消息末尾。这里按住的正是那一类写入。
 *
 * 纯状态机（注入假时钟），三条边界：
 *  · 只拦「补偿类」写入（`adjustments` 非 0）：跳转 / 平滑滚动 / 贴底按钮都不带它，照常放行；
 *  · 拦下后要把「刚拦了一笔」标记交给 onChange 消费一次（库的内部偏移需要按回去）；
 *  · 窗口到点自愈，没松开也不会一直按住。
 */
import { describe, expect, it } from 'vitest'
import {
  SCROLL_HOLD_MS,
  createScrollHold,
} from '@/ui/pages/chat/components/message/message-list/scroll-hold'

/** 可推进的假时钟 */
function fakeClock(start = 1_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('scroll-hold', () => {
  it('按住期间返回按住的偏移；没按住过则是 null', () => {
    const clock = fakeClock()
    const hold = createScrollHold(clock.now)

    expect(hold.held()).toBeNull()
    hold.arm(1234)
    expect(hold.held()).toBe(1234)
    // 重复 arm = 以最新偏移重新按住（收起方向先自行滚动，再重新按住）
    hold.arm(5678)
    expect(hold.held()).toBe(5678)
  })

  it('只拦「尺寸补偿」那一类写入：带 adjustments 的才改写', () => {
    const clock = fakeClock()
    const hold = createScrollHold(clock.now)
    hold.arm(900)

    // 跳转 / 平滑滚动 / 贴底按钮都不带 adjustments（或为 0）→ 放行
    expect(hold.intercept(undefined)).toBeNull()
    expect(hold.intercept(0)).toBeNull()
    // 补偿 → 拦下，改成按住的偏移
    expect(hold.intercept(-3200)).toBe(900)
    expect(hold.intercept(250)).toBe(900)
  })

  it('拦下一笔后要消费一次（库的内部偏移得按回去），且只消费一次', () => {
    const clock = fakeClock()
    const hold = createScrollHold(clock.now)
    hold.arm(400)

    // 没拦过 → 没有要按回的
    expect(hold.consumeIntercepted()).toBeNull()

    expect(hold.intercept(8000)).toBe(400)
    expect(hold.consumeIntercepted()).toBe(400)
    // 第二次消费拿不到东西：一笔补偿只按回一次
    expect(hold.consumeIntercepted()).toBeNull()
  })

  it('拦住的是「当前」按住的偏移（重新按住后跟着变）', () => {
    const clock = fakeClock()
    const hold = createScrollHold(clock.now)
    hold.arm(100)
    expect(hold.intercept(50)).toBe(100)

    hold.arm(700)
    expect(hold.intercept(50)).toBe(700)
    expect(hold.consumeIntercepted()).toBe(700)
  })

  it('窗口到点自愈：过期后不再拦、也不再报「按住」', () => {
    const clock = fakeClock()
    const hold = createScrollHold(clock.now)
    hold.arm(300)
    expect(hold.held()).toBe(300)

    clock.advance(SCROLL_HOLD_MS - 1)
    expect(hold.held()).toBe(300)

    clock.advance(1)
    expect(hold.held()).toBeNull()
    expect(hold.intercept(999)).toBeNull()
    expect(hold.consumeIntercepted()).toBeNull()
  })
})
