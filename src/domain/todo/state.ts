/**
 * todo/state — 任务清单纯函数（无状态、无 IO、可单测）
 *
 * 同时服务两条路径：
 * - TS 引擎：直接执行 `todo_write`（即 `infrastructure/tools/plan/todo-write.ts`）
 * - Rust 引擎：**已原生化（Step 2）** → `native_tools/plan/{todo_write,common}.rs`
 *
 * ⚠️ 自 Step 2 起两侧是**两份实现**，存在铁律 1 的同步义务：工具执行真正用到的那几个
 * 函数（`sanitizeTodos` / `computeStats` / `validateTodos` / `checkTodoLimit` /
 * `renderTodoContent`）在 Rust 侧有逐字镜像，改一边必须改另一边；
 * `diffTodos` / `pickCurrentTodos` / `shouldShowTodoEntry` 等只服务
 * 「用户编辑清单」的 UI 与注入逻辑（数据源是消息历史），没有 Rust 镜像。
 *
 * UI 侧（标题栏按钮 / 徽章 / 浮层 / 消息流一行胶囊）也只从这里取数据，
 * 「唯一的那份清单」就靠 pickCurrentTodos 派生，不引入任何额外状态字段。
 */
import type { Message } from '@/types'
import type {
  TodoChange,
  TodoItem,
  TodoStats,
  TodoStatus,
  TodoUiData,
} from './types'
import { MAX_TODOS } from './types'

const VALID_STATUS: TodoStatus[] = ['pending', 'in_progress', 'completed']

/** 单条正文 / 备注的长度上限（防止模型塞进一整篇文档） */
const MAX_CONTENT_LEN = 300
const MAX_NOTE_LEN = 120

function isStatus(v: unknown): v is TodoStatus {
  return typeof v === 'string' && (VALID_STATUS as string[]).includes(v)
}

function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return s.length > max ? s.slice(0, max) : s
}

/**
 * 把模型给的原始数组归一化成 TodoItem[]。
 *
 * - 非数组 → 空（调用方负责决定这是「清空」还是「非法」）
 * - 丢弃 content 为空的项
 * - status 非法 → pending
 * - id 缺失/重复 → 自动补 `t{n}`（保证合并时按 id 匹配的唯一性）
 */
export function sanitizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const content = clip(r.content, MAX_CONTENT_LEN)
    if (!content) continue
    let id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!id || seen.has(id)) id = `t${out.length + 1}`
    // 极端情况下 `t{n}` 也可能撞车：再兜一层
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    const todo: TodoItem = {
      id,
      content,
      status: isStatus(r.status) ? r.status : 'pending',
    }
    const activeForm = clip(r.activeForm, MAX_CONTENT_LEN)
    if (activeForm) todo.activeForm = activeForm
    const note = clip(r.note, MAX_NOTE_LEN)
    if (note) todo.note = note
    out.push(todo)
  }
  return out
}

export function computeStats(todos: TodoItem[]): TodoStats {
  const stats: TodoStats = {
    total: todos.length,
    completed: 0,
    inProgress: 0,
    pending: 0,
  }
  for (const t of todos) {
    if (t.status === 'completed') stats.completed++
    else if (t.status === 'in_progress') stats.inProgress++
    else stats.pending++
  }
  return stats
}

/**
 * 软规则校验 —— 只报警、不改数据。
 *
 * 「最多一个 in_progress」是给模型的约定，而不是要静默篡改模型写入的内容：
 * 数据一旦被悄悄改动，模型下一轮看到的清单就和它以为的不一样了。
 */
export function validateTodos(todos: TodoItem[]): string[] {
  const warnings: string[] = []
  const inProgress = todos.filter((t) => t.status === 'in_progress')
  if (inProgress.length > 1) {
    warnings.push(
      `${inProgress.length} items are in_progress (convention: at most 1 at a time)`,
    )
  }
  return warnings
}

/** 超限检查（返回错误文本；null = 通过） */
export function checkTodoLimit(rawCount: number): string | null {
  if (rawCount > MAX_TODOS) {
    return `Too many tasks (${rawCount}, max ${MAX_TODOS}). Please merge them into coarser-grained tasks and retry.`
  }
  return null
}

// ==================== 渲染（给模型 / 给人） ====================

/** 给模型的紧凑清单正文 —— 模型读的是这条 content，不是 uiData */
export function renderTodoContent(
  todos: TodoItem[],
  warnings: string[] = [],
): string {
  const s = computeStats(todos)
  if (todos.length === 0) {
    return '[Todo list updated] The task list was cleared (there are no pending tasks).'
  }
  const lines = todos.map(
    (t, i) =>
      `${i + 1}. [${t.status}] ${t.content}` + (t.note ? ` — ${t.note}` : ''),
  )
  const parts = [
    `[Todo list updated] ${s.total} items — ${s.completed} completed, ${s.inProgress} in progress, ${s.pending} pending`,
    '',
    ...lines,
  ]
  if (warnings.length > 0) {
    parts.push('', `⚠️ ${warnings.join('; ')}`)
  }
  parts.push(
    '',
    'Rules: at most one item may be in_progress; mark completed as soon as it is done.',
  )
  return parts.join('\n')
}

/**
 * 变更摘要（**英文**，仅用于「用户改了清单」的 feedback 消息正文，即模型侧）。
 * 界面文案另有一份走 i18n 的实现：`ui/pages/chat/components/todo/brief.ts`（铁律 1/7）。
 */
