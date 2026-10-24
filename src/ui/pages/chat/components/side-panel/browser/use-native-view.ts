/**
 * 原生网页视图的**宿主**：把 DOM 里的一个占位 div 翻译成 WebView2 子视图的位置与显隐。
 *
 * 为什么需要这一层：child webview 是**原生窗口**，浮在 HTML 之上，它不知道自己在页面布局里
 * 该占哪一格。DOM 这边只负责量出一个 rect（`getBoundingClientRect`），真正的像素在原生层。
 *
 * 四条口径：
 * 1. **逐帧比对，变了才发**：面板宽度的 200ms 过渡、拖分隔条、窗口缩放都会让 rect 每帧变化，
 *    一帧一次命令才跟得上；但静止时必须一条都不发（否则 60 次/秒的 IPC 白烧 CPU）。
 * 2. **不可见就 hide，不销毁**：切标签、收起面板都要保住页面状态（滚动位置、表单、登录）。
 *    rect 的宽或高小于 2px（`display:none` 就是 0）即视为不可见。
 *    ⚠️ 拖面板宽度时（祖先 `.is-resizing`）也要藏起来：原生视图是**子窗口**，
 *    指针一进它的矩形，`document` 上的 `mousemove` / `mouseup` 就收不到了 —— 拖动会断在半路。
 * 3. **建视图要等布局**：地址有了但还没量到 rect（首次挂载那一帧、后台标签）时不创建，
 *    否则 WebView2 会拿到 0 尺寸或错位置。
 * 4. **失败要能说出来**：创建失败（非桌面环境、命令报错）落到 `error`，由调用方展示 ——
 *    静默失败等于永久白框。
 * 5. **量到的 CSS 像素要乘界面缩放**：`getBoundingClientRect()` 给的是 **CSS 像素**，
 *    `LogicalPosition` / `LogicalSize` 要的是 **逻辑像素**（DIP）。界面缩放（webview 原生
 *    `setZoom`）一放大，同一个 rect 在屏幕上占的就是 `CSS × zoom` —— 不乘就是「视图比占位
 *    小一圈、整体还往左上收」，缩放越大差得越远。倍率取**已经落到 webview 上**的那个值
 *    （`appliedZoomFactor()`，见 `ui/hooks/applied-zoom.ts`），不是设置里的期望值：
 *    `setZoom` 是异步 IPC，照期望值算会先撑大一两帧再收回。
 * 6. **被 DOM 浮层盖住时得自己让位**：原生子窗口**永远画在 HTML 之上**（它是窗口的子窗口，
 *    不是 DOM 节点）—— `z-index` / portal / `.settings-overlay` 那套层级对它完全无效。
 *    所以设置页 / Modal / 抽屉 / 右键菜单一打开，必须让它自己 `hide`，否则它会把整个浮层
 *    盖住（用户看到的就是「打开设置页，网页还在最上面」）。判据是**占位中心点的命中测试**
 *    （`coveredByOverlay`），而不是维护一张浮层清单 —— 那些浮层全是 portal 到 body 的，
 *    只要中心命中的元素跑出占位，就说明被盖了。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { appliedZoomFactor } from '@/ui/hooks/applied-zoom'
import {
  applyBrowserView,
  closeBrowserView,
  hasBrowserView,
  navigateBrowserView,
  openBrowserView,
  reloadBrowserView,
  type BrowserViewBounds,
} from '@/infrastructure/browser/browser-view'

interface Options {
  /** 视图 label（一个网页标签一个，由调用方保证稳定） */
  label: string
  /** 要加载的地址（空串 = 空白页：不建视图） */
  url: string
  /** 刷新计数：变化即重载（地址不变时唯一能触发重载的信号） */
  reloadToken: number
}

