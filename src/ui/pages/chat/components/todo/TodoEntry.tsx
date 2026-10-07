/**
 * TodoEntry — 标题栏的任务清单入口（按钮 + 未完成徽章 + 浮层）。
 *
 * 「用户层面任务只有一份」的落点：数据 = 消息里最后一份清单快照（`pickCurrentTodos`），
 * 徽章数字 = 未完成数；编辑在浮层里（TodoEditor），消息流只留一行摘要。
 *
 * - 入口只在「有活可看」时出现（`shouldShowTodoEntry`：没清单 / 已清空 / 全完成且已开新一轮都不显示），
 *   但只要还有本地草稿（正在改、或已应用等本轮生效）就必须留着，否则用户没法应用 / 放弃改动；
 * - 关掉浮层 = 丢弃「还没应用」的编辑（`dropUnappliedTodoDraft`）；已应用等本轮生效的草稿不会丢；
 *   编辑期间 AI 又写过清单时，丢弃的文案是「已放弃编辑，已同步 AI 的最新清单」；
 * - 未点「应用变更」时，徽章 / 来源徽章仍按消息历史那一份显示（草稿只在浮层内可见），
 *   按钮用虚线描边提示「有未应用的编辑」；点过「应用」后草稿才接管显示。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import TodoListSvg from '@/ui/components/icons/TodoListSvg'
import {
  computeStats,
  pickCurrentTodos,
  sameTodoList,
  shouldShowTodoEntry,
} from '@/domain/todo/state'
import { getSessionRuntime, sessionStore } from '@/ui/store'
import { dropUnappliedTodoDraft, getTodoDraft } from '@/ui/store/todoDraftStore'
import { showToast } from '@/ui/components/shared/Toast'
import { TodoEditor } from './TodoEditor'
import './style.scss'

interface Props {
  sessionId: string
}

export const TodoEntry = observer(function TodoEntry({ sessionId }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const session = sessionStore.getSession(sessionId)
  const current = pickCurrentTodos(session?.messages || [])
  const effective = current ? current.data.todos : []
  const draft = getTodoDraft(sessionId)
  /** 只有「已应用」的草稿才接管显示；用户还在编辑时，徽章 / 来源徽章仍按消息历史那一份算 */
  const committed = !!draft?.committed
  const list = committed ? draft!.todos : effective
  const stats = computeStats(list)
  const unfinished = stats.total - stats.completed
  const working = !!getSessionRuntime(sessionId).working

  /**
   * 关闭浮层 —— 顺带**丢弃未应用的编辑**。所有关闭路径都走这里（✕ / 点浮层外 / 再点图标），
   * 避免「关掉又打开，上次没保存的草稿还活着」。已应用（等本轮生效）的草稿不会被丢。
   */
  const closePopover = () => {
    // 编辑期间 AI 又写过清单时，「丢弃」的语义就是「跟随 AI 最新」——文案说清楚
    const synced = !!draft && !sameTodoList(effective, draft.base)
    if (dropUnappliedTodoDraft(sessionId)) {
      showToast(
        synced
          ? t('已放弃编辑，已同步 AI 的最新清单')
          : t('已放弃未保存的编辑'),
      )
    }
    setOpen(false)
  }

  /**
   * 关窗处理器的最新引用：mousedown 监听只在 open 变化时重挂一次，若闭包直接捕获
   * closePopover，拿到的会是「浮层刚打开那一刻」的 draft（往往为空），判断就会失灵。
   */
  const closeRef = useRef(closePopover)
  closeRef.current = closePopover

  // 点击浮层外部关闭（与项目其它下拉一致：mousedown 判断包含关系）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 焦点在浮层内输入框（任务名 / 备注）时 Esc 只 blur 不关窗，避免打字时误按丢编辑；
  // 其余情况才关。所有关闭路径共用 closePopover（会丢弃未应用的编辑）。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const active = document.activeElement as HTMLElement | null
      if (
        active &&
        wrapRef.current?.contains(active) &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      ) {
        active.blur()
        return
      }
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  /** 没活可看时入口整个不渲染；有草稿例外（正在改 / 已应用待生效的东西不能藏起来） */
  const show = shouldShowTodoEntry(session?.messages || [])

  // 入口隐藏期间把 open 复位（否则下次会自己弹开）；⚠️ 有草稿时不复位 —— 入口靠草稿例外继续
  // 显示，此时把浮层关掉会连用户的编辑一起丢。
  useEffect(() => {
    if (!show && !draft) setOpen(false)
  }, [show, draft])

  if (!show && !draft) return null

  const title =
    (stats.total
      ? tpl('任务清单 · $__done__/$__total__ 完成', {
          done: stats.completed,
          total: stats.total,
        })
      : t('任务清单（暂无）')) +
    (committed
      ? `（${t('已应用 · 本轮结束后生效')}）`
      : draft
        ? `（${t('有未应用的修改')}）`
        : '')

  return (
    <div className="todo-entry" ref={wrapRef}>
      <button
        type="button"
        className={`toolbar-icon-btn todo-entry-btn ${open ? 'active' : ''} ${
          committed ? 'drafting' : draft ? 'has-draft' : ''
        }`}
        onClick={() => (open ? closePopover() : setOpen(true))}
        title={title}>
        <TodoListSvg />
        {unfinished > 0 && (
          <span className={`todo-badge ${committed ? 'draft' : ''}`}>
            {unfinished > 99 ? '99+' : unfinished}
          </span>
        )}
      </button>

      {open && (
        <div className="todo-popover">
          <div className="todo-popover-head">
            <span className="todo-popover-title">{t('任务清单')}</span>
            {/* 来源徽章只在非默认状态出现：模型写入是默认情况，画个徽章只占宽、没信息量 */}
            {(committed || current?.data.source === 'user') && (
              <span className={`todo-source ${committed ? 'draft' : 'user'}`}>
                {committed ? t('已应用 · 待本轮生效') : t('你修改过')}
              </span>
            )}
            <span className="todo-flex-1" />
            <button
              type="button"
              className="todo-close"
              onClick={closePopover}
              title={t('关闭')}>
              ✕
            </button>
          </div>
          <TodoEditor
            sessionId={sessionId}
            effective={effective}
            working={working}
          />
        </div>
      )}
    </div>
  )
})

export default TodoEntry
