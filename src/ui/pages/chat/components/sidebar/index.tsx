/**
 * 侧边栏，三个页签：会话 / 工作目录 / 技能。搜索关键词挂在侧边栏一级（否则切页签回来就丢）。
 * 会话页签：working 指示、按 Agent 或工作目录分组、置顶、导出 Markdown、导入知识库。
 */
import { useState, useMemo, useCallback, useEffect, useRef, JSX } from 'react'
import { observer } from 'mobx-react-lite'
import type { Session, Message } from '@/types'
import { VISION_IMAGE_ROLE } from '@/types'
import {
  chatState,
  getSessionRuntime,
  isSessionRuntimeBusy,
  pendingInteractionCount,
  sessionStore,
  agentStore,
  settingsState,
} from '@/ui/store'
import AddSvg from '@/ui/components/icons/AddSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import AgentSvg from '@/ui/components/icons/AgentSvg'
import PinSvg from '@/ui/components/icons/PinSvg'
import PanelRightSvg from '@/ui/components/icons/PanelRightSvg'
import ExportDialog from '@/ui/pages/chat/components/modals/ExportDialog'
import { exportSessionToFile } from '@/services/export-service'
import { deleteSessions, renameSession, setSessionArchived, setSessionsArchived, countArchiveBlockedSessions } from '@/services/chat-service'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import Select from '@/ui/components/shared/Select'
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
import ImportMessageList from './import-message-list'
import { extractPlainText } from './session-text'
import { filterSessionGroups } from './session-filter'
import { foldGroupSessions } from './session-fold'
import {
  registerSessionDropList,
  SESSION_ROW_ATTR,
  SESSION_GROUP_ATTR,
  SESSION_DROP_GROUP_EVENT,
} from './session-drop'
import { badgeDragJustEnded, startSessionBadgeDrag } from './session-badge-drag'
import {
  groupSessions,
  toggleGroupPin,
  UNGROUPED_KEY,
  type SessionGroup as AnySessionGroup,
} from './session-grouping'
import { statusFlagKind, type StatusFlagKind } from './session-status'
import type { PanelTabSummary } from '../side-panel/sessions'

interface Props {
  onSelectSession: (sessionId: string) => void
  /** 把路径作为附件挂到聊天输入框 */
  onAttachPaths: (paths: string[]) => void
  /** 双击工作目录里的文件 → 在右侧面板打开 */
  onOpenFile: (path: string) => void
  /** 把技能引用挂到聊天输入框 */
  onAttachSkills: (names: string[]) => void
  /** 输入框当前已引用的技能名（技能卡片据此高亮） */
  referencedSkills: string[]
  /** 技能卡片单击：未引用则引用，已引用则取消 */
  onToggleSkill: (name: string) => void
  /**
   * 每个会话「还开着几个右侧标签页、面板收没收起」（`side-panel/sessions.ts::panelTabSummaries`）。
   * 标签属于会话，而面板一次只显示一个 —— 切走后「哪里还开着标签栏」就只剩这枚徽标能说。
   */
  panelTabs?: Record<string, PanelTabSummary>
  /** 点徽标：切到那个会话并展开它的右侧栏（宿主持有标签状态） */
  onOpenSessionPanel?: (sessionId: string) => void
  /**
   * 拖徽标：把那一个会话**开着的那批标签**整批搬到另一个会话。
   *
   * `toSessionId` 为 `null` = 新对话页（拖到标签栏、而当前还没建会话时）；归属由宿主按
   * `panelKeyOf` 解（侧栏不持有分桶）。
   */
  onTransferSessionTabs?: (fromSessionId: string, toSessionId: string | null) => void
  style?: React.CSSProperties
  className?: string
}

/** 分组装完整会话对象（分组规则与 Session 解耦） */
type SessionGroup = AnySessionGroup<Session>

type SidebarTab = 'sessions' | 'workspace' | 'skills'

/** 页签定义（label 即 i18n key） */
const SIDEBAR_TABS: { key: SidebarTab; label: string }[] = [
  { key: 'sessions', label: '对话' },
  { key: 'workspace', label: '工作目录' },
  { key: 'skills', label: '技能' },
]

/** 状态槽的呈现（两处共用）：`kind` 由 `statusFlagKind` 定，槽里只有一枚 */
function StatusFlag({ kind }: { kind: StatusFlagKind }) {
  return (
    <span className="session-flag">
      {kind === 'waiting' ? (
        <span
          className="waiting-interaction-indicator"
          title={t('有交互待你回答')}
        />
      ) : (
        <span className="working-indicator" title={t('运行中')} />
      )}
    </span>
  )
}

