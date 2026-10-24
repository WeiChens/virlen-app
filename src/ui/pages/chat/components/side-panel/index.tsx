/**
 * SidePanel — 右侧面板的**容器**：顶部一排标签页，下面是可拖宽的内容区。
 *
 * 为什么要有这一层（而不是继续在 `chat-view` 里直接挂一个文件面板）：
 * 1. **一次能看多个文件**（对着改两处代码、边改 md 边看别的）—— 标签页切换比反复开关快；
 * 2. **宽度 / 拖拽 / 占满归容器**：内容区（`workspace-file` 等）只管自己那块，
 *    不给每个面板各写一套「量可用宽度 + 拖左边缘」。切换标签时宽度当然也不跳；
 * 3. **切标签不卸载**：所有标签的内容**一直挂着**，只做显隐 —— 换成卸载再挂载，
 *    草稿、Monaco 撤销栈、滚动位置全丢（文件面板的草稿只活在组件 state 里）；
 * 4. **两种内容**：文件（`workspace-file`）与后台服务终端（`service/ServiceTerminal`），
 *    加一种 kind 只加 `renderTab()` 的一支；
 * 5. **标签可拖拽换顺序**：顺序归宿主（`tabs` 是它的 state），容器只在拖动中就地预览，
 *    松手时用 `onMoveTab(id, toIndex)` 上报一次 —— 两边同一个下标口径（`tabs.ts::moveTab`）。
 *
 * 未保存草稿的归属：本容器汇总「任一标签脏」上报宿主（切会话 / 切工作目录前要确认）；
 * 关标签的确认也在这里 —— 但**面板自己的关闭按钮已经确认过一次**，那条路径直接
 * `onCloseTab`，不再问第二遍。
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
import WorkspaceFilePanel from '../workspace-file'
import ServiceTerminal from '../service/ServiceTerminal'
import { moveTab, tabLabel, type SidePanelTab } from './tabs'
import { wheelScrollLeft } from './tab-scroll'
import './style.scss'

interface Props {
  /** 标签列表（宿主持有：打开 / 关闭都要跟着改宿主自己的状态） */
  tabs: SidePanelTab[]
  /** 当前激活的标签 id（指向已关闭的标签时退回第一个） */
  activeId: string | null
  sessionId?: string
  onActiveChange: (id: string) => void
  /** 关闭某个标签。**调用前草稿确认已经问过**（面板内或本容器的 `requestCloseTab`） */
  onCloseTab: (id: string) => void
  /** 把标签 `id` 挪到第 `toIndex` 位（拖动松手时上报一次；不传则标签不可拖） */
  onMoveTab?: (id: string, toIndex: number) => void
  /** 一次关掉多个标签（标签右键菜单）；没传时容器退化为逐个 `onCloseTab` */
  onCloseTabs?: (ids: string[]) => void
  /** 任一标签有未保存草稿（宿主据此在切会话 / 切工作目录前确认） */
  onDirtyChange?: (dirty: boolean) => void
  /** 面板占满（聊天区被压到不足 `CHAT_MIN_WIDTH`）时为 true：宿主据此把聊天区藏起来 */
  onExpandedChange?: (expanded: boolean) => void
}

/** 面板宽度：只有下限与兜底默认值，**没有固定上限**（最多给到整块可用宽度，见 `maxDragWidth`） */
const MIN_WIDTH = 360
const DEFAULT_WIDTH = 560
/** 聊天区的最小可用宽度：连它都留不住，就让面板占满、聊天区先不显示 */
const CHAT_MIN_WIDTH = 300
/** 鼠标移动超过这么多像素才算「拖标签」（否则还是一次点击） */
const DRAG_THRESHOLD = 4
/** 拖完松手后多久内到达的 click 算「拖动的尾巴」（浏览器把它紧跟在 mouseup 后面发） */
const CLICK_AFTER_DRAG_MS = 400

/** 面板和聊天区是同一行的兄弟：`.chat-view` 里的那个 `.chat-main` */
function chatMainOf(panel: HTMLElement | null): HTMLElement | null {
  const parent = panel?.parentElement
  if (!parent) return null
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.classList.contains('chat-main')) return child
  }
  return null
}

