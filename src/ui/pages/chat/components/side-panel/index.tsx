/**
 * SidePanel — 右侧面板的**容器**：顶部一排标签页，下面是可拖宽的内容区。
 *
 * 为什么要有这一层（而不是继续在 `chat-view` 里直接挂一个文件面板）：
 * 1. **一次能看多个文件**（对着改两处代码、边改 md 边看别的）—— 标签页切换比反复开关快；
 * 2. **宽度 / 拖拽 / 占满归容器**：内容区（`workspace-file` 等）只管自己那块，
 *    不给每个面板各写一套「量可用宽度 + 拖左边缘」。切换标签时宽度当然也不跳；
 * 3. **切标签不卸载**：所有标签的内容**一直挂着**，只做显隐 —— 换成卸载再挂载，
 *    草稿、Monaco 撤销栈、滚动位置全丢（文件面板的草稿只活在组件 state 里）；
 * 4. **五类内容**：文件（`workspace-file`）、后台服务终端（`service/ServiceTerminal`）、
 *    **用户自己的终端**（`terminal/UserTerminal`）、**网页**（`browser/BrowserPane`）、
 *    开始页 / 文件树，加一种 kind 只加 `renderTab()` 的一支；
 * 5. **标签可拖拽换顺序**：顺序归宿主（`tabs` 是它的 state），容器只在拖动中就地预览，
 *    松手时用 `onMoveTab(id, toIndex)` 上报一次 —— 两边同一个下标口径（`tabs.ts::moveTab`）。
 * 6. **标签属于会话，不属于窗口**：宿主按会话分桶（`sessions.ts`），切会话只是换一桶；
 *    别的会话的标签通过 `parkedTabs` 交给这里**一直挂着**（内容不卸载、也不进标签栏）——
 *    所以「收起 / 切会话不清状态」不是靠缓存，而是靠它们从来没被摘下来过。
 * 7. **但「盯着磁盘」只给正在被看的那一个**：常驻挂载 ≠ 常驻订阅。文件标签只在我们传
 *    `active`（= 当前激活标签 **且** 面板没收起）时才订 watcher，文件树同理 —— 否则收起 / 切走后
 *    十几个标签各盯一个父目录，一次落盘换来十几次整文件重读。重新被看着时子组件自己读一次盘对齐。
 * 8. **系统里拖进来的文件直接开成标签**：面板整块登记为一个原生拖放落点（另一个在输入框），
 *    拖入时铺一层提示，松手把路径交给宿主的 `onDropPaths`（开标签归宿主，容器不碰标签状态）。
 *    监听只有一份（`useNativeFileDrop`）—— 各处自己 `listen` 会把同一次拖放处理两遍。
 * 9. **文件标签分「预览位」与「常驻」**（`tabs.ts` 头注释第 6 条）：预览位是用户「路过看一眼」
 *    开的（点文件树 / 拖文件进来），标签文字**斜体**，下一个打开的文件顶掉它；常驻（present
 *    交付 / 用户双击标签 / 改动了草稿）不被顶掉。容器在这条链路上只做两件事：
 *    - 标签上双击 → `onPinTab`（升级成常驻，标签状态归宿主）；
 *    - 子面板报脏的那一刻 → 也 `onPinTab`（预览位永远是干净的，顶掉它才不会丢草稿）。
 *
 * 未保存草稿的归属：本容器汇总「**本会话**任一标签脏」上报宿主（切工作目录前要确认）；
 * 关标签的确认也在这里 —— 但**面板自己的关闭按钮已经确认过一次**，那条路径直接
 * `onCloseTab`，不再问第二遍。切会话**不再**确认：标签与草稿都跟着会话留着。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { fileMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import ServerSvg from '@/ui/components/icons/ServerSvg'
import CompassSvg from '@/ui/components/icons/CompassSvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import TerminalSvg from '@/ui/components/icons/TerminalSvg'
import GlobeSvg from '@/ui/components/icons/GlobeSvg'
import AddSvg from '@/ui/components/icons/AddSvg'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import HideRightSideBarSvg from '@/ui/components/icons/HideRightSideBarSvg'
import WorkspaceFilePanel from '../workspace-file'
import ServiceTerminal from '../service/ServiceTerminal'
import UserTerminal from '../terminal/UserTerminal'
import { shellLabel } from '../terminal/shells'
import type { UserTerminalShell } from '@/infrastructure/terminal'
import WorkspaceTree from '../sidebar/workspace-tree'
import Guide from './guide'
import BrowserPane from './browser/BrowserPane'
import { urlLabel } from './browser/url'
import { isPreviewTab, moveTab, tabLabel, type SidePanelTab } from './tabs'
import { paneSessionIdOf } from './sessions'
import { wheelScrollLeft } from './tab-scroll'
import { useNativeDropTarget } from '@/ui/hooks/useNativeFileDrop'
import './style.scss'

interface Props {
  /** 标签列表（宿主持有：打开 / 关闭都要跟着改宿主自己的状态） */
  tabs: SidePanelTab[]
  /** 当前激活的标签 id（指向已关闭的标签时退回第一个） */
  activeId: string | null
  /**
   * 面板该不该收起来：真的时候宽度被压到 0、不接指针。
   * 宿主在「这个会话里面板是收起的 / 一个标签也没有」时传 true —— 容器**不卸载**，
   * 宽度收 0 只是看不贝（里面那份草稿与终端屏幕还得留着，见头注释第 6 条）。
   */
  collapsed?: boolean
  /** 兜底会话 id：文件面板解析工作区用（带会话前缀的标签走自己的那一桶，见 `sessions.ts`） */
  sessionId?: string
  /**
   * **别的会话的标签**（宿主从其它桶里摊出来的）：内容照旧挂着、不进标签栏、不显示。
   * 它们的存在只为一个目的 —— 切走再切回来时草稿 / 撤销栈 / 终端屏幕还是原来那份。
   */
  parkedTabs?: SidePanelTab[]
  onActiveChange: (id: string) => void
  /** 关闭某个标签。**调用前草稿确认已经问过**（面板内或本容器的 `requestCloseTab`） */
  onCloseTab: (id: string) => void
  /** 把标签 `id` 挪到第 `toIndex` 位（拖动松手时上报一次；不传则标签不可拖） */
  onMoveTab?: (id: string, toIndex: number) => void
  /**
   * 把一个**预览位**的文件标签升级成常驻（双击标签 / 改动草稿两条路）。
   * 标签状态归宿主，所以这里只上报；不传 = 双击不升级（预览位只能靠宿主自己的风控口径留不住）。
   */
  onPinTab?: (id: string) => void
  /** 一次关掉多个标签（标签右键菜单）；没传时容器退化为逐个 `onCloseTab` */
  onCloseTabs?: (ids: string[]) => void
  /** 任一标签有未保存草稿（宿主据此在切会话 / 切工作目录前确认） */
  onDirtyChange?: (dirty: boolean) => void
  /** 面板占满（聊天区被压到不足 `CHAT_MIN_WIDTH`）时为 true：宿主据此把聊天区藏起来 */
  onExpandedChange?: (expanded: boolean) => void
  /** 标签栏的「+」：打开 / 切到开始页（不传则不显示这颗按钮） */
  onOpenGuide?: () => void
  /** 标签栏右端的收起按钮：收起右侧栏（不传则不显示） */
  onCollapse?: () => void
  /**
   * 开始页点了一扇门：宿主持有标签状态，由它把开始页原地换成目标页。
   * `shell` 只对终端有意义（用户在类型菜单里挑的那一种；不带 = 上次的 / 默认的）。
   */
  onPickGuide?: (kind: 'files' | 'terminal' | 'browser', shell?: string) => void
  /**
   * 开始页「新建终端」要用的类型列表（探测「装没装」要问 Rust）。
   * 不传 = 不弹类型菜单，直接开默认那种。
   */
  loadTerminalShells?: () => Promise<UserTerminalShell[]>
  /** 网页标签里导航了一次：宿主把地址写回标签（tooltip 与兑底标题用它） */
  onBrowserNavigate?: (id: string, url: string) => void
  /** 页面报来了自己的标题：宿主写回标签（标签栏优先显示它） */
  onBrowserTitle?: (id: string, title: string) => void
  /** 有没有可浏览的工作区（没有时开始页的「工作区文件」禁用并说明原因） */
  guideWorkspaceReady?: boolean
  /** 开始页 / 文件树里双击（面板里单击）文件 → 宿主开标签 */
  onOpenPath?: (path: string) => void
  /** 文件树右键「引用到输入框」/ 拖到输入框（与左侧栏同一条链路） */
  onAttachPaths?: (paths: string[]) => void
  /**
   * 系统里拖进来的文件（原生拖放，带真实路径）：宿主持有标签状态，由它把路径开成文件标签。
   * 不传 = 面板不接拖放（也就没有拖入高亮）。
   */
  onDropPaths?: (paths: string[]) => void
}

