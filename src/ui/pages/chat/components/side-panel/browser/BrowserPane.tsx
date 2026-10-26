/**
 * BrowserPane — 右侧面板里的**网页标签**（开始页的「浏览器」或 `Ctrl + T` 打开）。
 *
 * 网页不在 `<iframe>` 里，而在**原生子 WebView** 里（`use-native-view.ts` + Rust
 * `src-tauri/src/browser_view.rs`）。这不是实现口味问题：
 * `X-Frame-Options: SAMEORIGIN`（virlen.cn 就是）对 iframe 是硬限制，浏览器只会给一片空白，
 * 拒绝原因只进控制台；Electron 桌面端的 `<webview>` 与这里的 child WebView 都是
 * **独立浏览上下文**，服务器不知道它被摆在界面哪一格，这套响应头不适用。
 *
 * 由此带来的四条新口径：
 *
 * 1. **地址栏显示的是真实地址**：页面自己跳转、服务端重定向、SPA 的 `pushState` 都由原生视图
 *    回传，这边不预测也不纠正。⚠️ **后退 / 前进归原生历史栈**：面板不维护历史条目，也不做
 *    「把重定向折成一条」这种压缩 —— 那类判据（两跳间隔短、又落回出发页）本质是猜，猜错就是
 *    **删掉用户真去过的页面**（快站点点两个链接能被并成一条；「登录后跳回原页」会被判成中转页）。
 *    Chromium 提交 302 时会替换进行中的那一条，`GoBack` 因此直接回到出发页；按钮可用性取
 *    `CanGoBack` / `CanGoForward`（口径见 §11.57 ⑮）。
 * 2. **切标签不卸载**（与容器同一条口径）：本组件一直挂着，非激活时 rect 为 0，
 *    宿主据此把原生视图 `hide` 掉 —— 页面、滚动位置、表单、登录都还在。
 *    **例外：闲置休眠** —— 切走超过设定秒数（默认 20，可关）会 `close` 掉原生视图省内存，
 *    切回来重建并重载当前地址（页面内状态丢，原生历史栈也空，按钮状态自然回到「不能后退」）。
 * 3. **导航是命令，不是受控值**：地址栏回车 → `navigate`，后退 / 前进 → 原生命令，页面自己改
 *    地址只更新地址栏。⚠️ 绝不为「地址变了」补一次导航 —— 那会跟原生后退打架（地址那一路刚把
 *    页面导到目标页，原生后退又把它退回去，落在中转页上再跳一次 = 「回退没用 / 又跳回去了」）。
 * 4. **下载一律拦下并告知**：原生子窗口没有浏览器那种下载栏，放行就等于「静默写进系统下载
 *    目录」（用户点一下只觉得没反应）；Rust 侧 `on_download` 取消后回传 `phase = "download"`，
 *    这里在面板顶部出一条提示，并给「在系统浏览器中打开」的出口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { t } from '@/ui/i18n'
import GlobeSvg from '@/ui/components/icons/GlobeSvg'
import ArrowRightSvg from '@/ui/components/icons/ArrowRightSvg'
import CloseThickSvg from '@/ui/components/icons/CloseThickSvg'
import ReloadSvg from '@/ui/components/icons/ReloadSvg'
import OpenExternalSvg from '@/ui/components/icons/OpenExternalSvg'
import { listenBrowserView } from '@/infrastructure/browser/browser-view'
import { normalizeAddress, type AddressProblem } from './url'
import { useNativeBrowserView } from './use-native-view'
import './style.scss'

interface Props {
  /**
   * 打开标签时给的地址（空串 = 空白页，地址栏等着输入）。
   * ⚠️ **只在挂载时读一次**：之后导航全归本组件（宿主的 `tab.url` 是它的镜像，
   * 每次导航会回调 `onNavigate` 写回去）。
   */
  initialUrl: string
  /** 真实地址变化（宿主据此更新标签标题的兑底地址 / tooltip） */
  onNavigate?: (url: string) => void
  /** 页面自己的 `document.title`（标签栏显示它；空标题不会上报） */
  onTitle?: (title: string) => void
  /** 关掉这个标签（与标签栏的 × 同一条路） */
  onClose: () => void
}

