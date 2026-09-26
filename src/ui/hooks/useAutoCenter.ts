import { useEffect, useRef } from 'react'

/**
 * 「打开即居中」—— 用户主动展开某块内容后，把它滚动到滚动容器的可视区中间。
 *
 * 触发语义（只对「用户主动打开」负责）：
 *   - `open` 由 false → true（用户点击展开）→ 居中一次；
 *   - 组件在 `open` 已为 true 时挂载 → 也居中一次。这批调用点的内容只有用户点开时才会挂载
 *     （折叠时 `getExpandView` 返回 null；虚拟列表重挂载会把 expand 重置为 false，不会带着 true 挂载）。
 *   - 禁止把被动时机接到这里（`!running`、消息到达、列表重挂载…）：用户可能正在别处阅读，
 *     把列表拽走比不居中更糟 —— 这正是上一版 `useAutoCenter(!running)` 的问题：
 *     命令结束时（用户并未点开）也会把列表滚到该终端块。
 *
 * @param open 打开信号（只应由用户手势产生）
 * @returns 挂到「要居中的那块内容」根节点上的 ref
 */
export function useAutoCenter(open = true) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const el = rootRef.current
    if (!el) return
    centerInScrollParent(el)
  }, [open])

  return rootRef
}

/** 把元素滚动到最近滚动容器的可视区中间；找不到可滚容器 / 宿主不支持则不动。 */
function centerInScrollParent(el: HTMLElement) {
  const scrollParent = getScrollParent(el)
  if (!scrollParent || typeof scrollParent.scrollTo !== 'function') return

  const elRect = el.getBoundingClientRect()
  const parentRect = scrollParent.getBoundingClientRect()
  // 元素中心相对滚动内容顶部的距离 → 让它对齐容器可视区中心
  const target =
    elRect.top -
    parentRect.top +
    scrollParent.scrollTop +
    elRect.height / 2 -
    scrollParent.clientHeight / 2

  try {
    scrollParent.scrollTo({ top: target, behavior: 'smooth' })
  } catch {
    // 少数宿主（如 jsdom）会抛「scrollTo is not implemented」→ 放弃居中，不影响渲染
  }
}

/** 向上查找第一个可纵向滚动的祖先元素；没有则退回文档滚动容器。 */
function getScrollParent(node: HTMLElement): HTMLElement | null {
  let parent: HTMLElement | null = node.parentElement
  while (parent) {
    const { overflowY } = getComputedStyle(parent)
    const scrollable =
      (overflowY === 'auto' ||
        overflowY === 'scroll' ||
        overflowY === 'overlay') &&
      parent.scrollHeight > parent.clientHeight
    if (scrollable) return parent
    parent = parent.parentElement
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement
}