/**
 * 会话项的「在忙 / 等你回答」状态槽。
 *
 * ⚠️ 必须是 observer：它读的是运行时与待答计数，外层分组组件只按 `group.sessions` 记忆化，
 * store 一变不会重渲（那样琥珀点永远晚一拍甚至不出现）。
 */
const SessionStatusFlag = observer(function SessionStatusFlag({
  sessionId,
}: {
  sessionId: string
}) {
  const kind = statusFlagKind(
    pendingInteractionCount(sessionId) > 0,
    isSessionRuntimeBusy(getSessionRuntime(sessionId)),
  )
  return kind ? <StatusFlag kind={kind} /> : null
})

/** 折叠分组头的同款状态槽：组内任一会话在等 → 琥珀点；否则有会话在跑 → 蓝点。 */
const GroupStatusFlag = observer(function GroupStatusFlag({
  sessions,
}: {
  sessions: Session[]
}) {
  const kind = statusFlagKind(
    sessions.some((s) => pendingInteractionCount(s.id) > 0),
    sessions.some((s) => isSessionRuntimeBusy(getSessionRuntime(s.id))),
  )
  return kind ? <StatusFlag kind={kind} /> : null
})

function ChatSidebar({
  onSelectSession,
  onAttachPaths,
  onOpenFile,
  onAttachSkills,
  referencedSkills,
  onToggleSkill,
  panelTabs,
  onOpenSessionPanel,
  onTransferSessionTabs,
  style,
  className = '',
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [expandGroups, setExpandGroups] = useState<Record<string, boolean>>({})
  /** 悬停多久才临时展开：太短擦过就开（闪），太长像没反应 */
  const HOVER_OPEN_DELAY = 500
  /**
   * 拖动悬停在折叠分组上时的**临时展开**（事件源见 `session-drop.ts` 的
   * `sessionGroupHitAt` / `announceCollapsedGroup`）：只在拖动期间生效，不写进
   * `expandGroups` —— 用户收起的分组不该因为一次擦过就永久展开。
   *
   * 带 **500ms 停顿**（`HOVER_OPEN_DELAY`）：拖动中会一路划过好几个分组，立即展开
   * 会一整列噼里咋嗯地闪。停满 500ms 才展开 = 「在这儿停下」是有意动作，路过的都不算；
   * 中途换分组 / 离开就取消计时（展开后不再重设 —— 收回由事件带 `null` 负责）。
   */
  const [dragHoverGroup, setDragHoverGroup] = useState<string | null>(null)
  /**
   * 「锁定」：临时展开后指针**进过组内会话行**就锁住 —— 哪怕后来挪出分组容器
   * （悬在组间隙 / 别的分组头上）也不收回，松手才收（`endSessionGroupHover`）。
   * 不锁的话「展开→想去组内某行→中途划出 1px 缝隙→收起」会来回跳。
   */
  const lockedGroupRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const clearTimer = () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }
    const onAnnounce = (event: Event) => {
      const { key, onRow, end } = (event as CustomEvent<{
        key: string | null
        onRow?: boolean
        end?: boolean
      }>).detail
      // 拖动结束（松手 / 取消 / 失焦）：解锁。**进过组内行（已锁定）的分组转正为
      // 用户展开**（写进 expandGroups）—— 刚把标签落进那个组，折叠回去就看不见去哪儿了；
      // 没锁定（只路过 / 悬停了头部）的照旧收回。
      if (end) {
        clearTimer()
        const locked = lockedGroupRef.current
        lockedGroupRef.current = null
        if (locked) {
          setDragHoverGroup(null)
          setExpandGroups((prev) => ({ ...prev, [locked]: true }))
        } else {
          setDragHoverGroup(null)
        }
        return
      }
      // 进过组内会话行 → 锁定这个分组：之后事件带 null（挪出容器）也不收
      if (key !== null && onRow) {
        lockedGroupRef.current = key
      }
      if (key === null) {
        // 离开分组：锁定的不收（等松手），没锁的走正常收回
        if (lockedGroupRef.current) return
        clearTimer()
        setDragHoverGroup(null)
        return
      }
      // 已锁定的分组保持展开：对同一分组不再重复计时；别的分组照常走 500ms
      if (lockedGroupRef.current === key) return
      setDragHoverGroup((prev) => {
        // ⚠️ updater 里只能 return prev（任何返回值都会**立即**上屏）：
        // 展开在计时器回调里。同一个目标不重计（拖过组内行时事件 key 不变），
        // 换了目标就重设 500ms 计时 —— 路过的分组永远展不开。
        if (prev !== key) {
          clearTimer()
          hoverTimerRef.current = window.setTimeout(() => {
            hoverTimerRef.current = null
            setDragHoverGroup(key)
          }, HOVER_OPEN_DELAY)
        }
        return prev
      })
    }
    window.addEventListener(SESSION_DROP_GROUP_EVENT, onAnnounce)
    return () => {
      clearTimer()
      lockedGroupRef.current = null
      window.removeEventListener(SESSION_DROP_GROUP_EVENT, onAnnounce)
    }
  }, [])
  const [exportSessionId, setExportSessionId] = useState<string | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  /** 三个页签各自的搜索关键词：提到侧边栏一级，切走卸载后回来还在。 */
  const [sessionQuery, setSessionQuery] = useState('')
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [skillsQuery, setSkillsQuery] = useState('')
  /** 会话项右键菜单（共享 ContextMenu 负责外部关闭 / Esc / 视口钳制） */
  const sessionMenu = useContextMenu<Session>()
  /**
   * 会话列表容器：**拖动右侧栏标签时的落点**（`side-panel` 按会话行的 rect 命中，
   * 见 `session-drop.ts`）。登记容器而不是逐行：列表重渲染 / 分组折叠 / 搜索过滤都不用重登记。
   */
  const sessionListRef = useRef<HTMLDivElement>(null)
  useEffect(
    () => registerSessionDropList(() => sessionListRef.current),
    [],
  )

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
  /** 会话搜索关键词（trim + 小写） */
  const sessionKeyword = sessionQuery.trim().toLowerCase()
  // 已置顶的分组（只取当前维度那一份；缺键 / 旧数据时兜底为空）
  const pinnedGroupKeys =
    settingsState.value.pinnedSessionGroups?.[sessionGroupType] ?? []
  const groups = useMemo(() => {
    // 分组规则（含置顶）在 session-grouping，这里只注入 Agent 查询与置顶 key
    const all = groupSessions(sessions, {
      type: sessionGroupType,
      lookupAgent: (agentId) => agentStore.getAgent(agentId),
      pinnedGroups: pinnedGroupKeys,
    })
    return filterSessionGroups(all, sessionKeyword)
  }, [sessions, sessionGroupType, sessionKeyword, pinnedGroupKeys])

  const handleNewSession = useCallback(() => {
    chatState.set({ currentSessionId: null, error: null })
  }, [])

  const handleNewSessionInGroup = useCallback(
    (group: SessionGroup) => {
      if (sessionGroupType === 'workspace' && group.key !== UNGROUPED_KEY) {
        // 先清空 agent 让 useEffect 取默认 agent，再在下一拍覆盖 workspace
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
        // 设置 agent，并把它的 defaultWorkspace 带上
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
      // 归档会话不可打开：只能先右键「取消归档」（清红点走 onSelectSession，入口统一）
      if (sessionStore.getSession(sessionId)?.archived) {
        showToast(t('该对话已归档，取消归档后才能打开'), 2500)
        return
      }
      chatState.setValue('currentSessionId', sessionId)
      onSelectSession(sessionId)
    },
    [onSelectSession],
  )

  // 菜单项回调不接收 MouseEvent：ContextMenu 在调用 onClick 前已先 onClose
  // （见 ContextMenu/index.tsx::handleItemClick），故不再需要 stopPropagation
  const handleDelete = useCallback((sessionId: string) => {
    // ⚠️ 必须走 deleteSessions（先断流再删库）：直接删会在会话仍在生成时留下孤儿消息
    void deleteSessions([sessionId])
    if (chatState.value.currentSessionId === sessionId) {
      chatState.set({ currentSessionId: null })
    }
  }, [])

  const handleTogglePin = useCallback((sessionId: string) => {
    sessionStore.toggleSessionPin(sessionId)
  }, [])

  /** 归档 / 取消归档：归档当前会话时退出视图（运行中的会话不允许归档，取消归档不受限） */
  const handleToggleArchive = useCallback((session: Session) => {
    const next = !session.archived
    // ⚠️ service 会拒绝「run 还活着」的归档（含暂停等你回答的），这里必须告知原因，不能静默不动
    if (!setSessionArchived(session.id, next)) {
      if (next) showToast(t('该对话正在运行，结束后才能归档'), 2500)
      return
    }
    if (next && chatState.value.currentSessionId === session.id) {
      chatState.set({ currentSessionId: null })
    }
    showToast(next ? t('已归档') : t('已取消归档'), 2000)
  }, [])

  /** 分组「全部归档 / 全部取消归档」：一次写入，组内当前会话被归档时一并退出视图 */
  const handleArchiveGroup = useCallback(
    (group: SessionGroup, archived: boolean) => {
      const ids = group.sessions.map((s) => s.id)
      // 运行中的会被跳过（与 service 内过滤同一判据，见 countArchiveBlockedSessions）
      const blocked = archived ? countArchiveBlockedSessions(ids) : 0
      const changed = setSessionsArchived(ids, archived)
      const currentId = chatState.value.currentSessionId
      // 只有当前会话真的变成了归档态才退出视图：被跳过的运行中会话切走会让人以为被中断了
      if (archived && currentId && sessionStore.getSession(currentId)?.archived) {
        chatState.set({ currentSessionId: null })
      }
      if (archived && changed === 0 && blocked > 0) {
        showToast(
          tpl('$__count__ 个对话正在运行，暂时不能归档', { count: blocked }),
          2500,
        )
        return
      }
      const base = archived
        ? tpl('已归档 $__count__ 个对话', { count: changed })
        : tpl('已取消归档 $__count__ 个对话', { count: changed })
      const suffix =
        blocked > 0
          ? tpl('（$__count__ 个正在运行，已跳过）', { count: blocked })
          : ''
      showToast(base + suffix, 2500)
    },
    [],
  )

  const handleStartEdit = useCallback((session: Session) => {
    setEditingId(session.id)
    setEditTitle(session.title)
  }, [])

  const handleSaveEdit = useCallback(
    (sessionId: string) => {
      // ⚠️ 走 renameSession：空标题 / 超长校验只在服务层，接口层与侧栏共用同一份规则
      renameSession(sessionId, editTitle)
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

  /** 置顶分组：分组是现算的，状态存设置项 pinnedSessionGroups（按维度分开） */
  const handleToggleGroupPin = useCallback(
    (groupKey: string) => {
      const all = settingsState.value.pinnedSessionGroups ?? {
        agent: [],
        workspace: [],
      }
      settingsState.setValue('pinnedSessionGroups', {
        ...all,
        [sessionGroupType]: toggleGroupPin(all[sessionGroupType], groupKey),
      })
    },
    [sessionGroupType],
  )

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
        // 只有一个知识库时直接选中（意图无歧义）
        if (list.length === 1) setSelectedKbId(list[0].id)
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
    // 按钮在前置条件不满足时就已禁用，走到这里只剩兜底
    if (!importSessionId || !selectedKbId) return
    // 分页加载下，导入前补齐完整历史
    await sessionStore.ensureAllMessagesLoaded(importSessionId)
    const session = sessionStore.getSession(importSessionId)
    if (!session) return

    if (selectedMsgIds.size === 0) {
      showToast(t('请至少选择一条消息'), 3000)
      return
    }

    setImportLoading(true)
    try {
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
   * 会话项右键菜单项：渲染时按 target 现算，文案不会是打开那一刻的过期值。
   *
   * 归档会话**只给两个入口**：取消归档、删除。其余操作（置顶 / 重命名 / 导出 / 导入知识库）
   * 一律不提供 —— 归档 = 「暂时不想动它」，只保留恢复与清理两条路。
   */
  const buildSessionMenuItems = useCallback(
    (session: Session): ContextMenuItem[] => {
      if (session.archived) {
        return [
          {
            key: 'unarchive',
            label: t('取消归档'),
            onClick: () => handleToggleArchive(session),
          },
          {
            key: 'delete',
            label: t('删除'),
            divider: true,
            danger: true,
            onClick: () => handleDelete(session.id),
          },
        ]
      }
      return [
        {
          key: 'pin',
          label: session.pinned ? t('取消置顶') : t('置顶'),
          onClick: () => handleTogglePin(session.id),
        },
        {
          key: 'archive',
          label: t('归档'),
          onClick: () => handleToggleArchive(session),
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
      ]
    },
    [
      handleTogglePin,
      handleToggleArchive,
      handleStartEdit,
      handleOpenExport,
      handleOpenImportKB,
      handleDelete,
    ],
  )

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

  /**
   * 「前面全选 / 后面全选」是**追加**语义：全选若做成覆盖，用户先前逐条挑的会被默默丢掉。
   */
  const handleAppendMessages = useCallback((ids: string[]) => {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }, [])

  /**
   * 目标知识库下拉项：文档数并进标签（单行文案塞不进徽标），计数是选库的关键依据。
   * dropdownWidth="content" 下长库名会被省略，故把完整库名挂到 title。
   */
  const kbOptions = useMemo(
    () =>
      kbList.map((kb) => ({
        value: kb.id,
        label: tpl('$__name__（$__count__ 个文档）', {
          name: kb.name,
          count: kb.document_count,
        }),
        title: kb.name,
      })),
    [kbList],
  )

  useTime(1000 * 60)

  const renderSession = (session: Session) => {
    const rt = getSessionRuntime(session.id)
    const isCurrent = session.id === chatState.value.currentSessionId
    const isEdit = editingId === session.id
    // 「在忙」= 引擎 run 在跑 或 本地前置处理中（图片识别）；含它才给 item 加 `working` 修饰类
    const isBusy = isSessionRuntimeBusy(rt)
    // 右侧栏徽标：**只给别的会话** —— 当前会话的标签数在工具栏那颗按钮上，
    // 同一件事在两个地方说就是噪音（而且当前那行的徽标会和「选中」高亮抢眼神）
    const panel = isCurrent ? undefined : panelTabs?.[session.id]
    return (
      <div
        key={session.id}
        className={`session-item ${isCurrent ? 'active' : ''} ${isBusy ? 'working' : ''} ${session.pinned ? 'pinned' : ''} ${session.archived ? 'archived' : ''}`}
        // 拖动右侧栏标签时的落点标记：`sidebar/session-drop.ts` 按这个属性找行（值 = 会话 id）
        {...{ [SESSION_ROW_ATTR]: session.id }}
        onClick={() => handleSelect(session.id)}
        // 右键即菜单：openAt 会 preventDefault + stopPropagation，顺带拦掉默认菜单
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
                <span className="shelved-indicator" title={t('有待处理的提问')}>
                  <svg className="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path d="M885.333333 85.333333H138.666667a53.393333 53.393333 0 0 0-53.333334 53.333334v746.666666a53.393333 53.393333 0 0 0 53.333334 53.333334h746.666666a53.393333 53.393333 0 0 0 53.333334-53.333334V138.666667a53.393333 53.393333 0 0 0-53.333334-53.333334z m-458.666666 618.666667a21.333333 21.333333 0 0 1-42.666667 0V320a21.333333 21.333333 0 0 1 42.666667 0z m213.333333 0a21.333333 21.333333 0 0 1-42.666667 0V320a21.333333 21.333333 0 0 1 42.666667 0z" fill="var(--accent-color)"></path></svg>
                </span>
              )}
              <SessionStatusFlag sessionId={session.id} />
              <span className="session-title">{session.title}</span>
              {session.archived && (
                <span className="archived-indicator" title={t('已归档')}>
                  {t('已归档')}
                </span>
              )}
            </div>
          )}
          <span className="session-meta">{timeFormat(session.updatedAt)}</span>
        </div>
        {/* 那个对话的右侧栏还开着（或挂着收起）：一枚可点的徽标 —— 切走会话后「哪里还开着」
            就靠它。数字与工具栏徽标同口径（`tabs.length`，开始页也算一格）；
            `is-collapsed` = 面板是收起的（标签挂着但看不见），色阶降一档。 */}
        {panel && panel.count > 0 && (
          <button
            type="button"
            className={`session-panel-badge${panel.open ? '' : ' is-collapsed'}`}
            title={
              panel.open
                ? tpl('右侧栏打开着 $__count__ 个标签页', { count: panel.count })
                : tpl('右侧栏已收起，还有 $__count__ 个标签页', { count: panel.count })
            }
            aria-label={
              panel.open
                ? tpl('右侧栏打开着 $__count__ 个标签页', { count: panel.count })
                : tpl('右侧栏已收起，还有 $__count__ 个标签页', { count: panel.count })
            }
            // 徽标自带动作（切过去并展开面板），不能让整行那个「选中会话」再跑一遍
            onMouseDown={(e) =>
              // 按住就能拖：拖到标签栏 / 另一个会话行 = 把那批标签整批搬过去
              onTransferSessionTabs &&
              startSessionBadgeDrag(e, {
                fromSessionId: session.id,
                onDrop: (target) =>
                  onTransferSessionTabs(
                    session.id,
                    target.kind === 'session' ? target.sessionId : chatState.value.currentSessionId,
                  ),
              })
            }
            onClick={(e) => {
              e.stopPropagation()
              // 拖完松手那一下不是「打开面板」
              if (badgeDragJustEnded()) return
              onOpenSessionPanel?.(session.id)
            }}>
            <PanelRightSvg />
            <span className="session-panel-badge-count">{panel.count}</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`chat-sidebar ${chatState.value.sidebarOpen ? '' : 'collapsed'} ${className}`}
      style={style}>
      <div className="sidebar-header">
        <ripple-button
          className="new-chat-btn"
          title={`${t('新对话')} (Ctrl+N)`}
          onClick={handleNewSession}>
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

      {/* 页签 */}
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

      {/* 会话页签常驻 DOM（只切换显隐），保住滚动位置与展开态 */}
      <div
        className={`session-pane${activeTab === 'sessions' ? '' : ' tab-hidden'}`}>
        {/* 空列表不配搜索框：永远搜不到东西的输入框只会让人以为坏了 */}
        {sessions.length > 0 && (
          <SidebarSearch
            value={sessionQuery}
            onChange={setSessionQuery}
            placeholder={t('搜索对话标题…')}
          />
        )}
        <div className="session-list" ref={sessionListRef}>
          {groups.length > 0 ? (
            groups.map((group) => (
              <SessionGroupView
                key={group.key}
                group={group}
                sessionGroupType={sessionGroupType}
                // 搜索时强制展开：命中项藏在折叠的分组 / 折叠的归档里等于没搜到；
                // 拖标签悬停时同样临时展开（让人看清松手会把标签放进哪个组）
                isCollapsed={
                  sessionKeyword
                    ? false
                    : !(dragHoverGroup === group.key || !!expandGroups[group.key])
                }
                isSearching={sessionKeyword !== ''}
                isPinned={pinnedGroupKeys.includes(group.key)}
                isUngrouped={group.key === UNGROUPED_KEY}
                hasActiveSession={
                  !!currentSessionId &&
                  group.sessions.some((s) => s.id === currentSessionId)
                }
                renderSession={renderSession}
                panelTabs={panelTabs}
                onToggleGroup={() => toggleGroup(group.key)}
                onNewSession={() => handleNewSessionInGroup(group)}
                onTogglePin={() => handleToggleGroupPin(group.key)}
                onArchiveGroup={(archived) => handleArchiveGroup(group, archived)}
              />
            ))
          ) : sessionKeyword ? (
            <div className="empty-sessions">
              <p>{t('未找到匹配的对话')}</p>
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

      {/* 会话项右键菜单（portal 挂到 body） */}
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
          onOpenFile={onOpenFile}
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

      {/* 用量统计面板（portal 挂到 body） */}
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
        title={t('导入对话到知识库')}
        onClose={handleCloseImport}
        width={560}
        className="import-kb-modal"
        footer={
          <ModalFooterButtons
            onCancel={handleCloseImport}
            onConfirm={handleConfirmImport}
            confirmText={t('导入')}
            confirmLoading={importLoading}
            /* 没选库 / 一条消息都没选时点下去只会静默 return，不如直接禁用 —— 前置条件在「选择消息（n/m）」上可对照 */
            confirmDisabled={!selectedKbId || selectedMsgIds.size === 0}
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
            {/* 知识库选择：库多时用下拉面板兜住（原列表会把弹窗撑得很高） */}
            <div className="import-kb-section">
              <div className="import-kb-section-title">{t('选择目标知识库')}</div>
              <Select
                className="import-kb-select"
                dropdownWidth="content"
                value={selectedKbId}
                onChange={(v) => setSelectedKbId(String(v))}
                placeholder={t('请选择知识库')}
                options={kbOptions}
              />
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
                  <ImportMessageList
                    messages={session.messages}
                    selectedIds={selectedMsgIds}
                    onToggle={handleToggleMessage}
                    onSelectMessages={handleAppendMessages}
                  />
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

/** 会话消息 → 可读纯文本（导入知识库用）；messages 可选，不传则用 session 全部消息 */
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
    // 「工具把图片交给模型」的注入消息：没有可读正文（只有图片 + 路径），不入知识库
    if (msg.role === VISION_IMAGE_ROLE) continue
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

interface SessionGroupViewProps {
  group: SessionGroup
  sessionGroupType: 'agent' | 'workspace'
  isCollapsed: boolean
  /** 正在按关键词搜索：组内折叠一律铺开（否则命中的归档会话搜了却看不见） */
  isSearching: boolean
  /** 已置顶（排到最前 + 图钉） */
  isPinned: boolean
  isUngrouped: boolean
  /** 组内含当前选中会话（用于分组高亮） */
  hasActiveSession: boolean
  renderSession: (session: Session) => JSX.Element
  /** 每个会话的右侧栏摘要（折叠时分组头用它们汇总，见 `session-panel-badge`） */
  panelTabs?: Record<string, PanelTabSummary>
  onToggleGroup: () => void
  onNewSession: () => void
  /** 置顶 / 取消置顶本分组 */
  onTogglePin: () => void
  /** 整组归档 / 取消归档（入参 = 目标态） */
  onArchiveGroup: (archived: boolean) => void
}

function SessionGroupView({
  group,
  sessionGroupType,
  isCollapsed,
  isSearching,
  isPinned,
  isUngrouped,
  hasActiveSession,
  renderSession,
  panelTabs,
  onToggleGroup,
  onNewSession,
  onTogglePin,
  onArchiveGroup,
}: SessionGroupViewProps) {
  const [showAll, setShowAll] = useState(false)
  /** 组内折叠：混排时归档的会话全部收进「展示全部」（规则见 session-fold） */
  const folded = useMemo(
    () => foldGroupSessions(group.sessions, showAll || isSearching),
    [group.sessions, showAll, isSearching],
  )
  /** 分组头右键菜单：与「会话项」共用同一个 ContextMenu */
  const menu = useContextMenu<SessionGroup>()

  /** 组内会话全部已归档 → 分组头显示归档态（分组本身也已排到列表尾部） */
  const allArchived = useMemo(
    () => group.sessions.length > 0 && group.sessions.every((s) => !!s.archived),
    [group.sessions],
  )

  // 组内有未查看的新回复（折叠时分组头显示红点）
  const hasNewReplySession = useMemo(
    () => group.sessions.some((s) => getSessionRuntime(s.id).hasNewReply),
    [group.sessions],
  )

  /** 折叠时组内还有几个右侧标签页（展开时每个会话行自己的徽标会说明） */
  const panelTabCount = useMemo(
    () =>
      panelTabs
        ? group.sessions.reduce((sum, s) => sum + (panelTabs[s.id]?.count ?? 0), 0)
        : 0,
    [group.sessions, panelTabs],
  )

  const handleDeleteAllSessions = useCallback(async () => {
    const count = group.sessions.length
    const confirmed = await MessageBox.propt(
      tpl('删除 $__name__ 分组下的所有对话？', {
        name: group.name,
      }),
      tpl('该操作将永久删除 $__count__ 个对话，无法恢复。', {
        count,
      }),
      { confirmText: t('确认删除'), cancelText: t('取消'), danger: true },
    )
    if (!confirmed) return

    const ids = group.sessions.map((s) => s.id)
    // 同单项删除：先断流再删库
    const deleted = await deleteSessions(ids)
    const currentId = chatState.value.currentSessionId
    if (currentId && ids.includes(currentId)) {
      chatState.set({ currentSessionId: null })
    }
    showToast(tpl('已删除 $__count__ 个对话', { count: deleted }), 2000)
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

  /** 分组头右键菜单项 */
  const groupMenuItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { key: 'new-session', label: t('新对话'), onClick: onNewSession },
      {
        key: 'pin-group',
        label: isPinned ? t('取消置顶分组') : t('置顶分组'),
        onClick: onTogglePin,
      },
      {
        key: 'archive-group',
        // 已全归档 → 对称的「取消」入口，否则要逐个取消
        label: allArchived ? t('全部取消归档') : t('全部归档'),
        onClick: () => onArchiveGroup(!allArchived),
      },
    ]
    // 「打开文件路径 / 编辑智能体」按分组维度二选一，未分组均不适用
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
            label: t('编辑 Agent'),
            divider: true,
            onClick: handleEditAgent,
          },
      )
    }
    items.push({
      key: 'delete-all',
      label: t('删除所有对话'),
      divider: true,
      danger: true,
      onClick: handleDeleteAllSessions,
    })
    return items
  }, [
    isPinned,
    sessionGroupType,
    group.key,
    allArchived,
    onNewSession,
    onTogglePin,
    onArchiveGroup,
    handleOpenWorkspace,
    handleEditAgent,
    handleDeleteAllSessions,
  ])

  return (
    <div className="session-group" {...{ [SESSION_GROUP_ATTR]: group.key }}>
      <div
        className={`session-group-header${hasActiveSession && isCollapsed ? ' has-active' : ''}${isCollapsed ? '' : ' is-expanded'}${allArchived ? ' archived' : ''}`}
        onClick={onToggleGroup}
        // 右键即菜单（与「会话项」一致）
        onContextMenu={(e) => menu.openAt(e, group)}
        title={group.title}>
        {/* 图标与折叠箭头**共用一格**（省下一份 gap 6px + 14px 宽）：展开的分组常显箭头（它就是那一列的
            「点这里收起」把手），收起的分组回落到类型图标（方向已不存在，留个「这是什么组」），
            hover 时一律换成箭头。叠放靠「同一网格格叠两层」（样式在 `.group-slot`），
            不是 display 切换（那会打断透明度过渡）。 */}
        <span className="group-slot">
          <DropDownSvg
            className={`group-toggle ${isCollapsed ? 'collapsed' : ''}`}
          />
          {group.icon === 'folder' || isUngrouped ? (
            <FolderSvg className="group-icon" />
          ) : (
            <AgentSvg className="group-icon" />
          )}
        </span>
        {/* 折叠时组内有会话在忙 / 有交互要你回答：同槽只亮一枚（等你回答优先） */}
        {isCollapsed && <GroupStatusFlag sessions={group.sessions} />}
        {/* 折叠分组内有未查看的新回复 → 分组头部红点 */}
        {isCollapsed && hasNewReplySession && (
          <span className="new-reply-dot" title={t('有新的回复')} />
        )}
        {/* 已置顶 → 只挂一枚图钉，不改图标 / 文字颜色 */}
        {isPinned && (
          <span className="group-pin-indicator" title={t('已置顶分组')}>
            <PinSvg />
          </span>
        )}
        <span className="group-name">{group.name}</span>
        {/* 折叠分组内还有右侧标签页：否则组里挂着的那些标签栏完全隐形。
            位置靠右、紧贴会话数 —— 左边那块是「状态」（在忙 / 待答 / 新回复），
            这一枚是「计数」，与 `group-count` 同一组读数。`group-name` 是 `flex: 1`，
            所以放在它后面就自然贴右。 */}
        {isCollapsed && panelTabCount > 0 && (
          <span
            className="group-panel-badge"
            title={tpl('组内还有 $__count__ 个右侧栏标签页', { count: panelTabCount })}
            aria-label={tpl('组内还有 $__count__ 个右侧栏标签页', { count: panelTabCount })}>
            <PanelRightSvg />
            {panelTabCount}
          </span>
        )}
        {/* 会话数只是计数（点击交给整行），操作全在右键菜单里 */}
        <span className="group-count">{group.sessions.length}</span>
      </div>

      {/* 分组头右键菜单（portal 挂到 body） */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={groupMenuItems}
          onClose={menu.close}
        />
      )}
      {/* 折叠 / 展开的过渡：组内高度事先不知道，`height: auto` 不能过渡，所以外层走
          `grid-template-rows: 1fr ↔ 0fr`（样式在 `.session-group-body`）。收起时内容仍挂着 ——
          一是没有高度就没有过渡，二是展开回来时滚动位置 / 「展示全部」的展开态不用重算。
          ⚠️ 正因为「挂着但看不见」，收起态必须 `inert`：否则 Tab 键会走进看不见的会话行，
          `show-all-btn` 也还能被点到 / 被读屏念出来。 */}
      <div
        className={`session-group-body${isCollapsed ? ' is-collapsed' : ''}`}
        inert={isCollapsed}>
        <div className="session-group-items">
          {folded.visible.map(renderSession)}
          {folded.folded && (
            <button
              className="show-all-btn"
              onClick={(e) => {
                e.stopPropagation()
                setShowAll(true)
              }}>
              {t('展示全部')} ({group.sessions.length})
            </button>
          )}
          {showAll && !folded.folded && (
            <button
              className="show-all-btn"
              onClick={(e) => {
                e.stopPropagation()
                setShowAll(false)
              }}>
              {t('收起')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