export function renderChangeBrief(changes: TodoChange[]): string {
  if (!changes || changes.length === 0) return 'updated'
  const parts = changes.map((c) => {
    switch (c.type) {
      case 'add':
        return `added "${c.content}"`
      case 'remove':
        return `removed "${c.content}"`
      case 'status':
        return `"${c.content}" → ${c.to}`
      case 'edit':
        return `rewritten to "${c.to}"`
      case 'reorder':
        return 'reordered'
      default:
        return 'updated'
    }
  })
  return parts.join(' · ')
}

/**
 * 用户修改后注入给模型的文本（role='feedback' 消息的正文）。
 *
 * 三个要点：
 * 1. 全量清单 —— 模型按它继续干活；
 * 2. 明确「这是用户改的」—— 否则模型会以为是自己写的；
 * 3. 显式禁止复原被移除的项 —— 否则模型很容易「好心」加回来。
 */
export function renderUserTodoContent(
  todos: TodoItem[],
  changes: TodoChange[],
): string {
  const lines = todos.map(
    (t, i) =>
      `${i + 1}. [${t.status}] ${t.content}` + (t.note ? ` — ${t.note}` : ''),
  )
  const parts = ['[User updated the task list]', ...lines]
  if (changes.length > 0) {
    parts.push(`(User: ${renderChangeBrief(changes)})`)
  }
  parts.push(
    'Follow this list strictly and do not re-add tasks the user removed.',
  )
  return parts.join('\n')
}

// ==================== 比对 / 派生 ====================

/**
 * 两份清单是否「实质相同」（按 id 逐项比用户可改字段 + 顺序）。
 *
 * 用途：判断用户编辑期间清单权威有没有被换过 —— `draft.base`（用户开始编辑那一刻的
 * 清单）与当前生效清单不一致 = AI 又写了一版，编辑器据此提示「AI 已更新」，
 * 并把两个出口摆明：放弃编辑并同步 / 覆盖更新。
 */
export function sameTodoList(a: TodoItem[], b: TodoItem[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.content !== y.content ||
      x.status !== y.status ||
      (x.note || '') !== (y.note || '') ||
      (x.activeForm || '') !== (y.activeForm || '')
    ) {
      return false
    }
  }
  return true
}

/** 净变更：base → next（用于生成给模型的说明与 UI 胶囊文案） */
export function diffTodos(base: TodoItem[], next: TodoItem[]): TodoChange[] {
  const baseMap = new Map(base.map((t) => [t.id, t]))
  const nextMap = new Map(next.map((t) => [t.id, t]))
  const changes: TodoChange[] = []

  for (const n of next) {
    const b = baseMap.get(n.id)
    if (!b) {
      changes.push({ type: 'add', content: n.content })
      continue
    }
    if (b.status !== n.status) {
      changes.push({
        type: 'status',
        content: n.content,
        to: n.status,
        toStatus: n.status,
      })
    }
    if (b.content !== n.content) {
      changes.push({ type: 'edit', to: n.content })
    }
  }

  for (const b of base) {
    if (!nextMap.has(b.id)) changes.push({ type: 'remove', content: b.content })
  }

  // 顺序变化：只看双方共有项的相对次序
  const baseOrder = base.filter((t) => nextMap.has(t.id)).map((t) => t.id)
  const nextOrder = next.filter((t) => baseMap.has(t.id)).map((t) => t.id)
  if (baseOrder.join(',') !== nextOrder.join(',')) {
    changes.push({ type: 'reorder' })
  }

  return changes
}

/** 判断一条消息是否携带清单快照 */
export function isTodoUiData(v: unknown): v is TodoUiData {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return d.type === 'todo' && Array.isArray(d.todos)
}

export interface CurrentTodos {
  message: Message
  index: number
  data: TodoUiData
}

/**
 * 「唯一的那份清单」—— 从消息列表尾部倒序找第一条带清单快照的消息。
 *
 * ⚠️ 刻意**不区分 role**：模型写的（tool 消息）和用户改的（feedback 消息）
 * 是同一种权威载体，谁最新谁生效。这是「用户层面任务只有一份」的实现方式 ——
 * 消息里可以有 N 份快照，界面永远只呈现最后一份。
 */
export function pickCurrentTodos(messages: Message[]): CurrentTodos | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const data = messages[i]?.uiData
    if (isTodoUiData(data)) {
      return { message: messages[i], index: i, data }
    }
  }
  return null
}

/**
 * 清单快照之后是否又出现了用户消息（= 用户已经开了新的一轮对话）。
 *
 * 只认 `role === 'user'`：用户对清单的编辑落的是 `feedback` 消息 ——
 * 那是「在改这份清单」，不是「开始新一轮」。
 */
export function hasUserMessageAfterTodos(messages: Message[]): boolean {
  if (!Array.isArray(messages)) return false
  const cur = pickCurrentTodos(messages)
  if (!cur) return false
  for (let i = cur.index + 1; i < messages.length; i++) {
    if (messages[i]?.role === 'user') return true
  }
  return false
}

/**
 * 标题栏「任务清单」入口是否该出现。
 *
 * 两种情况不显示（纯界面降噪，不动数据 —— 清单本身仍完整地躺在消息里）：
 * 1. 从来没有清单，或清单被清空（0 项）—— 没东西可看；
 * 2. 全部完成 + 用户已经开了新一轮 —— 这份清单已经交付，属于历史。
 *
 * 其余一律显示：还有未完成项，或全都完成但这轮就是它（用户还没说话）。
 */
export function shouldShowTodoEntry(messages: Message[]): boolean {
  const cur = pickCurrentTodos(messages)
  if (!cur) return false
  const stats = computeStats(cur.data.todos)
  if (stats.total === 0) return false
  if (stats.completed === stats.total && hasUserMessageAfterTodos(messages)) {
    return false
  }
  return true
}