/** 面板宽度：只有下限与兜底默认值，**没有固定上限**（最多给到整块可用宽度，见 `maxDragWidth`） */
const MIN_WIDTH = 360
const DEFAULT_WIDTH = 560
/**
 * 聊天区的最小可用宽度：连它都留不住，就让面板占满、聊天区先不显示。
 * 450（旧值 300）：300 时消息气泡只剩一条窄栏，中文一行放不下几个字、输入框的工具行也挤掉；
 * 与其把聊天区挤成一条，不如让面板占满（宿主把 `.chat-main` 隐起来，往回拖过这条线再回来）。
 */
const CHAT_MIN_WIDTH = 450
/** 鼠标移动超过这么多像素才算「拖标签」（否则还是一次点击） */
const DRAG_THRESHOLD = 4
/** 拖完松手后多久内到达的 click 算「拖动的尾巴」（浏览器把它紧跟在 mouseup 后面发） */
const CLICK_AFTER_DRAG_MS = 400
/** 没有别的会话挂着标签时的空表（共享一份，避免每次渲染换引用） */
const EMPTY_PARKED: SidePanelTab[] = []

/** 面板和聊天区是同一行的兄弟：`.chat-view` 里的那个 `.chat-main` */
function chatMainOf(panel: HTMLElement | null): HTMLElement | null {
  const parent = panel?.parentElement
  if (!parent) return null
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.classList.contains('chat-main')) return child
  }
  return null
}

/** 拖动下限：正常是 MIN_WIDTH；窗口窄到 `MIN_WIDTH + CHAT_MIN_WIDTH` 都放不下时，先让聊天区能露出来 */
function minDragWidth(available: number): number {
  if (available <= 0) return MIN_WIDTH
  return Math.min(MIN_WIDTH, Math.max(120, available - CHAT_MIN_WIDTH))
}

/** 打开时占「可用宽度的一半」（没有固定上限，只受可用宽度本身约束） */
function preferredWidth(available: number): number {
  if (available <= 0) return DEFAULT_WIDTH
  return Math.min(available, Math.max(minDragWidth(available), Math.round(available / 2)))
}

/**
 * 拖动上限：**不设固定上限** —— 最多给到「聊天区 + 面板」的整块可用宽度。
 * 再往左就是面板占满（聊天区交给 `expanded` 藏起来），比可用宽度更宽没有意义。
 */
function maxDragWidth(available: number): number {
  // 量不到可用宽度时退回窗口宽度：宁可放宽，也别把用户卡在默认宽度上
  return available > 0 ? available : window.innerWidth
}

