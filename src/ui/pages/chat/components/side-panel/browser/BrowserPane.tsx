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
 * 1. **地址栏显示的是真实地址**：页面自己跳转、服务端重定向都由 `on_page_load` 回传，
 *    不再有「已跳转，地址可能不准」那种将就状态；重定向走 `historyReplace`，
 *    免得「后退」退回去又被重定向回来、转圈。
 * 2. **切标签不卸载**（与容器同一条口径）：本组件一直挂着，非激活时 rect 为 0，
 *    宿主据此把原生视图 `hide` 掉 —— 页面、滚动位置、表单、登录都还在。
 *    **例外：闲置休眠** —— 切走超过设定秒数（默认 20，可关）会 `close` 掉原生视图省内存，
 *    切回来重建并重载当前地址（页面内状态丢，面板历史收敛成当前页），见 `view-policy.ts`。
 * 3. **地址是唯一的导航来源**：`url` 一变宿主就 `navigate`；同一地址再来一次算刷新
 *    （`reloadToken`），因为 `navigate` 到当前地址不会重新加载。
 * 4. **下载一律拦下并告知**：原生子窗口没有浏览器那种下载栏，放行就等于「静默写进系统下载
 *    目录」（用户点一下只觉得没反应）；Rust 侧 `on_download` 取消后回传 `phase = "download"`，
 *    这里在面板顶部出一条提示，并给「在系统浏览器中打开」的出口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { t } from '@/ui/i18n'
import GlobeSvg from '@/ui/components/icons/GlobeSvg'
import {
  historyBrowserView,
  listenBrowserView,
} from '@/infrastructure/browser/browser-view'
import {
  canGoBack,
  canGoForward,
  historyBack,
  historyCurrent,
  historyForward,
  historyGo,
  historyReplace,
  newHistory,
  normalizeAddress,
  type AddressProblem,
  type BrowserHistory,
} from './url'
import { useNativeBrowserView } from './use-native-view'
import './style.scss'

interface Props {
  /**
   * 打开标签时给的地址（空串 = 空白页，地址栏等着输入）。
   * ⚠️ **只在挂载时读一次**：之后导航全归本组件（宿主的 `tab.url` 是它的镜像，
   * 每次导航会回调 `onNavigate` 写回去；把它当成受控值会让每次导航重建历史）。
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

export default function BrowserPane({ initialUrl, onNavigate, onTitle, onClose }: Props) {
  const [history, setHistory] = useState<BrowserHistory>(() => newHistory(initialUrl))
  /**
   * 与 state 同步的镜像：页面回传的事件可能连着来，回调里读 state 会读到上一帧的值。
   */
  const historyRef = useRef(history)
  useEffect(() => {
    historyRef.current = history
  }, [history])
  /**
   * 地址栏里正在编辑的文本（`null` = 显示当前地址）。
   * 用「草稿 or 当前地址」而不是「每次导航把当前地址灌进 state」：后退 / 前进 / 重定向之后
   * 地址栏必须立刻跟着换，而用户正在敲的字又不能被一次无关的重渲染冲掉。
   */
  const [draft, setDraft] = useState<string | null>(null)
  /** 上一次提交被拒的原因（改输入即清） */
  const [problem, setProblem] = useState<AddressProblem | null>(null)
  /** 刷新计数：宿主据此真的重载（地址不变时这是唯一能触发重载的信号） */
  const [reloadKey, setReloadKey] = useState(0)
  /** 页面正在加载（原生视图里没有东西可给我们看，至少给一条进度） */
  const [loading, setLoading] = useState(!!initialUrl)
  /**
   * 我们发起、还没被页面回传兑现的导航。
   * 兑现时**替换**当前历史条目而不是追加：服务端重定向（A → B）不该在历史里留下 A。
   */
  const pendingRef = useRef<string | null>(null)
  /**
   * 被拦下的下载（`null` = 没有）。`name` 可能为空（`blob:` / `data:` 下载拿不到文件名），
   * 提示里就不带文件名。**不自动消失**：用户不关就一直留着 ——「静默」正是要修掉的那个问题。
   */
  const [blocked, setBlocked] = useState<{ name: string; url: string } | null>(null)

