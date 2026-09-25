/**
 * todo — 任务清单领域模块（类型 + 纯函数）
 *
 * 对外只暴露无副作用的能力；有副作用的落地（写消息 / 落库）在
 * `src/services/todo-service.ts`，按会话缓存的草稿在 `src/ui/store/todoDraftStore.ts`。
 */
export type {
  TodoChange,
  TodoItem,
  TodoSource,
  TodoStats,
  TodoStatus,
  TodoUiData,
} from './types'
export { MAX_TODOS } from './types'
export {
  checkTodoLimit,
  computeStats,
  diffTodos,
  isTodoUiData,
  pickCurrentTodos,
  renderChangeBrief,
  renderTodoContent,
  renderUserTodoContent,
  sameTodoList,
  sanitizeTodos,
  shouldShowTodoEntry,
  validateTodos,
} from './state'
export type { CurrentTodos } from './state'