function SidePanel({
  tabs,
  activeId,
  sessionId,
  parkedTabs,
  collapsed = false,
  onActiveChange,
  onCloseTab,
  onCloseTabs,
  onMoveTab,
  onPinTab,
  onDirtyChange,
  onExpandedChange,
  onOpenGuide,
  onCollapse,
  onPickGuide,
  guideWorkspaceReady = true,
  loadTerminalShells,
  onOpenPath,
  onAttachPaths,
  onBrowserNavigate,
  onBrowserTitle,
  onDropPaths,
}: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  /** 「聊天区 + 面板」可用的总宽（0 = 还没量到 / 量不了） */
  const [available, setAvailable] = useState(0)
  const [resizing, setResizing] = useState(false)
  /** 左侧栏 + 分隔条占掉的宽度：聊天区被藏起来（占满态）时量不到它，靠上次的值推算 */
  const insetRef = useRef(0)
  /** 有未保存草稿的标签（标签上一个小圆点；宿主据此决定要不要拦一下） */
  const [dirtyIds, setDirtyIds] = useState<string[]>([])
  /** 正在拖的标签与它当前的落点（null = 没在拖）；落点 = 最终下标，与 `tabs.ts::moveTab` 同口径 */
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null)
  /**
   * 开始页里那棵文件树的搜索词。
   *
   * 与左侧栏一样由「宿主」持有（`WorkspaceTree` 是受控的）—— 但它真正的宿主是容器：
   * 标签切走时树**不卸载**（只试 hidden），却不能再往上抬一层（chat-view 已经够长）。
   */
  const [filesQuery, setFilesQuery] = useState('')
  /**
   * 标签栏「全屏」按钮：用户手动让面板接管整块可用宽度（聊天区交给宿主藏起来）。
   * 与 `expanded`（窗口太窄时的自动占满）分开记 —— 自动占满不是用户选的，窗口宽回来就该自己退。
   */
  const [fullscreen, setFullscreen] = useState(false)
  /** 有文件正被拖到面板上方（原生拖放只给坐标，命中由 `useNativeFileDrop` 算）：铺一层提示 */
  const [dropActive, setDropActive] = useState(false)

  /**
   * 登记「整个面板」作为一个原生拖放落点（另一个在输入框，见 `input/use-native-drag-drop`）。
   * 收起时不接：那时宽度是 0（命中判定本来就会跳过），显式再挡一道，免得高亮留在看不见的地方。
   */
  useNativeDropTarget({
    element: () => panelRef.current,
    enabled: () => !collapsed && !!onDropPaths,
    onHover: setDropActive,
    onDrop: (paths) => onDropPaths?.(paths),
  })

  /**
   * 量一次「聊天区 + 面板」可用的总宽：面板贴右，所以 = 容器右边界 - 聊天区左边界
   * （左侧栏与分隔条不算进来）。量不到时返回 0，宽度退回 DEFAULT_WIDTH。
   */
  const measureAvailable = useCallback(() => {
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!panel || !parent) return 0
    const parentRect = parent.getBoundingClientRect()
    const mainRect = chatMainOf(panel)?.getBoundingClientRect()
    if (mainRect && mainRect.width > 0) {
      insetRef.current = mainRect.left - parentRect.left
    } else if (insetRef.current <= 0) {
      // 聊天区被藏起来，且还没量过「左侧栏 + 分隔条」：这次按量不到处理，别拿满宽去猜
      return 0
    }
    return Math.max(0, Math.round(parentRect.width - insetRef.current))
  }, [])

  /**
   * **第一次量到可用宽度时**按它的一半定宽（通常是首个标签打开的那一刻；加标签、切标签都不重算，
   * 用户拖出来的宽度不会被悄悄改回去）。之后窗口 / 左侧栏变化只更新「可用宽度」，
   * 宽度本身不跟着改 —— 窄到聊天区不足 `CHAT_MIN_WIDTH` 时由下面的 `expanded` 接管，把面板撑满。
   * ⚠️ 容器现在是**常驻挂载**的（没标签也在树上），首帧很可能量不到（布局还没排好）：
   * 所以定宽放在「第一次量到非 0」那一刻，而不是无条件在挂载时干一次（否则会永远停在 560）。
   */
  const widthSettledRef = useRef(false)
  useLayoutEffect(() => {
    const settle = (next: number) => {
      if (widthSettledRef.current || next <= 0) return
      widthSettledRef.current = true
      setWidth(preferredWidth(next))
    }
    const next = measureAvailable()
    setAvailable(next)
    settle(next)

    const refresh = () => {
      const measured = measureAvailable()
      setAvailable(measured)
      settle(measured)
    }
    const parent = panelRef.current?.parentElement
    // jsdom 没有 ResizeObserver：没有它就只靠窗口 resize（真机上窗口变化必有这一支）
    const observer =
      parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null
    if (parent && observer) observer.observe(parent)
    window.addEventListener('resize', refresh)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', refresh)
    }
  }, [measureAvailable])

  /**
   * 聊天区会被压到不足 `CHAT_MIN_WIDTH`（450）：面板占满，聊天区交给宿主先藏起来。
   * 两种来源：用户按了标签栏的全屏（`fullscreen`），或窗口本来就窄到挤不下两者。
   * 收起时不算 —— 宽度是 0，拿它去比只会得「占满」并把聊天区藏掉。
   */
  const expanded =
    !collapsed &&
    available > 0 &&
    (fullscreen || available - width < CHAT_MIN_WIDTH)
  /**
   * 上屏宽度：占满态铺满整块可用宽度（`width` 里记的偏好值可能与眼前这块对不上）。
   * **拖动中一律按 `width`**：否则从占满态往回拖，前 450px（`CHAT_MIN_WIDTH`）面板一动不动，手柄就像坏的。
   */
  const shownWidth = expanded && !resizing ? available : width

  // 收起时把全屏态一并退掉：再展开时回到用户拖出来的宽度，而不是莫名其妙又占满
  useEffect(() => {
    if (collapsed) setFullscreen(false)
  }, [collapsed])

  /**
   * 全屏 ↔ 还原。
   * 退出时若宽度本来就已经大到挤掉聊天区（窗口太窄时被自动顶成占满），
   * 顺手收到「刚好留出 `CHAT_MIN_WIDTH`」那条线（与拖动下限同一口径），否则聊天区回不来。
   */
  const toggleFullscreen = useCallback(() => {
    if (!fullscreen) {
      setFullscreen(true)
      return
    }
    setFullscreen(false)
    if (available > 0 && available - width < CHAT_MIN_WIDTH) {
      setWidth(minDragWidth(available))
    }
  }, [fullscreen, available, width])

  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  // 容器卸载（最后一个标签关掉）时把聊天区放回来：宿主那边也复位，这里兜一层
  useEffect(() => () => onExpandedChange?.(false), [onExpandedChange])

  /** 记一个标签的脏状态（同一个值重复上报时保持原引用，不触发重渲染） */
  const markDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      const has = prev.includes(id)
      if (dirty === has) return prev
      return dirty ? [...prev, id] : prev.filter((item) => item !== id)
    })
  }, [])

  /**
   * 每个标签一份**稳定**的脏回调：面板里的 effect 依赖它，内联箭头会让那个 effect
   * 每帧重跑（面板每渲染一次就 setState 一次）。
   */
  const dirtyHandlersRef = useRef(new Map<string, (dirty: boolean) => void>())
  const dirtyHandlerOf = useCallback(
    (id: string) => {
      let handler = dirtyHandlersRef.current.get(id)
      if (!handler) {
        handler = (dirty: boolean) => markDirty(id, dirty)
        dirtyHandlersRef.current.set(id, handler)
      }
      return handler
    },
    [markDirty],
  )

  /**
   * 每个标签的「刷新」动作（标签右键菜单里的那一项）：面板挂载时登记、卸载时撤回。
   * 登记器按标签 id 缓存成稳定引用（面板里的 effect 依赖它）；动作存另一张表，菜单直接取。
   */
  const reloadActionsRef = useRef(new Map<string, () => void>())
  const reloadRegistrarsRef = useRef(
    new Map<string, (reload: (() => void) | null) => void>(),
  )
  const reloadRegistrarOf = useCallback((id: string) => {
    let registrar = reloadRegistrarsRef.current.get(id)
    if (!registrar) {
      registrar = (reload) => {
        if (reload) reloadActionsRef.current.set(id, reload)
        else reloadActionsRef.current.delete(id)
      }
      reloadRegistrarsRef.current.set(id, registrar)
    }
    return registrar
  }, [])

  // 标签关掉之后把它的脏状态一起清掉（不清的话「任一脏」会一直是 true）；
  // 别的会话里挂着的标签也算「活着」—— 它们只是不在标签栏里
  useEffect(() => {
    const alive = new Set([
      ...tabs.map((tab) => tab.id),
      ...(parkedTabs ?? []).map((tab) => tab.id),
    ])
    for (const key of Array.from(dirtyHandlersRef.current.keys())) {
      if (!alive.has(key)) dirtyHandlersRef.current.delete(key)
    }
    for (const registry of [reloadActionsRef, reloadRegistrarsRef]) {
      for (const key of Array.from(registry.current.keys())) {
        if (!alive.has(key)) registry.current.delete(key)
      }
    }
    setDirtyIds((prev) =>
      prev.every((id) => alive.has(id)) ? prev : prev.filter((id) => alive.has(id)),
    )
  }, [tabs, parkedTabs])

  /**
   * 上报的「有未保存草稿」只算**本会话**的标签：
   * 别的会话藏着的那份脏不关眼前的事（它们不会因为切会话丢掉，切回去自然还是脏的）。
   */
  const dirty = useMemo(() => {
    if (dirtyIds.length === 0) return false
    return dirtyIds.some((id) => tabs.some((tab) => tab.id === id))
  }, [dirtyIds, tabs])
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  /**
   * 「改动就能留下来」：预览位标签一旦脏了就升级成常驻。
   *
   * 为什么必须在脏的那一刻升级：顶掉预览位 = 那一格的面板**卸载**（草稿、撤销栈一起没），
   * 下一个打开的文件不能把用户刚写下的东西顶掉。反过来，预览位永远是干净的 ——
   * 所以顶掉它不需要任何确认（旧实现是单面板，换文件必须问「放弃未保存的修改？」）。
   *
   * 「支持编辑」不用另判：只有文本文件会脏（媒体 / PDF / Office / 3D 是只看不改，
   * 它们连草稿都没有），所以能走到这里的本来就只有能改的那几种。
   * 别的会话挂着的标签也算在内（`parkedTabs`）：它们切回去时同样不能被下一个文件顶掉。
   */
  const parkedList = parkedTabs ?? EMPTY_PARKED
  useEffect(() => {
    if (!onPinTab) return
    for (const id of dirtyIds) {
      const tab =
        tabs.find((item) => item.id === id) ?? parkedList.find((item) => item.id === id)
      if (tab && isPreviewTab(tab)) onPinTab(id)
    }
  }, [dirtyIds, tabs, parkedList, onPinTab])

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const rect = panelRef.current?.getBoundingClientRect()
      if (!rect) return
      // 用户亲手拖过就不再自动定宽（量到可用宽度也不改回去）
      widthSettledRef.current = true
      // 从全屏往回拖 = 退出全屏：否则上屏宽度只认 `available`，手柄怎么拖都不动
      setFullscreen(false)
      const right = rect.right
      // 拖之前重量一次：左侧栏或窗口可能刚动过
      const room = measureAvailable()
      if (room > 0) setAvailable(room)
      const min = minDragWidth(room)
      const max = maxDragWidth(room)
      // 占满态上屏的是 `available`，先把 state 对齐到眼前这条边：按下去那一瞬间面板才不会跳一下
      if (rect.width > 0) setWidth(Math.round(rect.width))
      setResizing(true)
      // 指针拖出面板时也要保持 col-resize（与左侧栏拖拽同一手法）
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (moveEvent: MouseEvent) => {
        // 不能把聊天区压到 `CHAT_MIN_WIDTH` 以下 —— 那条线交给 `expanded`（松手后铺满）
        const next = Math.max(min, Math.min(max, Math.round(right - moveEvent.clientX)))
        setWidth(next)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setResizing(false)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [measureAvailable],
  )

  /**
   * 标签右键菜单：target 是「右键的那个标签」—— 关闭类动作都作用于它，与当前激活的是谁无关。
   * 按坐标开（不按锚点）：标签栏就在鼠标下方，菜单跟着指针更符合直觉。
   */
  const tabMenu = useContextMenu<{ id: string }>()

  /**
   * 关一批标签：里面有未保存草稿先问**一次**（逐个问会弹一串对话框）。
   * 面板自己头部的关闭按钮走的是另一条路（它内部已经确认过，直接 `onCloseTab`）。
   */
  const requestCloseTabs = useCallback(
    async (ids: string[]) => {
      // 菜单开着的时候标签可能已经没了（切工作目录等）：只处置还活着的
      const closable = ids.filter((id) => tabs.some((tab) => tab.id === id))
      if (closable.length === 0) return
      const submit = () => {
        if (!onCloseTabs) {
          for (const id of closable) onCloseTab(id)
          return
        }
        onCloseTabs(closable)
      }
      if (!closable.some((id) => dirtyIds.includes(id))) {
        submit()
        return
      }
      const confirmed = await MessageBox.propt(
        t('放弃未保存的修改？'),
        t('关闭后这些修改会丢失。'),
        { confirmText: t('放弃并关闭'), cancelText: t('取消'), danger: true },
      )
      if (confirmed) submit()
    },
    [dirtyIds, onCloseTab, onCloseTabs, tabs],
  )

  /** 关单个标签（标签栏那颗 ×）：有草稿先问一句 */
  const requestCloseTab = useCallback(
    (id: string): void => {
      void requestCloseTabs([id])
    },
    [requestCloseTabs],
  )

  /**
   * 右键菜单的项。四条口径：
   * 1. 关闭类一律以「右键的那个标签」为锚点（关闭其他 / 关闭右侧不会因为当前激活的是别人而作用错对象）；
   * 2. 「关闭已保存」= 关掉所有**没有**未保存草稿的标签（与 VS Code 同口径；服务终端没有草稿，一并算「已保存」）；
   * 3. 文件类动作只给**文件**标签（服务终端没有路径可复制 / 没有编辑器），且用全应用唯一那份工厂、
   *    `withOpen:false` —— 面板头已经有「在系统程序中打开」；
   * 4. 「刷新」= 让那个**文件**面板重新读盘（有草稿会先问）：动作住在面板里（`load()` 与
   *    草稿确认都在那儿），所以由面板登记上来（见 `reloadRegistrarOf`），容器只负责转发。
   */
  function tabMenuItems(target: { id: string }): ContextMenuItem[] {
    const index = tabs.findIndex((tab) => tab.id === target.id)
    // 菜单开着的时候目标标签被关掉了：不给任何操作入口
    if (index < 0) return []
    const tab = tabs[index]
    const others = tabs.filter((item) => item.id !== target.id).map((item) => item.id)
    const right = tabs.slice(index + 1).map((item) => item.id)
    const saved = tabs.filter((item) => !dirtyIds.includes(item.id)).map((item) => item.id)
    const contentItems: ContextMenuItem[] =
      tab.kind === 'file'
        ? [
          // 刷新归「内容动作」这一段（与文件类动作同一组），分隔线画在它上面
          {
            key: 'reload',
            label: t('刷新'),
            divider: true,
            // 面板还没挂载完（刚打开 / 已卸载）时点不了
            disabled: !reloadActionsRef.current.has(tab.id),
            onClick: () => reloadActionsRef.current.get(tab.id)?.(),
          },
          ...fileMenuItems(tab.path, { withOpen: false }),
        ]
        : []
    return [
      { key: 'close', label: t('关闭'), onClick: () => void requestCloseTabs([target.id]) },
      {
        key: 'close-others',
        label: t('关闭其他'),
        disabled: others.length === 0,
        onClick: () => void requestCloseTabs(others),
      },
      {
        key: 'close-right',
        label: t('关闭右侧标签页'),
        disabled: right.length === 0,
        onClick: () => void requestCloseTabs(right),
      },
      {
        key: 'close-saved',
        label: t('关闭已保存'),
        disabled: saved.length === 0,
        onClick: () => void requestCloseTabs(saved),
      },
      {
        key: 'close-all',
        label: t('全部关闭'),
        onClick: () => void requestCloseTabs(tabs.map((item) => item.id)),
      },
      ...contentItems,
    ]
  }

  /** 真正渲染某个标签的内容：加新的内容类型（网址 / 差异…）就在这里加一支 */
  const renderTab = (tab: SidePanelTab, active: boolean) => {
    /**
     * 「正在被看」= 这个标签是当前激活的**而且**面板没收起。
     * 只有被看的那个标签才去盯磁盘 / 订目录：标签全部常驻挂载（本会话的其它标签、别的会话
     * 挂着的、面板收起时的那一批都在），谁都能订就是一个落盘换来十几次读盘。
     * 注：`active`（终端 / 服务终端的那份）仍然只看「是不是选中标签」—— 收起时终端进程与
     * 服务轮询照旧活着，那是它们本来的语义。
     */
    const live = active && !collapsed
    if (tab.kind === 'file') {
      return (
        <WorkspaceFilePanel
          path={tab.path}
          // 文件面板按**标签自己的**会话解析工作区：别的会话挂着的那份不能跟着当前会话跑
          //（跟着跑会让它去当前工作区里找路径 → 读不到，甚至把草稿当成「外面的文件」）
          sessionId={paneSessionIdOf(tab, sessionId)}
          // 只盯「正在被看」的那个文件（见 `workspace-file` 头注释第 7 条）
          active={live}
          // 标题已经在上面的标签栏里了：面板头只留目录 + 操作按钮
          hideTitle
          // 打开时落在哪个视图：present 的交付物直接给预览（普通打开仍是编辑）；
          // viewSeq 让「同一个文件再 present 一次」也能把用户手动切走的视图请回预览
          defaultView={tab.view}
          viewSeq={tab.viewSeq}
          onDirtyChange={dirtyHandlerOf(tab.id)}
          // 刷新归容器（标签右键菜单）：面板把动作登记上来
          onReloadReady={reloadRegistrarOf(tab.id)}
          onClose={() => onCloseTab(tab.id)}
        />
      )
    }
    if (tab.kind === 'guide') {
      return (
        <Guide
          onPick={(kind, shell) => onPickGuide?.(kind, shell)}
          workspaceReady={guideWorkspaceReady}
          loadShells={loadTerminalShells}
        />
      )
    }
    if (tab.kind === 'files') {
      // 树根按**标签自己的**会话解析（与左侧栏同一份解析，`paneSessionIdOf` 兜底到当前会话）：
      // 别的会话挂着的那棵树不能跟着当前会话跑，否则会去当前会话的目录里订 watcher
      return (
        <div className="side-panel-files">
          <WorkspaceTree
            // 面板里单击就打开（左侧栏保持双击，避免改掉了老手感）
            variant="panel"
            sessionId={paneSessionIdOf(tab, sessionId)}
            // 不是当前标签 / 面板收起时不订任何目录 watcher（见 `workspace-tree`）
            active={live}
            onAttachPaths={onAttachPaths ?? (() => { })}
            onOpenFile={(path) => onOpenPath?.(path)}
            searchQuery={filesQuery}
            onSearchQueryChange={setFilesQuery}
          />
        </div>
      )
    }
    if (tab.kind === 'service') {
      // 会话 id 取标签自己的（全局视图里服务可能属于另一个会话）；切走时停轮询、不卸载
      return (
        <ServiceTerminal
          sessionId={tab.sessionId}
          serviceId={tab.serviceId}
          name={tab.name}
          sessionLabel={tab.sessionLabel}
          active={active}
          // 头部那颗 ✕ 与标签栏的 × 同一条路：服务终端没有草稿，直接关
          onClose={() => onCloseTab(tab.id)}
        />
      )
    }
    if (tab.kind === 'terminal') {
      // 用户自己的终端：关标签由宿主先 kill 掉进程树（`onCloseTab` 那一侧负责）。
      // 面板不再显示工作目录 / pid：用户自己的终端屏幕上就是全部有用的东西（cwd 在标签 tooltip 上）
      return (
        <UserTerminal
          sessionId={tab.sessionId}
          termId={tab.termId}
          shell={tab.shell}
          active={active}
          onClose={() => onCloseTab(tab.id)}
        />
      )
    }
    if (tab.kind === 'browser') {
      // 网页：切走时**不卸载**（iframe 里的页面、滚动位置都留着）；
      // `initialUrl` 只在挂载时读一次 —— 之后导航归面板，宿主那份是它的镜像
      return (
        <BrowserPane
          initialUrl={tab.url}
          onNavigate={(url) => onBrowserNavigate?.(tab.id, url)}
          onTitle={(title) => onBrowserTitle?.(tab.id, title)}
          onClose={() => onCloseTab(tab.id)}
        />
      )
    }
    return null
  }

  // activeId 指向已关闭的标签（宿主还没来得及换）时退回第一个，别渲染出一片空白
  const current = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null

  /** 标签栏本体：滚轮横向滚动挂在它上面 */
  const tabsRef = useRef<HTMLDivElement>(null)
  /**
   * 激活的标签滚进可视区：标签一多标签栏会横向滚，开一个新文件时
   * 它可能刚落在视野外（点标签本身不需要，但双击文件 / 已开着再点一下就靠它）。
   */
  const tabRefs = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    const el = current ? tabRefs.current.get(current.id) : null
    // jsdom 没有实现 scrollIntoView：有才调
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [current?.id])

  /**
   * 标签栏：滚轮纵向手势 → 横向滚动。
   * 自己挂非 passive 的原生监听，不用 `onWheel` —— React 的 wheel 监听在 root 上带
   * `passive: true`，里面 `preventDefault()` 不生效（标签一多滚起来还会牵动外层滚动）。
   */
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      const next = wheelScrollLeft(el, event)
      if (next === null) return
      event.preventDefault()
      el.scrollLeft = next
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const dragStateRef = useRef<{
    id: string
    /** 按下时的下标（也是初始落点） */
    from: number
    startX: number
    /** 指针在标签内的横向位置：拖动时这个点一直跟着指针 */
    grabOffset: number
    target: number
    moved: boolean
    /** 拖动开始时「其他标签」的中线 x（快照，不随重排变动） */
    others: number[]
    /** 已经写到元素上的 translateX（用来把视觉位置换算回布局位置） */
    applied: number
    /** 最后一次鼠标 x：重排落地后要用它再校正一次 */
    lastX: number
  } | null>(null)
  /** 拖完松手那一次 click 是拖动的尾巴：只吞「同一个标签 + 短窗口内」的那一下（自己会过期，不残留） */
  const suppressClickRef = useRef<{ id: string; until: number } | null>(null)

  /**
   * 让被拖的标签跟住指针：视觉左边缘 = 指针 - 抓握偏移。
   *
   * 位移是**直接写元素 style**的，不走 state：每帧 setState 会让整个面板（含编辑器）重渲染，
   * 拖起来一跳一跳的。重排后布局位置变了，靠「视觉位置 - 已写位移」反算当前布局位置再重算，
   * 所以标签始终贴在指针上（不会因为换了一格而顺着旧位移滑一下）。
   */
  function followPointer(state: { id: string; grabOffset: number; applied: number }, clientX: number): void {
    const el = tabRefs.current.get(state.id)
    if (!el) return
    const layoutLeft = el.getBoundingClientRect().left - state.applied
    const next = Math.round(clientX - state.grabOffset - layoutLeft)
    if (next === state.applied) return
    state.applied = next
    el.style.transform = `translateX(${next}px)`
  }

  /**
   * 拖标签换顺序。用鼠标事件而不是 HTML5 拖拽：`dragDropEnabled: true`（拖文件进输入框要真实路径，
   * 见 §11.8）时页面收不到 HTML5 drag / drop，`draggable` 在这里根本不触发。
   *
   * 落点只看**开始拖那一刻**的中线快照：用实时 DOM 中线的话，标签一重排中线跟着跑，
   * 指针停在两格之间就会来回跳。
   */
  const startTabDrag = (event: React.MouseEvent, tab: SidePanelTab) => {
    if (event.button !== 0 || !onMoveTab || tabs.length < 2) return
    // 关标签那颗 × 上按下不是拖标签
    if ((event.target as HTMLElement).closest('.side-panel-tab-close')) return
    const from = tabs.findIndex((item) => item.id === tab.id)
    if (from < 0) return
    const rects = tabs.map((item) => ({
      id: item.id,
      rect: tabRefs.current.get(item.id)?.getBoundingClientRect() ?? null,
    }))
    const own = rects.find((item) => item.id === tab.id)?.rect ?? null
    const others = rects
      .filter((item) => item.id !== tab.id)
      .map((item) => (item.rect ? item.rect.left + item.rect.width / 2 : 0))
    dragStateRef.current = {
      id: tab.id,
      from,
      startX: event.clientX,
      grabOffset: own ? event.clientX - own.left : 0,
      target: from,
      moved: false,
      others,
      applied: 0,
      lastX: event.clientX,
    }

    const onMove = (moveEvent: MouseEvent) => {
      const state = dragStateRef.current
      if (!state) return
      if (!state.moved) {
        if (Math.abs(moveEvent.clientX - state.startX) < DRAG_THRESHOLD) return
        state.moved = true
        setDrag({ id: state.id, index: state.target })
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      state.lastX = moveEvent.clientX
      // 落点 = 「中线在指针左边的其他标签」个数（= 取出被拖标签后的插入位置，也是最终下标）
      const target = state.others.filter((center) => center < moveEvent.clientX).length
      if (target !== state.target) {
        state.target = target
        setDrag({ id: state.id, index: target })
      }
      followPointer(state, moveEvent.clientX)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const state = dragStateRef.current
      dragStateRef.current = null
      setDrag(null)
      if (!state || !state.moved) return
      // 位移只是拖动中的视觉效果：松手后标签回到它自己的格子里
      const el = tabRefs.current.get(state.id)
      if (el) el.style.transform = ''
      // 用时钟窗口而不是永久标志：click 未如期到达（松手时指针不在标签上）也不会吞掉下一次点击
      suppressClickRef.current = { id: state.id, until: performance.now() + CLICK_AFTER_DRAG_MS }
      // 没换位置就别惊动宿主
      if (state.target !== state.from) onMoveTab?.(state.id, state.target)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // 拖动中按落点就地重排（松手时宿主落同一份顺序），用户不用等松手才看到结果
  const arranged = drag ? moveTab(tabs, drag.id, drag.index) : tabs

  // 重排落地后按新布局再校正一次位移：否则标签会「跳一整格」到下一帧才被拉回指针（layout effect = 上屏前）
  useLayoutEffect(() => {
    const state = dragStateRef.current
    if (drag && state) followPointer(state, state.lastX)
  }, [drag])

  /**
   * 内容块的渲染顺序 = **打开顺序**，与标签顺序解耦。
   *
   * ⚠️ 不能跟着 `tabs` 排序：挪 DOM 会让 React 重连那棵子树的 effect（dev 下还会双调用），
   * 而 `@monaco-editor/react@4.7` 的 mount-only 清理会 `editor.dispose()` 却不清自己持有的实例，
   * 紧接着的一次性 effect 又 `setModel` 到已 dispose 的编辑器上 —— 就是
   * 「InstantiationService has been disposed」+ 视图 rAF 里的 「reading 'domNode'」。
   * 内容块一次只显一个，顺序本来就无关紧要。
   *
   * 列表里还包括**别的会话挂着的标签**（`parkedTabs`）：它们永远 `hidden`，但 DOM 一直在 ——
   * 这就是「切会话不清状态」的全部实现（草稿 / 撤销栈 / 终端屏幕都活在子组件里）。
   */
  const parked = parkedTabs ?? EMPTY_PARKED
  const paneIdsRef = useRef<string[]>([])
  const paneIds = useMemo(() => {
    const all = [...tabs, ...parked]
    const alive = new Set(all.map((tab) => tab.id))
    const kept = paneIdsRef.current.filter((id) => alive.has(id))
    for (const tab of all) if (!kept.includes(tab.id)) kept.push(tab.id)
    paneIdsRef.current = kept
    return kept
  }, [tabs, parked])

  /**
   * 内容区与拖动无关：单独 memo 一次，免得拖动中的每一帧都把里面的编辑器全重渲染一遍
   *（`@monaco-editor/react` 每帧都会 `updateOptions` 一次）。依赖只写 `renderTab` 真正读的东西。
   */
  const body = useMemo(
    () => (
      <div className="side-panel-body">
        {paneIds.map((id) => {
          const tab = tabs.find((item) => item.id === id) ?? parked.find((item) => item.id === id)
          if (!tab) return null
          return (
            // 所有标签的内容**都挂着**，只切显隐：卸载会把草稿 / 撤销栈 / 滚动位置一起抹掉
            <div
              key={tab.id}
              className="side-panel-pane"
              role="tabpanel"
              hidden={tab.id !== current?.id}>
              {renderTab(tab, tab.id === current?.id)}
            </div>
          )
        })}
      </div>
    ),
    // eslint 不在本仓：`renderTab` 读取的只有这几个，漏一个就会出现「切了标签内容不换」
    [
      paneIds,
      tabs,
      parked,
      current?.id,
      // 收起 / 展开也要重算：文件面板与文件树的 `active` 靠它（不收起的「不看」只是 hidden）
      collapsed,
      sessionId,
      dirtyHandlerOf,
      onCloseTab,
      onOpenPath,
      onAttachPaths,
      onPickGuide,
      guideWorkspaceReady,
      filesQuery,
      onBrowserNavigate,
      onBrowserTitle,
    ],
  )

  return (
    <aside
      ref={panelRef}
      className={`side-panel${resizing ? ' is-resizing' : ''}${expanded ? ' is-full' : ''}${collapsed ? ' is-collapsed' : ''
        }`}
      // 占满态直接铺满「聊天区 + 面板」的整块可用宽度（宿主这时已经把聊天区藏起来了）
      style={{ width: shownWidth }}>
      <div
        className="side-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整面板宽度')}
        onMouseDown={startResize}
      />

      {/* 文件正被拖到面板上方：整块铺一层提示。`pointer-events: none` 是必须的 ——
          原生拖放的命中按**坐标**算（见 `useNativeFileDrop`），这层只负责告诉用户「松手就开」。 */}
      {dropActive && (
        <div className="side-panel-drop-hint" aria-hidden="true">
          <span className="side-panel-drop-hint-text">{t('松开即可打开文件')}</span>
        </div>
      )}

      <div className="side-panel-tabbar">
        <div className="side-panel-tabs" role="tablist" ref={tabsRef}>
          {arranged.map((tab) => {
            const active = tab.id === current?.id
            /** 预览位（临时标签）：文字斜体，下一个打开的文件顶掉它（见 `tabs.ts` 头注释第 6 条） */
            const preview = isPreviewTab(tab)
            const label =
              tab.kind === 'file'
                ? tabLabel(tab.path)
                : tab.kind === 'guide'
                  ? t('开始页')
                  : tab.kind === 'files'
                    ? t('工作区文件')
                    : tab.kind === 'terminal'
                      ? tpl('终端 $__index__', { index: tab.index })
                      : tab.kind === 'browser'
                        ? tab.title || urlLabel(tab.url) || t('浏览器')
                        : tab.name || tab.serviceId
            // 服务标签的 tooltip 带上归属会话：两个会话各有一个 dev 时要分得清；
            // 终端标签的 tooltip 给工作目录（几个终端同名时靠它区分）；
            // 网页标签的 tooltip 给完整地址（标题只有主机名，同主机的两页靠它区分）
            const title =
              tab.kind === 'file'
                ? isPreviewTab(tab)
                  ? `${tab.path} · ${t('预览模式')}`
                  : tab.path
                : tab.kind === 'service' && tab.sessionLabel
                  ? `${label} · ${tpl('对话：$__name__', { name: tab.sessionLabel })}`
                  : tab.kind === 'terminal'
                    ? `${label} · ${shellLabel(tab.shell)} · ${tab.cwd}`
                    : tab.kind === 'browser'
                      ? tab.url || t('浏览器')
                      : label
            return (
              /* 一个标签 = 外层 div（拖动 / 右键 / 整行点击都挂它）+ 里面一颗真按钮 `role="tab"`
                 + 平级的关闭按钮。
                 ⚠️ 外层**不能**写成 <button>：关闭按钮也是 <button>，HTML 不允许按钮嵌按钮
                 （解析器会把外层提前闭合），React 会报 “<button> cannot be a descendant of
                 <button>”。`role="tab"` / `aria-selected` 归**内层那颗按钮**（键盘 Tab 到的是它），
                 外层的 onClick 只负责「点标签的空白 / 内边也切过去」（内层点击会冒泡到这里）。 */
              <div
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el)
                  else tabRefs.current.delete(tab.id)
                }}
                className={`side-panel-tab${active ? ' is-active' : ''}${preview ? ' is-preview' : ''}${
                  drag?.id === tab.id ? ' is-dragging' : ''
                }`}
                onMouseDown={(event) => startTabDrag(event, tab)}
                // 双击标签 = 「这个我要留着」：预览位升级成常驻（在关闭按钮上双击不算）
                onDoubleClick={(event) => {
                  if (!preview) return
                  if ((event.target as HTMLElement).closest('.side-panel-tab-close')) return
                  onPinTab?.(tab.id)
                }}
                // 右键在标签上开菜单；空白处不弹（不给「关谁」的歧义）
                onContextMenu={(event) => tabMenu.openAt(event, { id: tab.id })}
                onClick={() => {
                  // 拖完松手的那一下 click（指针还在被拖的标签上）不算点击
                  const suppression = suppressClickRef.current
                  if (
                    suppression &&
                    suppression.id === tab.id &&
                    performance.now() < suppression.until
                  ) {
                    suppressClickRef.current = null
                    return
                  }
                  onActiveChange(tab.id)
                }}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="side-panel-tab-btn"
                  title={title}
                >
                  {tab.kind === 'file' && <FileTypeIcon filename={label} className="side-panel-tab-icon" />}
                  {tab.kind === 'service' && (
                    <span className="side-panel-tab-icon is-service">
                      <ServerSvg />
                    </span>
                  )}
                  {tab.kind === 'guide' && (
                    <span className="side-panel-tab-icon is-page">
                      <CompassSvg />
                    </span>
                  )}
                  {tab.kind === 'files' && (
                    <span className="side-panel-tab-icon is-page">
                      <FolderSvg />
                    </span>
                  )}
                  {tab.kind === 'terminal' && (
                    <span className="side-panel-tab-icon is-page">
                      <TerminalSvg />
                    </span>
                  )}
                  {tab.kind === 'browser' && (
                    <span className="side-panel-tab-icon is-page">
                      <GlobeSvg />
                    </span>
                  )}
                  <span className="side-panel-tab-name">{label}</span>
                  {dirtyIds.includes(tab.id) && (
                    <span className="side-panel-tab-dirty" title={t('未保存')} />
                  )}
                </button>
                <button
                  type="button"
                  className="side-panel-tab-close"
                  title={t('关闭')}
                  aria-label={t('关闭')}
                  onClick={(e) => {
                    // 外层 div 也开着「点标签切过去」：关标签不能顺手把那个标签激活
                    e.stopPropagation()
                    requestCloseTab(tab.id)
                  }}>
                  <CloseSvg />
                </button>
              </div>
            )
          })}
        </div>

        {/* 标签栏右侧的固定按钮（不跟着标签区横向滚动）：新标签 / 全屏 / 收起 */}
        {(onOpenGuide || onCollapse) && (
          <div className="side-panel-tabbar-actions">
            {onOpenGuide && (
              <button
                type="button"
                className="side-panel-tabbar-action"
                title={t('新标签页')}
                aria-label={t('新标签页')}
                onClick={onOpenGuide}>
                <AddSvg />
              </button>
            )}
            {onCollapse && (
              <button
                type="button"
                className="side-panel-tabbar-action is-fullscreen"
                title={fullscreen ? t('退出全屏') : t('全屏')}
                aria-label={fullscreen ? t('退出全屏') : t('全屏')}
                aria-pressed={fullscreen}
                onClick={toggleFullscreen}>
                {fullscreen ? <ExitFullScreenSvg /> : <FullScreenSvg />}
              </button>
            )}
            {onCollapse && (
              <button
                type="button"
                className="side-panel-tabbar-action is-collapse"
                title={t('收起右侧栏')}
                aria-label={t('收起右侧栏')}
                onClick={onCollapse}>
                <HideRightSideBarSvg />
              </button>
            )}
          </div>
        )}
      </div>

      {body}

      {tabMenu.state && (
        <ContextMenu
          position={tabMenu.state.position}
          items={tabMenuItems(tabMenu.state.target)}
          onClose={tabMenu.close}
        />
      )}
    </aside>
  )
}

export default SidePanel
