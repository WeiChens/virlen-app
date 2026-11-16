/**
 * GlobalTextMenu — 全应用**兜底**的右键菜单：没有任何地方自定义右键菜单时，只要当前有选中文本
 * 就弹一个「复制」；没有选中文本就什么都不弹。
 *
 * 为什么不覆盖子级（不需要各处登记）：监听挂在 `document` 的**冒泡阶段**，而各处的菜单
 *（`useContextMenu().openAt`）都在更深的节点上 `preventDefault()` + `stopPropagation()` ——
 * 事件要么根本冒不到 document，要么到了也已经 `defaultPrevented`，这里直接让位。
 * React 17+ 把合成事件的监听挂在根容器（比 document 深），所以「子级先跑、这里后跑」是有保证的。
 *
 * 原生菜单：生产期一律 `preventDefault`（自绘窗口的老约定，原来写在 `WindowLayout` 的根节点上，
 * 现在收在这一处）；开发期只在**我们要弹菜单时**接管，没选中文本时把原生菜单留着，方便 Inspect。
 *
 * 时机：浏览器在 mousedown 阶段就把「点在选区之外」的选区清掉了，所以这里读到的选区正好是
 * 「右键点是落在哪段文字上」那一段 —— 与原生「右键选区 → 复制」同一个观感，不必自己算坐标。
 */
import { useEffect } from 'react'
import ContextMenu, { useContextMenu } from './index'
import { textMenuItems } from './menus'

/**
 * 当前选区的文本。
 *
 * 无选区 / 只有空白 → 空串（空白选区没有可复制的意义，不该顶出一个「复制」）；
 * 有内容则**原样**返回 —— 复制不该悄悄改写用户选中的首尾空白。
 */
export function selectedText(): string {
  const selection = window.getSelection?.()
  // isCollapsed：光标落在一个点上（包括「刚点了空白处」），没有拖选
  if (!selection || selection.isCollapsed) return ''
  const text = selection.toString()
  return text.trim() ? text : ''
}

export default function GlobalTextMenu() {
  const menu = useContextMenu<string>()

  useEffect(() => {
    function onContextMenu(event: MouseEvent): void {
      // ① 子级已经接管（自绘菜单的 openAt 会 preventDefault + stopPropagation）→ 一律让位
      if (event.defaultPrevented) return

      // ② 右键落在菜单自己身上：不重开（否则「在菜单上右键」会把菜单换成新的）
      const insideMenu =
        event.target instanceof Element &&
        event.target.closest('.context-menu') !== null
      const text = insideMenu ? '' : selectedText()

      // ③ 原生菜单：生产期一律不出现；开发期只在我们要弹菜单时接管（否则留着方便 Inspect）
      if (!import.meta.env.DEV || text) event.preventDefault()

      // ④ 没有选中文本 → 跳过（不弹菜单，也不去猜「这里该干什么」）
      if (!text) return

      // 选中文本存在时才记「点了哪儿」：菜单项只有一项「复制」，内容就是这份选中文本
      menu.openAtPoint({ x: event.clientX, y: event.clientY }, text)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [menu.openAtPoint])

  if (!menu.state) return null

  // 文案在打开那一刻就定下来了：菜单项的 getText / getSelected 都是**点菜单项时**才调用，
  // 而那时浏览器可能已经把选区折叠掉（甚至换了选区）—— 两个取值都指向这份快照，结果才确定
  const text = menu.state.target
  return (
    <ContextMenu
      position={menu.state.position}
      items={textMenuItems(() => text, { getSelected: () => text })}
      onClose={menu.close}
    />
  )
}
