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
// 后台服务：标题栏入口 + 面板（与本会话的 service 工具同一张注册表）
import ServiceEntry from './components/service/ServiceEntry'
import type { ServiceTabTarget } from './components/service/ServiceEntry'
import GitEntry from './components/git/GitEntry'
import SearchDialog from './components/search'
// 右侧面板容器：多个文件 / 终端 / 网页各占一个标签
import SidePanel from './components/side-panel'
import {
  browserTab,
  closeTab,
  closeTabs,
  moveTab,
  nextTerminalIndex,
  openFileTab,
  openPageTab,
  openServiceTab,
  replacePageTab,
  replaceTabWith,
  terminalTab,
  updateBrowserTab,
  updateBrowserTitle,
  type FileTabView,
  type SidePanelTab,
} from './components/side-panel/tabs'
import {
  bucketOf,
  clearBucketTabs,
  guideTabIdOf,
  isBucketVisible,
  parkedTabsOf,
  panelKeyOf,
  scopeTabs,
  withBucketOpen,
  withBucketTabs,
  withoutSessions,
  type PanelBucket,
  type PanelBuckets,
} from './components/side-panel/sessions'
import { killUserTerminal, listUserTerminalShells, startUserTerminal } from '@/infrastructure/terminal'
import { resolveShellChoice } from './components/terminal/shells'
import {
  isTypingTarget,
  matchesCommand,
  PANEL_COMMANDS,
} from '@/ui/shortcuts/commands'
import { MessageBox } from '@/ui/components/shared/MessageBox'

