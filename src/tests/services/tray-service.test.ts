/**
 * tray-service 测试
 *
 * 覆盖：
 * - 非 Tauri 环境：不注册任何监听、不发任何命令（浏览器 dev / vitest 下必须零副作用）
 * - 设置同步：启动推一次 + 变更后立即推送（含 i18n 托盘文案，Rust 侧据此决定关闭/退出语义）
 * - 工作状态派生：0→1、1→2、2→0 时 `tray_set_working` 的调用序列（同会话只推一次，去重）
 * - 完成提醒：`tray_notify_completed` 的参数透传，含 `viewing`（「用户正看着这条回复」）
 * - 托盘左键单击：切到对应会话并清未读
 * - 窗口回到前台：清当前会话未读
 *
 * `tray-service` 的 `inited` 是模块级一次性标志，所以每个用例都要 `vi.resetModules()`
 * 后重新动态 import，才能拿到干净的模块实例。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Session } from '@/types'

/** 托盘点击事件的监听器（mock 的 listen 会写进来，测试用它模拟 Rust 发事件） */
const listeners = new Map<string, (event: { payload: unknown }) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb)
    return Promise.resolve(() => {})
  }),
}))

/** 模拟/取消 Tauri 运行环境（`isTauriAvailable()` 读的就是这个字段） */
function setTauriEnv(on: boolean): void {
  if (on) {
    ;(globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  } else {
    delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

/**
 * 模拟 webview 焦点。
 * `document.hasFocus()` 在 jsdom 下不可控，直接替换成一个可控实现（`afterEach` 里删掉恢复）。
 * tray-service 靠它算「用户是否正在看这个会话」（`viewing`）。
 */
function mockHasFocus(value: boolean): void {
  Object.defineProperty(document, 'hasFocus', {
    value: () => value,
    configurable: true,
    writable: true,
  })
}

/**
 * 重新加载模块图，返回同一实例上的托盘服务 / 状态仓库 / invoke mock。
 *
 * 必须一起返回：`vi.resetModules()` 后 mock 工厂会重建，测试里顶层 import 的
 * `invoke` 与被测模块用的**不是同一个** vi.fn。
 */
async function freshModules() {
  vi.resetModules()
  const core = await import('@tauri-apps/api/core')
  const store = await import('@/ui/store')
  const tray = await import('@/services/tray-service')
  return { inv: vi.mocked(core.invoke), ...store, ...tray }
}

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0, topP: 1, maxTokens: 0, stream: true },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    tags: [],
  }
}

/**
 * 只取 `tray_*` 调用。
 *
 * 不能直接断言 `invoke` 的总调用次数：`sessionStore` 的落库是防抖的
 * （`cmd_upsert_session` 会稍后自己冒出来），会污染计数。
 */
function trayCalls(inv: { mock: { calls: unknown[][] } }): unknown[][] {
  return inv.mock.calls.filter(([cmd]) => String(cmd).startsWith('tray_'))
}

