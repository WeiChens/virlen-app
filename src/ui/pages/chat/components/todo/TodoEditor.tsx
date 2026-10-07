/**
 * TodoEditor — 任务清单编辑器（标题栏浮层内）。
 *
 * 编辑只写**本地草稿**（`ui/store/todoDraftStore`），点「应用变更」才算修改：AI 空闲 → 立即落地
 * （追加 feedback 消息）；AI 回复中 → 标记「已应用」，等本轮 stream_end 或用户取消时落地
 * （见 `services/todo-service.flushTodoDraft`）。
 *
 * **编辑期间 AI 又写了一版清单**：不自动合并、也不静默覆盖，而是提示「AI 已更新」（附 base → 最新
 * 清单的差异）并摆明两个出口：「放弃编辑并同步」跟随 AI，「覆盖更新」用我这份整体覆盖。
 * 判定靠 `sameTodoList(effective, draft.base)`。
 *
 * 数据流单向：读「草稿（优先）/ 生效清单」→ 生成新数组 → 写回 store，不在组件里存副本；
 * 排序靠拖拽手柄（不用 ↑↓ 按钮），超长任务名鼠标移入才横向滚动。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { computeStats, diffTodos, sameTodoList } from '@/domain/todo/state'
import type { TodoItem, TodoStatus } from '@/domain/todo/types'
import { applyTodoDraft } from '@/services/todo-service'
import { changeBrief } from './brief'
import {
  clearTodoDraft,
  ensureTodoDraft,
  getTodoDraft,
  markTodoDraftCommitted,
  updateTodoDraftItems,
} from '@/ui/store/todoDraftStore'

const STATUS_CYCLE: TodoStatus[] = ['pending', 'in_progress', 'completed']
const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
}

/**
 * TodoTitle — 任务名控件（展示态 / 编辑态二选一）：展示态超宽时鼠标移入才用 translateX
 * 来回滚动（溢出多少滚多少，不悬停保持静止），点击切到 `<input>`（回车 / Esc / 失焦回展示态）。
 * 两态共用同一套 padding / 边框 / 高度，切换不跳版。
 */
const TodoTitle = observer(function TodoTitle({
  item,
  onPatch,
}: {
  item: TodoItem
  onPatch: (id: string, p: Partial<TodoItem>) => void
}) {
  const [editing, setEditing] = useState(false)
  const [shift, setShift] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * 量溢出：`scrollWidth - clientWidth` = 需滚距离，末尾多留 12px 便于看清结尾。同时取文本项
   * 自身宽度（`flex: 0 0 auto` 不收缩，即真实文本宽）：不同 WebView 对容器溢出区的上报不一致。
   */
  const measure = () => {
    const el = wrapRef.current
    if (!el) return
    const over =
      Math.max(el.scrollWidth, textRef.current?.offsetWidth || 0) -
      el.clientWidth
    setShift(over > 1 ? -(over + 12) : 0)
  }

  useLayoutEffect(() => {
    if (editing) return
    measure()
  }, [item.content, editing])

  // 浮层宽度会被窗口尺寸 / 缩放影响：容器尺寸变了要重新量
  useEffect(() => {
    if (editing) return
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="todo-input"
        value={item.content}
        onChange={(e) => onPatch(item.id, { content: e.target.value })}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') setEditing(false)
        }}
        placeholder={t('任务内容')}
        spellCheck={false}
      />
    )
  }

  return (
    <div
      ref={wrapRef}
      className={`todo-title ${shift ? 'is-overflowing' : ''} ${item.content ? '' : 'is-empty'
        }`}
      onClick={() => setEditing(true)}>
      <span
        ref={textRef}
        className="todo-title-text"
        style={
          shift
            ? ({
              '--todo-marquee-shift': `${shift}px`,
              // 时长按滚动距离线性放大，长任务名不会「一闪而过」
              '--todo-marquee-dur': `${Math.min(14, Math.max(3, -shift / 16))}s`,
            } as CSSProperties)
            : undefined
        }>
        {item.content || t('任务内容')}
      </span>
    </div>
  )
})

interface Props {
  sessionId: string
  /** 当前生效清单（消息历史派生）—— 首次编辑时作为草稿的 base */
  effective: TodoItem[]
  /** AI 是否正在回复本轮（回复中不允许直接落地） */
  working: boolean
}