/** 地址被拒时给人看的一句话（`empty` 不弹：那是「还没输入」，不是错误） */
function problemText(reason: AddressProblem): string {
  // 写成 switch 而不是「reason → 文案」的常量表：这里的每条文案必须是 `t` + 字符串字面量，
  // 才会被 `side-panel-i18n-keys.test.ts` 扫到（铁律 7 的守卫只认字面量）。
  switch (reason) {
    case 'scheme':
      return t('只支持 http / https 地址')
    case 'credentials':
      return t('地址里不能带用户名或密码')
    case 'invalid':
      return t('地址无法解析')
    default:
      return ''
  }
}

/** 视图标签：一个网页标签一个，稳定即可（Rust 侧按它找视图） */
let viewSeq = 0
function nextViewLabel(): string {
  viewSeq += 1
  return `browser-view-${viewSeq}`
}

/** 原生视图建不起来的原因：`unavailable` 是「不在桌面应用里」，其余是命令自己的报错 */
function viewErrorText(reason: string): string {
  return reason === 'unavailable' ? t('网页视图只在桌面应用里可用') : reason
}

/** 加载兜底：页面打不开（DNS / 证书 / 连接被重置）时可能永远等不到 `finished` */
const LOAD_TIMEOUT_MS = 15_000

export default function BrowserPane({ initialUrl, onNavigate, onTitle, onClose }: Props) {
  /**
   * 页面上**真的显示着**的地址（空串 = 空白页）。只由视图回传驱动（外加地址栏提交那一下的
   * 乐观更新）—— 它不再是「我们要去哪儿」，只是「现在在哪儿」。
   */
  const [address, setAddress] = useState(initialUrl)
  /** 与 state 同步的镜像：回传事件可能连着来，回调里读 state 会读到上一帧的值 */
  const addressRef = useRef(address)
  /**
   * 地址栏里正在编辑的文本（`null` = 显示当前地址）。
   * 用「草稿 or 当前地址」而不是「每次导航把当前地址灌进 state」：导航之后
   * 地址栏必须立刻跟着换，而用户正在敲的字又不能被一次无关的重渲染冲掉。
   */
  const [draft, setDraft] = useState<string | null>(null)
  /** 上一次提交被拒的原因（改输入即清） */
  const [problem, setProblem] = useState<AddressProblem | null>(null)
  /** 页面正在加载（原生视图里没有东西可给我们看，至少给一条进度） */
  const [loading, setLoading] = useState(!!initialUrl)
  /** 原生历史栈能不能后退 / 前进（`null` = 平台还没上报 / 不上报，见 `canBack`） */
  const [historyState, setHistoryState] = useState<{ back: boolean; forward: boolean } | null>(
    null,
  )
  /**
   * 被拦下的下载（`null` = 没有）。`name` 可能为空（`blob:` / `data:` 下载拿不到文件名），
   * 提示里就不带文件名。**不自动消失**：用户不关就一直留着 ——「静默」正是要修掉的那个问题。
   */
  const [blocked, setBlocked] = useState<{ name: string; url: string } | null>(null)

  const viewLabelRef = useRef('')
  if (!viewLabelRef.current) viewLabelRef.current = nextViewLabel()
  const viewLabel = viewLabelRef.current

  const {
    hostRef,
    error: viewError,
    covered,
    navigate,
    reload,
    goBack,
    goForward,
  } = useNativeBrowserView({ label: viewLabel, initialUrl })

  /**
   * 回调存 ref：宿主每次渲染都会传新的箭头函数，把它们放进依赖数组会让监听
   * 「卸载 → 异步重注册」；事件恰好落在那个空档里就丢了（现象：地址栏不跟手）。
   */
  const onNavigateRef = useRef(onNavigate)
  const onTitleRef = useRef(onTitle)
  useEffect(() => {
    onNavigateRef.current = onNavigate
    onTitleRef.current = onTitle
  }, [onNavigate, onTitle])

  /** 地址真的变了才写 state 并上报宿主（同一地址重复回传不该引起重渲染） */
  const applyAddress = useCallback((next: string) => {
    if (addressRef.current === next) return
    addressRef.current = next
    setAddress(next)
    onNavigateRef.current?.(next)
  }, [])

  /**
   * 订阅网页侧变化：地址 / 标题 / 加载阶段 / 历史栈状态。
   */
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null

    void listenBrowserView((event) => {
      if (!alive || event.label !== viewLabel) return
      if (event.phase === 'title') {
        if (event.title) onTitleRef.current?.(event.title)
        return
      }
      if (event.phase === 'download') {
        // Rust 侧已经把这次下载取消了（没有落盘），这里只负责让用户看见
        setBlocked({
          name: typeof event.name === 'string' ? event.name : '',
          url: typeof event.url === 'string' ? event.url : '',
        })
        return
      }
      // 加载阶段只管进度条：地址一律由回传的 `url` 决定，不按阶段推断
      if (event.phase === 'started') setLoading(true)
      if (event.phase === 'finished') setLoading(false)
      // 历史栈状态跟着 `location`（提交那一刻）回传：这是按钮可用性的唯一来源
      if (typeof event.canBack === 'boolean' || typeof event.canForward === 'boolean') {
        setHistoryState({ back: event.canBack === true, forward: event.canForward === true })
      }
      if (event.url) applyAddress(event.url)
    }).then((fn) => {
      if (alive) unlisten = fn
      else fn()
    })
    return () => {
      alive = false
      unlisten?.()
    }
    // 只跟视图身份走：回调通过 ref 取最新值（见上面的注释）
  }, [applyAddress, viewLabel])

  /** 加载兜底：永远等不到 `finished` 时（打不开的站点）进度条不能一直转 */
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setLoading(false), LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [loading])

  /**
   * 原生历史栈能不能后退 / 前进。`null` = 当前平台不上报（非 Windows）：此时按「有地址就
   * 放行」兜底 —— 栈底 / 栈顶点一下顶多什么都不发生，绝不会把页面导到错的地方。
   * ⚠️ 除这两条之外不允许自己推算历史（那是上一版删数据 bug 的根源）。
   */
  const canBack = historyState ? historyState.back : !!address
  const canForward = historyState ? historyState.forward : !!address
  /** 地址栏里显示的文本：用户正在敲的就是草稿，否则是真当前地址 */
  const display = draft ?? address

  /** 地址栏回车：校验 → 加载（地址由页面回传后再落定，这里先乐观显示目标） */
  const submit = useCallback(() => {
    const check = normalizeAddress(draft ?? addressRef.current)
    if (check.kind === 'rejected') {
      // 空输入不算错误：什么都不做，焦点留在地址栏
      setProblem(check.reason === 'empty' ? null : check.reason)
      return
    }
    setDraft(null)
    setProblem(null)
    applyAddress(check.url)
    setLoading(true)
    navigate(check.url)
  }, [applyAddress, draft, navigate])

  /** 刷新：地址不变也要真的重载 */
  const refresh = useCallback(() => {
    if (!addressRef.current) return
    setLoading(true)
    reload()
  }, [reload])

  /**
   * 后退 / 前进：**只发原生命令**，结果由页面回传（地址、加载阶段、按钮状态）。
   * 这边不预设目标地址，也不按「历史条目」推算 —— 见文件头第 1、3 条。
   */
  const stepBack = useCallback(() => {
    if (!canBack) return
    setDraft(null)
    setProblem(null)
    setLoading(true)
    goBack()
  }, [canBack, goBack])

  const stepForward = useCallback(() => {
    if (!canForward) return
    setDraft(null)
    setProblem(null)
    setLoading(true)
    goForward()
  }, [canForward, goForward])

  /** 兜底出口：只在 http(s) 地址上给（`openUrl` 不接受别的协议，也是安全红线） */
  const openExternal = useCallback(() => {
    if (!address) return
    void openUrl(address)
  }, [address])

  /**
   * 被拦下那次下载的浏览器出口：优先下载链接本身（在系统浏览器里会真的开始下载），
   * 拿不到（`blob:` / `data:`）就退回当前页 —— 至少让用户自己去点。
   */
  const downloadTarget = blocked ? blocked.url || address : ''
  const openDownload = useCallback(() => {
    if (!downloadTarget) return
    void openUrl(downloadTarget)
  }, [downloadTarget])

  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <div className="browser-nav">
          <button
            type="button"
            className="browser-nav-btn"
            title={t('后退')}
            aria-label={t('后退')}
            disabled={!canBack}
            onClick={stepBack}>
            {/* 只有一枚右箭头图标，后退转 180°（几何只有一份，见 ArrowRightSvg） */}
            <ArrowRightSvg className="browser-glyph is-back" />
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={t('前进')}
            aria-label={t('前进')}
            disabled={!canForward}
            onClick={stepForward}>
            <ArrowRightSvg className="browser-glyph" />
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={t('重新加载')}
            aria-label={t('重新加载')}
            disabled={!address}
            onClick={refresh}>
            <ReloadSvg className="browser-glyph" />
          </button>
        </div>

        <input
          type="text"
          className="browser-address"
          // 地址栏自己是一段「正在编辑的输入」：焦点进来全选（浏览器口径）
          value={display}
          placeholder="https://virlen.cn"
          spellCheck={false}
          autoComplete="off"
          autoFocus={!address}
          aria-label={t('地址栏')}
          title={address}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setDraft(event.target.value)
            if (problem) setProblem(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
              return
            }
            // Esc = 放弃这次编辑，退回当前地址（不关面板：地址栏里按 Esc 的人想改的是字）
            if (event.key === 'Escape') {
              setDraft(null)
              setProblem(null)
              event.currentTarget.blur()
            }
          }}
        />

        <button
          type="button"
          className="browser-tool"
          title={t('在系统浏览器中打开')}
          aria-label={t('在系统浏览器中打开')}
          disabled={!address}
          onClick={openExternal}>
          <OpenExternalSvg className="browser-glyph" />
        </button>
        <button
          type="button"
          className="browser-tool"
          title={t('关闭')}
          aria-label={t('关闭')}
          onClick={onClose}>
          <CloseThickSvg className="browser-glyph is-close" />
        </button>
        {loading && <div className="browser-progress" aria-hidden="true" />}
      </div>

      {problem && problem !== 'empty' && (
        <div className="browser-error" role="alert">
          {problemText(problem)}
        </div>
      )}

      {/*
        下载被拦下的提示。为什么必须有这一条：视图是原生子窗口，浮在 HTML 之上，没有下载栏；
        不拦的话 WebView2 会直接把文件写进系统下载目录，用户只看到「点了没反应」。
        提示条本身上下推高内容区 → 原生视图下一帧跟着变位置（`browser-viewport` 逐帧同步）。
      */}
      {blocked && (
        <div className="browser-notice" role="status">
          <span className="browser-notice-text" title={blocked.name || undefined}>
            {t('网页尝试下载文件，已阻止')}
            {blocked.name && <span className="browser-notice-name">{blocked.name}</span>}
          </span>
          <button
            type="button"
            className="browser-notice-action"
            disabled={!downloadTarget}
            onClick={openDownload}>
            {t('在系统浏览器中打开')}
          </button>
          <button
            type="button"
            className="browser-tool"
            title={t('关闭')}
            aria-label={t('关闭')}
            onClick={() => setBlocked(null)}>
            <CloseThickSvg className="browser-glyph is-close" />
          </button>
        </div>
      )}


      <div className="browser-frame">
        {/*
          原生视图的挂载点：这里量出来的 rect 就是 WebView2 子视图的位置。
          视图建起来之后会**盖在它上面**，所以这里只留空状态 / 错误卡片 / 首帧占位。
        */}
        <div className="browser-viewport" ref={hostRef} aria-hidden="true">
          {!address ? (
            <div className="browser-empty">
              <span className="browser-empty-icon" aria-hidden="true">
                <GlobeSvg />
              </span>
              <p className="browser-empty-title">{t('在上面输入网址开始浏览')}</p>
              <p className="browser-empty-note">
                {t('仅支持 http / https 地址。')}
              </p>
            </div>
          ) : viewError ? (
            /* 视图建不起来（不在桌面应用里 / 命令报错）：至少把原因说清楚，并给出口 */
            <div className="browser-empty browser-blocked">
              <span className="browser-empty-icon" aria-hidden="true">
                <GlobeSvg />
              </span>
              <p className="browser-empty-title">{t('网页视图启动失败')}</p>
              <p className="browser-empty-note">{viewErrorText(viewError)}</p>
              <button type="button" className="browser-blocked-action" onClick={openExternal}>
                {t('在系统浏览器中打开')}
              </button>
            </div>
          ) : (
            /* 被 DOM 浮层盖住时视图已藏起来；遮罩是半透明的，这行字会透出来，干脆不画 */
            !covered && <div className="browser-pending">{t('正在加载…')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