describe('tray-service', () => {
  beforeEach(() => {
    listeners.clear()
    setTauriEnv(false)
  })

  afterEach(() => {
    setTauriEnv(false)
    // 删掉测试里替换的 hasFocus，恢复 jsdom 原生实现
    delete (document as unknown as Record<string, unknown>).hasFocus
  })

  // 该用例要动态加载整个模块图（tray-service → i18n → react），全量并发跑时容易超过默认 5s
  it('非 Tauri 环境：不发任何托盘命令', async () => {
    const { inv, initTrayService, trayNotifyCompleted, updateSessionRuntime } =
      await freshModules()
    inv.mockClear()

    initTrayService()
    updateSessionRuntime('s1', { working: true })
    trayNotifyCompleted('s1', { status: 'success' })

    expect(inv).not.toHaveBeenCalled()
  }, 20000)

  it('设置同步：启动推一次，变更后再推', async () => {
    setTauriEnv(true)
    const { inv, initTrayService, settingsState } = await freshModules()
    // 先固定基线值（localStorage 可能残留其它用例写过的值），此时 reaction 尚未注册
    settingsState.setValue('closeToTray', true)
    settingsState.setValue('notifyOnComplete', true)
    inv.mockClear()

    // fireImmediately：启动即推一次（含 i18n 后的托盘文案），Rust 侧才拿得到用户的真实选择。
    // 推送前会 `await ensureLanguageReady()`（见 tray-service::pushSettings），故等一个微任务
    initTrayService()
    // 只查 `tray_sync_settings`：本文件共享同一份 localStorage，可能残留其它用例的状态
    //   （多出 `tray_clear_attention` / `tray_set_working`），断言总条数不稳定
    const syncCalls = () =>
      trayCalls(inv).filter(([cmd]) => cmd === 'tray_sync_settings')
    await vi.waitFor(() => expect(syncCalls()).toHaveLength(1))
    const firstArgs = syncCalls()[0][1] as Record<string, any>
    expect(firstArgs).toMatchObject({
      closeToTray: true,
      notifyOnComplete: true,
    })
    // 托盘文案由前端推（Rust 无语言资源）；带数量的文案必须保留 `$__count__` 占位符，
    // 否则 Rust 替换不到、数量就丢了（zh-CN 下 t() 返回 key 本身）
    expect(firstArgs.labels.statusWorking).toBe(
      '正在工作（$__count__ 个会话）',
    )
    expect(firstArgs.labels.show).toBe('显示主窗口')

    // 用户关掉「关闭即隐藏」→ 立即推送（Rust 侧据此把关闭按钮变回真退出）
    inv.mockClear()
    settingsState.setValue('closeToTray', false)
    await vi.waitFor(() =>
      expect(inv).toHaveBeenCalledWith(
        'tray_sync_settings',
        expect.objectContaining({ closeToTray: false, notifyOnComplete: true }),
      ),
    )

    // 用户关掉「完成提醒」
    inv.mockClear()
    settingsState.setValue('notifyOnComplete', false)
    await vi.waitFor(() =>
      expect(inv).toHaveBeenCalledWith(
        'tray_sync_settings',
        expect.objectContaining({
          closeToTray: false,
          notifyOnComplete: false,
        }),
      ),
    )
  })

  it('工作状态派生：开始/结束各推一次，字段变化不重复推', async () => {
    setTauriEnv(true)
    const { inv, initTrayService, sessionStore, updateSessionRuntime } =
      await freshModules()
    sessionStore.saveSession(makeSession('s1', '会话一'))
    sessionStore.saveSession(makeSession('s2', '会话二'))
    inv.mockClear()

    initTrayService()
    // 启动时会先推一次设置（fireImmediately）；推送前 await 语言包就绪，故用 waitFor。
    // 只查设置那一条：可能残留其它用例的 working 会话（会多推 tray_set_working）
    await vi.waitFor(() =>
      expect(
        trayCalls(inv).filter(([cmd]) => cmd === 'tray_sync_settings'),
      ).toHaveLength(1),
    )
    expect(inv).toHaveBeenCalledWith(
      'tray_sync_settings',
      expect.objectContaining({ closeToTray: true, notifyOnComplete: true }),
    )

    // s1 开始工作 → 带标题推一次
    inv.mockClear()
    updateSessionRuntime('s1', { working: true })
    expect(trayCalls(inv)).toHaveLength(1)
    expect(inv).toHaveBeenCalledWith(
      'tray_set_working',
      expect.objectContaining({ sessionId: 's1', working: true, title: '会话一' }),
    )

    // 同一会话的流式内容变化 → 不重复推
    inv.mockClear()
    updateSessionRuntime('s1', { pendingContent: '增量' })
    expect(trayCalls(inv)).toHaveLength(0)

    // s2 开始工作 → 只推 s2（s1 不重复）
    inv.mockClear()
    updateSessionRuntime('s2', { working: true })
    expect(trayCalls(inv)).toHaveLength(1)
    expect(inv).toHaveBeenCalledWith(
      'tray_set_working',
      expect.objectContaining({ sessionId: 's2', working: true }),
    )

    // 两个都结束 → 各推一次 false
    inv.mockClear()
    updateSessionRuntime('s1', { working: false })
    updateSessionRuntime('s2', { working: false })
    expect(trayCalls(inv)).toHaveLength(2)
    expect(inv).toHaveBeenCalledWith('tray_set_working', {
      sessionId: 's1',
      working: false,
    })
    expect(inv).toHaveBeenCalledWith('tray_set_working', {
      sessionId: 's2',
      working: false,
    })
  })

  it('完成提醒：title / preview / status / viewing 原样透传', async () => {
    setTauriEnv(true)
    mockHasFocus(false)
    const { inv, initTrayService, chatState, trayNotifyCompleted } =
      await freshModules()
    initTrayService()
    inv.mockClear()

    // 窗口不在前台（用户没在看）→ viewing=false，交由 Rust 决定是否提醒
    chatState.setValue('currentSessionId', 's9')
    trayNotifyCompleted('s9', {
      title: '会话九',
      preview: '总结：已完成',
      status: 'error',
    })
    expect(inv).toHaveBeenCalledWith('tray_notify_completed', {
      sessionId: 's9',
      title: '会话九',
      preview: '总结：已完成',
      status: 'error',
      viewing: false,
    })

    // 正在看这个会话 + 窗口在前台 → viewing=true（Rust 据此不推未读红点）
    inv.mockClear()
    mockHasFocus(true)
    trayNotifyCompleted('s9', { status: 'success' })
    expect(inv).toHaveBeenCalledWith(
      'tray_notify_completed',
      expect.objectContaining({ sessionId: 's9', viewing: true }),
    )

    // 前台但看的是别的会话 → viewing=false（这条回复用户确实还没看到）
    inv.mockClear()
    chatState.setValue('currentSessionId', 'other')
    trayNotifyCompleted('s9', { status: 'success' })
    expect(inv).toHaveBeenCalledWith(
      'tray_notify_completed',
      expect.objectContaining({ sessionId: 's9', viewing: false }),
    )
  })

  it('托盘左键单击：切到该会话并清未读', async () => {
    setTauriEnv(true)
    const { inv, initTrayService, sessionStore, chatState } =
      await freshModules()
    sessionStore.saveSession(makeSession('s1', '会话一'))
    initTrayService()
    inv.mockClear()

    const onActivate = listeners.get('tray:activate-session')
    expect(onActivate).toBeTypeOf('function')

    onActivate!({ payload: { sessionId: 's1' } })
    expect(chatState.value.currentSessionId).toBe('s1')
    expect(inv).toHaveBeenCalledWith('tray_clear_attention', {
      sessionId: 's1',
    })

    // 会话不存在（已删除）→ 不动当前会话
    inv.mockClear()
    chatState.setValue('currentSessionId', 's1')
    onActivate!({ payload: { sessionId: '已删除' } })
    expect(chatState.value.currentSessionId).toBe('s1')
    expect(trayCalls(inv)).toHaveLength(0)
  })

  it('用户切会话 → 清该会话未读', async () => {
    setTauriEnv(true)
    const { inv, initTrayService, chatState } = await freshModules()
    initTrayService()
    inv.mockClear()

    chatState.setValue('currentSessionId', 's7')
    expect(inv).toHaveBeenCalledWith('tray_clear_attention', {
      sessionId: 's7',
    })
  })

  it('窗口回到前台 → 清当前会话未读', async () => {
    setTauriEnv(true)
    const { inv, initTrayService, chatState } = await freshModules()
    initTrayService()
    chatState.setValue('currentSessionId', 's8')
    inv.mockClear()

    // 窗口失焦时跑完 → 推了未读；用户点回窗口但不切会话，也要清掉当前会话的未读
    window.dispatchEvent(new Event('focus'))
    expect(inv).toHaveBeenCalledWith('tray_clear_attention', {
      sessionId: 's8',
    })
  })
})
