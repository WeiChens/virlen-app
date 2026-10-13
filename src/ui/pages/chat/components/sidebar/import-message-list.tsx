/**
 * import-message-list — 「导入会话到知识库」弹窗里的消息选择列表（虚拟滚动 + 行右键菜单）。
 *
 * 为什么虚拟化：长会话一次几千条消息，全量渲染要跑几千次 `extractPlainText` 再挂上万个节点，
 * 弹窗打开的瞬间就会卡住。这里只渲染视口附近的若干条（滚动容器固定 240px，见 style.scss），
 * 行数与消息总数无关。
 *
 * 行高不写死：`--font-size-*` 会随「设置 → 字体大小」缩放（small / large 档整套变），
 * 写死行高会在非 medium 档把行挤重叠，因此交给 measureElement 实测 —— 与 message-list 同一套做法。
 *
 * 右键菜单：逐条勾选在长会话里太慢，「前面全选 / 后面全选」按范围补选（**追加**语义，不取消已选的那
 * 些，见 sidebar/index.tsx::handleAppendMessages），「查看详情」用嵌套弹窗摊开全文。
 */
import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Message } from '@/types'
import { t } from '@/ui/i18n'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { extractPlainText } from './session-text'
import { ROLE_ICON, DEFAULT_ROLE_ICON } from './message-role'
import MessageDetailModal from './message-detail-modal'

/** 未测量前的估算行高（medium 档实测值）：只决定首帧占位高度，测过就被真实值取代 */
const ESTIMATED_ROW_HEIGHT = 29
/** 视口外上下各多渲染几条，给滚动留反应空间 */
const OVERSCAN = 8
/** 预览截断长度（完整正文在「查看详情」里看） */
const PREVIEW_CHARS = 60

interface Props {
  messages: Message[]
  selectedIds: Set<string>
  /** 勾选 / 取消勾选一条消息（点击整行与点击勾选框走同一条路） */
  onToggle: (msgId: string) => void
  /** 范围补选（右键菜单「前面全选 / 后面全选」）：这些 id 并入当前选中集合 */
  onSelectMessages: (ids: string[]) => void
}

export default function ImportMessageList({
  messages,
  selectedIds,
  onToggle,
  onSelectMessages,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<{ msg: Message; index: number } | null>(null)
  /** 右键目标带上 index：菜单项现算，「前面 / 后面」的范围才是点开那一刻的 */
  const menu = useContextMenu<{ msg: Message; index: number }>()

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    // 用消息 id 做 key：勾选导致的列表更新能让同一行沿用测量缓存，不重算行高
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: OVERSCAN,
    /* ⚠️ 必须关掉库默认的 flushSync（同 message-list）：measureElement 的测量发生在提交阶段，
       库若在测量中同步改 scrollTop 就会在渲染中 flushSync(rerender)，React 会告警。 */
    useFlushSync: false,
  })

  const buildMenuItems = (target: { msg: Message; index: number }): ContextMenuItem[] => [
    {
      key: 'select-before',
      label: t('前面全选'),
      onClick: () =>
        onSelectMessages(messages.slice(0, target.index + 1).map((m) => m.id)),
    },
    {
      key: 'select-after',
      label: t('后面全选'),
      onClick: () => onSelectMessages(messages.slice(target.index).map((m) => m.id)),
    },
    {
      key: 'detail',
      label: t('查看详情'),
      divider: true,
      onClick: () => setDetail(target),
    },
  ]

  return (
    <>
      <div className="import-kb-msg-list" ref={scrollRef}>
        {/* 撑总高 + 作为绝对定位行的定位容器（行 top 由虚拟库给） */}
        <div
          className="import-kb-msg-inner"
          style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const msg = messages[item.index]
            if (!msg) return null
            const checked = selectedIds.has(msg.id)
            const preview = extractPlainText(msg.content).slice(0, PREVIEW_CHARS)
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={`import-kb-msg-item ${checked ? 'checked' : ''}`}
                style={{ top: item.start }}
                onClick={() => onToggle(msg.id)}
                onContextMenu={(e) =>
                  menu.openAt(e, { msg, index: item.index })
                }>
                <input
                  type="checkbox"
                  className="import-kb-msg-checkbox"
                  checked={checked}
                  onChange={() => onToggle(msg.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className={`import-kb-msg-role role-${msg.role}`}>
                  {ROLE_ICON[msg.role] ?? DEFAULT_ROLE_ICON}
                </span>
                <span className="import-kb-msg-preview">
                  {preview || `[${msg.role}]`}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={buildMenuItems(menu.state.target)}
          onClose={menu.close}
        />
      )}

      {detail && (
        <MessageDetailModal
          message={detail.msg}
          seq={detail.index + 1}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  )
}