import { useToolUI } from './components/tool-ui'
import HideSideBarSvg from '@/ui/components/icons/HideSideBarSvg'
import ShowSideBarSvg from '@/ui/components/icons/ShowSideBarSvg'
import PanelRightSvg from '@/ui/components/icons/PanelRightSvg'
import SettingsView from '@/ui/pages/Settings/settings-view'
import { t, tpl } from '@/ui/i18n'
import settingsEvent from '@/events/settingsEvent'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import SearchSvg from '@/ui/components/icons/SearchSvg'
import TrajectorySvg from '@/ui/components/icons/TrajectorySvg'
import './chat-view.scss'
import { settingsState } from '@/ui/store/settingStore'
import ChatMessageList, {
  type MessageJumpTarget,
} from './components/message/message-list'
import { TrajectoryView } from './components/trajectory/trajectory-view'
import WelcomeScreen from './components/welcome'
import { appName } from '@/ui/constants'
import { sessionStore } from '@/ui/store'
import { openPath } from '@tauri-apps/plugin-opener'
import * as dialog from '@tauri-apps/plugin-dialog'
import { getMatch } from '@/utils/common'
import { getDefaultAgent } from '@/services/agent-service'
import { repairSessionIfNeeded } from '@/services/chat-service'
import { setPresentRevealHandler } from '@/services/present-service'
import { vision } from '@/infrastructure/vision'
import type { VisionAnalyzeResult } from '@/infrastructure/vision/types'
import { buildUserContent } from '@/utils/messageContent'
import type { MessageSearchItem } from '@/infrastructure/sessionRepo'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { createFrameBatcher } from '@/utils/frameBatch'
import { track, trackPerf, hashText } from '@/utils/telemetry'
/** 侧边栏宽度 localStorage 键 */
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
  /** 可用的历史工作目录（无会话时下拉切换） */
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
  /** 消息区当前显示的是「轨迹表」而不是「对话」（同一份 messages，两种看法） */
  const [showTrajectory, setShowTrajectory] = useState(false)
  /** 检索结果的跳转目标（滚动定位 + 临时高亮） */
  const [searchJump, setSearchJump] = useState<MessageJumpTarget | null>(null)
  const searchJumpNonceRef = useRef(0)
  /**
   * 输入框当前引用的技能名（侧边栏卡片据此高亮）。真相在 ChatInput（它持有 SKILL.md 全文），
   * 这里只存名字镜像，发完消息自动清空。
   */
  const [referencedSkills, setReferencedSkills] = useState<string[]>([])
  // 工具交互弹窗：声明的是元素而不是组件类型 —— 内联组件每次渲染换类型会整体卸载重挂（草稿与焦点一起丢）
  const { toolUI, inlineUI } = useToolUI()
  const [sidebarWidth, setSidebarWidth] = useState(getStoredWidth())
  const resizingRef = useRef(false)
  const currentWidthRef = useRef(sidebarWidth)

  /**
   * 右侧面板：**每个会话一套标签**（`side-panel/sessions.ts`）。
   *
   * 三条口径（与旧版的差别就在这三条上）：
   * 1. **收起 = 只隐藏**：`open` 只是宽度收到 0，标签 / 草稿 / 终端屏幕一条不动；
   * 2. **切会话 = 换一桶**：别的会话的标签交给容器 `parkedTabs` 继续挂着（不卸载、不显示）——
   *    所以切回去草稿与终端滚动都是原来那份；两个会话各开同一个文件也互不影响；
   * 3. **面板容器常驻**（不再按「有没有标签」挂载 / 卸载）：要清状态只能靠卸载，不能两头都要。
   */
  const [panelBuckets, setPanelBuckets] = useState<PanelBuckets>({})
  /** 同步链路的基准：宿主回调（关闭标签 / 拖顺序 / 网页回传）里立刻读得到最新一桶 */
  const panelBucketsRef = useRef<PanelBuckets>(panelBuckets)
  panelBucketsRef.current = panelBuckets
  /** 面板占满（聊天区会被压到不足 300px）→ 聊天区先不显示 */
  const [filePanelFull, setFilePanelFull] = useState(false)
  /** 任一标签有未保存草稿（切工作目录前要确认；切会话不用 —— 草稿跟着会话留着） */
  const fileDirtyRef = useRef(false)
  /** present 的「请你再看一次」序号：每次交付自增，标签记住它，面板据此把视图迁回预览 */
  const viewSeqRef = useRef(0)
  /** 网页标签的序号：只用于造 id（`browser:3`），关掉不回收（回收会让新标签撞上旧的） */
  const browserSeqRef = useRef(0)

  /** 当前会话（新对话页也算一桶，见 `panelKeyOf`） */
  const panelKey = panelKeyOf(chatState.value.currentSessionId)
  const currentBucket = bucketOf(panelBuckets, panelKey)
  /** 面板此刻该不该露着（展开着并且至少一个标签） */
  const panelVisible = isBucketVisible(currentBucket)
  /** 工具栏徽标用：**这个会话里还开着几个标签**（收起时告诉用户里面还有东西） */
  const panelTabCount = currentBucket.tabs.length
  /** 别的会话的标签：交给容器一直挂着（切回去草稿 / 终端屏幕还在） */
  const parkedPanelTabs = useMemo(
    () => parkedTabsOf(panelBuckets, panelKey),
    [panelBuckets, panelKey],
  )

  /** 取「当前会话那一桶」（回调里调，不依赖渲染期快照） */
  const bucketNow = useCallback((): { key: string; bucket: PanelBucket } => {
    const key = panelKeyOf(chatState.value.currentSessionId)
    return { key, bucket: bucketOf(panelBucketsRef.current, key) }
  }, [])

  const handleFileDirtyChange = useCallback((dirty: boolean) => {
    fileDirtyRef.current = dirty
  }, [])

  /**
   * 落一次某个会话的标签状态（ref 与 state 同步：ref 是同步链路的基准）。
   * id 在这里统一加会话前缀，**标签变多就展开面板**（见 `sessions.ts::withBucketTabs`）。
   */
  const applyBucketTabs = useCallback(
    (key: string, next: { tabs: readonly SidePanelTab[]; activeId: string | null }) => {
      const buckets = withBucketTabs(panelBucketsRef.current, key, next)
      panelBucketsRef.current = buckets
      setPanelBuckets(buckets)
    },
    [],
  )

  /** 展开 / 收起当前会话的面板（收起 ≠ 关标签） */
  const applyBucketOpen = useCallback(
    (key: string, open: boolean) => {
      const buckets = withBucketOpen(panelBucketsRef.current, key, open)
      panelBucketsRef.current = buckets
      setPanelBuckets(buckets)
    },
    [],
  )

  /**
   * 关标签前先把里面的**用户终端**杀掉：关标签 = 关终端。
   *
   * 服务终端不走这条 —— 它还留在 AI 的服务注册表里，终止与否是用户在那边的决定；
   * 而用户自己的 shell 只有标签这一个入口，标签没了它就不该再跑（`dev server` 占着端口没人知道）。
   * ⚠️ **收起面板 / 切会话不在此列**：那两条只是看不见 / 换了一桶，终端还得继续跑。
   * 传 `null` = 所有会话的全部（组件卸载 / 会话被删）。
   */
  const killTerminalsIn = useCallback((ids: Set<string> | null) => {
    for (const bucket of Object.values(panelBucketsRef.current)) {
      for (const tab of bucket.tabs) {
        if (tab.kind !== 'terminal') continue
        if (ids && !ids.has(tab.id)) continue
        void killUserTerminal(tab.sessionId, tab.termId)
      }
    }
  }, [])

  /**
   * 关掉**当前会话**的全部标签（切工作目录这条路）：终端先杀，容器只隐藏不卸载。
   * ⚠️ 别的会话不受影响 —— 它们各自的桶还在，切回去照旧。
   */
  const closeSessionTabs = useCallback(() => {
    const { key, bucket } = bucketNow()
    if (bucket.tabs.length === 0) return
    killTerminalsIn(new Set(bucket.tabs.map((tab) => tab.id)))
    const buckets = clearBucketTabs(panelBucketsRef.current, key)
    panelBucketsRef.current = buckets
    setPanelBuckets(buckets)
    fileDirtyRef.current = false
    // 面板占满时聊天区是藏起来的：关掉必须把它放回来
    setFilePanelFull(false)
  }, [bucketNow, killTerminalsIn])

  /** 关掉一个标签：邻居顶上来；关完最后一个就是面板收起来（容器仍在，标签内容随之卸载） */
  const handleCloseTab = useCallback(
    (id: string) => {
      killTerminalsIn(new Set([id]))
      const { key, bucket } = bucketNow()
      applyBucketTabs(key, closeTab(bucket.tabs, id, bucket.activeId))
    },
    [applyBucketTabs, bucketNow, killTerminalsIn],
  )

  /**
   * 关掉一批标签（标签右键菜单的关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭）。
   * 一次算完再落库：逐个回调会让激活态在中间状态里来回跳（还多渲染几次）。
   */
  const handleCloseTabs = useCallback(
    (ids: string[]) => {
      killTerminalsIn(new Set(ids))
      const { key, bucket } = bucketNow()
      applyBucketTabs(key, closeTabs(bucket.tabs, ids, bucket.activeId))
    },
    [applyBucketTabs, bucketNow, killTerminalsIn],
  )

  /** 拖标签换顺序：只改顺序，激活态与草稿都不动（重排口径在 `tabs.ts::moveTab`） */
  const handleMoveTab = useCallback(
    (id: string, toIndex: number) => {
      const { key, bucket } = bucketNow()
      applyBucketTabs(key, {
        tabs: moveTab(bucket.tabs, id, toIndex),
        activeId: bucket.activeId,
      })
    },
    [applyBucketTabs, bucketNow],
  )

  /** 切标签：只改激活态（不动标签列表，也不碰收起态） */
  const handleActiveTabChange = useCallback(
    (id: string) => {
      const { key, bucket } = bucketNow()
      if (bucket.activeId === id) return
      applyBucketTabs(key, { tabs: bucket.tabs, activeId: id })
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * 有未保存草稿时先问一句（无草稿直接放行）。
   *
   * ⚠️ 现在只剩**切工作目录**一条路需要问：收起面板 / 切会话都不再丢任何东西
   *（草稿跟着会话的桶留着，切回去还在）。关单个标签的确认归容器（`side-panel`）
   * 与面板自己（`workspace-file`）。
   */
  const confirmDiscardDraft = useCallback(
    (message: string, confirmText: string): Promise<boolean> => {
      if (!fileDirtyRef.current) return Promise.resolve(true)
      return MessageBox.propt(t('放弃未保存的修改？'), message, {
        confirmText,
        cancelText: t('取消'),
        danger: true,
      })
    },
    [],
  )

  /**
   * 批量在右侧面板打开（`present` 的交付物可能不止一个）：已有同路径的标签只切过去，
   * 新文件追加到末尾；**激活第一个**（它是主交付物）。一次算完再落 state，N 个文件只渲染一次。
   * 落的是**当前会话**那一桶（后台会话不抢标签页）。
   */
  const handleOpenFiles = useCallback(
    (paths: string[], view?: FileTabView) => {
      if (paths.length === 0) return
      const { key, bucket } = bucketNow()
      let tabs = bucket.tabs
      let activeId: string | null = null
      // present 是「请看这个」：同一个文件重复交付也要把面板请回预览（序号自增，值相同不重渲染）
      const viewSeq = view ? ++viewSeqRef.current : undefined
      for (const path of paths) {
        const next = openFileTab(tabs, path, view, viewSeq)
        tabs = next.tabs
        activeId = activeId ?? next.activeId
      }
      applyBucketTabs(key, { tabs, activeId })
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * 双击文件 → 右侧打开：已有同路径的标签就切过去，否则新开一个。
   * **不再需要「丢弃草稿」确认** —— 打开新文件不再挤掉原来那个（单面板时代的必答题）。
   */
  const handleOpenFile = useCallback(
    (path: string) => handleOpenFiles([path]),
    [handleOpenFiles],
  )

  /**
   * 服务面板点一行 → 右侧开一个服务终端标签（已开着就只切过去）。
   * 标签落在当前会话那一桶；标签自己的 `sessionId` 可能是另一个会话
   *（新对话页的全局视图），轮询 / 终止都走标签自己的。
   */
  const handleOpenService = useCallback(
    (target: ServiceTabTarget) => {
      const { key, bucket } = bucketNow()
      applyBucketTabs(key, openServiceTab(bucket.tabs, target))
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * AI 交付文件（`present` 工具）→ 右侧面板：登记**唯一入口**（`services/present-service`）。
   * 标签状态在本组件的 state + ref 里，别处拿不到；卸载时注销，避免留下上一个实例的 handler。
   *
   * 交付物默认落在「预览」（能预览的类型才有那个 tab）—— present 的语义是给人看，不是给人改。
   */
  useEffect(
    () => setPresentRevealHandler((paths) => handleOpenFiles(paths, 'preview')),
    [handleOpenFiles],
  )

  /**
   * 右侧面板的工作目录：与文件树、目录树**同一套解析**（会话工作区 → 已选目录 → 全局默认）。
   *
   * 做成函数而不是渲染期常量：终端的 `cwd` 必须在**点的当下**现取（用户可能刚换了工作目录）。
   */
  const panelWorkspacePath = useCallback((): string => {
    const sessionId = chatState.value.currentSessionId
    const raw = sessionId
      ? sessionStore.getSession(sessionId)?.workspace
      : chatState.value.selectedWorkspace
    return raw || settingsState.value.defaultWorkspace || ''
  }, [])

  /** 「+」/ 工具栏：打开（或切到）当前会话的开始页；已开着就只激活 */
  const handleOpenGuide = useCallback(() => {
    const { key, bucket } = bucketNow()
    const next = openPageTab(bucket.tabs, 'guide')
    applyBucketTabs(key, next)
  }, [applyBucketTabs, bucketNow])

  /**
   * 「工作区文件」页：快捷键 / 工具栏直接开（`fromGuide=false`）；
   * 从开始页的胶囊点进来时**把开始页原地换成文件树**（参考实现的口径）。
   */
  const handleOpenFilesPage = useCallback(
    (fromGuide = false) => {
      const { key, bucket } = bucketNow()
      const next = fromGuide
        ? replacePageTab(bucket.tabs, 'files', guideTabIdOf(key))
        : openPageTab(bucket.tabs, 'files')
      applyBucketTabs(key, next)
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * 新建终端（开始页的胶囊 / `Ctrl + \``）：在**会话工作区**起一个真 shell。
   *
   * 五个必须守住的点：
   * 1. **先起进程再建标签**：终端 id 由 Rust 给（`term_N`），失败就什么标签也不留；
   *    失败原因原样展示（工作目录不存在 / 平台不支持 / 终端数量到上限 / 选的那种没装）——
   *    这是用户主动点的动作，静默失败会让人以为「点了没反应」。
   * 2. **从开始页进来时原地替换**（`replaceTabWith`）：开始页是门厅，点完就该消失。
   * 3. **默认脱壳**：这里不做任何审批 / 沙盒判断（产品口径，见 `user_shell` 模块头）。
   * 4. **`shellId` 显式给了就用它**（开始页的类型菜单），否则用**上次用的那种**
   *    （`settings.terminalShell`；设置里空着 = 让 Rust 用默认的 Windows PowerShell）——
   *    `Ctrl + \`` 要快，不能每次都弹菜单，但也不能永远只开 powershell。
   * 5. **开成了就把这次用的记下来**：下次 `Ctrl + \`` 直接开它，菜单里也会标「上次使用」。
   *
   * 标签落在**点它的那一刻**那个会话的桶里；起进程是异步的，期间切了会话就 kill 掉不建标签。
   */
  const handleNewTerminal = useCallback(
    async (fromGuide = false, shellId?: string) => {
      const sessionId = chatState.value.currentSessionId ?? ''
      const key = panelKeyOf(sessionId)
      const cwd = panelWorkspacePath()
      if (!cwd) {
        void MessageBox.info(t('无法打开终端'), t('这个会话没有工作区目录。'))
        return
      }
      const remembered = settingsState.value.terminalShell || undefined
      const shell = resolveShellChoice(shellId, remembered)
      try {
        // 初始尺寸只是占位：xterm 挂载后立刻按真实宽高上报（同尺寸会被 Rust 去重）
        const info = await startUserTerminal(sessionId, cwd, 120, 30, shell)
        // 起进程是异步的：期间切了会话就不把这个终端塞进新会话的工作目录
        if (panelKeyOf(chatState.value.currentSessionId) !== key) {
          void killUserTerminal(sessionId, info.id)
          return
        }
        // 记住**实际**用的那一种（Rust 没指定时会自己挑默认，不能把空串记成「用户选的」）
        if (info.shell && info.shell !== settingsState.value.terminalShell) {
          settingsState.setValue('terminalShell', info.shell)
        }
        const tabs = bucketOf(panelBucketsRef.current, key).tabs
        const tab = scopeTabs(
          key,
          [
            terminalTab({
              termId: info.id,
              sessionId,
              shell: info.shell,
              cwd: info.cwd,
              pid: info.pid,
              // 序号取「已用最大值 + 1」：关掉中间那个再开不会出现两个「终端 2」（见 `tabs.ts`）
              index: nextTerminalIndex(tabs),
            }),
          ],
        )[0]
        const guideId = guideTabIdOf(key)
        const next =
          fromGuide && tabs.some((item) => item.id === guideId)
            ? replaceTabWith(tabs, tab, guideId)
            : { tabs: [...tabs, tab], activeId: tab.id }
        applyBucketTabs(key, next)
      } catch (e: any) {
        // 上次用的那种已经不在了（卸载了 / 换了台机器）：丢掉记忆，下次按键回到默认
        if (!shellId && remembered) {
          settingsState.setValue('terminalShell', '')
        }
        void MessageBox.info(
          t('无法打开终端'),
          String(e?.message ?? e ?? ''),
        )
      }
    },
    [applyBucketTabs, panelWorkspacePath],
  )

  /**
   * 新建网页标签（开始页的「浏览器」/ `Ctrl + T`）：地址留空，由用户在地址栏里输入。
   *
   * 与终端相反，这里**没有要先做成的事**（不起进程、不需要工作目录），所以同步建标签即可；
   * 从开始页进来同样原地替换（`replaceTabWith`）—— 用户看到的还是刚才那一格。
   */
  const handleOpenBrowser = useCallback(
    (fromGuide = false) => {
      // 序号只增不减：回收会跟还开着的旧标签撞 id（它全局一份，不按会话分）
      browserSeqRef.current += 1
      const seq = browserSeqRef.current
      const { key, bucket } = bucketNow()
      const tabs = bucket.tabs
      // 两条路都走标签模型：原地接管开始页那一格 / 追加到末尾
      const tab = scopeTabs(key, [browserTab({ seq })])[0]
      const guideId = guideTabIdOf(key)
      const next =
        fromGuide && tabs.some((item) => item.id === guideId)
          ? replaceTabWith(tabs, tab, guideId)
          : { tabs: [...tabs, tab], activeId: tab.id }
      applyBucketTabs(key, next)
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * 网页标签里导航了一次 → 把地址写回标签（标签标题 = 主机名，会跟着换）。
   *
   * 只改那一个标签、**不动激活态**：导航发生在用户正在看的那个面板里，但回调是异步到达的，
   * 期间用户可能已经切到别的标签 —— 不能把焦点抢回来。
   */
  const handleBrowserNavigate = useCallback(
    (id: string, url: string) => {
      const { key, bucket } = bucketNow()
      const tabs = updateBrowserTab(bucket.tabs, id, url)
      // 地址没变 / 标签已经关掉：原引用返回，不触发重渲染
      if (tabs === bucket.tabs) return
      applyBucketTabs(key, { tabs, activeId: bucket.activeId })
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * 页面上报标题（`document.title`）→ 只改那一个标签的文字。
   *
   * 与导航同一条口径：**不动激活态** —— 事件是异步到的，期间用户可能已经切到别的标签。
   * 标题没变时 `updateBrowserTitle` 返回原引用，这里直接跳过（不触发重渲染）。
   */
  const handleBrowserTitle = useCallback(
    (id: string, title: string) => {
      const { key, bucket } = bucketNow()
      const tabs = updateBrowserTitle(bucket.tabs, id, title)
      if (tabs === bucket.tabs) return
      applyBucketTabs(key, { tabs, activeId: bucket.activeId })
    },
    [applyBucketTabs, bucketNow],
  )

  /**
   * 收起右侧栏 = **只隐藏**（什么都不丢）：标签、草稿、终端屏幕全留着，展开就原样回来。
   * 所以这里不再问「未保存的修改将丢失」—— 已经没有东西会丢了。
   * 真正会丢东西的只剩「切工作目录」（工具栏那个下拉菜单），确认在那边。
   */
  const handleCollapsePanel = useCallback(() => {
    const { key } = bucketNow()
    applyBucketOpen(key, false)
  }, [applyBucketOpen, bucketNow])

  /** 工具栏按钮 / 快捷键：有标签就展开 ↔ 收起；一个也没有就展开面板并开开始页 */
  const handleTogglePanel = useCallback(() => {
    const { key, bucket } = bucketNow()
    if (bucket.tabs.length > 0) {
      applyBucketOpen(key, !bucket.open)
      return
    }
    applyBucketOpen(key, true)
    handleOpenGuide()
  }, [applyBucketOpen, bucketNow, handleOpenGuide])

  // 同步 ref 与 state
  useEffect(() => {
    currentWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  // Ctrl / Cmd + P 唤起消息检索（再次按下关闭）
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

  /**
   * 右侧栏快捷键（键位定义在 `ui/shortcuts/commands.ts`，与开始页的键帽同源）：
   * - `Ctrl+Shift+E` 工作区文件；
   * - `Ctrl+\`` 新建终端；
   * - `Ctrl+T` 新建网页标签；
   * - `Ctrl+Alt+B` 展开 / 收起右侧栏。
   *
   * 不在输入框 / 终端里抢键：那边有自己的语义（readline 的 Ctrl+E 是行尾）。
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return
      if (matchesCommand(e, PANEL_COMMANDS['panel.files'])) {
        e.preventDefault()
        handleOpenFilesPage()
        return
      }
      if (matchesCommand(e, PANEL_COMMANDS['panel.terminal'])) {
        e.preventDefault()
        void handleNewTerminal()
        return
      }
      if (matchesCommand(e, PANEL_COMMANDS['panel.browser'])) {
        e.preventDefault()
        handleOpenBrowser()
        return
      }
      if (matchesCommand(e, PANEL_COMMANDS['panel.toggle'])) {
        e.preventDefault()
        handleTogglePanel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [handleNewTerminal, handleOpenBrowser, handleOpenFilesPage, handleTogglePanel])

  // Ctrl / Cmd + N 新建对话（等价于侧边栏按钮）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // 只认纯 Ctrl/Cmd + N
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      // 用 code 兼容非拉丁键盘布局
      if (e.key?.toLowerCase() !== 'n' && e.code !== 'KeyN') return
      // 焦点在终端内时让路：Ctrl+N 是发给 PTY 的控制字符，而 xterm 不阻止冒泡
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
    // 侧边栏元素（用于直接写 CSS 变量）
    const sidebarEl =
      e.currentTarget
        .closest('.chat-view')
        ?.querySelector<HTMLElement>(':scope > .chat-sidebar') ??
      (e.currentTarget.previousElementSibling as HTMLElement | null)

    function applyWidth(w: number) {
      currentWidthRef.current = w
      sidebarEl?.style.setProperty('--width', `${w}px`)
    }

    // 拖拽期间禁用宽度过渡（inline 优先级最高）
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
      // 只在拖拽结束时同步一次 state + 持久化
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
   * 稳定的 setText 回调：内联箭头会让 MessageBubble 的 onEdit 每次换引用，绕过 memo，
   * 流式期间所有可见气泡跟着重渲染。
   */
  const handleSetText = useCallback((text: string) => {
    chatInputRef.current?.setText(text)
  }, [])

  /** 输入框技能引用变化：内容一致时保留原引用，避免侧边栏无谓重渲 */
  const handleSkillsChange = useCallback((names: string[]) => {
    setReferencedSkills((prev) =>
      prev.length === names.length && prev.every((n, i) => n === names[i])
        ? prev
        : names,
    )
  }, [])

  /** 侧边栏技能卡片：未引用则引用，已引用则取消 */
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

  /** 引用消息：把 id / 发送方 / 正文快照交给输入框（必须是稳定引用，否则绕过 memo） */
  const handleQuote = useCallback((quote: QuoteAttachment) => {
    chatInputRef.current?.addQuote(quote)
  }, [])

  /**
   * 点引用 chip：跳转定位到原消息（复用检索的跳转通道）；原消息已删除则静默不动。
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

  /**
   * 轨迹里「在对话中查看」：先切回聊天，再复用检索的跳转通道（滚动定位 + 临时高亮）。
   * 切回是必须的 —— 目标气泡在轨迹视图下根本没渲染，不下发跳转就只能看到一张表。
   */
  const handleTrajectoryJump = useCallback((messageId: string) => {
    const sid = chatState.value.currentSessionId
    if (!sid) return
    setShowTrajectory(false)
    searchJumpNonceRef.current += 1
    setSearchJump({
      id: messageId,
      sessionId: sid,
      nonce: searchJumpNonceRef.current,
    })
  }, [])

  // 从 store 同步消息到本地 state（仅用于触发重渲染）
  const [messages, setMessages] = useState<Message[]>([])
  const applyMessagesUpdate = useCallback((sessionId: string) => {
    if (sessionId !== chatState.value.currentSessionId) return
    const s = sessionStore.getSession(sessionId)
    if (s) setMessages([...s.messages])
  }, [])
  /**
   * 帧合批：流式期间 onMessagesUpdate 每秒上百次，逐次 setMessages 会把重渲染拉到与 chunk 同量级；
   * 合并到每帧一次后上限钉在帧率，视觉无差别。
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
  /** 低频路径（发送、图片分析结果回填）：立即生效，并丢弃排队中的旧更新 */
  const syncMessagesToUINow = useCallback(
    (sessionId: string) => {
      messagesBatchRef.current?.cancel()
      applyMessagesUpdate(sessionId)
    },
    [applyMessagesUpdate],
  )
  /**
   * 消息镜像的兜底同步：messagesChanged 是消息 CRUD 的唯一收口点，任何来源（含手机 bridge）都会到达这里；
   * 走 rAF 合批，与 onMessagesUpdate 同帧去重。
   */
  useEffect(
    () => sessionStore.onMessagesChanged(syncMessagesToUI),
    [syncMessagesToUI],
  )
  // currentSessionId 变为 null 时清空 messages（并丢弃未消费的跳转目标）
  useEffect(() => {
    if (!chatState.value.currentSessionId) {
      setMessages([])
      setSearchJump(null)
    }
    // 切会话（含新建对话）：轨迹是「就这段会话而言」的视图，跟着关掉回到对话
    setShowTrajectory(false)
  }, [chatState.value.currentSessionId])
  useEffect(() => {
    if (chatState.value.currentSessionId) {
      const sid = chatState.value.currentSessionId
      const rt = sessionRuntimeState.value.sessions[sid]
      repairSessionIfNeeded(sid, rt?.working || rt?.paused)
    }
  }, [chatState.value.currentSessionId])

  /**
   * 会话列表变了（或切了会话）：把**已经删掉的会话**那一桶连标签一起丢掉。
   *
   * 三个必须守住的点：
   * 1. **列表空的时候一律不动**：会话是懒加载的，刚启动 / 重新拉列表的瞬间可能是空数组，
   *    那一瞬把桶清掉就等于把用户的三个草稿杀了（连里面的终端一起）；
   * 2. **当前那一桶永远保留**：删会话与切会话可能错开一帧；
   * 3. **切会话也算一次时机**：删的正好是当前会话时，`keep` 那一瞬还是它 —— 只靠列表变化
   *    会把孤儿桶留到下次，那一桶里的终端就再也没人能看见了。
   */
  useEffect(() => {
    if (sessions.length === 0) return
    const keep = panelKeyOf(chatState.value.currentSessionId)
    const alive = new Set(sessions.map((session) => session.id))
    const { buckets, dropped } = withoutSessions(
      panelBucketsRef.current,
      alive,
      keep,
    )
    if (buckets === panelBucketsRef.current) return
    for (const tab of dropped) {
      if (tab.kind === 'terminal') void killUserTerminal(tab.sessionId, tab.termId)
    }
    panelBucketsRef.current = buckets
    setPanelBuckets(buckets)
  }, [sessions, panelKey])

  /** 最近一次「已由本组件处理」的会话切换目标（用于区分自己切的与外部直接改 store 的） */
  const handledSessionRef = useRef<string | null>(null)

  /**
   * 本组件卸载（关窗口 / 页面切走）= 这些终端没有归属了：尽最后一把力杀掉进程树。
   * ⚠️ 是**所有会话**的终端（面板按会话分桶，别的会话里还跑着的也得收）。
   *
   * 真正的兜底在 Rust 侧（每个终端都挂着一个带 `KILL_ON_JOB_CLOSE` 的 Job，进程退出时
   * 内核代杀），所以这里不 await、失败也不报错 —— 只是一个「尽早」。
   */
  useEffect(() => () => killTerminalsIn(null), [killTerminalsIn])

  /**
   * 会话切换的外部入口兜底：托盘唤起这类路径只改 currentSessionId，拿不到 handleSelectSession，
   * 会表现为「窗口打开了、也跳到了会话，但消息列表是空的」。发现非本组件切的就走同一条切换逻辑。
   */
  useEffect(() => {
    const sid = chatState.value.currentSessionId
    if (!sid || sid === handledSessionRef.current) return
    void handleSelectSession(sid)
  }, [chatState.value.currentSessionId])

  async function handleSelectSession(sessionId: string) {
    const session = sessionStore.getSession(sessionId)
    if (!session) return
    // ⚠️ 切会话不再确认、也不再关掉右侧标签：每个会话一套（`panelBuckets`），
    // 切回去原样还在（草稿 / 终端屏幕都没动过）
    // 先登记再干活：内部会再次写同值 currentSessionId，早登记避免兜底 effect 重入
    handledSessionRef.current = sessionId
    const fromSessionId = chatState.value.currentSessionId
    const switchStart =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    // 数据侧准备（清未读 / 懒加载 / 修复 / 锚点索引）与手机接口层共用同一入口，否则两份必分叉。
    // 不 await：清未读在首个 await 之前同步完成
    const prep = activateSession(sessionId)
    chatState.setValue('currentSessionId', sessionId)
    // 切换会话时从该会话运行时恢复错误信息（跨会话不丢失）
    chatState.setValue('error', getSessionRuntime(sessionId).error)
    setMessages([...session.messages])
    // 消息到位后再渲染一次（悬空 tool_calls 的修复结果也在这里出现）
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

    // 存原始数据：content = [{quote}, {text}, {image_url}, {file}]；文件只存路径，引用存快照
    const finalContent: MessageContent = buildUserContent(
      content,
      images ?? [],
      files ?? [],
      quotes ?? [],
      skills ?? [],
    )

    // 先保证有 session（无 session 则立即创建），让 UI 切到聊天视图
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
      // 无会话时在输入区选的推理强度，落到新建会话参数上
      if (chatState.value.selectReasoningEffort) {
        sessionStore.updateSession(session.id, {
          params: {
            ...session.params,
            reasoningEffort: chatState.value.selectReasoningEffort,
          },
        })
      }
      chatState.setValue('currentSessionId', sid)
      // 新建会话由本函数自己接管（内存即真相）；登记一下，避免兜底 effect 重新加载把刚加的消息覆盖回去
      handledSessionRef.current = sid
      setMessages([])
    }

    // 立即添加用户消息，让 UI 立刻显示（含图片，不含分析结果）
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
      // 本地识别期间点亮输入区指示器。用 preparing 而不是 working：后者是并发锁，
      // 写成它之后紧接着的 sendMessage 会被自己的锁判成「正在回复中」
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
          // 按序号组装多图分析结果（让 AI 知道每张图对应哪段分析）
          const parts = validResults.map(
            (r, i) => tpl('第$__n__张图片\n$__text__', { n: i + 1, text: r.combined_text }),
          )
          imageAnalyzeResult =
            tpl('用户上传了$__count__张图片\n\n', { count: validResults.length }) + parts.join('\n\n')
        }
        if (!imageAnalyzeResult) imageOptimize = false
      } finally {
        // 本地准备阶段到此为止：成功 / 失败 / 抛错都必须解除，否则会话会一直停在忙碌上
        updateSessionRuntime(sid, { preparing: false })
      }
    }

    // 分析完成后回填字段
    if (imageOptimize) {
      updateSessionMessage(sid, userMsgId, {
        imageVisionAnalyzeOptimize: true,
        imageVisionAnalyzeResult: imageAnalyzeResult,
      })
      syncMessagesToUINow(sid)
    }

    // 清除分析中的状态文本（sendMessage 会通过 onWorkingChange 设置）
    chatState.setValue('loadingText', '')

    // 公共事件回调
    const events = {
      onWorkingChange: (sid: string, working: boolean) => {
        chatState.setValue('loading', working)
        // 结束工作时清除 loadingText，避免「正在验证」残留
        if (!working) chatState.setValue('loadingText', '')
        // AI 回复结束（无错误）→ 窗口未激活时闪烁提醒
        if (!working && !chatState.value.error) {
          // 非当前会话完成 → 侧边栏标记红点
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
        // 始终存入运行时（跨会话不丢失）；仅当前会话同步到全局态立即展示
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
   * 检索结果点击：关弹窗 → 切会话 → 滚动定位 + 临时高亮。必须等分页加载完成再下发跳转目标。
   */
  async function handleSearchSelect(item: MessageSearchItem) {
    setShowSearch(false)
    if (item.sessionId) {
      if (item.sessionId !== chatState.value.currentSessionId) {
        await handleSelectSession(item.sessionId)
      } else {
        // 同一会话：确保分页已在内存
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

  /**
   * 传给侧栏的三个回调必须引用稳定：`ChatSidebar` 是 observer（内部带 memo），内联箭头每次
   * ChatView 渲染都换引用 → 整棵侧栏（会话列表 / 目录树）跟着重渲染，每次 setMessages、
   * 每一个流式 token 都要多花十几毫秒。三者只用到 ref 与 handleOpenFile。
   */
  const handleAttachPaths = useCallback((paths: string[]) => {
    chatInputRef.current?.attachPaths(paths)
  }, [])
  const handleOpenFileFromSidebar = useCallback(
    (path: string): void => {
      handleOpenFile(path)
    },
    [handleOpenFile],
  )
  const handleAttachSkills = useCallback((names: string[]) => {
    chatInputRef.current?.attachSkills(names)
  }, [])

  const currentTitle = chatState.value.currentSessionId
    ? sessionStore.getSession(chatState.value.currentSessionId)?.title ||
    t('对话')
    : appName

  /**
   * 右侧面板的「工作区文件」与「新建终端」能不能用：与目录树/文件树同一套解析
   * （会话工作区 → 已选目录 → 全局默认目录）。三者都没配时禁用入口并说明原因，
   * 而不是让人点进去看一句「未设置工作目录」。
   */
  const panelWorkspaceReady = Boolean(panelWorkspacePath())

  return (
    <div className={filePanelFull ? 'chat-view is-file-full' : 'chat-view'}>
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
        onAttachPaths={handleAttachPaths}
        // 双击文件 → 右侧面板（文本编辑 / 媒体预览）
        onOpenFile={handleOpenFileFromSidebar}
        // 技能卡片「引用 / 拖拽到输入框」→ 输入框技能附件（读 SKILL.md 全文）
        onAttachSkills={handleAttachSkills}
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
            {/* 对话 / 轨迹：同一份消息的两种看法（轨迹 = 按轮次摊开的事件记录表） */}
            {chatState.value.currentSessionId && (
              <button
                className={`toolbar-icon-btn${showTrajectory ? ' is-active' : ''}`}
                onClick={() => setShowTrajectory((value) => !value)}
                title={showTrajectory ? t('返回对话') : t('轨迹视图')}
                aria-pressed={showTrajectory}
                type="button">
                <TrajectorySvg />
              </button>
            )}
            {/* 任务清单入口（未完成数红点 + 浮层编辑） */}
            {chatState.value.currentSessionId && (
              <TodoEntry sessionId={chatState.value.currentSessionId} />
            )}
            {/* 后台服务：有会话 = 本会话；新对话页 = 全部会话；点行在右侧面板开终端标签 */}
            <ServiceEntry
              sessionId={chatState.value.currentSessionId ?? null}
              onOpenService={handleOpenService}
            />
            {/* 源代码管理：徽标 = 未提交变更数；不是 Git 仓库时入口不出现 */}
            <GitEntry
              sessionId={chatState.value.currentSessionId ?? null}
              // 变更行“拖到输入框 / 右键引用到输入框” → 输入框附件（与目录树同一条链路）
              onAttachPaths={handleAttachPaths}
            />
            <WorkspaceDisplay
              value={
                chatState.value.currentSessionId
                  ? sessionStore.getSession(chatState.value.currentSessionId)
                    ?.workspace
                  : chatState.value.selectedWorkspace
              }
              setValue={(e) => {
                // 换工作目录 = 右侧打开的标签已不属于当前目录，一并关掉（先确认草稿）
                void (async () => {
                  const confirmed = await confirmDiscardDraft(
                    t('切换工作目录会关闭右侧所有标签页，未保存的修改将丢失。'),
                    t('放弃并切换'),
                  )
                  if (!confirmed) return
                  closeSessionTabs()
                  chatState.setValue('selectedWorkspace', e)
                })()
              }}
              workspaces={historyWorkspaces}
            />
            {/*
              右侧面板：一个标签一个视图（文件 / 服务终端 / 用户终端 / 网页 / 开始页 / 文件树）。
              没有标签就开「开始页」；有标签就展开 ↔ 收起 —— **收起只是隐藏**，标签与草稿都留着；
              收起时这颗按钮上的徽标是「这个会话里还开着几个标签」（与 Ctrl+Alt+B 同一条路）。
            */}
            <button
              className={`toolbar-icon-btn${panelVisible ? ' is-active' : ''}`}
              onClick={handleTogglePanel}
              title={
                panelVisible
                  ? t('收起右侧栏')
                  : panelTabCount > 0
                    ? tpl('打开右侧栏（$__count__ 个标签页）', { count: panelTabCount })
                    : t('打开右侧栏')
              }
              aria-label={
                panelTabCount > 0
                  ? tpl('右侧栏：$__count__ 个标签页', { count: panelTabCount })
                  : t('右侧栏')
              }
              aria-pressed={panelVisible}
              type="button">
              <PanelRightSvg />
              {!panelVisible && panelTabCount > 0 && (
                <span className="toolbar-badge" aria-hidden="true">
                  {panelTabCount}
                </span>
              )}
            </button>
            <SettingsView />
          </div>
        </div>

        {chatState.value.currentSessionId ? (
          <>
            {showTrajectory ? (
              <>
                <TrajectoryView
                  sessionId={chatState.value.currentSessionId}
                  systemPrompt={
                    sessionStore.getSession(chatState.value.currentSessionId)
                      ?.systemPrompt
                  }
                  allowedTools={sessionStore.getSession(
                    chatState.value.currentSessionId,
                  )?.allowedTools}
                  messages={messages}
                  hasMoreOlder={sessionStore.hasMoreMessages(
                    chatState.value.currentSessionId,
                  )}
                  onLoadOlder={async () => {
                    const sid = chatState.value.currentSessionId
                    if (sid) await sessionStore.loadOlderMessages(sid)
                  }}
                  onJumpToMessage={handleTrajectoryJump}
                  onClose={() => setShowTrajectory(false)}
                />
                {/* 轨迹视图没有消息滚动容器，卡片退化为一块独立的尾巴（仍可答） */}
                {inlineUI}
              </>
            ) : (
              <ChatMessageList
                messages={messages}
                setMessages={setMessages}
                setText={handleSetText}
                onQuote={handleQuote}
                onQuoteJump={handleQuoteJump}
                jumpTarget={searchJump}
                // 待应答交互的**会话内**通道：挂在滚动内容最底部（只显示当前会话的）
                footer={inlineUI}
              />
            )}
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

      {/*
        右侧面板：一条标签一个视图（文件 / 服务终端 / 用户终端 / 网页 / 开始页 / 文件树）。
        **切标签不卸载**（草稿与撤销栈都不会丢），**收起也不卸载**（宽度收 0，只是看不见）。
        别的会话的标签经 `parkedTabs` 一直挂着 —— 切回去时草稿 / 终端屏幕就是原来那份。
        （所以它不再按「有没有标签」挂载 / 卸载：要清状态只能靠卸载，两个好处不能都要。）
      */}
      <SidePanel
        tabs={currentBucket.tabs}
        activeId={currentBucket.activeId}
        // 别的会话挂着的标签：内容照旧活着，不进标签栏、不显示
        parkedTabs={parkedPanelTabs}
        // 收起 = 只隐藏：宿主的 `open` 与「有标签吗」共同决定
        collapsed={!panelVisible}
        sessionId={chatState.value.currentSessionId ?? undefined}
        onActiveChange={handleActiveTabChange}
        onCloseTab={handleCloseTab}
        onCloseTabs={handleCloseTabs}
        onMoveTab={handleMoveTab}
        onDirtyChange={handleFileDirtyChange}
        // 占满（聊天区不足 300px）→ 把聊天区藏起来，面板接管整块宽度
        onExpandedChange={setFilePanelFull}
        // 「+」开开始页；「»」收起（什么都不丢，所以不问草稿）；开始页里的胶囊原地换成目标页
        onOpenGuide={handleOpenGuide}
        onCollapse={handleCollapsePanel}
        onPickGuide={(kind, shell) => {
          if (kind === 'files') handleOpenFilesPage(true)
          else if (kind === 'terminal') void handleNewTerminal(true, shell)
          else handleOpenBrowser(true)
        }}
        guideWorkspaceReady={panelWorkspaceReady}
        // 开始页的「新建终端」先问类型再开（没装的灰显）：探测在 Rust，宿主只转交
        loadTerminalShells={listUserTerminalShells}
        // 面板里的文件树：单击即开（与左侧栏的双击同一条链路）
        onOpenPath={handleOpenFile}
        onAttachPaths={handleAttachPaths}
        // 网页标签里导航了 → 地址写回标签（tooltip / 兑底标题跟着换）
        onBrowserNavigate={handleBrowserNavigate}
        // 页面报来自己的标题 → 标签栏优先显示它
        onBrowserTitle={handleBrowserTitle}
      />

      {toolUI}

      {/* 消息检索弹窗（Ctrl / Cmd + P）：有会话只搜当前会话，否则搜全部 */}
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
