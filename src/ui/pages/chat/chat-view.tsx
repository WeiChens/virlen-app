/**
 * chat-view — 聊天主视图
 *
 * 只负责 UI 状态管理，数据操作委托给 chat-service。
 * 状态来源：chatState / settingsState / sessionStorage / sessionRuntimeState
 */
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
  agentStore,
} from '@/ui/store'
import {
  sendMessage,
  cancelMessage,
  createSession,
  addSessionMessage,
  updateSessionMessage,
} from '@/services/chat-service'
import ChatSidebar from './components/sidebar'
import ChatInput from './components/input'
import ProviderPrompt from './components/modals/provider-prompt'

import { useToolUI } from './components/tool-ui'
import HideSideBarSvg from '@/ui/components/icons/HideSideBarSvg'
import ShowSideBarSvg from '@/ui/components/icons/ShowSideBarSvg'
import SettingsView from '@/ui/pages/Settings/settings-view'
import { t, tpl } from '@/ui/i18n'
import settingsEvent from '@/events/settingsEvent'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import './chat-view.scss'
import { settingsState } from '@/ui/store/settingStore'
import ChatMessageList from './components/message/message-list'
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
  } catch {}
}
function WorkspaceDisplay({
  value,
  setValue,
  workspaces,
}: {
  value: string
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
  const chatInputRef = useRef<{ setText: (text: string) => void }>(null)
  const [showProviderPrompt, setShowProviderPrompt] = useState(false)
  const [pendingContent, setPendingContent] = useState<string | null>(null)
  const { ToolUI } = useToolUI()
  const [sidebarWidth, setSidebarWidth] = useState(getStoredWidth())
  const [dragging, setDragging] = useState(false)
  const resizingRef = useRef(false)
  const currentWidthRef = useRef(sidebarWidth)

  // 同步 ref 与 state
  useEffect(() => {
    currentWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  // 鼠标拖拽调整侧边栏宽度
  function handleResizerMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    resizingRef.current = true
    setDragging(true)
    const startX = e.clientX
    const startW = currentWidthRef.current

    function onMouseMove(ev: MouseEvent) {
      if (!resizingRef.current) return
      const newW = Math.max(180, Math.min(500, startW + ev.clientX - startX))
      currentWidthRef.current = newW
      setSidebarWidth(newW)

      // 拖拽过程中实时切换折叠状态
      const shouldOpen = newW > 185
      if (shouldOpen !== chatState.value.sidebarOpen) {
        chatState.setValue('sidebarOpen', shouldOpen)
      }
    }

    function onMouseUp() {
      if (!resizingRef.current) return
      resizingRef.current = false
      setDragging(false)
      storeWidth(currentWidthRef.current)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
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

  // 从 store 同步消息到 chatState（仅用于通知组件重渲染）
  const [messages, setMessages] = useState<Message[]>([])
  const syncMessagesToUI = useCallback((sessionId: string) => {
    if (sessionId !== chatState.value.currentSessionId) return
    const s = sessionStore.getSession(sessionId)
    if (s) setMessages([...s.messages])
  }, [])
  // 当 currentSessionId 变为 null 时清空 messages
  useEffect(() => {
    if (!chatState.value.currentSessionId) {
      setMessages([])
    }
  }, [chatState.value.currentSessionId])
  useEffect(() => {
    if (chatState.value.currentSessionId) {
      const sid = chatState.value.currentSessionId
      const rt = sessionRuntimeState.value.sessions[sid]
      repairSessionIfNeeded(sid, rt?.working || rt?.paused)
    }
  }, [chatState.value.currentSessionId])

  function handleSelectSession(sessionId: string) {
    const session = sessionStore.getSession(sessionId)
    if (!session) return
    chatState.setValue('currentSessionId', sessionId)
    chatState.setValue('error', null)
    setMessages([...session.messages])
  }

  const hasEnabledProvider = settingsState.value.providers.some(
    (p) => p.enabled,
  )
  const currentRt = chatState.value.currentSessionId
    ? getSessionRuntime(chatState.value.currentSessionId)
    : null
  const isCurrentWorking = currentRt?.working ?? false

  // 发送消息
  function handleSend(content: string, images?: { url: string }[]) {
    if (!hasEnabledProvider) {
      setPendingContent(content || (images ? '(图片)' : ''))
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
        setPendingContent(content || (images ? '(图片)' : ''))
        setShowProviderPrompt(true)
        return
      }
      chatState.setValue('selectModel', {
        providerConfigId: firstEnabled.id,
        modelId: firstEnabled.models[0],
      })
    }

    chatState.setValue('error', null)
    doSend(sessionId, content, images)
  }

  async function doSend(
    sessionId: string | null,
    content: string,
    images?: { url: string }[],
  ) {
    // ── 立即显示 loading ──
    chatState.setValue('loading', true)

    // ── 始终存原始数据：content = [{text}, {image_url}, ...] ──
    const finalContent: MessageContent = buildImageContent(
      content,
      images ?? [],
    )

    // ── 先保证有 session（无 session → 立即创建），让 UI 切换到聊天视图 ──
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
          if (!model) {
            throw new Error('没有可用的模型')
          }
        }
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
      chatState.setValue('currentSessionId', sid)
      setMessages([])
    }

    // ── 立即添加用户消息到会话，让 UI 立刻显示（含图片，不含分析结果） ──
    const userMsgId = v4()
    const userMessage: Message = {
      id: userMsgId,
      role: 'user',
      content: finalContent,
      timestamp: Date.now(),
    }
    addSessionMessage(sid, userMessage)
    syncMessagesToUI(sid)

    // ── 视觉分析（此时用户已看到消息，后台分析不阻塞界面） ──
    let imageOptimize = false
    let imageAnalyzeResult: string | undefined

    if (
      images &&
      images.length > 0 &&
      settingsState.value.imageVisionAnalyzeOptimize
    ) {
      // 激活 loading 状态，让 working-indicator 显示「视觉分析中」
      updateSessionRuntime(sid, { working: true })
      chatState.setValue('loadingText', t('视觉分析中...'))

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
        // 按序号组装多图分析结果，让 AI 知道每张图片对应哪个分析
        // 格式：
        //   用户上传了{N}张图片
        //
        //   第1张图片
        //   [分析结果]
        //
        //   第2张图片
        //   [分析结果]
        const parts = validResults.map(
          (r, i) => `第${i + 1}张图片\n${r.combined_text}`,
        )
        imageAnalyzeResult =
          `用户上传了${validResults.length}张图片\n\n` +
          parts.join('\n\n')
      }
      if (!imageAnalyzeResult) imageOptimize = false
    }

    // ── 分析完成后，更新已显示的消息，补上分析结果字段 ──
    if (imageOptimize) {
      updateSessionMessage(sid, userMsgId, {
        imageVisionAnalyzeOptimize: true,
        imageVisionAnalyzeResult: imageAnalyzeResult,
      })
      syncMessagesToUI(sid)
    }

    // ── 清除分析中的状态文本，sendMessage 会通过 onWorkingChange 自动设置 ──
    chatState.setValue('loadingText', '')

    // ── 调 sendMessage（跳过用户消息创建，直接从 AI 响应开始） ──
    await sendMessage(
      sid,
      finalContent,
      {
        onWorkingChange: (sid, working) => {
          chatState.setValue('loading', working)
        },
        onMessagesUpdate: (sid) => {
          syncMessagesToUI(sid)
        },
        onError: (sid, error) => {
          if (sid === chatState.value.currentSessionId) {
            chatState.setValue('error', error)
          }
        },
        onStreamEnd: () => {},
      },
      imageOptimize
        ? {
            imageVisionAnalyzeOptimize: true,
            imageVisionAnalyzeResult: imageAnalyzeResult,
          }
        : undefined,
      { skipUserMessage: true },
    )
  }

  /** 构建含图片的 MessageContent */
  function buildImageContent(
    text: string,
    images: { url: string }[],
  ): MessageContent {
    return [
      ...(text
        ? [{ type: 'text' as const, text }]
        : [{ type: 'text' as const, text: images.length > 1 ? tpl('分析这$__num__张图片', { num: images.length }) : t('分析这张图片') }]),
      ...images.map((img) => ({
        type: 'image_url' as const,
        image_url: { url: img.url, detail: 'auto' as const },
      })),
    ]
  }

  function handleGoToSettings() {
    setShowProviderPrompt(false)
    setPendingContent(null)
    settingsEvent.emit('openSettings', 'provider')
  }

  function handleClosePrompt() {
    setShowProviderPrompt(false)
    setPendingContent(null)
  }

  function handleCancel() {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    cancelMessage(sid)
  }

  function toggleSidebar() {
    chatState.setValue('sidebarOpen', !chatState.value.sidebarOpen)
  }

  // ==================== 工作目录展示 ====================

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
        className={
          dragging && chatState.value.sidebarOpen ? 'no-transition' : ''
        }
        // @ts-ignore
        style={{ '--width': `${sidebarWidth}px` }}
        onSelectSession={handleSelectSession}
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
              setText={(text) => chatInputRef.current?.setText(text)}
            />
            <ChatInput
              ref={chatInputRef}
              sessionId={chatState.value.currentSessionId}
              onSend={handleSend}
              onCancel={handleCancel}
              onMessagesUpdate={syncMessagesToUI}
              loading={isCurrentWorking}
              disabled={isCurrentWorking}
              placeholder={t('输入消息...')}
            />
          </>
        ) : (
          <div className="welcome-layout">
            <WelcomeScreen
              setText={(text) => chatInputRef.current?.setText(text)}
            />
            <ChatInput
              ref={chatInputRef}
              sessionId={null}
              onSend={handleSend}
              onCancel={handleCancel}
              loading={false}
              disabled={false}
              placeholder={t('开始新的对话...')}
            />
          </div>
        )}
      </div>

      <ToolUI />
    </div>
  )
}

export default observer(ChatView)
