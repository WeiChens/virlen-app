/**
 * tray-service — 托盘 / 后台化集成（前端的唯一出口）
 *
 * 只做两件事，都不碰窗口控制（窗口显隐与退出的权威在 Rust 侧的 `tray` 模块）：
 * 1. 把「谁在工作」推给 Rust —— 真源是 `sessionRuntimeState`，TS 与 Rust 两种引擎都经过它；
 * 2. 一次运行结束时通知 Rust（由 `chat/event-handler.ts::finishWorking` 调用），
 *    由 Rust 决定是否打扰用户、走哪条提醒通道。
 *
 * ⚠️ 「关闭窗口 = 隐藏到托盘」不在这里实现：Rust 拦 `WindowEvent::CloseRequested`
 * 直接 `hide()`，所以前端标题栏关闭按钮一行都不用改。
 */
import { reaction } from 'mobx'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauriAvailable } from '@/services/rust-engine'
import { t, ensureLanguageReady } from '@/ui/i18n'
import {
  chatState,
  sessionRuntimeState,
  sessionStore,
  settingsState,
} from '@/ui/store'

/** 托盘点击回传的事件名（对应 Rust 的 `tray::EVENT_ACTIVATE`，raw 事件，不进 AgentEventType 契约） */
const EVENT_ACTIVATE = 'tray:activate-session'

let inited = false
/** 上一轮「正在工作」的会话集合（用于向 Rust 推增量） */
let prevWorking = new Set<string>()

/**
 * 托盘命令统一入口。
 *
 * 托盘是**增强能力**：非 Tauri 环境（浏览器 dev / vitest）、命令不存在、调用失败
 * 一律静默 —— 绝不能影响聊天主流程。
 */
function inv(cmd: string, args?: Record<string, unknown>): void {
  if (!inited) return
  try {
    void invoke(cmd, args).catch(() => {})
  } catch {
    // 非 Tauri 环境忽略
  }
}

/** webview 此刻是否真的被激活（隐藏窗口 / 切到别的应用都是 false） */
function hasWebviewFocus(): boolean {
  return typeof document !== 'undefined' && document.hasFocus?.() === true
}

/**
 * 「用户此刻正看着这个会话」—— 只有前端能算出来。
 *
 * 两个条件缺一不可：窗口在前台（`document.hasFocus()`）+ 当前会话就是它。
 * 少了它会怎样：用户盯着屏幕看它回复完，Rust 只知道「窗口可见」（而它还会因
 * 焦点缓存读不准而判成未聚焦），于是照常推未读 ⇒ 屏幕上多出一个**清不掉**的红点
 * （用户已在看，不会再触发任何清除动作）。
 *
 * 用 DOM 焦点而不是 `getCurrentWindow().isFocused()`：后者走原生侧缓存的窗口事件，
 * 与 Rust 端 `window_focus()` 是同一份数据；这里要的是「webview 真的被激活」这个独立信号。
 */
function isViewingSession(sessionId?: string | null): boolean {
  return !!sessionId && chatState.value.currentSessionId === sessionId && hasWebviewFocus()
}

/**
 * 托盘**原生菜单 / tooltip**的文案。
 *
 * ⚠️ 托盘菜单是原生菜单，Rust 侧没有语言资源 —— i18n 必须由前端推（铁律 7）。
 * 带数量的文案在这里保留 `$__count__` 占位符（与 `tpl()` 同一约定），由 Rust 在数量变化时替换：
 * `t()` 只翻译、不替换占位符，所以拿到的是模板而不是成品文案。
 */
function trayLabels() {
  return {
    show: t('显示主窗口'),
    quit: t('退出 Virlen'),
    statusIdle: t('空闲'),
    statusWorking: t('正在工作（$__count__ 个会话）'),
    statusUnread: t('$__count__ 个会话有新回复'),
    tooltipHidden: t('Virlen（已隐藏到托盘，右键可退出）'),
    tooltipWorking: t('Virlen · 正在工作（$__count__）'),
    tooltipUnread: t('Virlen ● 有新回复（$__count__）'),
  }
}

/**
 * 推送设置 + 托盘文案。
 *
 * ⚠️ 必须先 `await ensureLanguageReady()`：切语言的“生效”在 `useLanguage()` 的
 * reaction 里异步完成，而本 reaction 注册更早（`main.ts` 的 init 早于 App 渲染）
 * ⇒ 不等待就一定拿到**旧语言**，托盘菜单会滞后一次。
 */
async function pushSettings(): Promise<void> {
  await ensureLanguageReady()
  inv('tray_sync_settings', {
    closeToTray: settingsState.value.closeToTray,
    notifyOnComplete: settingsState.value.notifyOnComplete,
    // 「强制激活窗口」：开着时窗口只是失焦就不另推系统通知（由 chat-view 强制激活），
    // 只有窗口已关到托盘才推 —— 判定在 Rust 侧 `notify::decide_remind`
    forceWindowActive: settingsState.value.forceWindowActive,
    labels: trayLabels(),
  })
}

