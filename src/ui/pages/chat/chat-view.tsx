/** 聊天主视图：只管 UI 状态，数据操作委托给 chat-service。 */
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react'
import { observer } from 'mobx-react-lite'
import type { Message, MessageContent } from '@/types'
import { v4 } from '@/utils/uuid'
import {
  chatState,
  getSessionRuntime,
  sessionRuntimeState,
  updateSessionRuntime,
  isSessionRuntimeBusy,
  agentStore,
} from '@/ui/store'
import {
  sendMessage,
  sendMessageWithGoal,
  cancelMessage,
  createSession,
  addSessionMessage,
  updateSessionMessage,
  activateSession,
} from '@/services/chat-service'
import ChatSidebar from './components/sidebar'
import ChatInput, {
  type FileAttachment,
  type ImageAttachment,
  type QuoteAttachment,
  type SkillAttachment,
} from './components/input'
import ProviderPrompt from './components/modals/provider-prompt'
import TodoEntry from './components/todo/TodoEntry'
import SearchDialog from './components/search'

import { useToolUI } from './components/tool-ui'
import HideSideBarSvg from '@/ui/components/icons/HideSideBarSvg'
import ShowSideBarSvg from '@/ui/components/icons/ShowSideBarSvg'
import SettingsView from '@/ui/pages/Settings/settings-view'
import { t, tpl } from '@/ui/i18n'
import settingsEvent from '@/events/settingsEvent'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import SearchSvg from '@/ui/components/icons/SearchSvg'
import './chat-view.scss'
import { settingsState } from '@/ui/store/settingStore'
import ChatMessageList, {
  type MessageJumpTarget,
} from './components/message/message-list'
import WelcomeScreen from './components/welcome'
import { appName } from '@/ui/constants'
import { sessionStore } from '@/ui/store'
import { openPath } from '@tauri-apps/plugin-opener'
import * as dialog from '@tauri-apps/plugin-dialog'
import { getMatch } from '@/utils/common'
import { getDefaultAgent } from '@/services/agent-service'
import { repairSessionIfNeeded } from '@/services/chat-service'
import { vision } from '@/infrastructure/vision'
import type { VisionAnalyzeResult } from '@/infrastructure/vision/types'
import { buildUserContent } from '@/utils/messageContent'
import type { MessageSearchItem } from '@/infrastructure/sessionRepo'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { createFrameBatcher } from '@/utils/frameBatch'
import { track, trackPerf, hashText } from '@/utils/telemetry'
/** 侧边栏宽度 localStorage 键名 */
const SIDEBAR_WIDTH_KEY = '_sidebar_width'

function getStoredWidth(): number {
  try {
    return parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '260', 10)
  } catch {
    return 260
  }
}