  const viewLabelRef = useRef('')
  if (!viewLabelRef.current) viewLabelRef.current = nextViewLabel()
  const viewLabel = viewLabelRef.current

  const url = historyCurrent(history)
  const { hostRef, error: viewError, covered, slept } = useNativeBrowserView({
    label: viewLabel,
    url,
    reloadToken: reloadKey,
  })
  /**
   * 原生视图被闲置休眠过（页面已重新加载）：原生历史栈没了，面板历史必须收敛成当前页 ——
   * 否则「后退 / 前进」指向的是已经不存在的页面，点了也只会没反应。
   */
  const sleptSeenRef = useRef(slept)
  useEffect(() => {
    if (sleptSeenRef.current === slept) return
    sleptSeenRef.current = slept
    pendingRef.current = null
    const next = newHistory(historyCurrent(historyRef.current))
    historyRef.current = next
    setHistory(next)
  }, [slept])
  const back = canGoBack(history)
  const forward = canGoForward(history)
  /** 地址栏里显示的文本：用户正在敲的就是草稿，否则是真当前地址 */
  const address = draft ?? url

  /**
   * 加载兜底：页面打不开（DNS / 证书 / 连接被重置）时可能永远等不到 `finished`，
   * 进度条不能就这么一直转下去 —— 到点就收，页面自己的错误页会说明情况。
   */
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setLoading(false), 15_000)
    return () => clearTimeout(timer)
  }, [loading])

  /**
   * 订阅网页侧变化：地址 / 标题 / 加载阶段。
   *
   * 页面自己跳转、服务端重定向、SPA 的 `pushState` 都由 WebView2 回传（`phase = location`），
   * 拿到就写回历史与地址栏 —— 地址栏从此显示的是**真实地址**。
   *
   * ⚠️ 回调存 ref：宿主每次渲染都会传新的箭头函数，把它们放进依赖数组会让这条监听
   * 「卸载 → 异步重注册」；事件恰好落在那个空档里就丢了（现象：地址栏不跟手）。
   */
  const onNavigateRef = useRef(onNavigate)
  const onTitleRef = useRef(onTitle)
  useEffect(() => {
    onNavigateRef.current = onNavigate
    onTitleRef.current = onTitle
  }, [onNavigate, onTitle])

  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null
    void listenBrowserView((event) => {
      if (!alive || event.label !== viewLabel) return
      if (event.phase === 'title') {
        if (event.title) onTitleRef.current?.(event.title)
        return
      }
      if (event.phase === 'finished') {
        setLoading(false)
        // 这次导航已经落地：后面的回传都是页面自己的事（新的历史条目）
        pendingRef.current = null
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
      if (!event.url) return
      const next = event.url
      // `started` 是加载阶段；`location` 只是地址变了（SPA 路由不会重加载）
      if (event.phase === 'started') setLoading(true)
      const current = historyRef.current
      if (historyCurrent(current) === next) return
      const pending = pendingRef.current
      const updated = pending !== null ? historyReplace(current, next) : historyGo(current, next)
      historyRef.current = updated
      setHistory(updated)
      onNavigateRef.current?.(historyCurrent(updated))
    }).then((fn) => {
      if (alive) unlisten = fn
      else fn()
    })
    return () => {
      alive = false
      unlisten?.()
    }
    // 只跟视图身份走：回调通过 ref 取最新值（见上面的注释）
  }, [viewLabel])

  /**
   * 落一次历史（后退 / 前进 / 地址栏提交的唯一出口）。
   * 地址真的变了才上报宿主；没变（= 又敲了一遍同一个地址）当刷新处理。
   */
  const applyHistory = useCallback(
    (next: BrowserHistory) => {
      const before = historyCurrent(history)
      const after = historyCurrent(next)
      historyRef.current = next
      setHistory(next)
      setDraft(null)
      setProblem(null)
      if (!after) {
        setLoading(false)
        return
      }
      // 这一笔是我们发起的：等页面回传时用它区分「重定向」与「页面自己跳走」
      pendingRef.current = after
      setLoading(true)
      if (after === before) setReloadKey((key) => key + 1)
      else onNavigate?.(after)
    },
    [history, onNavigate],
  )

  /** 地址栏回车：校验 → 记历史 → 加载 */
  const submit = useCallback(() => {
    const check = normalizeAddress(address)
    if (check.kind === 'rejected') {
      // 空输入不算错误：什么都不做，焦点留在地址栏
      setProblem(check.reason === 'empty' ? null : check.reason)
      return
    }
    // 新建标签页那条「空白」不是一页：第一个地址**替换**掉它而不是追加。
    // 追加的后果：后退会退到空串 → 视图被销毁（`use-native-view` 对空地址就是 close），
    // 永远等不到 `finished`，进度条只能等 15s 兜底才停。浏览器也是同一口径（空白页不在后退栈里）。
    const next = url ? historyGo(history, check.url) : historyReplace(history, check.url)
    applyHistory(next)
  }, [address, applyHistory, history, url])

  /** 刷新：地址不变也要真的重载（换 reloadKey + 记一次待兑现的导航） */
  const reload = useCallback(() => {
    if (!url) return
    pendingRef.current = url
    setLoading(true)
    // 与 applyHistory 同一条口径：待兑现的永远只有这一笔
    setReloadKey((key) => key + 1)
  }, [url])

  /**
   * 后退 / 前进：面板历史决定方向，页面自己的历史栈负责执行。
   * ⚠️ 目标是空白（历史里真留了空白条目，比如老板本留下的状态）时不置 `loading`：
   * 视图会因空地址被销毁，没有 `finished` 可等，进度条就会一直转。
   */
  const goBack = useCallback(() => {
    if (!back) return
    const next = historyBack(history)
    const target = historyCurrent(next)
    historyRef.current = next
    setHistory(next)
    setDraft(null)
    setProblem(null)
    pendingRef.current = target || null
    setLoading(!!target)
    if (target) void historyBrowserView(viewLabel, 'back')
  }, [back, history, viewLabel])

  const goForward = useCallback(() => {
    if (!forward) return
    const next = historyForward(history)
    const target = historyCurrent(next)
    historyRef.current = next
    setHistory(next)
    setDraft(null)
    setProblem(null)
    pendingRef.current = target || null
    setLoading(!!target)
    if (target) void historyBrowserView(viewLabel, 'forward')
  }, [forward, history, viewLabel])

  /** 兜底出口：只在 http(s) 地址上给（`openUrl` 不接受别的协议，也是安全红线） */
  const openExternal = useCallback(() => {
    if (!url) return
    void openUrl(url)
  }, [url])

  /**
   * 被拦下那次下载的浏览器出口：优先下载链接本身（在系统浏览器里会真的开始下载），
   * 拿不到（`blob:` / `data:`）就退回当前页 —— 至少让用户自己去点。
   */
  const downloadTarget = blocked ? blocked.url || url : ''
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
            disabled={!back}
            onClick={goBack}>
            ←
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={t('前进')}
            aria-label={t('前进')}
            disabled={!forward}
            onClick={goForward}>
            →
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={t('重新加载')}
            aria-label={t('重新加载')}
            disabled={!url}
            onClick={reload}>
            ↻
          </button>
        </div>

        <input
          type="text"
          className="browser-address"
          // 地址栏自己是一段「正在编辑的输入」：焦点进来全选（浏览器口径）
          value={address}
          placeholder="https://virlen.cn"
          spellCheck={false}
          autoComplete="off"
          autoFocus={!url}
          aria-label={t('地址栏')}
          title={url}
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
          disabled={!url}
          onClick={openExternal}>
          ↗
        </button>
        <button
          type="button"
          className="browser-tool is-close"
          title={t('关闭')}
          aria-label={t('关闭')}
          onClick={onClose}>
          ✕
        </button>
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
            ✕
          </button>
        </div>
      )}

      {loading && <div className="browser-progress" aria-hidden="true" />}

      <div className="browser-frame">
        {/*
          原生视图的挂载点：这里量出来的 rect 就是 WebView2 子视图的位置。
          视图建起来之后会**盖在它上面**，所以这里只留空状态 / 错误卡片 / 首帧占位。
        */}
        <div className="browser-viewport" ref={hostRef} aria-hidden="true">
          {!url ? (
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
