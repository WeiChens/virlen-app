/**
 * todo/types — 任务清单（todo）领域类型
 *
 * 「任务清单」既是模型可见的工具（todo_write），也是用户可编辑的界面对象。
 * 单一权威源 = 会话消息里最后一条带 `uiData.type === 'todo'` 的消息，
 * 因此模型写入与用户修改共用同一份结构（差别只有 `source`）。
 */

/** 任务状态（三态 —— 与工具 schema、模型约定严格一致，不引入 cancelled） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** 稳定 id：模型复用同一 id 表示「同一项」，合并时按它匹配 */
  id: string
  content: string
  status: TodoStatus
  /** 进行中时的进行体描述（可选，展示用） */
  activeForm?: string
  /** 一行备注（结果 / 阻塞原因） */
  note?: string
}

export interface TodoStats {
  total: number
  completed: number
  inProgress: number
  pending: number
}

/** 清单快照的来源：模型写入 / 用户修改 */
export type TodoSource = 'model' | 'user'

/** 相对上一版清单的净变更（给模型解释「用户改了什么」+ UI 胶囊文案） */
export interface TodoChange {
  type: 'add' | 'remove' | 'status' | 'edit' | 'reorder'
  /** 涉及的任务正文（add / remove / status 时给出） */
  content?: string
  /** status 变更后的状态值（英文枚举）/ edit 变更后的新正文（模型侧文案） */
  to?: string
  /** status 变更后的枚举值（UI 侧用它走 i18n 取标签） */
  toStatus?: TodoStatus
}

/** 挂在消息 `uiData` 上的清单快照 —— 唯一的权威载体（随消息一起落库） */
export interface TodoUiData {
  type: 'todo'
  todos: TodoItem[]
  stats: TodoStats
  source: TodoSource
  changes?: TodoChange[]
}

/** 清单上限：超过直接报错（不截断），避免模型基于残缺清单做决策、也避免上下文爆炸 */
export const MAX_TODOS = 50