interface NativeBrowserView {
  /** 挂到铺满内容区的占位元素上（原生视图会盖在它上面） */
  hostRef: RefObject<HTMLDivElement | null>
  /** 建不起来的原因（非桌面环境 / 命令失败）；`null` = 正常 */
  error: string | null
  /**
   * 是否被 DOM 浮层盖住（原生视图已藏起来）。
   * 调用方据此把占位里的「正在加载…」一并收掉：
   * 设置页的遮罩是半透明的，底下留着那行字会透出来。
   */
  covered: boolean
}

/** 小于这个尺寸就算不可见（`display:none` 的元素 rect 正好是 0） */
const MIN_SIZE = 2

/** 位置变化小于这个值就不发命令（亚像素抖动没有意义，只是白跑一趟 IPC） */
const MIN_DELTA = 0.5

/**
 * 让位判定：占位的中心点是不是被 DOM 浮层盖住了（`rect` 是 CSS 像素，与 `elementFromPoint` 同口径）。
 *
 * 为什么用命中测试而不是「浮层清单」：设置页（`.settings-overlay`）、`Modal`（`.modal-overlay`）、
 * 抽屉、右键菜单、全局提示全都是 portal 到 body 的，列清单一定会漏；而它们要盖住视图时，
 * 中心点必然跑到 `.browser-viewport` 外面。取中心点是**最小代价的近似**：全屏遮罩型浮层
 * （设置页 / Modal）必然命中；局部浮层只在真的压住主要区域时才让位（遮一个小角就藏起来会是闪烁）。
 * ⚠️ 不能因为「原生视图看不见」而放弃这一步 —— 反过来，它盖在遮罩上会**吃掉鼠标**，
 * 用户点「设置」里的东西却落到了网页上。
 */
function coveredByOverlay(host: HTMLElement, rect: DOMRect): boolean {
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  // 中心点根本不在视口里（面板大半滚出去）：与遮挡无关，交给尺寸判断
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
  // jsdom 没有布局引擎，也不提供 elementFromPoint（单测里按需打桩）
  if (typeof document.elementFromPoint !== 'function') return false
  const hit = document.elementFromPoint(x, y)
  return hit !== null && !host.contains(hit)
}

interface ViewState {
  created: boolean
  creating: boolean
  visible: boolean
  /** 上一次创建失败过：同一个地址不再每帧重试（改地址时重置，见 url 的 effect） */
  failed: boolean
  bounds: BrowserViewBounds
  /** 最新想要的地址（异步创建期间用户可能又改了一次） */
  wantUrl: string
}

function sameBounds(a: BrowserViewBounds, b: BrowserViewBounds): boolean {
  return (
    Math.abs(a.x - b.x) < MIN_DELTA &&
    Math.abs(a.y - b.y) < MIN_DELTA &&
    Math.abs(a.width - b.width) < MIN_DELTA &&
    Math.abs(a.height - b.height) < MIN_DELTA
  )
}

