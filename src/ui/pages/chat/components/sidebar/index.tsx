/**
 * sidebar — 侧边栏
 *
 * 三个页签：会话 / 工作目录 / 技能
 *  - 每个页签的顶部都有一个搜索框（search-box.tsx），只搜当前页签的条目：
 *    会话 = 标题 / 分组名，工作目录 = 磁盘递归搜文件名，技能 = 名称 / 描述 / 标签；
 *    关键词挂在**此处**（侧边栏常驻），所以切页签回来仍在
 *  - 会话：每个会话显示 working 状态指示（流式回复中）、按 Agent 或工作目录分组、
 *    支持导出为 Markdown、置顶、导入知识库；
 *    **会话项与分组头的操作统一收拢到右键菜单**（共享组件 ContextMenu，
 *    与「工作目录 / 技能」页签同一套样式）—— 旧的两颗「更多」按钮已移除
 *  - 工作目录：当前工作目录的文件树（只读，见 workspace-tree.tsx）
 *  - 技能：已安装技能列表（见 skill-list.tsx）：单击 = 开关式引用 SKILL.md，已引用的卡片高亮
 */
import { useState, useMemo, useCallback, JSX } from 'react'
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
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import AgentSvg from '@/ui/components/icons/AgentSvg'
import PinSvg from '@/ui/components/icons/PinSvg'
import ExportDialog from '@/ui/pages/chat/components/modals/ExportDialog'
import { exportSessionToFile } from '@/services/export-service'
import { deleteSessions } from '@/services/chat-service'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { t, tpl } from '@/ui/i18n'
import './style.scss'
import { timeFormat } from '@/utils/time'
import useTime from '@/ui/hooks/useTime'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import StatsSvg from '@/ui/components/icons/StatsSvg'
import TokenStatsPanel from '@/ui/pages/chat/components/token-stats'
import settingsEvent from '@/events/settingsEvent'
import { openPath } from '@tauri-apps/plugin-opener'
import { ragService } from '@/services/rag-service'
import type { KnowledgeBase } from '@/domain/ports'
import WorkspaceTree from './workspace-tree'
import SkillList from './skill-list'
import SidebarSearch from './search-box'
import { filterSessionGroups } from './session-filter'

interface Props {
  onSelectSession: (sessionId: string) => void
  /** 把路径作为附件挂到聊天输入框（目录树右键「引用」/ 拖拽到输入框） */
  onAttachPaths: (paths: string[]) => void
  /** 把技能引用挂到聊天输入框（技能卡片单击 / 拖拽到输入框） */
  onAttachSkills: (names: string[]) => void
  /** 输入框当前已引用的技能名（技能卡片据此高亮） */
  referencedSkills: string[]
  /** 技能卡片单击：未引用则引用，已引用则取消 */
  onToggleSkill: (name: string) => void
  style?: React.CSSProperties
  className?: string
}

/** 未分组会话的虚拟 key */
const UNGROUPED_KEY = '__ungrouped__'

/** 侧边栏页签 */
type SidebarTab = 'sessions' | 'workspace' | 'skills'

/** 页签定义（label 以中文为 i18n key，渲染时再 t()） */
const SIDEBAR_TABS: { key: SidebarTab; label: string }[] = [
  { key: 'sessions', label: '会话' },
  { key: 'workspace', label: '工作目录' },
  { key: 'skills', label: '技能' },
]

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