function storeWidth(w: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w))
  } catch { }
}
function WorkspaceDisplay({
  value,
  setValue,
  workspaces,
}: {
  value?: string
  setValue: (v: string) => void
  /** 可用的历史工作目录列表（无会话时下拉切换用） */
  workspaces?: string[]
}) {
  const sessionId = chatState.value.currentSessionId
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    if (!dropdownOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  async function handleClick() {
    if (sessionId) {
      // 有会话 → 打开文件夹
      if (!value) return
      await openPath(value)
    } else {
      // 无会话 → 选择工作目录
      await pickDirectory()
    }
  }

  async function pickDirectory() {
    try {
      const selected = await dialog.open({
        directory: true,
        multiple: false,
        defaultPath: value,
      })
      if (selected) {
        setValue(selected.replace(/\\/g, '/'))
      }
    } catch {
      // 非 Tauri 环境忽略
    }
  }

  const label = value
    ? value.split('/').pop()?.split('\\').pop()
    : t('选择目录')

  const showDropdown = !sessionId && workspaces && workspaces.length > 0
  return (
    <div
      className={`workspace-display${dropdownOpen ? ' menu-open' : ''}`}
      ref={dropdownRef}>
      <button
        className={`workspace-btn ${value ? 'has-path' : ''} ${showDropdown ? 'has-dropdown' : ''}`}
        onClick={handleClick}
        title={
          sessionId
            ? value
              ? tpl('打开工作目录：$__path__', { path: value })
              : t('该会话未设置工作目录')
            : value
              ? `${tpl('当前工作目录：$__path__', { path: value })}\n${t('点击更换')}`
              : t('点击选择工作目录')
        }
        type="button">
        <FolderSvg />
        {value && <span className="workspace-label">{label}</span>}
        {!value && <span className="workspace-placeholder">{label}</span>}
      </button>

      {/* 无会话时显示历史工作目录下拉按钮 */}
      {showDropdown && (
        <>
          <button
            className="workspace-dropdown-toggle"
            onClick={(e) => {
              e.stopPropagation()
              setDropdownOpen((prev) => !prev)
            }}
            title={t('切换历史工作目录')}
            type="button">
            <DropDownSvg />
          </button>
          {dropdownOpen && (
            <div
              className="workspace-dropdown-menu"
              onClick={(e) => e.stopPropagation()}>
              {workspaces.map((wp) => (
                <button
                  key={wp}
                  className={`workspace-dropdown-item ${wp === value ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setValue(wp)
                    setDropdownOpen(false)
                  }}
                  type="button"
                  title={wp}>
                  <FolderSvg />
                  <span className="workspace-dropdown-label">
                    {wp.split('/').pop()?.split('\\').pop()}
                  </span>
                  <span className="workspace-dropdown-path">{wp}</span>
                </button>
              ))}
              <div className="workspace-dropdown-divider" />
              <button
                className="workspace-dropdown-item browse"
                onClick={async (e) => {
                  e.stopPropagation()
                  setDropdownOpen(false)
                  await pickDirectory()
                }}
                type="button">
                <span className="workspace-dropdown-label">
                  {t('选择其他目录...')}
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ChatView() {
  const chatInputRef = useRef<{
    setText: (text: string) => void
    addQuote: (quote: QuoteAttachment) => void
    attachPaths: (paths: string[]) => void
    attachSkills: (names: string[]) => void
    detachSkills: (names: string[]) => void
  }>(null)
  const [showProviderPrompt, setShowProviderPrompt] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  /** 检索结果跳转目标（滚动定位 + 临时高亮），下发给消息列表 */
  const [searchJump, setSearchJump] = useState<MessageJumpTarget | null>(null)
  const searchJumpNonceRef = useRef(0)
  /**
   * 输入框当前引用的技能名（侧边栏技能卡片据此高亮）。
   * 真相在 ChatInput 里（它持有 SKILL.md 全文），这里只存名字镜像：输入框每次变化回传，发完消息自动清空。
   */
  const [referencedSkills, setReferencedSkills] = useState<string[]>([])
  // 工具交互弹窗（AI 提问 / 授权确认）：声明的是**元素**而不是组件类型 ——
  // 内联组件每次渲染都换类型会让待应答弹窗整体卸载重挂（草稿与输入焦点一起丢，见 tool-ui.tsx）
  const { toolUI } = useToolUI()
  const [sidebarWidth, setSidebarWidth] = useState(getStoredWidth())
  const resizingRef = useRef(false)
  const currentWidthRef = useRef(sidebarWidth)

  // 同步 ref 与 state
  useEffect(() => {
    currentWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  // Ctrl / Cmd + P 唤起消息检索弹窗（再次按下可关闭）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault() // 拦截 WebView 自带的打印
        setShowSearch((v) => !v)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Ctrl / Cmd + N 新建对话：等价于侧边栏「新对话」按钮（清空当前会话 → 回到新对话页）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // 只认纯 Ctrl/Cmd + N，避免与 Shift / Alt 组合冲突
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      // 用 code 兼容非拉丁键盘布局（俄语等布局下 e.key 不是 'n'）
      if (e.key?.toLowerCase() !== 'n' && e.code !== 'KeyN') return
      // 焦点在终端内时让路：终端里 Ctrl+N 是发给 PTY 的控制字符（readline 的「下一行」），
      // 而 xterm 不阻止冒泡 → 只能按事件目标跳过，否则会「一边发控制字符、一边新建对话」。
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
      e.preventDefault()
      chatState.set({ currentSessionId: null, error: null })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // 鼠标拖拽调整侧边栏宽度
  function handleResizerMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault()
    resizingRef.current = true

    const startX = e.clientX
    const startW = currentWidthRef.current
    // 侧边栏元素（.chat-view 的直接子元素），用于直接写 CSS 变量
    const sidebarEl =
      e.currentTarget
        .closest('.chat-view')
        ?.querySelector<HTMLElement>(':scope > .chat-sidebar') ??
      (e.currentTarget.previousElementSibling as HTMLElement | null)

    function applyWidth(w: number) {
      currentWidthRef.current = w
      sidebarEl?.style.setProperty('--width', `${w}px`)
    }

    // 拖拽期间禁用宽度过渡（inline 优先级最高，也不会被后续 render 的 className 覆盖）
    if (sidebarEl) sidebarEl.style.transition = 'none'

    function onMouseMove(ev: MouseEvent) {
      if (!resizingRef.current) return
      const newW = Math.max(180, Math.min(500, startW + ev.clientX - startX))
      applyWidth(newW)

      // 拖拽过程中实时切换折叠状态
      const shouldOpen = newW > 185
      if (shouldOpen !== chatState.value.sidebarOpen) {
        chatState.setValue('sidebarOpen', shouldOpen)
      }
    }

    function onMouseUp() {
      if (!resizingRef.current) return
      resizingRef.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (sidebarEl) sidebarEl.style.transition = ''
      // 只在拖拽结束时同步一次 React state + 持久化
      const finalW = currentWidthRef.current
      setSidebarWidth(finalW)
      storeWidth(finalW)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // 当会话列表变化时，确保当前会话 ID 存在
  const sessions = sessionStore.value.sessions
  /** 从所有会话中提取非空且唯一的历史工作目录 */
  const historyWorkspaces = useMemo(
    () =>
      [
        ...new Set(
          sessions.map((s) => s.workspace).filter((w): w is string => !!w),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [sessions],
  )
  useEffect(() => {
    const { currentSessionId } = chatState.value
    if (currentSessionId) {
      const exists = sessions.some((s) => s.id === currentSessionId)
      if (!exists) {
        chatState.setValue('currentSessionId', null)
      }
    }
  }, [sessions])

  // 无会话时自动折叠侧边栏，有会话时展开
  useLayoutEffect(() => {
    const hasSessions = sessions.length > 0
    if (hasSessions !== chatState.value.sidebarOpen) {
      chatState.setValue('sidebarOpen', hasSessions)
    }
  }, [sessions.length])

  /**
   * 稳定的 setText 回调。不要写成内联箭头：message-list 会把它包进 useCallback 作为
   * MessageBubble 的 onEdit，引用一变就绕过 memo → 流式期间所有可见气泡跟着重渲染。
   */
  const handleSetText = useCallback((text: string) => {
    chatInputRef.current?.setText(text)
  }, [])

  /** 输入框技能引用变化：内容一致时保留原数组引用，避免侧边栏无谓重渲 */
  const handleSkillsChange = useCallback((names: string[]) => {
    setReferencedSkills((prev) =>
      prev.length === names.length && prev.every((n, i) => n === names[i])
        ? prev
        : names,
    )
  }, [])

  /** 侧边栏技能卡片单击：未引用则引用，已引用则取消（开关语义） */
  const handleToggleSkill = useCallback(
    (name: string) => {
      if (referencedSkills.includes(name)) {
        chatInputRef.current?.detachSkills([name])
      } else {
        chatInputRef.current?.attachSkills([name])
      }
    },
    [referencedSkills],
  )

  /** 引用消息：把消息 id / 发送方 / 正文快照交给输入框挂成引用 chip。同「编辑」一样必须是稳定引用，否则会绕过 MessageBubble 的 memo。 */
  const handleQuote = useCallback((quote: QuoteAttachment) => {
    chatInputRef.current?.addQuote(quote)
  }, [])

  /**
   * 点击引用 chip：跳转定位到被引用的原消息。复用 Ctrl+P 检索的跳转通道（同一会话内滚动定位 +
   * 临时高亮，目标消息尚未加载时逐页回补）；原消息已被删除时找不到目标，静默不动。
   */
  const handleQuoteJump = useCallback((messageId: string) => {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    searchJumpNonceRef.current += 1
    setSearchJump({
      id: messageId,
      sessionId: sid,
      nonce: searchJumpNonceRef.current,
    })
  }, [])

  // 从 store 同步消息到 chatState（仅用于通知组件重渲染）
  const [messages, setMessages] = useState<Message[]>([])
  const applyMessagesUpdate = useCallback((sessionId: string) => {
    if (sessionId !== chatState.value.currentSessionId) return
    const s = sessionStore.getSession(sessionId)
    if (s) setMessages([...s.messages])
  }, [])
  /**
   * 帧合批（流式性能关键）：流式期间 onMessagesUpdate 按 chunk 触发（每秒上百次），逐次 setMessages
   * 会把「消息列表 + 气泡」的重渲染次数拉到与 chunk 同量级；合并到每帧一次后上限被钉在帧率，视觉无差别。
   */
  const messagesBatchRef = useRef<ReturnType<
    typeof createFrameBatcher<[string]>
  > | null>(null)
  if (!messagesBatchRef.current) {
    messagesBatchRef.current = createFrameBatcher(applyMessagesUpdate)
  }
  useEffect(() => () => messagesBatchRef.current?.cancel(), [])
  /** 高频路径（流式 chunk / 引擎事件）：帧合批 */
  const syncMessagesToUI = useCallback((sessionId: string) => {
    if (sessionId !== chatState.value.currentSessionId) return
    messagesBatchRef.current?.schedule(sessionId)
  }, [])
  /** 低频一次性路径（发送、图片分析结果回填）：立即生效，并丢弃排队中的旧更新 */
  const syncMessagesToUINow = useCallback(
    (sessionId: string) => {
      messagesBatchRef.current?.cancel()
      applyMessagesUpdate(sessionId)
    },
    [applyMessagesUpdate],
  )
  /**
   * 消息镜像的**兜底同步**。`messages` 是本地 state 镜像，过去只由「发起方传 events.onMessagesUpdate」
   * 驱动 —— 手机 bridge 的 `host.session.send` 拿不到组件回调闭包，改了 store 也刷不到视图
   * （「手机发消息，电脑端要切会话才看到」）。
   * 订 store 的 `messagesChanged`（消息 CRUD 的唯一收口点）后任何来源都会到达这里；走 rAF 合批，
   * 同帧内与 `onMessagesUpdate` 自动去重，流式性能不受影响。
   */
  useEffect(
    () => sessionStore.onMessagesChanged(syncMessagesToUI),
    [syncMessagesToUI],
  )
  // 当 currentSessionId 变为 null 时清空 messages（并丢弃未消费的检索跳转目标）
  useEffect(() => {
    if (!chatState.value.currentSessionId) {
      setMessages([])
      setSearchJump(null)
    }
  }, [chatState.value.currentSessionId])
  useEffect(() => {
    if (chatState.value.currentSessionId) {
      const sid = chatState.value.currentSessionId
      const rt = sessionRuntimeState.value.sessions[sid]
      repairSessionIfNeeded(sid, rt?.working || rt?.paused)
    }
  }, [chatState.value.currentSessionId])

  /** 最近一次「已由本组件处理」的会话切换目标 —— 让下面的兜底 effect 区分「自己人切的」与「外面直接改 store 切的」。 */
  const handledSessionRef = useRef<string | null>(null)

  /**
   * 会话切换的「外部入口」兜底：托盘唤起（`tray-service`）这类路径只会改 `chatState.currentSessionId`，
   * 拿不到本组件的 `handleSelectSession` → 表现为「窗口打开了、也确实跳到了那个会话，但消息列表是空的」
   * （既没触发 SQLite 懒加载，也没同步组件的 React 镜像）。统一收口：发现当前会话不是本组件切的，
   * 就走同一条切换逻辑。
   */
  useEffect(() => {
    const sid = chatState.value.currentSessionId
    if (!sid || sid === handledSessionRef.current) return
    void handleSelectSession(sid)
  }, [chatState.value.currentSessionId])

  async function handleSelectSession(sessionId: string) {
    const session = sessionStore.getSession(sessionId)
    if (!session) return
    // 先登记再干活：函数内部会再次写同值 currentSessionId，早登记可避免兜底 effect 与自身重入
    handledSessionRef.current = sessionId
    const fromSessionId = chatState.value.currentSessionId
    const switchStart =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    // 数据侧准备（清未读 / 懒加载 / 修复悬空 tool_calls / 锚点索引）与手机接口层共用同一入口
    // （`services/chat/session.ts::activateSession`），否则两份必然分叉。
    // ⚠️ 不 await：其中的「清未读」在首个 await 之前同步完成，时序与原实现一致
    const prep = activateSession(sessionId)
    chatState.setValue('currentSessionId', sessionId)
    // 切换会话时，从该会话的运行时状态恢复错误信息（跨会话不丢失）
    chatState.setValue('error', getSessionRuntime(sessionId).error)
    setMessages([...session.messages])
    // 消息到位后再渲染一次（悬空 tool_calls 的修复结果也在这里一并出现）
    const updated = await prep
    if (updated && chatState.value.currentSessionId === sessionId) {
      setMessages([...updated.messages])
    }
    const renderMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        switchStart,
    )
    const msgCount = updated?.messages.length ?? 0
    track('session.switch', {
      from_session_id: fromSessionId ? hashText(fromSessionId) : undefined,
      to_session_id: hashText(sessionId),
      msg_count: msgCount,
      render_ms: renderMs,
    })
    trackPerf('perf.session.switch', {
      session_id: hashText(sessionId),
      render_ms: renderMs,
      msg_count: msgCount,
    })
  }

  const hasEnabledProvider = settingsState.value.providers.some(
    (p) => p.enabled,
  )
  const currentRt = chatState.value.currentSessionId
    ? getSessionRuntime(chatState.value.currentSessionId)
    : null
  const isCurrentWorking = currentRt ? isSessionRuntimeBusy(currentRt) : false

  // 发送消息
  function handleSend(
    content: string,
    images?: ImageAttachment[],
    goal?: string,
    files?: FileAttachment[],
    quotes?: QuoteAttachment[],
    skills?: SkillAttachment[],
  ) {
    const hasAttachment =
      (images?.length ?? 0) > 0 ||
      (files?.length ?? 0) > 0 ||
      (quotes?.length ?? 0) > 0 ||
      (skills?.length ?? 0) > 0

    if (!hasEnabledProvider) {
      setShowProviderPrompt(true)
      return
    }

    // 如果当前正在回复，不允许重复发送
    if (isCurrentWorking) return

    let sessionId = chatState.value.currentSessionId

    // 无会话时需要确保有模型可选
    if (
      !sessionId &&
      !settingsState.availableModel(chatState.value.selectModel)
    ) {
      // 取第一个可用模型兜底
      const firstEnabled = settingsState.value.providers.find(
        (p) => p.enabled && p.models.length > 0,
      )
      if (!firstEnabled) {
        setShowProviderPrompt(true)
        return
      }
      chatState.setValue('selectModel', {
        providerConfigId: firstEnabled.id,
        modelId: firstEnabled.models[0],
      })
    }

    // 清除当前会话的错误状态（重新发送时）
    const clearSid = chatState.value.currentSessionId
    if (clearSid) updateSessionRuntime(clearSid, { error: null })
    chatState.setValue('error', null)
    doSend(sessionId, content, images, goal, files, quotes, skills)
  }

  async function doSend(
    sessionId: string | null,
    content: string,
    images?: ImageAttachment[],
    goal?: string,
    files?: FileAttachment[],
    quotes?: QuoteAttachment[],
    skills?: SkillAttachment[],
  ) {
    // 立即显示 loading
    chatState.setValue('loading', true)

    // 始终存原始数据：content = [{quote}, {text}, {image_url}, {file}, ...]
    // 图片带 base64；文件只存路径（不拷文件，交给 AI 按需读）；引用带发送方 + 消息 id + 正文快照
    const finalContent: MessageContent = buildUserContent(
      content,
      images ?? [],
      files ?? [],
      quotes ?? [],
      skills ?? [],
    )

    // 先保证有 session（无 session → 立即创建），让 UI 切换到聊天视图
    let sid = sessionId
    if (!sid) {
      const selectedAgentId = chatState.value.selectedAgentId
      const targetAgent = selectedAgentId
        ? agentStore.getAgent(selectedAgentId)
        : null
      const defaultAgent = targetAgent || (await getDefaultAgent())
      let model = chatState.value.selectModel
      if (!settingsState.availableModel(model)) {
        model = defaultAgent.defaultModel
        if (!settingsState.availableModel(model)) {
          model = settingsState.getAvailableModel()
        }
      }
      if (!model) {
        throw new Error(t('没有可用的模型'))
      }
      const { providerConfigId, modelId } = model
      const session = await createSession(
        t('新对话'),
        providerConfigId,
        modelId,
        defaultAgent,
        chatState.value.selectedWorkspace,
      )
      sid = session.id
      // 无会话时在输入区选的推理强度，落到新建会话的会话参数上
      if (chatState.value.selectReasoningEffort) {
        sessionStore.updateSession(session.id, {
          params: {
            ...session.params,
            reasoningEffort: chatState.value.selectReasoningEffort,
          },
        })
      }
      chatState.setValue('currentSessionId', sid)
      // 新建会话由本函数自己接管（消息随后由 addSessionMessage 逐个加入，内存即真相）；
      // 登记一下，避免兜底 effect 去数据库重新加载、把刚加的消息按旧内容覆盖回去
      handledSessionRef.current = sid
      setMessages([])
    }

    // 立即添加用户消息到会话，让 UI 立刻显示（含图片，不含分析结果）
    const userMsgId = v4()
    const userMessage: Message = {
      id: userMsgId,
      role: 'user',
      content: finalContent,
      timestamp: Date.now(),
    }
    addSessionMessage(sid, userMessage)
    syncMessagesToUINow(sid)

    // 视觉分析（此时用户已看到消息，后台分析不阻塞界面）
    let imageOptimize = false
    let imageAnalyzeResult: string | undefined

    if (
      images &&
      images.length > 0 &&
      settingsState.value.imageVisionAnalyzeOptimize
    ) {
      // 本地逐张识别期间点亮输入区指示器（「视觉分析中...」）。
      //
      // ⚠️ 用 `preparing` 而不是 `working`：后者是**并发锁**（`isSessionBusy`），写成它之后紧接着的
      //    `sendMessage` 会被自己的锁判成「该会话正在回复中」—— 用户消息已显示，却永远等不到回复。
      updateSessionRuntime(sid, { preparing: true })
      chatState.setValue('loadingText', t('视觉分析中...'))

      try {
        imageOptimize = true
        const analyses = await Promise.all(
          images.map((img) =>
            vision.analyzeBase64(img.url).catch((err): null => {
              console.error('vision_analyze failed:', err)
              return null
            }),
          ),
        )
        const validResults = analyses.filter(Boolean) as VisionAnalyzeResult[]
        if (validResults.length > 0) {
          // 按序号组装多图分析结果（让 AI 知道每张图对应哪段分析）：
          //   「用户上传了N张图片」+ 每张一节「第i张图片\n[分析结果]」
          const parts = validResults.map(
            (r, i) => tpl('第$__n__张图片\n$__text__', { n: i + 1, text: r.combined_text }),
          )
          imageAnalyzeResult =
            tpl('用户上传了$__count__张图片\n\n', { count: validResults.length }) + parts.join('\n\n')
        }
        if (!imageAnalyzeResult) imageOptimize = false
      } finally {
        // 本地准备阶段到此为止：识别成功 / 失败 / 抛错都必须解除，
        // 否则该会话会一直停在「忙碌」上（输入区再也发不出消息）
        updateSessionRuntime(sid, { preparing: false })
      }
    }

    // 分析完成后，更新已显示的消息，补上分析结果字段
    if (imageOptimize) {
      updateSessionMessage(sid, userMsgId, {
        imageVisionAnalyzeOptimize: true,
        imageVisionAnalyzeResult: imageAnalyzeResult,
      })
      syncMessagesToUINow(sid)
    }

    // 清除分析中的状态文本（sendMessage 会通过 onWorkingChange 自动设置）
    chatState.setValue('loadingText', '')

    // 公共事件回调
    const events = {
      onWorkingChange: (sid: string, working: boolean) => {
        chatState.setValue('loading', working)
        // 结束工作时清除 loadingText，避免「正在验证」残留到下次发送
        if (!working) chatState.setValue('loadingText', '')
        // AI 回复结束（无错误）→ 窗口未激活时闪烁提醒
        if (!working && !chatState.value.error) {
          // 非当前会话完成回复 → 侧边栏标记红点，引导用户前往查看
          if (sid !== chatState.value.currentSessionId) {
            updateSessionRuntime(sid, { hasNewReply: true })
          }
          requestAttentionIfUnfocused(
            undefined,
            settingsState.value.forceWindowActive,
          )
        }
      },
      onVerifyingChange: (sid: string, verifying: boolean) => {
        // 验证步骤时 working-indicator 显示「正在验证」
        chatState.setValue(
          'loadingText',
          verifying ? t('正在验证...') : '',
        )
      },
      onMessagesUpdate: (sid: string) => {
        syncMessagesToUI(sid)
      },
      onError: (sid: string, error: string) => {
        // 始终将错误存入会话运行时，跨会话切换不丢失
        updateSessionRuntime(sid, { error })
        // 仅当错误发生在当前会话时，同步到全局 chatState 以立即展示
        if (sid === chatState.value.currentSessionId) {
          chatState.setValue('error', error)
        }
      },
      onStreamEnd: () => { },
    }

    if (goal) {
      // 迭代模式：执行→验证→修复
      await sendMessageWithGoal(sid, finalContent, goal, events, {
        imageVisionAnalyzeOptimize: imageOptimize || undefined,
        imageVisionAnalyzeResult: imageAnalyzeResult,
        maxIterations: settingsState.value.maxIterations,
        skipUserMessage: true,
      })
    } else {
      // 普通模式
      await sendMessage(
        sid,
        finalContent,
        events,
        imageOptimize
          ? {
            imageVisionAnalyzeOptimize: true,
            imageVisionAnalyzeResult: imageAnalyzeResult,
          }
          : undefined,
        { skipUserMessage: true },
      )
    }
  }

  function handleGoToSettings() {
    setShowProviderPrompt(false)
    settingsEvent.emit('openSettings', 'provider')
  }

  function handleClosePrompt() {
    setShowProviderPrompt(false)
  }

  function handleCancel() {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    cancelMessage(sid)
  }

  /**
   * 检索结果点击：关弹窗、切到目标会话，再滚动定位 + 临时高亮该消息。
   * 必须等消息分页加载完成后再下发跳转目标，否则目标所在分页尚未就绪（scrollToMessage 靠
   * messagePaging 逐页回补）。
   */
  async function handleSearchSelect(item: MessageSearchItem) {
    setShowSearch(false)
    if (item.sessionId) {
      if (item.sessionId !== chatState.value.currentSessionId) {
        await handleSelectSession(item.sessionId)
      } else {
        // 同一会话：确保消息分页已在内存（通常已加载）
        await sessionStore.ensureMessagesLoaded(item.sessionId)
      }
    }
    searchJumpNonceRef.current += 1
    setSearchJump({
      id: item.id,
      sessionId: item.sessionId,
      nonce: searchJumpNonceRef.current,
    })
  }

  function toggleSidebar() {
    chatState.setValue('sidebarOpen', !chatState.value.sidebarOpen)
  }

  useEffect(() => {
    // 新对话
    if (!chatState.value.currentSessionId) {
      let agent = agentStore.getAgent(chatState.value.selectedAgentId)
      if (!agent) {
        agent = getDefaultAgent()
        chatState.setValue('selectedAgentId', agent.id)
      }

      chatState.set({
        selectModel: getMatch(
          [
            agent.defaultModel,
            chatState.value.selectModel,
            settingsState.value.defaultSelectModel,
          ].filter(Boolean),
          settingsState.availableModel,
        ),
        selectedWorkspace:
          agent.defaultWorkspace || settingsState.value.defaultWorkspace,
      })
    }
  }, [chatState.value.currentSessionId, settingsState.value.defaultWorkspace])
  useEffect(() => {
    if (!settingsState.availableModel(chatState.value.selectModel)) {
      chatState.setValue('selectModel', settingsState.getAvailableModel())
    }
  }, [chatState.value.selectModel])

  const currentTitle = chatState.value.currentSessionId
    ? sessionStore.getSession(chatState.value.currentSessionId)?.title ||
    t('对话')
    : appName

  return (
    <div className="chat-view">
      <ProviderPrompt
        visible={showProviderPrompt}
        onClose={handleClosePrompt}
        onGoToSettings={handleGoToSettings}
      />
      <ChatSidebar
        // @ts-ignore
        style={{ '--width': `${sidebarWidth}px` }}
        onSelectSession={handleSelectSession}
        // 目录树「引用 / 拖拽到输入框」→ 输入框附件（复用系统的文件链路）
        onAttachPaths={(paths) => chatInputRef.current?.attachPaths(paths)}
        // 技能卡片「引用 / 拖拽到输入框」→ 输入框技能附件（读 SKILL.md 全文）
        onAttachSkills={(names) => chatInputRef.current?.attachSkills(names)}
        // 已引用的技能卡片高亮 + 再点取消（引用状态由输入框回传）
        referencedSkills={referencedSkills}
        onToggleSkill={handleToggleSkill}
      />
      {chatState.value.sidebarOpen && (
        <div className="sidebar-resizer" onMouseDown={handleResizerMouseDown} />
      )}

      <div className="chat-main" style={{ position: 'relative' }}>
        <div className="chat-toolbar">
          <button className="toggle-sidebar-btn" onClick={toggleSidebar}>
            {chatState.value.sidebarOpen ? (
              <HideSideBarSvg />
            ) : (
              <ShowSideBarSvg />
            )}
          </button>
          <span className="chat-title">{currentTitle}</span>
          <div className="chat-toolbar-actions">
            <button
              className="toolbar-icon-btn"
              onClick={() => setShowSearch(true)}
              title={t('搜索消息')}
              type="button">
              <SearchSvg />
            </button>
            {/* 任务清单：唯一一份清单的入口（未完成数红点徽章 + 浮层编辑） */}
            {chatState.value.currentSessionId && (
              <TodoEntry sessionId={chatState.value.currentSessionId} />
            )}
            <WorkspaceDisplay
              value={
                chatState.value.currentSessionId
                  ? sessionStore.getSession(chatState.value.currentSessionId)
                    ?.workspace
                  : chatState.value.selectedWorkspace
              }
              setValue={(e) => {
                chatState.setValue('selectedWorkspace', e)
              }}
              workspaces={historyWorkspaces}
            />
            <SettingsView />
          </div>
        </div>

        {chatState.value.currentSessionId ? (
          <>
            <ChatMessageList
              messages={messages}
              setMessages={setMessages}
              setText={handleSetText}
              onQuote={handleQuote}
              onQuoteJump={handleQuoteJump}
              jumpTarget={searchJump}
            />
            <ChatInput
              ref={chatInputRef}
              sessionId={chatState.value.currentSessionId}
              onSend={handleSend}
              onCancel={handleCancel}
              onMessagesUpdate={syncMessagesToUI}
              onQuoteJump={handleQuoteJump}
              loading={isCurrentWorking}
              disabled={false}
              placeholder={t('输入消息...')}
              onSkillsChange={handleSkillsChange}
            />
          </>
        ) : (
          <div className="welcome-layout">
            <WelcomeScreen
              setText={handleSetText}
            />
            <ChatInput
              ref={chatInputRef}
              onSend={handleSend}
              onCancel={handleCancel}
              loading={false}
              disabled={false}
              placeholder={t('开始新的对话...')}
              onSkillsChange={handleSkillsChange}
            />
          </div>
        )}
      </div>

      {toolUI}

      {/* 消息检索弹窗（Ctrl / Cmd + P 唤起）：有会话只搜当前会话；无会话搜所有会话（条目带工作目录 + Agent 名） */}
      <SearchDialog
        visible={showSearch}
        scope={chatState.value.currentSessionId ? 'session' : 'global'}
        sessionId={chatState.value.currentSessionId}
        onClose={() => setShowSearch(false)}
        onSelect={handleSearchSelect}
      />
    </div>
  )
}

export default observer(ChatView)
