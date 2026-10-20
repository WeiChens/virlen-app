/**
 * Monaco 查找控件（Ctrl/Cmd+F 的右上角搜索框）在本项目里的两处「水土不服」，统一在这里收口。
 *
 * ① **气泡被切掉**：三个开关（区分大小写 / 全字匹配 / 正则）的悬浮气泡由 `IHoverService` 渲染，
 *    宿主容器就是编辑器容器本身（`ILayoutService.activeContainer`），而外层容器
 *    （`.code-editor` / `.code-preview` / 代码块滚动区）是 `overflow: hidden`，查找框又贴在顶边 ——
 *    气泡只能朝上，于是被切掉一半（露半个框，比没有更难看）。
 *    这里在**捕获阶段**吞掉 `.find-widget` 内的 `mouseover`：气泡是 `setupDelayedHover` 从
 *    `mouseover` 长出来的，断在源头就不依赖「气泡挂在哪个节点」（CSS 拦不住这种情况，见 style.scss 的兜底）。
 *    只影响气泡：按钮的 `aria-label`、点击、键盘（Alt+C 等）全照旧。
 *
 * ② **可能落在看不见的地方**：查找框是 overlay widget（钉在编辑器顶部，不随编辑器内部滚动而移动），
 *    所以内容超高、由 Monaco 内置滚动条滚的现在，往下滚也看得见它。真正需要它的是另一种情形：
 *    编辑器比可视区高、上半被消息列表 / 弹窗裁掉（工作目录文件面板里不会，聊天里会）。
 *    这里在滚动 / 尺寸变化 / 编辑器重新渲染之后，把查找框的 `top` 夹进「编辑器与所有滚动祖先的**可见交集**」。
 *    编辑器整体可见时 offset 恒为 0，与原行为一致。
 *
 * 历史：只读预览曾经是「高度 = 内容高度、滚动交给外层 `.code-block-wrapper`」，那时查找框会被一起
 * 滚出视野；现在纵向滚动归 Monaco（`CodePreview` 的 `maxContentHeight`），夹紧只剩兜底作用。
 *
 * ⚠️ 这里改的是 Monaco 的内联 `top`（`overlayWidgets` 里 TOP_RIGHT_CORNER 的定位就是 `top: 0`）：
 *    编辑器自己重新布局时会把它写回 0，所以每次交互都要重算 —— 见下面的监听清单。
 */
import type * as MonacoNs from 'monaco-editor'

/** 查找框贴住可见区顶边时留的余量（px，与 CSS 的 margin-top: 4px 对齐观感） */
const EDGE_MARGIN = 4

/** 拿不到 offsetHeight 时的兜底（Monaco 的 FIND_INPUT_AREA_HEIGHT = 33） */
const WIDGET_FALLBACK_HEIGHT = 33

/** 查找框的根节点（Monaco `findWidget.js` 里 `this._domNode.className = 'find-widget'`） */
const WIDGET_SELECTOR = '.find-widget'

/**
 * 元素当前的**可见纵向区间**：视口 ∩ 所有 `overflow != visible` 的祖先。
 *
 * 为什么要把祖先也算进来：聊天里的代码块被 `.code-preview` 裁一次（overflow: hidden）、
 * 被消息列表再裁一次，只看 `window.innerHeight` 会把查找框挪到看不见的位置。
 */
function visibleVerticalBox(element: HTMLElement): { top: number; bottom: number } {
  let top = 0
  let bottom = window.innerHeight
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'visible') continue
    const rect = node.getBoundingClientRect()
    if (rect.height <= 0) continue
    top = Math.max(top, rect.top)
    bottom = Math.min(bottom, rect.bottom)
  }
  return { top, bottom }
}

/**
 * 把某个编辑器实例的查找框「驯服」（幂等：同一实例重复调用只会多挂一份监听，
 * 由调用方保证只在 onMount 时调一次）。
 *
 * 返回的 dispose 会摘掉全部监听并取消挂起的帧 —— 编辑器销毁前必须调用，否则监听会指向已卸载的 DOM。
 */
export function tameFindWidget(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
): MonacoNs.IDisposable {
  // 用可选调用：假编辑器（单测）可能根本没这个方法
  const container = editor.getContainerDomNode?.()
  // 没有真实 DOM 容器就没什么可做的（单测里的假编辑器 / 尚未挂载）。
  // 这里不报错：本函数管的全部是「DOM 几何 + 事件」层面的行为，非 DOM 宿主下它天然无事可做。
  if (!(container instanceof HTMLElement)) {
    return { dispose: (): void => {} }
  }

  // ── ① 气泡：捕获阶段掐掉源头 ──
  const swallowHover = (event: MouseEvent): void => {
    const target = event.target
    if (target instanceof Element && target.closest(WIDGET_SELECTOR)) {
      event.stopPropagation()
    }
  }
  container.addEventListener('mouseover', swallowHover, true)

  // ── ② 位置：夹进可见交集 ──
  let frame = 0

  const apply = (): void => {
    const widget = container.querySelector<HTMLElement>(WIDGET_SELECTOR)
    // 查找框是懒创建的（第一次 Ctrl+F 才有），没有就什么都不用做
    if (!widget) return
    const host = container.getBoundingClientRect()
    const box = visibleVerticalBox(container)
    const height = widget.offsetHeight || WIDGET_FALLBACK_HEIGHT
    // 目标：框顶不低于可见区顶边，框底不超出可见区底边
    const lowest = Math.max(box.bottom - host.top - height - EDGE_MARGIN, 0)
    const offset = Math.max(Math.min(box.top - host.top, lowest), 0)
    widget.style.top = `${Math.round(offset)}px`
  }

  /** 排到下一帧（Monaco 自己的布局也在 rAF 里，连排两帧才能落在它后面） */
  const schedule = (): void => {
    if (frame || typeof requestAnimationFrame !== 'function') return
    frame = requestAnimationFrame(() => {
      apply()
      frame = requestAnimationFrame(() => {
        frame = 0
        apply()
      })
    })
  }

  // 外层滚动（消息列表 / 弹窗）—— scroll 不冒泡，必须用捕获（Monaco 内部滚动也会走到这里，
  // 那时算出来的 offset 恒为 0，等于什么都没做）
  document.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  // Ctrl+F 是键盘事件之后才创建查找框的：按任意键都重算一次（成本只有一次 querySelector）
  container.addEventListener('keydown', schedule, true)

  const listeners: MonacoNs.IDisposable[] = [
    editor.onDidFocusEditorWidget?.(schedule),
    // 编辑器重新渲染会把 top 写回 0（点一下正文就会触发），跟着补一次
    editor.onDidChangeCursorSelection?.(schedule),
    editor.onDidLayoutChange?.(schedule),
  ].filter((item): item is MonacoNs.IDisposable => !!item)

  const handle: MonacoNs.IDisposable = {
    dispose(): void {
      container.removeEventListener('mouseover', swallowHover, true)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      container.removeEventListener('keydown', schedule, true)
      for (const listener of listeners) listener.dispose()
      if (frame && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame)
      }
      frame = 0
      selfDispose?.dispose()
    },
  }
  // 编辑器销毁时自动摘干净（调用方不需要自己接）。
  // 可选调用：单测里的假编辑器只实现了组件真正用到的那几个成员。
  const selfDispose = editor.onDidDispose?.(() => handle.dispose())

  return handle
}
