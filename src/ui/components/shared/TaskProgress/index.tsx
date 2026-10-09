/**
 * 批量任务进度弹窗 —— 挂在屏幕中央的那一块「第 3 / 12 份：xxx」
 *
 * 谁在用：**一份一份来、且每份都要花时间**的活儿 ——
 * - 导入文件夹 / 导入压缩包（知识库 `file-import.ts` / `export.ts`）；
 * - 清空文档（逐份删除，删几十份要好几秒，`doc-delete.ts`）。
 *
 * 为什么要有它：这些活儿短则几秒、长则几十秒，从前只有「开始」与「结束」两个 toast，中间是
 * 一段黑箱 —— 用户既不知道进行到哪，也没法中途喊停。这里给三样东西：**最新一条文案**、
 * **进度**、**取消**。
 *
 * 两处刻意的设计：
 * - **取消是「下一条生效」，不是「立刻打断」**：调用方的循环每处理完一份查一次 `cancelled`，
 *   于是永远不会停在半个文件上（停就停在整份的边界）；
 * - **过程文案留在弹窗里，不再逐条发 toast**：批量操作会不断冒出「跳过这份」「那份没成功」，
 *   全弹出来会把屏幕刷满；这里只滚动显示最新一条，结束时汇总成一句。
 *
 * 用法（模块级单例，与 Toast / MessageBox 同一套写法，在 WindowLayout 里挂一次即可）：
 * ```ts
 * const task = beginTask({
 *   title: t('正在删除文档'),
 *   source: tpl('「$__name__」· 共 $__count__ 份', { name: kbName, count: docs.length }),
 *   total: docs.length,
 *   doneText: t('删除完成'),
 *   stoppedText: t('已停止删除'),
 * })
 * for (let i = 0; i < docs.length; i++) {
 *   if (task.cancelled) break            // 上一轮结束时用户按了取消
 *   task.step(i + 1, docs[i].name, summarize(counts))
 *   ...                                  // 处理这一份
 * }
 * task.finish(task.cancelled, summarize(counts))
 * ```
 *
 * ⚠️ 文案口径：`title` / `doneText` / `stoppedText` / `stoppingHint` 全部由调用方给 ——
 * 弹窗只管画，不猜「这是在导入还是在删除」（同一次批量里，导入说「已停止导入」、
 * 删除要说「已停止删除」，一句通用的话两边都别扭）。
 */
import { useEffect, useState } from 'react'
import EventEmitter from '@/utils/EventEmitter'
import Modal from '@/ui/components/shared/Modal'
import { t, tpl } from '@/ui/i18n'
import './style.scss'

/** 弹窗要显示的一份快照（每次变化发一个新对象，组件直接 setState） */
export interface TaskProgressView {
  /** 运行中的标题，如「正在添加文档」「正在删除文档」 */
  title: string
  /** 来源（文件夹名 / 压缩包名 + 知识库名），让用户确认「动的是这个」 */
  source: string
  total: number
  /** 已经处理到第几份（从 1 起） */
  current: number
  /** 最新一条文案：正在处理的那一份 / 刚发生的这件事 */
  latest: string
  /** 实时统计（新增 2 · 覆盖 1 … / 已删 3 份 · 1 份没删掉） */
  summary: string
  /** false = 已结束（按钮从「取消」变成「关闭」） */
  running: boolean
  /** 用户按了取消、但循环还没停在整份的边界上 */
  stopping: boolean
  /** 停下时那句说明（说明「停在哪」）；空字符串 = 不显示 */
  stoppingHint: string
  /** 结束语：doneText / stoppedText */
  result: string
}

/** 一次批量任务的手柄 */
export interface BatchTask {
  /** 报告进度：处理到第 `current` 份 + 最新一条文案 + 实时统计 */
  step(current: number, latest: string, summary: string): void
  /** 用户取消了吗（每份之间查一次 —— 取消就靠这个「下一条生效」） */
  readonly cancelled: boolean
  /** 收尾：`cancelled` 决定结束语；调用方负责刷新列表 */
  finish(cancelled: boolean, summary: string): void
}

/** 开一次批量任务要交代的东西 */
export interface TaskOptions {
  /** 运行中的标题，如「正在添加文档」 */
  title: string
  /** 来源（可省），如「「我的资料」· 从文件夹 D:/docs」 */
  source?: string
  /** 一共几份 */
  total: number
  /** 结束语：正常收尾。默认「已完成」 */
  doneText?: string
  /** 结束语：用户中途取消。默认「已停止」 */
  stoppedText?: string
  /** 停下时那句说明（说清「停在哪」）。不给就不显示 */
  stoppingHint?: string
  /** 进度条的无障碍名，默认「进度」 */
  ariaLabel?: string
}

type TaskProgressEvent = {
  show: (view: TaskProgressView & { ariaLabel: string }) => void
  hide: () => void
}

