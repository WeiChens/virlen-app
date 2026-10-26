/**
 * 原生文件拖放（能拿到真实路径）：**一份监听、多处落点**。
 *
 * 为什么要有这一层：`dragDropEnabled: true`（拖文件进输入框要真实路径，见 §11.8）时页面
 * 收不到 HTML5 drag / drop，唯一的通道是 Rust `drag_drop` 模块下发的 `virlen:drag-drop`
 *（带落点坐标 + 真实路径）。落点从「只有输入框」变成「输入框 + 右侧栏」之后，如果各组件
 * 各自 `listen`，一次拖放会被两个监听各处理一遍（文件既进附件又开标签），「拖到空白处」的
 * 提示也会互相打架 —— 所以监听只有一份（宿主调 `useNativeFileDrop()` 挂），各处只登记
 * 自己的命中范围（`useNativeDropTarget()`）。
 *
 * 四条口径：
 * 1. **命中按坐标判**：事件里只有「相对窗口左上角的物理像素」，先 ÷ devicePixelRatio 换成
 *    CSS 像素，再拿各落点元素的 `getBoundingClientRect()` 比；
 * 2. **宽高为 0 的落点不接**（收起的右侧栏就是这样）：否则贴边那几个像素会误判成命中；
 * 3. **高亮只在「换了落点」时回调一次**：`over` 每帧都来，逐帧 setState 会把面板刷成幻灯片；
 * 4. **同一次拖放只可能命中一个落点**：命中即消费，没命中才算「拖到没有接收方的地方」。
 */
import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { t } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'

/** 是否在 Tauri 环境（浏览器调试模式下没有原生拖放事件） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 原生拖放事件负载（来自 Rust 的 `drag_drop` 模块）。
 * 形状与 Tauri 内置的 DragDropEvent 一致；落点是**相对窗口左上角的物理像素**。
 * ⚠️ 与 `src-tauri/src/drag_drop.rs::DragDropPayload` 逐字对齐（改一边必须改另一边）。
 */
export type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'leave' }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }

/** 一个能接收「系统里拖进来的文件」的区域 */
export interface NativeDropTarget {
  /** 命中区域（每次事件现取：元素可能被重建） */
  element: () => HTMLElement | null
  /** 命中后还接不接（收起 / 没有接收方时为 false）；不传 = 一直接 */
  enabled?: () => boolean
  /** 文件落在本区域内（`paths` 保证非空） */
  onDrop: (paths: string[]) => void
  /** 指针进出本区域（做高亮用）：只在**状态变化**时调用 */
  onHover?: (inside: boolean) => void
}

/** 登记过的落点（后登记的优先命中：同一处叠了两层时里层的赢） */
const targets: NativeDropTarget[] = []

/** 登记一个落点，返回注销函数 */
export function registerNativeDropTarget(target: NativeDropTarget): () => void {
  targets.push(target)
  return () => {
    const index = targets.indexOf(target)
    if (index >= 0) targets.splice(index, 1)
  }
}

/** 这个坐标（CSS 像素）落在哪个落点里；没有就是 null */
export function nativeDropTargetAt(
  x: number,
  y: number,
): NativeDropTarget | null {
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const target = targets[i]
    if (target.enabled && !target.enabled()) continue
    const element = target.element()
    if (!element) continue
    const rect = element.getBoundingClientRect()
    // 收起 / 隐藏时 rect 是 0×0：不排除的话，贴边那几个像素会误判成「落在上面」
    if (rect.width <= 0 || rect.height <= 0) continue
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return target
    }
  }
  return null
}

/**
 * 在组件里登记一个落点（输入框 / 右侧栏各一个）。
 *
 * 回调存 ref：落点只登记一次，而 `onDrop` / `onHover` 每次渲染都是新箭头函数 ——
 * 进依赖数组会让「注销 → 重登记」每帧跑一遍，拖放期间正好落进那个空档就丢事件。
 */
export function useNativeDropTarget(target: NativeDropTarget): void {
  const ref = useRef(target)
  ref.current = target
  useEffect(
    () =>
      registerNativeDropTarget({
        element: () => ref.current.element(),
        enabled: () => ref.current.enabled?.() !== false,
        onDrop: (paths) => ref.current.onDrop(paths),
        onHover: (inside) => ref.current.onHover?.(inside),
      }),
    [],
  )
}

/**
 * 挂那**唯一**一份 `virlen:drag-drop` 监听：把事件派发给命中的落点。
 * 宿主（`chat-view`）调一次即可；重复挂会让同一次拖放被处理多次。
 */
export function useNativeFileDrop(): void {
  useEffect(() => {
    if (!isTauriEnv()) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    /** 当前高亮的落点（只在换人时回调，见文件头第 3 条） */
    let hovered: NativeDropTarget | null = null

    const hover = (next: NativeDropTarget | null) => {
      if (next === hovered) return
      hovered?.onHover?.(false)
      hovered = next
      hovered?.onHover?.(true)
    }

    /** 物理像素 → CSS 像素（WebView2 的界面缩放会让两者不等） */
    const toCss = (position: { x: number; y: number }) => {
      const ratio = window.devicePixelRatio || 1
      return { x: position.x / ratio, y: position.y / ratio }
    }

    listen<DragDropPayload>('virlen:drag-drop', (event) => {
      const payload = event.payload
      if (payload.type === 'leave') {
        hover(null)
        return
      }
      const { x, y } = toCss(payload.position)
      if (payload.type === 'enter' || payload.type === 'over') {
        hover(nativeDropTargetAt(x, y))
        return
      }
      // drop：先记下落点再清高亮（落点可能因为开标签而被重渲染掉）
      const target = nativeDropTargetAt(x, y)
      hover(null)
      const paths = (payload.paths ?? []).filter((path) => !!path)
      // 拖进来的不是文件（如拖选中的文本）：paths 为空，交给系统 / 页面原有行为，不插手
      if (paths.length === 0) return
      if (target) {
        target.onDrop(paths)
        return
      }
      // 落在哪儿都不接：不静默丢弃，给一句提示，否则用户会以为功能没生效
      showToast(t('请把文件拖到输入框或右侧栏内'))
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {
        // 非 Tauri 环境 / 事件不可用
      })

    return () => {
      cancelled = true
      unlisten?.()
      // 拖动途中宿主卸载：把高亮收掉，别留一块「以为还在拖」的提示
      hover(null)
    }
  }, [])
}