export function useNativeBrowserView({ label, url, reloadToken }: Options): NativeBrowserView {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(() =>
    hasBrowserView() ? null : 'unavailable',
  )
  const [covered, setCovered] = useState(false)
  /** 上一帧的遮挡结论：只在翻转时 setState（否则每帧一次调度） */
  const coveredRef = useRef(false)
  const stateRef = useRef<ViewState>({
    created: false,
    creating: false,
    visible: false,
    failed: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    wantUrl: url,
  })

  /**
   * 地址变化：已建好的视图直接导航；还没建的下一次 rAF 会带着新地址建。
   * 地址被清空（用户重开空白页）时销毁视图 —— 留着它就等于留着一个看不见的页面在跑。
   */
  useEffect(() => {
    const state = stateRef.current
    state.wantUrl = url
    // 换了地址就重新给一次机会（上一轮可能是网络 / 时机问题）
    state.failed = false
    if (!url) {
      if (state.created || state.creating) {
        state.created = false
        state.visible = false
        // 飞行中的 open 由它自己的 `.then` 在落地时收（这里先把 creating 放开，
        // 否则那一边会以为「已被新一轮接管」而不 close，视图就泄漏了）
        state.creating = false
        void closeBrowserView(label)
      }
      return
    }
    if (state.created) void navigateBrowserView(label, url)
  }, [label, url])

  /** 刷新：只换计数、不动地址；首次挂载不算一次刷新 */
  const reloadSeen = useRef(false)
  useEffect(() => {
    if (!reloadSeen.current) {
      reloadSeen.current = true
      return
    }
    void reloadBrowserView(label)
  }, [label, reloadToken])

  /** 逐帧同步：量 rect → 建视图 / 改大小 / 显隐。组件卸载时销毁视图。 */
  useEffect(() => {
    if (!hasBrowserView()) return
    const state = stateRef.current
    let frame = 0
    let stopped = false

    const tick = (): void => {
      if (stopped) return
      frame = requestAnimationFrame(tick)

      const host = hostRef.current
      if (!host) return
      const rect = host.getBoundingClientRect()
      // CSS 像素 → 逻辑像素：界面缩放让 1 CSS px 占 `zoom` 个 DIP（见文件头第 5 条）
      const zoom = appliedZoomFactor()
      const bounds: BrowserViewBounds = {
        x: rect.left * zoom,
        y: rect.top * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom,
      }
      // 没有地址、或者布局上根本看不见（别的标签 / 面板已收起）：不建，已建的就藏起来。
      // 拖动面板宽度时也藏：子窗口会吃掉 document 上的 mousemove / mouseup（见文件头第 2 条）。
      // 被 DOM 浮层盖住（设置页 / Modal / 抽屉 / 菜单）时同样藏：原生窗口不吃 z-index（第 6 条）。
      const dragging =
        host.closest('.side-panel')?.classList.contains('is-resizing') ?? false
      const sized = rect.width >= MIN_SIZE && rect.height >= MIN_SIZE
      // 尺寸正常才值得做命中测试（rect 为 0 时中心点毫无意义）
      const isCovered = sized && coveredByOverlay(host, rect)
      if (isCovered !== coveredRef.current) {
        coveredRef.current = isCovered
        setCovered(isCovered)
      }
      const visible =
        sized &&
        !dragging &&
        !!state.wantUrl &&
        !isCovered

      if (!state.created) {
        if (!visible || state.creating || state.failed) return
        state.creating = true
        const target = state.wantUrl
        openBrowserView(label, target, bounds)
          .then(() => {
            // 这一轮是不是已经被新一轮（StrictMode 的「卸载 → 再挂载」）接管了：
            // 新一轮已开始创建（creating）或已建好（created）时，**不能**替它 close 同名视图。
            const takenOver = state.creating || state.created
            state.creating = false
            if (stopped || !state.wantUrl) {
              state.created = false
              state.visible = false
              // 真正卸载（没任何新一轮接管）时，这个刚建好的视图必须收掉，否则泄漏
              if (!takenOver) void closeBrowserView(label)
              return
            }
            state.created = true
            state.visible = true
            state.bounds = bounds
            setError(null)
            // 创建期间用户又换了地址：补一次导航（那次 effect 跑的时候 created 还是 false）
            if (state.wantUrl !== target) void navigateBrowserView(label, state.wantUrl)
          })
          .catch((reason: unknown) => {
            state.creating = false
            state.failed = true
            if (!stopped) setError(reason instanceof Error ? reason.message : String(reason))
          })
        return
      }

      if (!sameBounds(state.bounds, bounds) || state.visible !== visible) {
        state.bounds = bounds
        state.visible = visible
        void applyBrowserView(label, bounds, visible)
      }
    }

    frame = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      state.created = false
      state.visible = false
      state.creating = false
      // 这里只收拾眼前这一份；飞行中的 open 由它自己的 `.then` 在落地时收
      // （那里会先看 `state.creating`，避免把 StrictMode 下一轮刚建的视图杀掉）
      void closeBrowserView(label)
    }
  }, [label])

  return { hostRef, error, covered }
}
