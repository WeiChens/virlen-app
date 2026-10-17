/**
 * 通用菜单（右键 / 「更多」按钮共用，全应用唯一实现）。
 *
 * 本地自绘窗口全局 preventDefault 了 contextmenu，原生菜单不出现，故把「位置钳制 + 点外部关闭 +
 * Esc 关闭 + 层级」这些易错细节收在一处。
 *
 * 层级：Modal 1300 < 本菜单 2000（弹窗里的右键菜单必须盖在遮罩上）。
 * 两个监听必须挂捕获阶段：mousedown 抢在菜单项 click 之前判定「点在外面」；
 * keydown 捕获 + stopPropagation 让 Esc 只关菜单，不连带触发外层。
 *
 * 传 anchorElement 才支持「再点一次那个按钮关掉」：否则 mousedown 先关、click 又开，看着像点不动。
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
  /** 点击后不关闭菜单（选择类动作，如终端「全选」→ 还要点「复制」） */
  keepOpen?: boolean
  /** 在本项之前画分隔线（隔开危险动作） */
  divider?: boolean
}

/** 菜单打开位置（视口坐标，与 MouseEvent.clientX/clientY 同源） */
export interface ContextMenuPosition {
  x: number
  y: number
}

/**
 * 展开方向（锚点 = 菜单的哪个角）：
 * bottom-right（默认）锚点在左上 → 向右下；bottom-left 锚点在右上 → 向左下；
 * top-left 锚点在右下 → 向左上（贴边按钮）。
 */
export type ContextMenuPlacement = 'bottom-right' | 'bottom-left' | 'top-left'

interface Props {
  position: ContextMenuPosition
  items: ContextMenuItem[]
  /** 关闭菜单（外部状态归零） */
  onClose: () => void
  /** 深色底场景（终端块）用深色皮肤，避免亮色菜单压在黑色终端上 */
  dark?: boolean
  /** 展开方向（默认 bottom-right） */
  placement?: ContextMenuPlacement
  /**
   * 打开这个菜单的按钮：点它不算「点在外面」，好让按钮自己的 onClick 去关菜单。
   * 点别的元素仍算外面（换一行再点「更多」= 先关旧的、再开新的）。
   */
  anchorElement?: HTMLElement | null
}

/**
 * 菜单本体。portal 到 document.body：消息列表祖先带 transform / overflow，fixed 定位会被牽连。
 */
export default function ContextMenu({
  position,
  items,
  onClose,
  dark,
  placement = 'bottom-right',
  anchorElement,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  // 关闭行为：点菜单外 / Esc
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) {
        // 拦住菜单内的 mousedown：「点浮层外关闭」型宿主按 DOM 包含判定，而菜单是 portal 到 body 的；
        // 不拦就成了「点菜单项，宿主浮层先关了」。本监听在捕获阶段，document 是最先下行的节点。
        e.stopPropagation()
        return
      }
      if (anchorElement?.contains(target)) return
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
  }, [onClose, anchorElement])

  // 定位：先按展开方向放，再按实际尺寸钳进视口
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    // 只有 bottom-right 的锚点是菜单左上角，其余都以锚点为右边界
    const rawX = placement === 'bottom-right' ? position.x : position.x - w
    // 只有 top-left 的锚点是菜单右下角（向上展开）
    const rawY = placement === 'top-left' ? position.y - h : position.y
    const x = Math.max(8, Math.min(rawX, window.innerWidth - w - 8))
    const y = Math.max(8, Math.min(rawY, window.innerHeight - h - 8))
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [position, placement])

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
 * 右键菜单状态：只记「在哪儿点的」+ 调用方定义的 target，菜单项渲染时现算
 *（终端「复制」要跟选区、消息菜单要区分正文 / 图片 / 文件）。
 *
 * openAt 顺手 preventDefault + stopPropagation：拦下浏览器默认菜单，并阻止外层容器的右键处理。
 * 需指定锚点而非鼠标位置时用 openAtPoint + placement="top-left"（锚点会当成菜单右下角）。
 */
export function useContextMenu<T = void>() {
  const [state, setState] = useState<{
    position: ContextMenuPosition
    target: T
  } | null>(null)

  const close = useCallback(() => setState(null), [])

  /** 直接给视口坐标开菜单（锚点语义由 placement 决定） */
  const openAtPoint = useCallback(
    (position: ContextMenuPosition, target: T) => {
      setState({ position, target })
    },
    [],
  )

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

  return { state, openAt, openAtPoint, close }
}