/** 初始化（在 `main.ts::init()` 里调用一次；非 Tauri 环境自动跳过） */
export function initTrayService(): void {
  if (inited || !isTauriAvailable()) return
  inited = true

  // ① 设置同步（启动推一次 + 变更时推送）。
  //    Rust 侧默认值与此处一致；旧版本 localStorage 里没有这两个字段时，
  //    `StorageState` 构造时会用默认值补齐（见 utils/storageState.ts），所以无需迁移代码。
  reaction(
    () =>
      [
        settingsState.value.closeToTray,
        settingsState.value.notifyOnComplete,
        // 完成提醒的推送条件依赖它（见 pushSettings），必须在依赖里才能跟着重推
        settingsState.value.forceWindowActive,
        // 语言也在依赖里：切语言要重推文案（`t()` 读的是 i18n 模块内的 currentLang）
        settingsState.value.language,
      ] as const,
    () => {
      void pushSettings()
    },
    { fireImmediately: true },
  )

  // ② 工作状态 → Rust。
  //    用 reaction 而不是在 flow/engine 里逐点上报：`working` 有 5+ 处变更点
  //    （flow.ts 发送/恢复/取消、finishWorking…），逐点上报必然会漏；
  //    这里只观察 sessionRuntimeState，两种引擎通吃，且引擎层零改动（铁律 1/3）。
  reaction(
    () =>
      Object.entries(sessionRuntimeState.value.sessions)
        .filter(([, rt]) => rt.working)
        .map(([id]) => id)
        .sort()
        .join('|'),
    (key) => {
      const next = new Set(key ? key.split('|') : [])
      for (const id of next) {
        if (prevWorking.has(id)) continue
        inv('tray_set_working', {
          sessionId: id,
          working: true,
          title: sessionStore.getSession(id)?.title,
        })
      }
      for (const id of prevWorking) {
        if (next.has(id)) continue
        inv('tray_set_working', { sessionId: id, working: false })
      }
      prevWorking = next
    },
  )

  // ③ 用户切到某个会话 → 该会话未读清零（看过了就别再红点提醒）
  reaction(
    () => chatState.value.currentSessionId,
    (sessionId) => {
      if (sessionId) inv('tray_clear_attention', { sessionId })
    },
  )

  // ④ 托盘左键单击 → 切到「最早那条未读」的会话（Rust 侧已完成 show + focus）
  //
  // ⚠️ 这里**只改 store**，不在这里做懒加载 / 组件状态同步：那两件事必须落在
  // `chat-view` 的会话切换逻辑里（React 镜像 state 只有组件能改）。
  // 组件侧靠「外部入口兜底 effect」接住（见 `chat-view.tsx` 中 `handledSessionRef` 一段）——
  // 否则会出现「跳到该会话但消息列表是空的」。
  void listen<{ sessionId: string }>(EVENT_ACTIVATE, (event) => {
    const sessionId = event.payload?.sessionId
    if (!sessionId || !sessionStore.getSession(sessionId)) return
    chatState.setValue('currentSessionId', sessionId)
    inv('tray_clear_attention', { sessionId })
  }).catch(() => {
    // 非 Tauri 环境 / 事件系统不可用时忽略
  })

  // ⑤ 窗口重新回到前台（点任务栏 / 直接点窗口）→ 当前会话刚看完，清它的未读。
  //    没有这一步：「窗口失焦时跑完 → 推未读 → 用户点回来但没切会话」的红点会一直挂着。
  //    用 DOM `focus` 而不是 tauri 的窗口焦点事件：要的是 webview 真被激活。
  window.addEventListener('focus', () => {
    const sessionId = chatState.value.currentSessionId
    if (sessionId) inv('tray_clear_attention', { sessionId })
  })
}

/**
 * 通知 Rust「一次运行结束了」。
 *
 * 由 `chat/event-handler.ts::finishWorking()` 调用（两种引擎共用的唯一收口）。
 * `preview` 在 Phase 1 只进埋点，Phase 2 用作系统通知正文。
 */
export function trayNotifyCompleted(
  sessionId: string,
  opts: { title?: string; preview?: string; status: 'success' | 'error' },
): void {
  inv('tray_notify_completed', {
    sessionId,
    title: opts.title,
    preview: opts.preview,
    status: opts.status,
    // 「用户正看着这条回复」由前端判定（Rust 拿不到 currentSessionId）——
    // 缺失就会「盯着屏幕看它回复完，托盘却冒出一个清不掉的红点」
    viewing: isViewingSession(sessionId),
  })
}