export const TodoEditor = observer(function TodoEditor({
  sessionId,
  effective,
  working,
}: Props) {
  const draft = getTodoDraft(sessionId)
  const list = draft ? draft.todos : effective
  /** 用户已点「应用」、等本轮结束生效（仅 AI 回复期间会出现） */
  const committed = !!draft?.committed
  /**
   * 编辑期间清单权威被换过（AI 又写了一版清单）：判定 = 生效清单 ≠ 草稿创建时的 `base`。
   * 此时**不静默处理** —— 既不把 AI 的改动静默灌进用户的编辑，也不默默丢掉 AI 的进度，
   * 只提示 + 把两个出口摆明。已应用但还未落地的草稿同样提示，用户才有机会改成「同步」。
   */
  const aiUpdated = !!draft && !sameTodoList(effective, draft.base)
  /** AI 这段时间改了什么（base → 最新清单），用 UI 文案展示 */
  const aiBrief = aiUpdated ? changeBrief(diffTodos(draft!.base, effective)) : ''
  const stats = computeStats(list)
  const pct = stats.total
    ? Math.round((stats.completed / stats.total) * 100)
    : 0

  /** 写回草稿（首次编辑自动创建，base = 当前生效清单） */
  const commit = (next: TodoItem[]) => {
    ensureTodoDraft(sessionId, effective)
    updateTodoDraftItems(sessionId, next)
  }

  const cycleStatus = (id: string) => {
    const cur = list.find((x) => x.id === id)
    if (!cur) return
    const idx = STATUS_CYCLE.indexOf(cur.status)
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
    commit(list.map((x) => (x.id === id ? { ...x, status: next } : x)))
  }

  const patch = (id: string, p: Partial<TodoItem>) => {
    commit(list.map((x) => (x.id === id ? { ...x, ...p } : x)))
  }

  const remove = (id: string) => commit(list.filter((x) => x.id !== id))

  const add = () =>
    commit([
      ...list,
      {
        id: `u_${Date.now().toString(36)}`,
        content: t('新任务'),
        status: 'pending',
      },
    ])

  /**
   * 拖拽排序（取代 ↑ / ↓ 按钮）：必须用指针事件而非 HTML5 拖放 —— 本项目 `dragDropEnabled: true`
   *（原生拖放取文件真实路径），Windows 上页面收不到 HTML5 drag 事件，只有 pointer 可靠。
   * 每越过一行就立即写草稿，数据流仍是单向的，组件里不存副本。
   */
  const [dragId, setDragId] = useState<string | null>(null)
  const rowsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dragId) return
    const rowEls = () =>
      Array.from(
        rowsRef.current?.querySelectorAll<HTMLElement>('.todo-row') || [],
      )

    const onMove = (e: PointerEvent) => {
      const els = rowEls()
      if (els.length < 2) return
      // 指针落在哪一行的竖直范围内 → 目标位置；越出上下边界则夹到首 / 尾
      let target = -1
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect()
        if (e.clientY >= r.top && e.clientY <= r.bottom) target = i
      })
      if (target < 0) {
        target =
          e.clientY < els[0].getBoundingClientRect().top ? 0 : els.length - 1
      }
      const from = list.findIndex((x) => x.id === dragId)
      if (from < 0 || target === from) return
      const next = [...list]
      const [moved] = next.splice(from, 1)
      next.splice(target, 0, moved)
      commit(next)
    }
    const onUp = () => setDragId(null)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragId, list])

  /**
   * 应用变更 / 覆盖更新 —— 「草稿」变「修改」的唯一入口。AI 空闲立即落地（追加 feedback）；
   * AI 回复中只标记「已应用」，等本轮 stream_end / 取消时落地。两者都是**用户这份逐字生效**，
   * AI 在这期间的改动由用户在此显式选择，不在落地时隐式混合。
   */
  const onApply = () => {
    // 先剔除空正文项（用户可能点了「添加任务」还没写内容）
    const cleaned = list.filter((x) => x.content.trim() !== '')
    if (cleaned.length !== list.length) commit(cleaned)
    // 没草稿 = 用户什么都没改
    if (!getTodoDraft(sessionId)) {
      showToast(t('清单没有变化'))
      return
    }
    if (working) {
      markTodoDraftCommitted(sessionId)
      showToast(
        aiUpdated
          ? t('已覆盖更新 · 本轮结束后生效')
          : t('已应用 · 本轮结束后生效'),
      )
      return
    }
    const applied = applyTodoDraft(sessionId, 'user')
    showToast(
      applied
        ? aiUpdated
          ? t('已覆盖更新 · 会在下一轮对话生效')
          : t('已应用 · 会在下一轮对话生效')
        : t('清单没有变化'),
    )
  }

  const onDiscard = () => {
    const synced = aiUpdated
    clearTodoDraft(sessionId)
    showToast(
      synced ? t('已放弃编辑，已同步 AI 的最新清单') : t('已放弃未应用的修改'),
    )
  }

  const inProgress = list.filter((x) => x.status === 'in_progress').length

  return (
    <div className={`todo-editor ${dragId ? 'is-dragging' : ''}`}>
      <div className="todo-progress">
        <div className="todo-progress-track">
          <div className="todo-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="todo-progress-text">
          {tpl('$__done__/$__total__ 完成 · $__running__ 进行中', {
            done: stats.completed,
            total: stats.total,
            running: stats.inProgress,
          })}
        </span>
      </div>

      {/* 编辑期间 AI 又写了一版：提示 + 摆明两个出口（不静默混合） */}
      {aiUpdated && (
        <div className="todo-ai-updated">
          <div className="todo-ai-updated-head">
            <span className="todo-ai-updated-title">{t('AI 已更新任务清单')}</span>
            <span className="todo-ai-updated-brief">{aiBrief}</span>
          </div>
          <div className="todo-ai-updated-tip">
            {t(
              '你的编辑还留着。「放弃编辑并同步」= 跟随 AI 的最新清单；「覆盖更新」= 用你这份整体覆盖 AI。',
            )}
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="todo-empty">
          {t('暂无任务。可以让 AI 先规划，或点下方「添加任务」。')}
        </div>
      ) : (
        <div className="todo-rows" ref={rowsRef}>
          {list.map((item) => (
            <div
              key={item.id}
              className={`todo-row ${item.status === 'completed' ? 'is-done' : ''} ${dragId === item.id ? 'is-dragging' : ''
                }`}>
              <button
                type="button"
                className="todo-handle"
                onPointerDown={(e) => {
                  // 阻止文本选中 / 原生拖拽，只保留指针拖拽
                  e.preventDefault()
                  setDragId(item.id)
                }}
                title={t('按住拖动可调整顺序')}></button>
              <button
                type="button"
                className={`todo-status ${item.status}`}
                onClick={() => cycleStatus(item.id)}
                title={t('点击切换状态：待办 / 进行中 / 已完成')}>
                {STATUS_ICON[item.status]}
              </button>
              <TodoTitle item={item} onPatch={patch} />
              <input
                className="todo-note"
                value={item.note || ''}
                onChange={(e) => patch(item.id, { note: e.target.value })}
                placeholder={t('备注')}
                spellCheck={false}
                title={item.note}
              />
              <div className="todo-row-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove(item.id)}
                  title={t('移除该项（模型会知道是用户移除的）')}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {inProgress > 1 && (
        <div className="todo-warn">
          {tpl('⚠️ 有 $__count__ 项处于进行中（约定：同一时刻最多 1 项）', {
            count: inProgress,
          })}
        </div>
      )}

      <div className="todo-footer">
        <button type="button" className="todo-btn ghost" onClick={add}>
          {t('添加任务')}
        </button>
        <span className="todo-flex-1" />
        {draft && (
          <span className={`todo-dirty ${committed ? 'committed' : ''}`}>
            {committed ? t('● 已应用 · 等本轮结束') : t('● 未应用')}
          </span>
        )}
        <button
          type="button"
          className="todo-btn"
          onClick={onDiscard}
          disabled={!draft}>
          {aiUpdated ? t('放弃编辑并同步') : t('放弃修改')}
        </button>
        <button
          type="button"
          className="todo-btn primary"
          onClick={onApply}
          disabled={!draft}
          title={working ? t('AI 回复中：会在本轮结束后生效') : ''}>
          {aiUpdated ? t('覆盖更新') : t('应用变更')}
        </button>
      </div>

      {working && (
        <div className="todo-warn">
          {committed
            ? t('AI 正在回复中：你的清单已生效，本轮结束后写入对话')
            : draft
              ? t(
                'AI 正在回复中：改动还只是草稿，点「应用变更 / 覆盖更新」后才会在本轮结束时生效',
              )
              : t('AI 正在回复中：你随时可以改这份清单，改完点「应用变更」才会生效')}
        </div>
      )}
    </div>
  )
})
