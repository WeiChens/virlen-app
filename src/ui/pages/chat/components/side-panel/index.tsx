/**
 * SidePanel — 右侧面板的**容器**：顶部一排标签页，下面是可拖宽的内容区。
 *
 * 为什么要有这一层（而不是继续在 `chat-view` 里直接挂一个文件面板）：
 * 1. **一次能看多个文件**（对着改两处代码、边改 md 边看别的）—— 标签页切换比反复开关快；
 * 2. **宽度 / 拖拽 / 占满归容器**：内容区（`workspace-file` 等）只管自己那块，
 *    不给每个面板各写一套「量可用宽度 + 拖左边缘」。切换标签时宽度当然也不跳；
 * 3. **切标签不卸载**：所有标签的内容**一直挂着**，只做显隐 —— 换成卸载再挂载，
 *    草稿、Monaco 撤销栈、滚动位置全丢（文件面板的草稿只活在组件 state 里）；
 * 4. **后面还要接别的东西**（网址访问 / 终端）：加一种 kind 只加 `renderTab()` 的一支。
 *
 * 未保存草稿的归属：本容器汇总「任一标签脏」上报宿主（切会话 / 切工作目录前要确认）；
 * 关标签的确认也在这里 —— 但**面板自己的关闭按钮已经确认过一次**，那条路径直接
 * `onCloseTab`，不再问第二遍。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import WorkspaceFilePanel from '../workspace-file'
import { tabLabel, type SidePanelTab } from './tabs'
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
  /** 任一标签有未保存草稿（宿主据此在切会话 / 切工作目录前确认） */
  onDirtyChange?: (dirty: boolean) => void
  /** 面板占满（聊天区被压到不足 `CHAT_MIN_WIDTH`）时为 true：宿主据此把聊天区藏起来 */
  onExpandedChange?: (expanded: boolean) => void
}

/** 面板宽度的范围；DEFAULT_WIDTH 只在量不到可用宽度（jsdom / 宿主布局不同）时兜底 */
const MIN_WIDTH = 360
const MAX_WIDTH = 960
const DEFAULT_WIDTH = 560
/** 聊天区的最小可用宽度：连它都留不住，就让面板占满、聊天区先不显示 */
const CHAT_MIN_WIDTH = 300

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

/** 打开时占「可用宽度的一半」，再夹进允许范围 */
function preferredWidth(available: number): number {
  if (available <= 0) return DEFAULT_WIDTH
  const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.72))
  return Math.min(max, Math.max(minDragWidth(available), Math.round(available / 2)))
}

/**
 * 拖动上限：常规上限之上，还要够得着「聊天区只剩 300」这条线 —— 再往里就是面板占满，
 * 否则窄窗口里永远触发不到那个状态。
 */
function maxDragWidth(available: number): number {
  const cap = Math.round(window.innerWidth * 0.72)
  if (available <= 0) return Math.min(MAX_WIDTH, cap)
  return Math.min(MAX_WIDTH, Math.max(cap, available - CHAT_MIN_WIDTH))
}

function SidePanel({
  tabs,
  activeId,
  sessionId,
  onActiveChange,
  onCloseTab,
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

  // 标签关掉之后把它的脏状态一起清掉（不清的话「任一脏」会一直是 true）
  useEffect(() => {
    const alive = new Set(tabs.map((tab) => tab.id))
    for (const key of Array.from(dirtyHandlersRef.current.keys())) {
      if (!alive.has(key)) dirtyHandlersRef.current.delete(key)
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
      setResizing(true)
      // 指针拖出面板时也要保持 col-resize（与左侧栏拖拽同一手法）
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (moveEvent: MouseEvent) => {
        // 不能把聊天区压到 300 以下 —— 那条线交给 `expanded`，到这里就直接让面板占满
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
   * 关标签（标签栏那颗 ×）：有草稿先问一句。面板自己头部的关闭按钮走的是另一条路
   * （它内部已经确认过了，直接 `onCloseTab`），所以这里不会问第二遍。
   */
  const requestCloseTab = useCallback(
    async (id: string) => {
      if (!dirtyIds.includes(id)) {
        onCloseTab(id)
        return
      }
      const confirmed = await MessageBox.propt(
        t('放弃未保存的修改？'),
        t('关闭后这些修改会丢失。'),
        { confirmText: t('放弃并关闭'), cancelText: t('取消'), danger: true },
      )
      if (confirmed) onCloseTab(id)
    },
    [dirtyIds, onCloseTab],
  )

  /** 真正渲染某个标签的内容：加新的预览类型（网址 / 终端）就在这里加一支 */
  const renderTab = (tab: SidePanelTab) => {
    if (tab.kind === 'file') {
      return (
        <WorkspaceFilePanel
          path={tab.path}
          sessionId={sessionId}
          // 标题已经在上面的标签栏里了：面板头只留目录 + 操作按钮
          hideTitle
          onDirtyChange={dirtyHandlerOf(tab.id)}
          onClose={() => onCloseTab(tab.id)}
        />
      )
    }
    return null
  }

  // activeId 指向已关闭的标签（宿主还没来得及换）时退回第一个，别渲染出一片空白
  const current = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null

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

  return (
    <aside
      ref={panelRef}
      className={`side-panel${resizing ? ' is-resizing' : ''}${expanded ? ' is-full' : ''}`}
      // 占满态直接铺满「聊天区 + 面板」的整块可用宽度（宿主这时已经把聊天区藏起来了）
      style={{ width: expanded ? available : width }}>
      <div
        className="side-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整面板宽度')}
        onMouseDown={startResize}
      />

      <div className="side-panel-tabs" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === current?.id
          const label = tab.kind === 'file' ? tabLabel(tab.path) : tab.id
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el)
                else tabRefs.current.delete(tab.id)
              }}
              className={`side-panel-tab${active ? ' is-active' : ''}`}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="side-panel-tab-btn"
                title={tab.kind === 'file' ? tab.path : label}
                onClick={() => onActiveChange(tab.id)}>
                {tab.kind === 'file' && <FileTypeIcon filename={label} className="side-panel-tab-icon" />}
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

      <div className="side-panel-body">
        {tabs.map((tab) => (
          // 所有标签的内容**都挂着**，只切显隐：卸载会把草稿 / 撤销栈 / 滚动位置一起抹掉
          <div
            key={tab.id}
            className="side-panel-pane"
            role="tabpanel"
            hidden={tab.id !== current?.id}>
            {renderTab(tab)}
          </div>
        ))}
      </div>
    </aside>
  )
}

export default SidePanel
