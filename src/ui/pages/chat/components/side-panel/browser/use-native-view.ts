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
 *    ⚠️ 命中测试每帧一次是白烧：结论只在浮层开合时变，故按 100ms 降频（wake 时强制重算）。
 * 7. **看不见就不跑帧**：看得见时逐帧同步（面板宽度过渡 / 拖分隔条要跟手），整体不可见就
 *    停掉 rAF，改由 `ResizeObserver` 与 `visibilitychange` 唤醒；没有 RO 的环境（jsdom 单测）
 *    低频轮询兜底。隐藏的标签不该每帧白量一次布局。
 * 8. **闲置休眠与上限**（`view-policy.ts`）：切走超过设定秒数就 `close` 掉原生视图，存活数超上限
 *    时淘汰最久没看的隐藏视图（设置项 `browserSleepAfterSec` / `browserMaxViews`，0 = 关）。
 *    销毁只发生在不可见时；重建后 `slept` 加一，调用方据此把后退 / 前进历史收敛成当前页。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { reaction } from 'mobx'
import { appliedZoomFactor } from '@/ui/hooks/applied-zoom'
import { settingsState } from '@/ui/store'
import {
  applyBrowserView,
  closeBrowserView,
  hasBrowserView,
  navigateBrowserView,
  openBrowserView,
  reloadBrowserView,
  type BrowserViewBounds,
} from '@/infrastructure/browser/browser-view'
import {
  noteBrowserView,
  refreshBrowserViewPolicy,
  setBrowserViewAwake,
  trackBrowserView,
} from './view-policy'

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
  /**
   * 原生视图因**闲置休眠**被销毁过的次数。变化即说明页面被重新加载过、原生历史栈已清空，
   * 调用方要把自己的后退 / 前进历史收敛成当前页（否则按钮指向已经不存在的页面）。
   */
  slept: number
}

/** 小于这个尺寸就算不可见（`display:none` 的元素 rect 正好是 0） */
const MIN_SIZE = 2

/** 位置变化小于这个值就不发命令（亚像素抖动没有意义，只是白跑一趟 IPC） */
const MIN_DELTA = 0.5

/**
 * 不可见时的轮询间隔（ms）：看得见才逐帧跑，看不见的标签不该每帧白量一次布局。
 * 有 `ResizeObserver` 的环境靠尺寸变化唤醒（不轮询），没有的环境（jsdom 单测）只能低频兜底。
 */
