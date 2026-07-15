/**
 * sidebar — 会话侧边栏
 * 每个会话显示 working 状态指示（流式回复中）
 * 支持按 Agent 分组展示
 * 支持导出会话为 Markdown
 * 支持会话置顶
 * 操作统一收拢到「更多」菜单
 */
import { useState, useMemo, useCallback, useEffect, useRef, JSX } from 'react'
import { observer } from 'mobx-react-lite'
import type { Session } from '@/types'
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
import { t, tpl } from '@/ui/i18n'
import './style.scss'
import { timeFormat } from '@/utils/time'
import useTime from '@/ui/hooks/useTime'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import settingsEvent from '@/events/settingsEvent'
import { openPath } from '@tauri-apps/plugin-opener'

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

  const toggleMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    setActiveMenuId((prev) => (prev === sessionId ? null : sessionId))
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
    </div>
  )
}

export default observer(ChatSidebar)

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
