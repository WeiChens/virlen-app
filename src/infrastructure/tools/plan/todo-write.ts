/**
 * todo_write — 任务清单（待办）写入工具
 *
 * 语义：**全量替换**。模型每次都必须传完整清单；空数组 = 清空清单。
 * （不做 merge/增量：增量需要保存「上一版」状态，而状态只在消息历史里，
 *   工具执行器读不到，反而会引入一份影子状态。全量替换语义清晰、无副作用。）
 *
 * 状态存放：本工具**不保存任何状态** —— 清单随 tool_result 消息的
 * `content`（给模型）+ `uiData`（给 UI）一起落库，UI 侧由
 * `pickCurrentTodos()` 从消息里派生「唯一的那份清单」。
 *
 * 未原生化：Rust 引擎经 `agent:tool-request` 桥回到这里执行（同一份语义），
 * 因此 TS / Rust 两侧行为一致；若日后要原生化，必须两边同步实现。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { track, hashText } from '@/utils/telemetry'
import {
  checkTodoLimit,
  computeStats,
  renderTodoContent,
  sanitizeTodos,
  validateTodos,
} from '@/domain/todo/state'
import type { TodoUiData } from '@/domain/todo/types'
import { MAX_TODOS } from '@/domain/todo/types'

toolRegistry.register(
  {
    name: 'todo_write',
    label: t('任务清单'),
    description:
      'Create and update the task list (todos) for the current session. ' +
      'Always pass the COMPLETE list — this call REPLACES the previous list; ' +
      `an empty array clears it. Up to ${MAX_TODOS} items. ` +
      'Use it to plan multi-step work and keep progress visible: mark an item ' +
      '"in_progress" before starting it and "completed" IMMEDIATELY after finishing it. ' +
      'Keep at most ONE item "in_progress" at a time; the remaining items stay "pending". ' +
      'Reuse the same "id" when updating an item so the user (and the UI) can track it. ' +
      'Do not use it for a single trivial step.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'The complete task list, in execution order. Pass the full list on every call.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'Stable id for the item (e.g. "1"). Reuse it when updating so progress stays trackable.',
              },
              content: {
                type: 'string',
                description:
                  'Imperative form, e.g. "Add unit tests for todo_write".',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description:
                  'Task status. Exactly one item should be "in_progress" at a time.',
                default: 'pending',
              },
              activeForm: {
                type: 'string',
                description:
                  'Present-continuous form shown while the item is in_progress, e.g. "Adding unit tests".',
              },
              note: {
                type: 'string',
                description: 'Optional one-line result or blocker note.',
              },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    },
  },
  (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const raw = args?.todos
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
      throw new Error(t('错误："todos" 必须是数组'))
    }
    const list = Array.isArray(raw) ? raw : []

    // 数量超限直接报错（不静默截断：残缺清单会让模型做出错误决策）
    const limitError = checkTodoLimit(list.length)
    if (limitError) throw new Error(limitError)

    const todos = sanitizeTodos(list)
    // 传了内容但全部无效（缺 content）→ 报错，避免模型以为写进去了
    if (list.length > 0 && todos.length === 0) {
      throw new Error(t('错误：todos 中没有任何有效的任务（content 不能为空）'))
    }

    const warnings = validateTodos(todos)
    const stats = computeStats(todos)

    track('todo.write', {
      session_id: hashText(ctx.sessionId),
      tool_call_id: ctx.toolCallId,
      total: stats.total,
      completed: stats.completed,
      in_progress: stats.inProgress,
      pending: stats.pending,
      warning_count: warnings.length,
    })

    const uiData: TodoUiData = {
      type: 'todo',
      todos,
      stats,
      source: 'model',
    }

    return {
      content: renderTodoContent(todos, warnings),
      uiData,
    }
  }) as ToolExecutor,
)
