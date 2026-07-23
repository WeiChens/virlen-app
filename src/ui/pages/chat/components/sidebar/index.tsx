/**
 * sidebar — 会话侧边栏
 * 每个会话显示 working 状态指示（流式回复中）
 * 支持按 Agent 分组展示
 * 支持导出会话为 Markdown
 * 支持会话置顶
 * 支持导入会话到知识库
 * 操作统一收拢到「更多」菜单
 */
import { useState, useMemo, useCallback, useEffect, useRef, JSX } from 'react'
import { observer } from 'mobx-react-lite'
import type { Session, Message } from '@/types'
import {
  chatState,
  getSessionRuntime,
  sessionStore,
  agentStore,
  settingsState,
} from '@/ui/store'
import AddSvg from '@/ui/components/icons/AddSvg'
import MoreSvg from '@/ui/components/icons/MoreSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import AgentSvg from '@/ui/components/icons/AgentSvg'
import PinSvg from '@/ui/components/icons/PinSvg'
import EditSvg from '@/ui/components/icons/EditSvg'
import ExportSvg from '@/ui/components/icons/ExportSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import ExportDialog from '@/ui/pages/chat/components/modals/ExportDialog'
import { exportSessionToFile } from '@/services/export-service'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { t, tpl } from '@/ui/i18n'
import './style.scss'
import { timeFormat } from '@/utils/time'
import useTime from '@/ui/hooks/useTime'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import settingsEvent from '@/events/settingsEvent'
import { openPath } from '@tauri-apps/plugin-opener'
import { ragService } from '@/services/rag-service'
import type { KnowledgeBase } from '@/domain/ports'

interface Props {
  onSelectSession: (sessionId: string) => void
  style?: React.CSSProperties
  className?: string
}

/** 未分组会话的虚拟 key */
const UNGROUPED_KEY = '__ungrouped__'

type SessionGroup = {
  key: string
  name: string
  icon: string
  /** 悬停提示文本：Agent 简介 或 工作目录完整路径 */
  title: string
  sessions: Session[]
}

/**
 * 将会话列表按 Agent 分组
 */