const emit = new EventEmitter<TaskProgressEvent>()

/** 当前任务的 id：新旧任务的收尾不会互相干扰（上一次的 `finish` 关不掉新一次的弹窗） */
let currentId = 0
/** 正在运行的任务 id（0 = 空闲）—— 取消、右上角 ✕ 的语义都靠它判断 */
let runningId = 0
/** 当前任务的快照（供 `requestTaskCancel` 改一个字段后重发） */
let currentView: (TaskProgressView & { ariaLabel: string }) | null = null
/** 被用户点了取消的任务 id */
const cancelledIds = new Set<number>()

/**
 * 开始一次批量任务：立刻弹出进度弹窗，返回手柄。
 *
 * `source` 写「从哪来 / 对谁下手」，用户一眼能确认这次操作的对象对不对。
 */
export function beginTask(options: TaskOptions): BatchTask {
  const id = ++currentId
  runningId = id
  const doneText = options.doneText ?? t('已完成')
  const stoppedText = options.stoppedText ?? t('已停止')
  const state: TaskProgressView & { ariaLabel: string } = {
    title: options.title,
    source: options.source ?? '',
    total: options.total,
    current: 0,
    latest: '',
    summary: '',
    running: true,
    stopping: false,
    stoppingHint: options.stoppingHint ?? '',
    result: '',
    ariaLabel: options.ariaLabel ?? t('进度'),
  }
  currentView = state
  const push = () => {
    if (id !== currentId) return // 已经有更新的任务了
    emit.emit('show', { ...state })
  }
  push()

  return {
    step(current, latest, summary) {
      state.current = current
      state.latest = latest
      state.summary = summary
      push()
    },
    get cancelled() {
      return cancelledIds.has(id)
    },
    finish(cancelled, summary) {
      // 已经收过尾了（例如调用方在 catch 里再收一次）：不能把最终文案覆盖掉
      if (id !== currentId || !state.running) return
      state.running = false
      state.stopping = false
      state.summary = summary
      state.result = cancelled ? stoppedText : doneText
      if (!cancelled) state.current = state.total
      push()
      cancelledIds.delete(id)
      runningId = 0
      currentView = null
    },
  }
}

/**
 * 用户要求取消（弹窗上的「取消」、右上角 ✕、Esc 都走这里）
 *
 * 不立刻收弹窗：调用方的循环要在**下一条边界**上停，这里先把标记打上，
 * 文案换成「正在停止…」，循环停下后由调用方 `finish` 收尾。
 */
export function requestTaskCancel() {
  if (!runningId || !currentView) return
  cancelledIds.add(runningId)
  currentView.stopping = true
  emit.emit('show', { ...currentView })
}

/** 关上弹窗（只在任务结束后有意义） */
function closeTaskProgress() {
  if (runningId) {
    requestTaskCancel()
    return
  }
  emit.emit('hide')
}

function TaskProgress() {
  const [view, setView] = useState<
    (TaskProgressView & { ariaLabel: string }) | null
  >(null)

  useEffect(() => {
    const offShow = emit.on('show', (v) => setView(v))
    const offHide = emit.on('hide', () => setView(null))
    return () => {
      offShow()
      offHide()
    }
  }, [])

  if (!view) return null

  const percent =
    view.total > 0 ? Math.min(100, Math.round((view.current / view.total) * 100)) : 0

  return (
    <Modal
      visible
      title={view.running ? view.title : view.result}
      onClose={closeTaskProgress}
      width={460}
      footer={
        <div className="task-progress-footer">
          {view.running ? (
            <button
              className="btn-cancel"
              onClick={requestTaskCancel}
              disabled={view.stopping}>
              {view.stopping ? t('正在停止…') : t('取消')}
            </button>
          ) : (
            <button className="btn-confirm" onClick={closeTaskProgress}>
              {t('关闭')}
            </button>
          )}
        </div>
      }>
      <div className="task-progress-body">
        {view.source && (
          <div className="task-progress-source">{view.source}</div>
        )}
        <div className="task-progress-head">
          <span className="task-progress-count">
            {view.current === 0
              ? t('准备中…')
              : tpl('第 $__current__ / $__total__ 份', {
                  current: view.current,
                  total: view.total,
                })}
          </span>
          {view.running && view.summary && (
            <span className="task-progress-summary">{view.summary}</span>
          )}
        </div>
        <div
          className="task-progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={view.total}
          aria-valuenow={view.current}
          aria-label={view.ariaLabel}>
          <span
            className="task-progress-bar-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        {/* 最新一条文案：正在处理哪一份 / 刚发生了什么。结束后换成汇总 */}
        <div className="task-progress-latest">
          {view.running ? view.latest : view.summary || view.latest}
        </div>
        {view.stopping && view.stoppingHint && (
          <div className="task-progress-hint">{view.stoppingHint}</div>
        )}
      </div>
    </Modal>
  )
}

export default TaskProgress
