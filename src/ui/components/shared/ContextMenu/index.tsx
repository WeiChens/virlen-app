/**
 * ContextMenu — 通用右键菜单（全应用唯一一份实现）。
 *
 * 本项目的自绘窗口在生产环境全局 preventDefault 了 contextmenu（见 layout/WindowLayout），
 * 原生右键菜单不出现；而消息正文 / 图片 / 文件 chip / 深度思考 / 终端等又都需要右键操作，
 * 于是把「位置钳制 + 点外部关闭 + Esc 关闭 + 层级」这些容易做错的细节收在一处。
 *
 * 层级：全屏浮层 500 < 本菜单 600 < Modal 800 < Toast 3012。
 *
 * 两个必须挂捕获阶段的监听（踩过的坑）：mousedown 捕获抢在菜单项 click 之前判定「点在外面」，
 * 也不会被兄弟节点的 stopPropagation 吃掉；keydown 捕获 + stopPropagation 让 Esc 只关菜单，
 * 不连带触发外层（终端全屏 / 图片预览也在 document 上听 Esc，同时消费会「一按两动作」）。
 *
 * 展开方向由 `placement` 决定（默认右下）；要「贴在按钮左上方」时传 `placement="top-left"`。
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
  /** 点击后不关闭菜单（选择类动作，如终端「全选」→ 紧接着还要点「复制」） */
  keepOpen?: boolean
  /** 在本项之前画一条分隔线（用于把「危险动作」与常规动作分开） */
  divider?: boolean
}

/** 菜单打开位置（视口坐标，与 MouseEvent.clientX/clientY 同源） */
export interface ContextMenuPosition {
  x: number
  y: number
}

/**
 * 菜单展开方向：bottom-right（默认）= 锚点是鼠标位置、向右下展开；top-left = 锚点就是菜单的
 * 右下角、向左上展开（用于「贴在按钮左上方」这类贴边场景，右下展开会被钳回来盖住按钮）。
 */
export type ContextMenuPlacement = 'bottom-right' | 'top-left'

interface Props {
  position: ContextMenuPosition
  items: ContextMenuItem[]
  /** 关闭菜单（外部状态归零） */
  onClose: () => void
  /** 深色底场景（终端块）用深色皮肤，避免亮色菜单压在黑色终端上 */
  dark?: boolean
  /** 展开方向（默认 `bottom-right`，即鼠标点向右下） */
  placement?: ContextMenuPlacement
}

/**
 * 菜单本体（只在需要时渲染）。经 createPortal 挂 document.body —— 消息列表祖先带
 * transform/overflow，fixed 定位会被牵连（同终端 / 代码块全屏浮层）。
 */
export default function ContextMenu({
  position,
  items,
  onClose,
  dark,
  placement = 'bottom-right',
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

  // 定位：先按展开方向放（top-left 时锚点是菜单右下角），再按实际尺寸钳进视口
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const rawX = placement === 'top-left' ? position.x - w : position.x
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
 * 右键菜单状态管理：只记「在哪儿点的」+ 调用方定义的 `target`（点什么），**菜单项渲染时现算**
 * —— 终端菜单的「复制」要跟随选区、消息菜单要区分正文 / 图片 / 文件，打开那一刻定死 items 会拿到过期状态。
 *
 * 用法：
 * ```tsx
 * const menu = useContextMenu<{ kind: 'image'; src: string }>()
 * return (
 *   <>
 *     <img onContextMenu={(e) => menu.openAt(e, { kind: 'image', src })} />
 *     {menu.state && (
 *       <ContextMenu position={menu.state.position} items={buildItems(menu.state.target)} onClose={menu.close} />
 *     )}
 *   </>
 * )
 * ```
 * `openAt` 顺手 preventDefault + stopPropagation：拦下浏览器默认菜单，并阻止外层容器的右键处理
 *（图片缩略图嵌在气泡里，两者菜单不该同时开）。需指定锚点而非鼠标位置时用 `openAtPoint` +
 * `placement="top-left"`（锚点会当成菜单右下角）。
 */
export function useContextMenu<T = void>() {
  const [state, setState] = useState<{
    position: ContextMenuPosition
    target: T
  } | null>(null)

  const close = useCallback(() => setState(null), [])

  /** 直接给视口坐标开菜单（锚点语义由 `ContextMenu` 的 `placement` 决定） */
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
