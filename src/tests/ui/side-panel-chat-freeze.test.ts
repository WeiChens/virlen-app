/**
 * 右侧栏过渡期的「消息列表宽度钉扎」（`side-panel/chat-freeze.ts`）。
 *
 * 这件事的目的只有一个：**过渡里不折行**。面板宽度一动，同一行的聊天区（`flex: 1`）每帧
 * 跟着变，消息列表的每一行都要重新排版 —— 逐行 `ResizeObserver` 连发实测 + 虚拟滚动按行高差
 * 补偿 `scrollTop`，观感就是「面板一边滑、内容一边抖」，长会话还掉帧。
 *
 * 所以钉四条口径：
 * ① 终值只用**真实布局**算（容器右边界 − 面板终宽 − 聊天区左缘），不拿取整过的 state 去减；
 * ② 挂在 `.chat-main` 上（变量只往下流进列内，面板里的树 / 终端不受牵连）；
 * ③ 过渡窗口一过自己摘掉，被下一次过渡打断时立即重钉（摘 + 设在同一帧里完成）；
 * ④ 聊天区量不到时（占满态 / 刚退出占满态那一帧）用调用方记下的左缘兜底 —— 那一帧最该钉；
 *    两样都没有才不动。
 */
import { afterEach, expect, it, vi } from 'vitest'

import {
  CHAT_FREEZE_VAR,
  PANEL_WIDTH_MOTION_MS,
  freezeChatWidth,
} from '@/ui/pages/chat/components/side-panel/chat-freeze'

/** 只喂 `getBoundingClientRect` 的最小布局：`.chat-view`(容器) > `.chat-main` + 面板 */
function mountLayout(opts: {
  available: number
  inset: number
  mainWidth?: number
  /** 聊天区高度：`display: none`（占满态）时是真浏览器的全 0 */
  mainHeight?: number
}) {
  const { available, inset, mainWidth = available, mainHeight = 800 } = opts
  const host = document.createElement('div')
  const main = document.createElement('div')
  const panel = document.createElement('div')
  host.append(main, panel)
  document.body.append(host)
  // 容器右边界 = 左缘留白 + 可用宽度；聊天区左缘 = 左侧栏 + 分隔条占掉的那段
  host.getBoundingClientRect = () => rect(0, inset + available)
  main.getBoundingClientRect = () => rect(inset, mainWidth, mainHeight)
  return { host, main, panel }
}

function rect(left: number, width: number, height = 800): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: height,
    height,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

const frozen = (el: HTMLElement) => el.style.getPropertyValue(CHAT_FREEZE_VAR)

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

it('终值 = 容器右边界 − 面板终宽 − 聊天区左缘（不经过取整过的可用宽度 state）', () => {
  const { main } = mountLayout({ available: 1200, inset: 260 })
  freezeChatWidth(main, 450)
  // (260 + 1200) − 450 − 260 = 750
  expect(frozen(main)).toBe('750px')
})

it('摘锁函数立刻把变量拿掉（过渡被打断时不能留着旧宽度）', () => {
  const { main } = mountLayout({ available: 1200, inset: 260 })
  const release = freezeChatWidth(main, 600)
  expect(frozen(main)).toBe('600px')

  release()
  expect(frozen(main)).toBe('')
  // 幂等：重复调不会报错，也不会把新钉的值误删（这里只是再摘一次）
  release()
  expect(frozen(main)).toBe('')
})

it('过渡窗口一过自己摘掉：过渡还没跑完时仍在，窗口过后清空', () => {
  vi.useFakeTimers()
  const { main } = mountLayout({ available: 1000, inset: 200 })
  freezeChatWidth(main, 500)

  // 过渡本身还没结束（200ms）不能提前放开，否则最后几帧又要折行
  vi.advanceTimersByTime(PANEL_WIDTH_MOTION_MS)
  expect(frozen(main)).toBe('500px')

  // 剩下的余量（等宿主把聊天区放回来）走完就自己摘（余量值变了也不用改这条）
  vi.advanceTimersToNextTimer()
  expect(frozen(main)).toBe('')
})

it('退出占满态（全屏 → 半屏）那一帧：宽度还是 0，也要钉（否则它从 0 一路涨、每帧折一次行）', () => {
  // 面板还占着整块可用宽度 → 聊天区宽度 0，但左缘与高度都有效
  const { main } = mountLayout({ available: 1200, inset: 260, mainWidth: 0 })
  freezeChatWidth(main, 600)
  // (260 + 1200) − 600 − 260 = 600
  expect(frozen(main)).toBe('600px')
})

it('聊天区还被宿主藏着（display: none，矩形全 0）时，用上次记下的左缘兜底——这一帧才最该钉', () => {
  // 退出占满态那一帧的真实情形：宿主把 `.chat-main` 放回来晚一拍，面板已经开始往半屏走了
  const { main } = mountLayout({ available: 1200, inset: 260, mainWidth: 0, mainHeight: 0 })
  freezeChatWidth(main, 600, 260)
  // 1460（容器宽）− 260（兜底左缘）− 600 = 600
  expect(frozen(main)).toBe('600px')
})

it('既量不到左缘、又没有兜底值时不动（拿 0 凑数会把宽度钉宽一个左侧栏）', () => {
  const { main } = mountLayout({ available: 500, inset: 260, mainWidth: 0, mainHeight: 0 })
  const release = freezeChatWidth(main, 500)
  expect(frozen(main)).toBe('')
  expect(() => release()).not.toThrow()
})

it('没有宿主（游离节点）时是空操作', () => {
  const detached = document.createElement('div')
  freezeChatWidth(detached, 100)
  expect(frozen(detached)).toBe('')
  expect(() => freezeChatWidth(null, 100)).not.toThrow()
})