function ChatSidebar({
  onSelectSession,
  onAttachPaths,
  onAttachSkills,
  referencedSkills,
  onToggleSkill,
  style,
  className = '',
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [expandGroups, setExpandGroups] = useState<Record<string, boolean>>({})
  const [exportSessionId, setExportSessionId] = useState<string | null>(null)
  /** 用量统计面板开关 */
  const [statsOpen, setStatsOpen] = useState(false)
  /** 当前页签：会话 / 工作目录 / 技能 */
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  /**
   * 三个页签各自的搜索关键词。放侧边栏一级（而不是各页签组件里）：
   * 会话页签常驻 DOM、另两个页签切走会卸载，关键词提到这里才能「切回来还在」。
   */
  const [sessionQuery, setSessionQuery] = useState('')
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [skillsQuery, setSkillsQuery] = useState('')
  /**
   * 会话项右键菜单。全应用唯一的 ContextMenu 实现（与「工作目录」「技能」
   * 页签、消息气泡同源），点外部关闭 / Esc 关闭 / 视口钳制都由它负责，
   * 这里不再需要上一版的 activeMenuId + menuRef + mousedown 监听那套手工逻辑。
   */
  const sessionMenu = useContextMenu<Session>()

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
  // 在 observer 渲染中读取，确保切换会话时分组高亮能同步刷新
  const currentSessionId = chatState.value.currentSessionId
  /** 会话搜索关键词（trim + 小写后交给 filterSessionGroups） */
  const sessionKeyword = sessionQuery.trim().toLowerCase()
  const groups = useMemo(() => {
    const all =
      sessionGroupType === 'workspace'
        ? groupSessionsByWorkspace(sessions)
        : groupSessionsByAgent(sessions)
    return filterSessionGroups(all, sessionKeyword)
  }, [sessions, sessionGroupType, sessionKeyword])

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
      // 进入会话 → 清除新回复红点由 `onSelectSession`（chat-view）统一负责，
      // 这样托盘唤起 / 检索跳转等其它入口也走同一套（避免只在这里清、别处漏清）
      chatState.setValue('currentSessionId', sessionId)
      onSelectSession(sessionId)
    },
    [onSelectSession],
  )

  // 菜单项回调不再接收 MouseEvent：菜单由共享组件 ContextMenu 渲染，它在调用 onClick
  // 之前已先 onClose（见 ContextMenu/index.tsx::handleItemClick），故旧版的
  // e.stopPropagation() / setActiveMenuId(null) 一并去掉。
  const handleDelete = useCallback((sessionId: string) => {
    // ⚠️ 走 chat-service 的 deleteSessions（先在引擎侧断流再删）：直接 sessionStore.deleteSession
    // 会在会话仍在生成时留下孤儿消息
    void deleteSessions([sessionId])
    if (chatState.value.currentSessionId === sessionId) {
      chatState.set({ currentSessionId: null })
    }
  }, [])

  const handleTogglePin = useCallback((sessionId: string) => {
    sessionStore.toggleSessionPin(sessionId)
  }, [])

  const handleStartEdit = useCallback((session: Session) => {
    setEditingId(session.id)
    setEditTitle(session.title)
  }, [])

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

  const handleOpenExport = useCallback((sessionId: string) => {
    setExportSessionId(sessionId)
  }, [])

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
    async (sessionId: string) => {
      setImportSessionId(sessionId)
      setSelectedKbId('')
      setShowImportModal(true)
      setImportKbLoading(true)
      // 分页加载下，先补齐完整历史，否则只能选到已加载的尾部消息
      await sessionStore.ensureAllMessagesLoaded(sessionId)
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
    // 分页加载下，导入前补齐完整历史
    await sessionStore.ensureAllMessagesLoaded(importSessionId)
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

  /**
   * 会话项右键菜单项。
   *
   * 与分组头那套旧的内联菜单（.group-more-menu）不同，这里走全应用统一的
   * ContextMenu；**菜单项在渲染时按 target 现算**，所以「置顶 / 取消置顶」
   * 这类随状态变的文案不会是打开那一刻的过期值。
   */
  const buildSessionMenuItems = useCallback(
    (session: Session): ContextMenuItem[] => [
      {
        key: 'pin',
        label: session.pinned ? t('取消置顶') : t('置顶'),
        onClick: () => handleTogglePin(session.id),
      },
      {
        key: 'rename',
        label: t('重命名'),
        onClick: () => handleStartEdit(session),
      },
      {
        key: 'export',
        label: t('导出'),
        onClick: () => handleOpenExport(session.id),
      },
      {
        key: 'import-kb',
        label: t('导入知识库'),
        onClick: () => handleOpenImportKB(session.id),
      },
      {
        key: 'delete',
        label: t('删除'),
        divider: true,
        danger: true,
        onClick: () => handleDelete(session.id),
      },
    ],
    [
      handleTogglePin,
      handleStartEdit,
      handleOpenExport,
      handleOpenImportKB,
      handleDelete,
    ],
  )

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

  const handleSelectAllMessages = useCallback(async () => {
    if (!importSessionId) return
    await sessionStore.ensureAllMessagesLoaded(importSessionId)
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
    const isEdit = editingId === session.id
    return (
      <div
        key={session.id}
        className={`session-item ${isCurrent ? 'active' : ''} ${rt.working ? 'working' : ''} ${session.pinned ? 'pinned' : ''}`}
        onClick={() => handleSelect(session.id)}
        // 右键即菜单（原来的「更多」按钮已移除）：openAt 会 preventDefault +
        // stopPropagation，顺带拦掉浏览器默认菜单与外层的右键处理
        onContextMenu={(e) => sessionMenu.openAt(e, session)}>
        {/* 非当前会话有新回复 → 左侧红点提示 */}
        {rt.hasNewReply && !isCurrent && (
          <span className="new-reply-dot" title={t('有新的回复')} />
        )}
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
            <div className="session-title-wrapper">
              {session.pinned && (
                <span className="pinned-indicator" title={t('已置顶')}>
                  <PinSvg />
                </span>
              )}
              {rt.paused && (
                <span className="shelved-indicator" title={t('工具调用已暂停')}>
                  <svg className="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path d="M885.333333 85.333333H138.666667a53.393333 53.393333 0 0 0-53.333334 53.333334v746.666666a53.393333 53.393333 0 0 0 53.333334 53.333334h746.666666a53.393333 53.393333 0 0 0 53.333334-53.333334V138.666667a53.393333 53.393333 0 0 0-53.333334-53.333334z m-458.666666 618.666667a21.333333 21.333333 0 0 1-42.666667 0V320a21.333333 21.333333 0 0 1 42.666667 0z m213.333333 0a21.333333 21.333333 0 0 1-42.666667 0V320a21.333333 21.333333 0 0 1 42.666667 0z" fill="var(--accent-color)"></path></svg>
                </span>
              )}
              {rt.working && <span className="working-indicator" />}
              <span className="session-title">{session.title}</span>
            </div>
          )}
          <span className="session-meta">{timeFormat(session.updatedAt)}</span>
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
        {/* 用量统计入口：紧贴「新对话」下方，与主操作同一视觉层级 */}
        <button
          type="button"
          className="token-stats-entry"
          onClick={() => setStatsOpen(true)}
          title={t('查看 token 用量统计')}
          aria-label={t('用量统计')}>
          <StatsSvg />
          <span>{t('用量统计')}</span>
        </button>
      </div>

      {/* 页签：会话 / 工作目录 / 技能 */}
      <div className="sidebar-tabs" role="tablist">
        {SIDEBAR_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`sidebar-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}>
            {t(tab.label)}
          </button>
        ))}
      </div>

      {/* 会话页签常驻 DOM（只切换显隐），避免切换页签时丢掉滚动位置与分组的展开态 */}
      <div
        className={`session-pane${activeTab === 'sessions' ? '' : ' tab-hidden'}`}>
        {/* 空列表不配搜索框：一个永远搜不到东西的输入框只会让人以为坏了 */}
        {sessions.length > 0 && (
          <SidebarSearch
            value={sessionQuery}
            onChange={setSessionQuery}
            placeholder={t('搜索会话标题…')}
          />
        )}
        <div className="session-list">
          {groups.length > 0 ? (
            groups.map((group) => (
              <SessionGroupView
                key={group.key}
                group={group}
                sessionGroupType={sessionGroupType}
                // 搜索时强制展开：命中项藏在折叠的分组里等于没搜到
                isCollapsed={sessionKeyword ? false : !expandGroups[group.key]}
                isUngrouped={group.key === UNGROUPED_KEY}
                hasActiveSession={
                  !!currentSessionId &&
                  group.sessions.some((s) => s.id === currentSessionId)
                }
                renderSession={renderSession}
                onToggleGroup={() => toggleGroup(group.key)}
                onNewSession={() => handleNewSessionInGroup(group)}
              />
            ))
          ) : sessionKeyword ? (
            <div className="empty-sessions">
              <p>{t('未找到匹配的会话')}</p>
              <p className="hint">{t('试试其他关键词')}</p>
            </div>
          ) : (
            <div className="empty-sessions">
              <p>{t('暂无对话')}</p>
              <p className="hint">{t('点击上方按钮开始新对话')}</p>
            </div>
          )}
        </div>
      </div>

      {/* 会话项右键菜单（portal 挂到 body，位置由 ContextMenu 钳进视口） */}
      {sessionMenu.state && (
        <ContextMenu
          position={sessionMenu.state.position}
          items={buildSessionMenuItems(sessionMenu.state.target)}
          onClose={sessionMenu.close}
        />
      )}

      {activeTab === 'workspace' && (
        <WorkspaceTree
          onAttachPaths={onAttachPaths}
          searchQuery={workspaceQuery}
          onSearchQueryChange={setWorkspaceQuery}
        />
      )}
      {activeTab === 'skills' && (
        <SkillList
          onAttachSkills={onAttachSkills}
          referencedSkills={referencedSkills}
          onToggleSkill={onToggleSkill}
          searchQuery={skillsQuery}
          onSearchQueryChange={setSkillsQuery}
        />
      )}

      {/* 用量统计面板（portal 挂到 body，见组件内部注释） */}
      <TokenStatsPanel
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        sessionId={currentSessionId || undefined}
      />

      {/* 导出对话框 */}
      {exportSessionId && (
        <ExportDialog
          visible={true}
          sessionTitle={
            sessions.find((s) => s.id === exportSessionId)?.title || t('对话')
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
                            {msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : msg.role === 'tool' ? '🔧' : msg.role === 'summary' ? '📋' : msg.role === 'feedback' ? '🔄' : '⚙️'}
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
  lines.push(tpl('> 模型：$__model__', { model: session.modelId || t('未知') }))
  lines.push(tpl('> 消息数：$__count__', { count: targetMsgs.length }))
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
        lines.push(tpl('**工具调用：$__name__**', { name: tc.name }))
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
  /** 组内是否包含当前选中的会话（用于分组高亮） */
  hasActiveSession: boolean
  renderSession: (session: Session) => JSX.Element
  onToggleGroup: () => void
  onNewSession: () => void
}

function SessionGroupView({
  group,
  sessionGroupType,
  isCollapsed,
  isUngrouped,
  hasActiveSession,
  renderSession,
  onToggleGroup,
  onNewSession,
}: SessionGroupViewProps) {
  const [showAll, setShowAll] = useState(false)
  /**
   * 分组头右键菜单。与「会话项」共用同一个 ContextMenu：
   * 原来那套「hover 换出更多按钮 + 内联 absolute 下拉」已整体删除
   * （它自带一套点外部关闭的实现，且样式与目录树 / 技能页签分叉）。
   */
  const menu = useContextMenu<SessionGroup>()

  // 检查组内是否有会话正在工作中
  const hasWorkingSession = useMemo(
    () => group.sessions.some((s) => getSessionRuntime(s.id).working),
    [group.sessions],
  )

  // 检查组内是否有会话有未查看的新回复（折叠时在分组头部显示红点）
  const hasNewReplySession = useMemo(
    () => group.sessions.some((s) => getSessionRuntime(s.id).hasNewReply),
    [group.sessions],
  )

  const handleDeleteAllSessions = useCallback(async () => {
    const count = group.sessions.length
    const confirmed = await MessageBox.propt(
      tpl('删除 $__name__ 分组下的所有会话？', {
        name: group.name,
      }),
      tpl('该操作将永久删除 $__count__ 个会话，无法恢复。', {
        count,
      }),
      { confirmText: t('确认删除'), cancelText: t('取消'), danger: true },
    )
    if (!confirmed) return

    const ids = group.sessions.map((s) => s.id)
    // 同单项删除：先断流再删库（见 deleteSessions）
    const deleted = await deleteSessions(ids)
    const currentId = chatState.value.currentSessionId
    if (currentId && ids.includes(currentId)) {
      chatState.set({ currentSessionId: null })
    }
    showToast(tpl('已删除 $__count__ 个会话', { count: deleted }), 2000)
  }, [group.sessions, group.name])

  const handleOpenWorkspace = useCallback(async () => {
    if (group.key === UNGROUPED_KEY) return
    await openPath(group.key).catch(() => {
      showToast(t('无法在系统文件管理器中打开该路径'), 2000)
    })
  }, [group.key])

  const handleEditAgent = useCallback(() => {
    if (group.key === UNGROUPED_KEY) return
    chatState.setValue('selectedAgentId', group.key)
    settingsEvent.emit('openSettings', 'agent')
  }, [group.key])

  /** 分组头右键菜单项（与「会话项」同一套共享 ContextMenu 样式） */
  const groupMenuItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { key: 'new-session', label: t('新对话'), onClick: onNewSession },
    ]
    // 「打开文件路径 / 编辑智能体」按分组维度二选一，未分组时两个都不适用
    if (group.key !== UNGROUPED_KEY) {
      items.push(
        sessionGroupType === 'workspace'
          ? {
              key: 'open-workspace',
              label: t('打开文件路径'),
              divider: true,
              onClick: handleOpenWorkspace,
            }
          : {
              key: 'edit-agent',
              label: t('编辑智能体'),
              divider: true,
              onClick: handleEditAgent,
            },
      )
    }
    items.push({
      key: 'delete-all',
      label: t('删除所有会话'),
      divider: true,
      danger: true,
      onClick: handleDeleteAllSessions,
    })
    return items
  }, [
    sessionGroupType,
    group.key,
    onNewSession,
    handleOpenWorkspace,
    handleEditAgent,
    handleDeleteAllSessions,
  ])

  return (
    <div className="session-group">
      <div
        className={`session-group-header${hasActiveSession && isCollapsed ? ' has-active' : ''}`}
        onClick={onToggleGroup}
        // 右键即菜单（原来的「更多」按钮已移除，与「会话项」保持一致）
        onContextMenu={(e) => menu.openAt(e, group)}
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
        {/* 折叠分组内有未查看的新回复 → 分组头部红点 */}
        {isCollapsed && hasNewReplySession && (
          <span className="new-reply-dot" title={t('有新的回复')} />
        )}
        <span className="group-name">{group.name}</span>
        {/* 会话数只是计数（点击行为交给整行 = 折叠/展开），操作全在右键菜单里 */}
        <span className="group-count">{group.sessions.length}</span>
      </div>

      {/* 分组头右键菜单（portal 挂到 body，位置由 ContextMenu 钳进视口） */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={groupMenuItems}
          onClose={menu.close}
        />
      )}
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
