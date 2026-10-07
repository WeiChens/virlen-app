/**
 * use-tree-drag —— 指针拖拽（拖到输入框 = 引用，拖到目录行 = 移动）。
 *
 * 「技能」页签的技能卡片也复用它（只有「拖到输入框」一种落点，onDropIntoDir 传空实现即可）。
 *
 * 不用 HTML5 drag & drop 的原因：`tauri.conf.json` 的 `dragDropEnabled` 必须为 true（与 HTML5
 * 拖拽互斥），Windows 上页面收不到 drag/drop 事件 —— 拖放已由 Rust 的 `drag_drop` 模块接管。
 * 这里改用指针事件自绘 ghost，按 elementFromPoint 判定落点。
 *
 * 落点两类（互斥）：`[data-tree-dir]`（目录行）→ onDropIntoDir；`[data-file-drop-zone]`
 *（输入框）→ onDropToInput。高亮直接改 DOM 类而非 React state —— 指针每次移入新落点才变一次，
 * 走 state 会把整个虚拟列表重渲一遍。
 *
 * 与调用方约定：`startDrag(e, items)` 挂在行的 onPointerDown（右键 / 中键自动忽略）；
 * `draggedRef.current` 为 true 表示「本轮交互是拖拽」，行的 click / dblclick 需据此吞掉激活。
 */
import { useCallback, useEffect, useRef } from 'react'
import { tpl } from '@/ui/i18n'

/** 超过这个位移才算拖拽，否则仍按点击处理 */
const DRAG_THRESHOLD = 4

/** 落点标记 */
const DROP_ZONE_SELECTOR = '[data-file-drop-zone]'
const DIR_TARGET_SELECTOR = '[data-tree-dir]'

/** 类名（ghost / 各类高亮 / body 态） */
const GHOST_CLASS = 'tree-drag-ghost'
const DROP_OVER_CLASS = 'drag-over'
const DIR_OVER_CLASS = 'is-drop-target'
const BODY_DRAGGING_CLASS = 'is-tree-dragging'

export interface TreeDragItem {
  path: string
  name: string
  isDir: boolean
  /** ghost 图标（缺省按数量 / isDir 推断；技能卡片传 🧩） */
  icon?: string
}

export interface TreeDragOptions {
  /** 松手在输入框上（引用成附件） */
  onDropToInput: (items: TreeDragItem[]) => void
  /** 松手在目录行上（移动到该目录） */
  onDropIntoDir: (items: TreeDragItem[], targetDir: string) => void
  /** 该目录能否接收这批拖拽项；false 时不加高亮、松手也不触发（合法性由调用方判断） */
  canDropIntoDir?: (items: TreeDragItem[], targetDir: string) => boolean
}

export function useTreeDrag(options: TreeDragOptions) {
  /** 本轮交互是否已进入拖拽态（供行的 click / dblclick 吞掉激活） */
  const draggedRef = useRef(false)
  /** 卸载兜底用的清理函数 */
  const cleanupRef = useRef<(() => void) | null>(null)
  /**
   * 选项存 ref：调用方每次渲染都传新函数（捕获了最新选择集），而 startDrag 必须保持稳定引用
   *（要挂到每一行的 onPointerDown），否则会一直持有首次渲染时的旧闭包。
   */
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    return () => cleanupRef.current?.()
  }, [])

  const startDrag = useCallback(
    (ev: React.PointerEvent, items: TreeDragItem[]) => {
      // 只处理左键；每次按下都先复位，避免上一轮的标记残留
      draggedRef.current = false
      if (ev.button !== 0 || items.length === 0) return

      const startX = ev.clientX
      const startY = ev.clientY
      let dragging = false
      let ghost: HTMLDivElement | null = null
      let dropZone: Element | null = null
      let dropDirEl: HTMLElement | null = null
      let dropDir: string | null = null

      const clearOver = () => {
        dropZone?.classList.remove(DROP_OVER_CLASS)
        dropZone = null
        dropDirEl?.classList.remove(DIR_OVER_CLASS)
        dropDirEl = null
        dropDir = null
      }

      const finish = () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        clearOver()
        ghost?.remove()
        ghost = null
        document.body.classList.remove(BODY_DRAGGING_CLASS)
        cleanupRef.current = null
      }

      const createGhost = () => {
        const el = document.createElement('div')
        el.className = GHOST_CLASS
        const icon = document.createElement('span')
        icon.className = 'tree-drag-ghost-icon'
        icon.textContent =
          items.length > 1
            ? '📚'
            : (items[0].icon ?? (items[0].isDir ? '📁' : '📄'))
        const name = document.createElement('span')
        name.className = 'tree-drag-ghost-name'
        // 用 textContent（而非 innerHTML），文件名里的尖括号不会被当成标签
        name.textContent =
          items.length > 1
            ? tpl('$__count__ 项', { count: items.length })
            : items[0].name
        el.append(icon, name)
        document.body.appendChild(el)
        return el
      }

      const onMove = (e: PointerEvent) => {
        if (!dragging) {
          if (
            Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD
          ) {
            return
          }
          dragging = true
          draggedRef.current = true
          ghost = createGhost()
          document.body.classList.add(BODY_DRAGGING_CLASS)
        }

        // ghost 带 pointer-events: none，因此不会命中自己
        if (ghost) {
          ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`
        }

        const hit = document.elementFromPoint(e.clientX, e.clientY)
        const dirEl =
          (hit?.closest(DIR_TARGET_SELECTOR) as HTMLElement | null) ?? null
        const dir = dirEl?.getAttribute('data-tree-dir') || null
        const { canDropIntoDir } = optionsRef.current
        const nextDir =
          dir && (!canDropIntoDir || canDropIntoDir(items, dir)) ? dir : null

        if (nextDir !== dropDir) {
          dropDirEl?.classList.remove(DIR_OVER_CLASS)
          dropDir = nextDir
          dropDirEl = nextDir ? dirEl : null
          dropDirEl?.classList.add(DIR_OVER_CLASS)
        }

        // 输入框落点：与目录落点互斥（命中目录行时不再考虑输入框）
        const zone = dropDir ? null : (hit?.closest(DROP_ZONE_SELECTOR) ?? null)
        if (zone !== dropZone) {
          dropZone?.classList.remove(DROP_OVER_CLASS)
          dropZone = zone
          dropZone?.classList.add(DROP_OVER_CLASS)
        }
      }

      const onUp = () => {
        const moveTo = dragging ? dropDir : null
        const toInput = dragging && !moveTo && !!dropZone
        finish()
        if (moveTo) optionsRef.current.onDropIntoDir(items, moveTo)
        else if (toInput) optionsRef.current.onDropToInput(items)
      }

      cleanupRef.current = finish
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [],
  )

  return { startDrag, draggedRef }
}