/** 拖动下限：正常是 MIN_WIDTH；窗口窄到 `MIN_WIDTH + 300` 都放不下时，先让聊天区能露出来 */
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
  onActiveChange,
  onCloseTab,
  onCloseTabs,
  onMoveTab,
  onDirtyChange,
  onExpandedChange,
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
   * **容器挂载时**按可用宽度的一半定宽（= 第一个标签打开时；加标签、切标签都不重算，
   * 用户拖出来的宽度不会被悄悄改回去）。之后窗口 / 左侧栏变化只更新「可用宽度」，
   * 宽度本身不跟着改 —— 窄到聊天区不足 300 时由下面的 `expanded` 接管，把面板撑满。
   */
  useLayoutEffect(() => {
    const next = measureAvailable()
    setAvailable(next)
    setWidth(preferredWidth(next))

    const refresh = () => setAvailable(measureAvailable())
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

  /** 聊天区会被压到不足 300px：面板占满，聊天区交给宿主先藏起来 */
  const expanded = available > 0 && available - width < CHAT_MIN_WIDTH

  /**
   * 上屏宽度：占满态铺满整块可用宽度（`width` 里记的偏好值可能与眼前这块对不上）。
   * **拖动中一律按 `width`**：否则从占满态往回拖，前 300px 面板一动不动，手柄就像坏的。
   */
  const shownWidth = expanded && !resizing ? available : width

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

  // 标签关掉之后把它的脏状态一起清掉（不清的话「任一脏」会一直是 true）
  useEffect(() => {
    const alive = new Set(tabs.map((tab) => tab.id))
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
  }, [tabs])

  const dirty = dirtyIds.length > 0
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const rect = panelRef.current?.getBoundingClientRect()
      if (!rect) return
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
        // 不能把聊天区压到 300 以下 —— 那条线交给 `expanded`（松手后铺满）
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
    if (tab.kind === 'file') {
      return (
        <WorkspaceFilePanel
          path={tab.path}
          sessionId={sessionId}
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
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
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
   */
  const paneIdsRef = useRef<string[]>([])
  const paneIds = useMemo(() => {
    const alive = new Set(tabs.map((tab) => tab.id))
    const kept = paneIdsRef.current.filter((id) => alive.has(id))
    for (const tab of tabs) if (!kept.includes(tab.id)) kept.push(tab.id)
    paneIdsRef.current = kept
    return kept
  }, [tabs])

  /**
   * 内容区与拖动无关：单独 memo 一次，免得拖动中的每一帧都把里面的编辑器全重渲染一遍
   *（`@monaco-editor/react` 每帧都会 `updateOptions` 一次）。依赖只写 `renderTab` 真正读的东西。
   */
  const body = useMemo(
    () => (
      <div className="side-panel-body">
        {paneIds.map((id) => {
          const tab = tabs.find((item) => item.id === id)
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
    [paneIds, tabs, current?.id, sessionId, dirtyHandlerOf, onCloseTab],
  )

  return (
    <aside
      ref={panelRef}
      className={`side-panel${resizing ? ' is-resizing' : ''}${expanded ? ' is-full' : ''}`}
      // 占满态直接铺满「聊天区 + 面板」的整块可用宽度（宿主这时已经把聊天区藏起来了）
      style={{ width: shownWidth }}>
      <div
        className="side-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整面板宽度')}
        onMouseDown={startResize}
      />

      <div className="side-panel-tabs" role="tablist" ref={tabsRef}>
        {arranged.map((tab) => {
          const active = tab.id === current?.id
          const label =
            tab.kind === 'file' ? tabLabel(tab.path) : tab.name || tab.serviceId
          // 服务标签的 tooltip 带上归属会话：两个会话各有一个 dev 时要分得清
          const title =
            tab.kind === 'file'
              ? tab.path
              : tab.sessionLabel
                ? `${label} · ${tpl('会话：$__name__', { name: tab.sessionLabel })}`
                : label
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el)
                else tabRefs.current.delete(tab.id)
              }}
              className={`side-panel-tab${active ? ' is-active' : ''}${
                drag?.id === tab.id ? ' is-dragging' : ''
              }`}
              onMouseDown={(event) => startTabDrag(event, tab)}
              // 右键在标签上开菜单；空白处不弹（不给「关谁」的歧义）
              onContextMenu={(event) => tabMenu.openAt(event, { id: tab.id })}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="side-panel-tab-btn"
                title={title}
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
                {tab.kind === 'file' && <FileTypeIcon filename={label} className="side-panel-tab-icon" />}
                {tab.kind === 'service' && (
                  <span className="side-panel-tab-icon is-service">
                    <ServerSvg />
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
                onClick={() => void requestCloseTab(tab.id)}>
                <CloseSvg />
              </button>
            </div>
          )
        })}
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
