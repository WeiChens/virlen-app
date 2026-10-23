/**
 * 会话内待应答卡片的**挂载位置**契约（源码级）。
 *
 * 卡片属于这段对话的结尾，必须挂在消息滚动容器**里面**、虚拟列表（`.vm-list`）之后 ——
 * 跟着消息一起滚。挂到列表外面（输入框上方）会永久占掉一截高度，多张时聊天区被挤没。
 *
 * jsdom 里没有布局，挂真组件验不出「在不在滚动容器里」；这里按源码顺序钉死（与样式契约同一手法）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const listSrc = read('src/ui/pages/chat/components/message/message-list.tsx')
const chatSrc = read('src/ui/pages/chat/chat-view.tsx')

describe('行内交互卡片挂在哪', () => {
  it('footer 在滚动容器内、虚拟列表之后（不在容器外面）', () => {
    const vmList = listSrc.indexOf('className="vm-list"')
    const footer = listSrc.indexOf('{footer}')
    // 锚点列表与「滚动到底部」按钮都渲染在滚动容器**外面**，拿它当右边界
    const afterContainer = listSrc.indexOf('m.anchorUsers.length > 1')

    expect(vmList).toBeGreaterThan(-1)
    expect(footer).toBeGreaterThan(vmList)
    expect(afterContainer).toBeGreaterThan(footer)
  })

  it('聊天页把卡片作为 footer 传进去（而不是当兄弟节点渲染）', () => {
    expect(chatSrc).toContain('footer={inlineUI}')
  })
})
