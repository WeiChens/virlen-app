/**
 * ContextMenu — 通用右键菜单（全应用唯一一份实现）
 *
 * 为什么要有它：本项目是自绘窗口，`WindowLayout` 在生产环境把 contextmenu
 * 全局 preventDefault（见 layout/WindowLayout/index.tsx），浏览器原生右键菜单不出现；
 * 而各处（消息正文 / 图片 / 文件 chip / 深度思考 / 终端 …）又都需要右键操作。
 * 于是把「位置钳制 + 点外部关闭 + Esc 关闭 + 层级」这些容易做错的细节收在一处。
 *
 * 层级约定（与项目其他浮层对齐）：
 *   全屏浮层 500 < 本菜单 600 < Modal 800 < Toast 3012
 *
 * ⚠️ 两个必须挂**捕获阶段**的监听（踩过的坑）：
 *   - mousedown 捕获：抢在菜单项自身的 click 之前判定「是否点在外面」，
 *     不会误伤菜单项；也避免被兄弟节点的 stopPropagation 吃掉；
 *   - keydown 捕获 + stopPropagation：Esc 只关菜单，不再连带触发外层的 Esc
 *     （终端全屏、图片预览等都在 document 上听了 Esc，两处监听同时消费会「一按两动作」）。
 */
import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import './style.scss'

/** 一个菜单项 */
export interface ContextMenuItem {
  /** 稳定标识（React key） */
  key: string
  /** 显示文案（调用方已经过 t()） */
  label: ReactNode
  /** 点击动作 */
  onClick: () => void | Promise<void>
  /** 禁用（灰显，不响应点击） */
  disabled?: boolean
  /** 危险动作（删除等）→ 危险色 */
  danger?: boolean
  /**
   * 点击后**不关闭**菜单。
   * 用于「选择类」动作（如终端里的「全选」→ 紧接着还要点「复制」）。
   */
  keepOpen?: boolean
  /** 在本项之前画一条分隔线（用于把「危险动作」与常规动作分开） */
  divider?: boolean
}

/** 菜单打开位置（视口坐标，与 MouseEvent.clientX/clientY 同源） */
export interface ContextMenuPosition {
  x: number
  y: number
}

interface Props {
  position: ContextMenuPosition
  items: ContextMenuItem[]
  /** 关闭菜单（外部状态归零） */
  onClose: () => void
  /** 深色底场景（终端块）用深色皮肤，避免亮色菜单压在黑色终端上 */
  dark?: boolean
}

/**
 * 右键菜单本体。**只在需要时渲染**（由 position 状态控制），
 * 经 createPortal 挂到 document.body —— 消息列表祖先带 transform/overflow，
 * fixed 定位会被牵连（与终端全屏浮层、代码块全屏同一理由）。
 */
export default function ContextMenu({
  position,
  items,
  onClose,
  dark,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  // 关闭行为：点菜单外 / Esc
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onDocKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true)
      document.removeEventListener('keydown', onDocKeyDown, true)
    }
  }, [onClose])

  // 定位：先按右键坐标放，再按**实际尺寸**钳进视口（贴右边/下边时往回缩）
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const x = Math.max(
      8,
      Math.min(position.x, window.innerWidth - el.offsetWidth - 8),
    )
    const y = Math.max(
      8,
      Math.min(position.y, window.innerHeight - el.offsetHeight - 8),
    )
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [position])

  function handleItemClick(item: ContextMenuItem): void {
    if (item.disabled) return
    // 先关再执行：动作可能弹 Modal / 开对话框，菜单留着会压在弹窗上
    if (!item.keepOpen) onClose()
    void item.onClick()
  }

  return createPortal(
    <div
      className={`context-menu${dark ? ' context-menu--dark' : ''}`}
      ref={menuRef}
      role="menu">
      {items.map((item) => (
        <div key={item.key}>
          {item.divider && <div className="context-menu-divider" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => handleItemClick(item)}>
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

/**
 * 右键菜单状态管理。
 *
 * 只记「在哪儿点的」+ 一个由调用方定义的 `target`（点什么），**菜单项在渲染时现算**：
 * 例如终端菜单的「复制」要跟随选区变化、消息菜单要区分正文 / 图片 / 文件，
 * 若在打开那一刻就把 items 定死，拿到的是过期状态。
 *
 * 用法：
 * ```tsx
 * const menu = useContextMenu<{ kind: 'image'; src: string }>()
 * return (
 *   <>
 *     <img onContextMenu={(e) => menu.openAt(e, { kind: 'image', src })} />
 *     {menu.state && (
 *       <ContextMenu
 *         position={menu.state.position}
 *         items={buildItems(menu.state.target)}
 *         onClose={menu.close}
 *       />
 *     )}
 *   </>
 * )
 * ```
 * `openAt` 会顺手 preventDefault + stopPropagation：拦下浏览器默认菜单，
 * 并阻止外层容器的右键处理（例如图片缩略图在消息气泡内部，两者菜单不该同时开）。
 */
export function useContextMenu<T = void>() {
  const [state, setState] = useState<{
    position: ContextMenuPosition
    target: T
  } | null>(null)

  const close = useCallback(() => setState(null), [])

  const openAt = useCallback(
    (
      ev: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
      target: T,
    ) => {
      ev.preventDefault()
      ev.stopPropagation()
      setState({ position: { x: ev.clientX, y: ev.clientY }, target })
    },
    [],
  )

  return { state, openAt, close }
}