const IDLE_TICK_MS = 250

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
  /** 闲置休眠销毁视图的次数（见 `NativeBrowserView.slept`） */
  const [slept, setSlept] = useState(0)

  /**
   * 登记到存活策略表：什么时候真销毁由设置决定（切走超过 N 秒 / 存活数超出上限）。
   * ⚠️ 只销毁、不导航：`wantUrl` 留着，下一次可见时会带着同一地址重建。
   */
  useEffect(
    () =>
      trackBrowserView(label, () => {
        const state = stateRef.current
        // 在用的那一页绝不动（可见时 slept 也不算：此刻销毁等于无端刷新）
        if (!state.created || state.visible) return
        state.created = false
        state.creating = false
        setSlept((n) => n + 1)
        void closeBrowserView(label)
      }),
    [label],
  )

  /** 两个策略参数是设置项：改了就重排计时器并立刻淘汰一次 */
  useEffect(
    () =>
      reaction(
        () => [
          settingsState.value.browserSleepAfterSec,
          settingsState.value.browserMaxViews,
        ],
        () => refreshBrowserViewPolicy(),
      ),
    [],
  )

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
        setBrowserViewAwake(label, false)
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

  /**
   * 逐帧同步：量 rect → 建视图 / 改大小 / 显隐。组件卸载时销毁视图。
   *
   * 节奏：**看得见才逐帧**（面板宽度过渡 / 拖分隔条要跟手），整体不可见时停掉 rAF，改由
   * `ResizeObserver` 与 `visibilitychange` 唤醒 —— 隐藏的标签不该每帧白量一次布局。
   * 没有 `ResizeObserver` 的环境（jsdom 单测）没法靠尺寸变化唤醒，只能低频轮询兜底。
   */
  useEffect(() => {
    if (!hasBrowserView()) return
    const state = stateRef.current
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let observer: ResizeObserver | null = null
    let stopped = false

    /** 收起已排的下一拍（rAF 与低频轮询二选一，不允许两路同时跑） */
    function cancelScheduled(): void {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    function schedule(active: boolean): void {
      if (stopped) return
      cancelScheduled()
      if (active) frame = requestAnimationFrame(tick)
      else if (!observer) timer = setTimeout(tick, IDLE_TICK_MS)
    }

    /** 命中测试的最小间隔（ms） */
    const COVER_CHECK_MS = 100
    /** 上一次命中测试的结论与时间：rAF 每秒 60 次，结论却只在浮层开合时变 */
    let coverAt = 0
    let coverHit = false
    /**
     * 浮层都是 portal 到 body 的：body 的直接子节点一变（开 / 关一个浮层）就把结论标脏
     * 并立刻补一拍 —— 只靠 100ms 的定时降频，开设置页那一瞬会是「网页仍盖在上面」。
     * 回调在 DOM 变更后的微任务里跑（React 提交已结束），此时 setState 不会打断渲染。
     */
    const overlayWatcher =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => wake())
        : null
    if (overlayWatcher && document.body) {
      overlayWatcher.observe(document.body, { childList: true })
    }

    /** 外部唤醒（占位尺寸变了 / 窗口回到前台）：立刻补一拍，再按结论决定下一拍 */
    function wake(): void {
      if (stopped) return
      // 刚回到前台 / 刚显示：遮挡结论可能已经变了，下一拍强制重测
      coverAt = 0
      cancelScheduled()
      tick()
    }

    function tick(): void {
      if (stopped) return
      frame = 0
      timer = null

      const host = hostRef.current
      if (!host) {
        schedule(false)
        return
      }
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
      // 尺寸正常才值得做命中测试（rect 为 0 时中心点毫无意义）；降频到 10Hz —— 每帧一次
      // `elementFromPoint` 是一次强制命中测试，而结论只在浮层开合时变。
      if (!sized) {
        coverAt = 0
        coverHit = false
      } else if (coverAt === 0 || Date.now() - coverAt >= COVER_CHECK_MS) {
        coverAt = Date.now()
        coverHit = coveredByOverlay(host, rect)
      }
      const isCovered = sized && coverHit
      if (isCovered !== coveredRef.current) {
        coveredRef.current = isCovered
        setCovered(isCovered)
      }
      /** 窗口最小化 / 切到后台：画面本来就看不到，不必让视图悬着 */
      const documentHidden = document.visibilityState === 'hidden'
      const inUse = sized && !dragging && !isCovered && !!state.wantUrl
      const visible = inUse && !documentHidden
      // 存活策略：`inUse` 决定能不能被上限淘汰，`parked`（彻底不可见）才允许开始计闲置时间
      noteBrowserView(label, inUse, !sized || documentHidden)

      if (!state.created) {
        if (!visible || state.creating || state.failed) {
          schedule(sized && !documentHidden)
          return
        }
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
              setBrowserViewAwake(label, false)
              // 真正卸载（没任何新一轮接管）时，这个刚建好的视图必须收掉，否则泄漏
              if (!takenOver) void closeBrowserView(label)
              return
            }
            state.created = true
            state.visible = true
            state.bounds = bounds
            setError(null)
            // 建好了才允许计入「存活视图数」：超出上限时由策略关掉最久没看的隐藏视图
            setBrowserViewAwake(label, true)
            // 创建期间用户又换了地址：补一次导航（那次 effect 跑的时候 created 还是 false）
            if (state.wantUrl !== target) void navigateBrowserView(label, state.wantUrl)
          })
          .catch((reason: unknown) => {
            state.creating = false
            state.failed = true
            setBrowserViewAwake(label, false)
            if (!stopped) setError(reason instanceof Error ? reason.message : String(reason))
          })
        schedule(sized && !documentHidden)
        return
      }

      if (!sameBounds(state.bounds, bounds) || state.visible !== visible) {
        state.bounds = bounds
        state.visible = visible
        void applyBrowserView(label, bounds, visible)
      }
      schedule(sized && !documentHidden)
    }

    observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(wake) : null
    const host = hostRef.current
    if (observer && host) observer.observe(host)
    document.addEventListener('visibilitychange', wake)
    frame = requestAnimationFrame(tick)

    return () => {
      stopped = true
      cancelScheduled()
      observer?.disconnect()
      overlayWatcher?.disconnect()
      document.removeEventListener('visibilitychange', wake)
      state.created = false
      state.visible = false
      state.creating = false
      setBrowserViewAwake(label, false)
      // 这里只收拾眼前这一份；飞行中的 open 由它自己的 `.then` 在落地时收
      // （那里会先看 `state.creating`，避免把 StrictMode 下一轮刚建的视图杀掉）
      void closeBrowserView(label)
    }
  }, [label])

  return { hostRef, error, covered, slept }
}