function groupSessionsByAgent(sessions: Session[]): SessionGroup[] {
  const groupMap = new Map<string, SessionGroup>()

  for (const session of sessions) {
    const key = session.agentId || UNGROUPED_KEY
    let group = groupMap.get(key)
    if (!group) {
      let name: string
      let title: string
      if (key === UNGROUPED_KEY) {
        name = t('未分组')
        title = t('未关联 Agent 的会话')
      } else {
        const agent = agentStore.getAgent(key)
        name = agent?.name || t('未知代理')
        title = agent?.description || name
      }
      group = { key, name, icon: 'agent', title, sessions: [] }
      groupMap.set(key, group)
    }
    group.sessions.push(session)
  }

  return Array.from(groupMap.values()).sort((a, b) => {
    const aKnown = a.key !== UNGROUPED_KEY && !!agentStore.getAgent(a.key)
    const bKnown = b.key !== UNGROUPED_KEY && !!agentStore.getAgent(b.key)
    if (aKnown !== bKnown) return aKnown ? -1 : 1
    if (a.key === UNGROUPED_KEY) return 1
    if (b.key === UNGROUPED_KEY) return -1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

/**
 * 将会话列表按工作目录分组
 */
function groupSessionsByWorkspace(sessions: Session[]): SessionGroup[] {
  const groupMap = new Map<string, SessionGroup>()

  for (const session of sessions) {
    const key = session.workspace || UNGROUPED_KEY
    let group = groupMap.get(key)
    if (!group) {
      const name =
        key === UNGROUPED_KEY
          ? t('未设置工作目录')
          : key.split(/[/]|[\\]/).pop() || key
      const title =
        key === UNGROUPED_KEY
          ? t('未设置工作目录的会话')
          : tpl('工作目录: $__path__', { path: key })
      group = { key, name, icon: 'folder', title, sessions: [] }
      groupMap.set(key, group)
    }
    group.sessions.push(session)
  }

  return Array.from(groupMap.values()).sort((a, b) => {
    if (a.key === UNGROUPED_KEY) return 1
    if (b.key === UNGROUPED_KEY) return -1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

function ChatSidebar({ onSelectSession, style, className = '' }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [expandGroups, setExpandGroups] = useState<Record<string, boolean>>({})
  const [exportSessionId, setExportSessionId] = useState<string | null>(null)
  /** 当前打开的「更多」菜单 sessionId */
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ===== 导入知识库状态 =====
  const [showImportModal, setShowImportModal] = useState(false)
  const [importSessionId, setImportSessionId] = useState<string | null>(null)
  const [kbList, setKbList] = useState<KnowledgeBase[]>([])
  const [selectedKbId, setSelectedKbId] = useState<string>('')
  const [importLoading, setImportLoading] = useState(false)
  const [importKbLoading, setImportKbLoading] = useState(false)
  /** 用户选择要导入的消息 ID 集合（默认全选） */
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set())

  const sessions = sessionStore.listSessions()
  const sessionGroupType = settingsState.value.sessionGroupType
  const groups = useMemo(
    () =>
      sessionGroupType === 'workspace'
        ? groupSessionsByWorkspace(sessions)
        : groupSessionsByAgent(sessions),
    [sessions, sessionGroupType],
  )

  // 点击菜单外部关闭
  useEffect(() => {
    if (!activeMenuId) return
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenuId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [activeMenuId])

  const handleNewSession = useCallback(() => {
    chatState.set({ currentSessionId: null, error: null })
  }, [])

  const handleNewSessionInGroup = useCallback(
    (group: SessionGroup) => {
      if (sessionGroupType === 'workspace' && group.key !== UNGROUPED_KEY) {
        // 先清空 agent，让 useEffect 取到默认 agent 后
        // 再用 setTimeout 在 effect 之后覆盖 workspace
        chatState.setValue('selectedAgentId', '')
        chatState.setValue('selectedWorkspace', group.key)
        chatState.set({ currentSessionId: null, error: null })
        setTimeout(
          () => chatState.setValue('selectedWorkspace', group.key),
          0,
        )
      } else if (
        sessionGroupType === 'agent' &&
        group.key !== UNGROUPED_KEY
      ) {
        // 设置 agent，并确保 agent 的 defaultWorkspace 被带上
        chatState.setValue('selectedAgentId', group.key)
        chatState.setValue('selectedWorkspace', '')
        chatState.set({ currentSessionId: null, error: null })
        const agent = agentStore.getAgent(group.key)
        if (agent?.defaultWorkspace) {
          setTimeout(
            () =>
              chatState.setValue(
                'selectedWorkspace',
                agent.defaultWorkspace!,
              ),
            0,
          )
        }
      }
    },
    [sessionGroupType],
  )

  const handleSelect = useCallback(
    (sessionId: string) => {
      chatState.setValue('currentSessionId', sessionId)
      onSelectSession(sessionId)
    },
    [onSelectSession],
  )

  const handleDelete = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    setActiveMenuId(null)
    sessionStore.deleteSession(sessionId)
    if (chatState.value.currentSessionId === sessionId) {
      chatState.set({ currentSessionId: null })
    }
  }, [])

  const handleTogglePin = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation()
      setActiveMenuId(null)
      sessionStore.toggleSessionPin(sessionId)
    },
    [],
  )

  const handleStartEdit = useCallback(
    (e: React.MouseEvent, session: Session) => {
      e.stopPropagation()
      setActiveMenuId(null)
      setEditingId(session.id)
      setEditTitle(session.title)
    },
    [],
  )

  const handleSaveEdit = useCallback(
    (sessionId: string) => {
      if (editTitle.trim()) {
        sessionStore.updateSessionTitle(sessionId, editTitle.trim())
      }
      setEditingId(null)
    },
    [editTitle],
  )

  const toggleGroup = useCallback((agentId: string) => {
    setExpandGroups((prev) => ({
      ...prev,
      [agentId]: !prev[agentId],
    }))
  }, [])

  const handleOpenExport = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation()
      setActiveMenuId(null)
      setExportSessionId(sessionId)
    },
    [],
  )

  const handleCloseExport = useCallback(() => {
    setExportSessionId(null)
  }, [])

  const handleConfirmExport = useCallback(
    async (
      sessionId: string,
      options: { omitToolCalls: boolean; omitThinking: boolean },
    ) => {
      try {
        const filePath = await exportSessionToFile(sessionId, options)
        if (filePath) {
          showToast(tpl('已导出到：$__path__', { path: filePath }), 3000)
          setExportSessionId(null)
        }
      } catch (e) {
        showToast(
          tpl('导出失败：$__error__', {
            error: (e as Error).message || t('未知错误'),
          }),
          3000,
        )
      }
    },
    [],
  )

  // ===== 导入知识库 =====

  const handleOpenImportKB = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation()
      setActiveMenuId(null)
      setImportSessionId(sessionId)
      setSelectedKbId('')
      setShowImportModal(true)
      setImportKbLoading(true)
      // 默认全选所有消息
      const session = sessionStore.getSession(sessionId)
      if (session) {
        setSelectedMsgIds(new Set(session.messages.map((m) => m.id)))
      }
      try {
        const list = await ragService.listKnowledgeBases()
        setKbList(list)
        // 如果有默认知识库，自动选中
        const cfg = ragService.getConfig()
        if (cfg.defaultKnowledgeBaseId && list.some(kb => kb.id === cfg.defaultKnowledgeBaseId)) {
          setSelectedKbId(cfg.defaultKnowledgeBaseId)
        }
      } catch (err: any) {
        showToast(
          tpl('获取知识库列表失败：$__error__', {
            error: err.message || t('未知错误'),
          }),
          3000,
        )
      }
      setImportKbLoading(false)
    },
    [],
  )

  const handleCloseImport = useCallback(() => {
    setShowImportModal(false)
    setImportSessionId(null)
    setSelectedKbId('')
    setKbList([])
    setSelectedMsgIds(new Set())
  }, [])

  const handleConfirmImport = useCallback(async () => {
    if (!importSessionId || !selectedKbId) return
    const session = sessionStore.getSession(importSessionId)
    if (!session) return

    // 如果没有选中任何消息，提示用户
    if (selectedMsgIds.size === 0) {
      showToast(t('请至少选择一条消息'), 3000)
      return
    }

    setImportLoading(true)
    try {
      // 只导出用户选中的消息
      const selectedMsgs = session.messages.filter((m) => selectedMsgIds.has(m.id))
      const content = formatSessionForKB(session, selectedMsgs)
      const docName = `📝 ${session.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}`
      await ragService.writeText(selectedKbId, docName, content)
      showToast(tpl('已导入「$__title__」到知识库', { title: session.title }), 3000)
      handleCloseImport()
    } catch (err: any) {
      showToast(
        tpl('导入知识库失败：$__error__', {
          error: err.message || t('未知错误'),
        }),
        3000,
      )
    }
    setImportLoading(false)
  }, [importSessionId, selectedKbId, selectedMsgIds, handleCloseImport])

  const toggleMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    setActiveMenuId((prev) => (prev === sessionId ? null : sessionId))
  }, [])

  // ===== 消息选择 =====

  const handleToggleMessage = useCallback((msgId: string) => {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev)
      if (next.has(msgId)) {
        next.delete(msgId)
      } else {
        next.add(msgId)
      }
      return next
    })
  }, [])

  const handleSelectAllMessages = useCallback(() => {
    if (!importSessionId) return
    const session = sessionStore.getSession(importSessionId)
    if (session) {
      setSelectedMsgIds(new Set(session.messages.map((m) => m.id)))
    }
  }, [importSessionId])

  const handleDeselectAllMessages = useCallback(() => {
    setSelectedMsgIds(new Set())
  }, [])

  useTime(1000 * 60)

  const renderSession = (session: Session) => {
    const rt = getSessionRuntime(session.id)
    const isCurrent = session.id === chatState.value.currentSessionId
    const isMenuOpen = activeMenuId === session.id
    const isEdit = editingId === session.id
    return (
      <div
        key={session.id}
        className={`session-item ${isCurrent ? 'active' : ''} ${rt.working ? 'working' : ''} ${session.pinned ? 'pinned' : ''}`}
        onClick={(isEdit) => handleSelect(session.id)}>
        <div className="session-info">
          {editingId === session.id ? (
            <input
              className="edit-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => handleSaveEdit(session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveEdit(session.id)
              }}
              autoFocus
              autoComplete="off"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="session-title">
              {session.pinned && (
                <span className="pinned-indicator" title={t('已置顶')}>
                  <PinSvg />
                </span>
              )}
              {rt.paused && (
                <span className="shelved-indicator" title={t('工具调用已暂停')}>
                  ⏸️
                </span>
              )}
              {rt.working && <span className="working-indicator" />}
              {session.title}
            </span>
          )}
          <span className="session-meta">{timeFormat(session.updatedAt)}</span>
        </div>

        {/* 「更多」菜单按钮 */}
        <div
          className={`session-more ${isEdit ? 'hidden' : ''}`}
          ref={isMenuOpen ? menuRef : undefined}>
          <button
            className={`more-btn ${isMenuOpen ? 'active' : ''}`}
            onClick={(e) => toggleMenu(e, session.id)}
            title={t('更多操作')}>
            <MoreSvg />
          </button>
          {isMenuOpen && (
            <div className="more-menu" onClick={(e) => e.stopPropagation()}>
              <button
                className="menu-item"
                onClick={(e) => handleTogglePin(e, session.id)}>
                <span className="menu-icon">
                  <PinSvg />
                </span>
                <span className="menu-label">
                  {session.pinned ? t('取消置顶') : t('置顶')}
                </span>
              </button>
              <button
                className="menu-item"
                onClick={(e) => handleStartEdit(e, session)}>
                <span className="menu-icon">
                  <EditSvg />
                </span>
                <span className="menu-label">{t('重命名')}</span>
              </button>
              <button
                className="menu-item"
                onClick={(e) => handleOpenExport(e, session.id)}>
                <span className="menu-icon">
                  <ExportSvg />
                </span>
                <span className="menu-label">{t('导出')}</span>
              </button>
              <button
                className="menu-item"
                onClick={(e) => handleOpenImportKB(e, session.id)}>
                <span className="menu-icon">
                  <FolderSvg />
                </span>
                <span className="menu-label">{t('导入知识库')}</span>
              </button>
              <div className="menu-divider" />
              <button
                className="menu-item danger"
                onClick={(e) => handleDelete(e, session.id)}>
                <span className="menu-icon">
                  <DeleteSvg />
                </span>
                <span className="menu-label">{t('删除')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`chat-sidebar ${chatState.value.sidebarOpen ? '' : 'collapsed'} ${className}`}
      style={style}>
      <div className="sidebar-header">
        <ripple-button className="new-chat-btn" onClick={handleNewSession}>
          <AddSvg />
          <span>{t('新对话')}</span>
        </ripple-button>
      </div>
      <div className="session-list">
        {groups.length > 0 ? (
          groups.map((group) => (
            <SessionGroupView
              key={group.key}
              group={group}
              sessionGroupType={sessionGroupType}
              isCollapsed={!expandGroups[group.key]}
              isUngrouped={group.key === UNGROUPED_KEY}
              renderSession={renderSession}
              onToggleGroup={() => toggleGroup(group.key)}
              onNewSession={() => handleNewSessionInGroup(group)}
            />
          ))
        ) : (
          <div className="empty-sessions">
            <p>{t('暂无对话')}</p>
            <p className="hint">{t('点击上方按钮开始新对话')}</p>
          </div>
        )}
      </div>

      {/* 导出对话框 */}
      {exportSessionId && (
        <ExportDialog
          visible={true}
          sessionTitle={
            sessions.find((s) => s.id === exportSessionId)?.title || '对话'
          }
          onConfirm={(options) => handleConfirmExport(exportSessionId, options)}
          onCancel={handleCloseExport}
        />
      )}

      {/* 导入知识库对话框 */}
      <Modal
        visible={showImportModal}
        title={t('导入会话到知识库')}
        onClose={handleCloseImport}
        width={560}
        className="import-kb-modal"
        footer={
          <ModalFooterButtons
            onCancel={handleCloseImport}
            onConfirm={handleConfirmImport}
            confirmText={t('导入')}
            confirmLoading={importLoading}
          />
        }>
        {importKbLoading ? (
          <div className="import-kb-loading">{t('加载中...')}</div>
        ) : kbList.length === 0 ? (
          <div className="import-kb-empty">
            <p>{t('暂无知识库，请先在设置中创建知识库。')}</p>
          </div>
        ) : (
          <>
            {/* 知识库选择 */}
            <div className="import-kb-section">
              <div className="import-kb-section-title">{t('选择目标知识库')}</div>
              <div className="import-kb-list">
                {kbList.map((kb) => (
                  <div
                    key={kb.id}
                    className={`import-kb-item ${selectedKbId === kb.id ? 'selected' : ''}`}
                    onClick={() => setSelectedKbId(kb.id)}>
                    <span className="import-kb-item-name">{kb.name}</span>
                    <span className="import-kb-item-count">
                      {tpl('$__count__ 个文档', { count: kb.document_count })}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* 消息选择 */}
            {importSessionId && (() => {
              const session = sessionStore.getSession(importSessionId)
              if (!session) return null
              const totalCount = session.messages.length
              const selectedCount = selectedMsgIds.size
              return (
                <div className="import-kb-section">
                  <div className="import-kb-section-title import-kb-msg-header">
                    <span>{tpl('选择消息（$__selected__/$__total__）', { selected: selectedCount, total: totalCount })}</span>
                    <div className="import-kb-msg-actions">
                      <button
                        className="import-kb-msg-action-btn"
                        onClick={handleSelectAllMessages}
                        disabled={selectedCount === totalCount}>
                        {t('全选')}
                      </button>
                      <span className="import-kb-msg-action-sep">|</span>
                      <button
                        className="import-kb-msg-action-btn"
                        onClick={handleDeselectAllMessages}
                        disabled={selectedCount === 0}>
                        {t('取消全选')}
                      </button>
                    </div>
                  </div>
                  <div className="import-kb-msg-list">
                    {session.messages.map((msg, idx) => {
                      const preview = extractPlainText(msg.content).slice(0, 60)
                      return (
                        <div
                          key={msg.id}
                          className={`import-kb-msg-item ${selectedMsgIds.has(msg.id) ? 'checked' : ''}`}
                          onClick={() => handleToggleMessage(msg.id)}>
                          <input
                            type="checkbox"
                            className="import-kb-msg-checkbox"
                            checked={selectedMsgIds.has(msg.id)}
                            onChange={() => handleToggleMessage(msg.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <span className={`import-kb-msg-role role-${msg.role}`}>
                            {msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : msg.role === 'tool' ? '🔧' : msg.role === 'summary' ? '📋' : '⚙️'}
                          </span>
                          <span className="import-kb-msg-preview">{preview || `[${msg.role}]`}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
          </>
        )}
      </Modal>
    </div>
  )
}

export default observer(ChatSidebar)

/* ==================== 格式化会话内容用于导入知识库 ==================== */

/**
 * 将会话消息格式化为可读的纯文本，供导入知识库使用
 * @param messages 可选，只格式化指定的消息列表（不传则使用 session 的全部消息）
 */
function formatSessionForKB(session: Session, messages?: Message[]): string {
  const lines: string[] = []
  const targetMsgs = messages ?? session.messages

  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`> 模型：${session.modelId || '未知'}`)
  lines.push(`> 消息数：${targetMsgs.length}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of targetMsgs) {
    const roleLabel =
      msg.role === 'user'
        ? '## 👤 User'
        : msg.role === 'assistant'
          ? '## 🤖 Assistant'
          : msg.role === 'tool'
            ? '## 🔧 Tool'
            : msg.role === 'summary'
              ? '## 📋 Summary'
              : '## System'

    lines.push(roleLabel)
    lines.push('')

    // 思考过程
    if (msg.reasoningContent) {
      lines.push('> 💭 ' + msg.reasoningContent.split('\n').join('\n> '))
      lines.push('')
    }

    // 文本内容
    const text = extractPlainText(msg.content)
    if (text) {
      lines.push(text)
      lines.push('')
    }

    // 工具调用
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        lines.push(`**工具调用：${tc.name}**`)
        lines.push('')
        lines.push('```json')
        lines.push(JSON.stringify(tc.input, null, 2))
        lines.push('```')
        lines.push('')
      }
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

/** 从 MessageContent 中提取纯文本 */
function extractPlainText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c: any) =>
        c.type === 'text' || (c.type === 'tool_result' && typeof c.content === 'string'),
    )
    .map((c: any) => (c.type === 'text' ? c.text : c.content))
    .join('\n\n')
}

/* ==================== SessionGroupView — 分组卡片组件 ==================== */

interface SessionGroupViewProps {
  group: SessionGroup
  sessionGroupType: 'agent' | 'workspace'
  isCollapsed: boolean
  isUngrouped: boolean
  renderSession: (session: Session) => JSX.Element
  onToggleGroup: () => void
  onNewSession: () => void
}

function SessionGroupView({
  group,
  sessionGroupType,
  isCollapsed,
  isUngrouped,
  renderSession,
  onToggleGroup,
  onNewSession,
}: SessionGroupViewProps) {
  const [isGroupMenuOpen, setGroupMenuOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const groupMenuRef = useRef<HTMLDivElement>(null)

  // 检查组内是否有会话正在工作中
  const hasWorkingSession = useMemo(
    () => group.sessions.some((s) => getSessionRuntime(s.id).working),
    [group.sessions],
  )

  // 点击菜单外部关闭
  useEffect(() => {
    if (!isGroupMenuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (
        groupMenuRef.current &&
        !groupMenuRef.current.contains(e.target as Node)
      ) {
        setGroupMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isGroupMenuOpen])

  const toggleGroupMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setGroupMenuOpen((prev) => !prev)
  }, [])

  const handleDeleteAllSessions = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      setGroupMenuOpen(false)

      const count = group.sessions.length
      const confirmed = await MessageBox.propt(
        tpl('删除 $__name__ 分组下的所有会话？', {
          name: group.name,
        }),
        tpl('该操作将永久删除 $__count__ 个会话，无法恢复。', {
          count,
        }),
        { confirmText: t('确认删除'), cancelText: t('取消') },
      )
      if (!confirmed) return

      const ids = group.sessions.map((s) => s.id)
      sessionStore.deleteSessions(ids)
      const currentId = chatState.value.currentSessionId
      if (currentId && ids.includes(currentId)) {
        chatState.set({ currentSessionId: null })
      }
      showToast(tpl('已删除 $__count__ 个会话', { count: ids.length }), 2000)
    },
    [group.sessions, group.name],
  )

  const handleOpenWorkspace = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      setGroupMenuOpen(false)
      if (group.key === UNGROUPED_KEY) return
      await openPath(group.key).catch(() => {
        showToast(t('无法在系统文件管理器中打开该路径'), 2000)
      })
    },
    [group.key],
  )

  const handleEditAgent = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setGroupMenuOpen(false)
      if (group.key === UNGROUPED_KEY) return
      chatState.setValue('selectedAgentId', group.key)
      settingsEvent.emit('openSettings', 'agent')
    },
    [group.key],
  )

  return (
    <div className="session-group">
      <div
        className="session-group-header"
        onClick={onToggleGroup}
        title={group.title}>
        <DropDownSvg
          className={`group-toggle ${isCollapsed ? 'collapsed' : ''}`}
        />
        {group.icon === 'folder' ? (
          <FolderSvg className="group-icon" />
        ) : isUngrouped ? (
          <FolderSvg className="group-icon" />
        ) : (
          <AgentSvg className="group-icon" />
        )}
        {isCollapsed && hasWorkingSession && <span className="working-indicator" />}
        <span className="group-name">{group.name}</span>
        <div
          className={`group-header-actions${isGroupMenuOpen ? ' menu-open' : ''}`}
          ref={isGroupMenuOpen ? groupMenuRef : undefined}>
          <span className="group-count" onClick={toggleGroupMenu}>
            {group.sessions.length}
          </span>
          <button
            className="group-more-btn"
            onClick={toggleGroupMenu}
            title="更多操作">
            <MoreSvg />
          </button>
          {isGroupMenuOpen && (
            <div
              className="group-more-menu"
              onClick={(e) => e.stopPropagation()}>
              <button className="menu-item" onClick={onNewSession}>
                <span className="menu-label">{t('新对话')}</span>
              </button>
              <div className="menu-divider" />
              {sessionGroupType === 'workspace' &&
                group.key !== UNGROUPED_KEY && (
                  <button className="menu-item" onClick={handleOpenWorkspace}>
                    <span className="menu-label">{t('打开文件路径')}</span>
                  </button>
                )}
              {sessionGroupType === 'agent' && group.key !== UNGROUPED_KEY && (
                <button className="menu-item" onClick={handleEditAgent}>
                  <span className="menu-label">{t('编辑智能体')}</span>
                </button>
              )}
              <div className="menu-divider" />
              <button
                className="menu-item danger"
                onClick={handleDeleteAllSessions}>
                <span className="menu-label">{t('删除所有会话')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {!isCollapsed && (
        <div className="session-group-items">
          {group.sessions.length > 11 && !showAll
            ? group.sessions.slice(0, 10).map(renderSession)
            : group.sessions.map(renderSession)}
          {group.sessions.length > 11 && !showAll && (
            <button
              className="show-all-btn"
              onClick={(e) => {
                e.stopPropagation()
                setShowAll(true)
              }}>
              {t('展示全部')} ({group.sessions.length})
            </button>
          )}
        </div>
      )}
    </div>
  )
}
