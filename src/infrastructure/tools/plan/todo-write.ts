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
 * ⚠️ 已原生化（Step 2）：Rust 引擎走 `native_tools/plan/todo_write.rs`（默认路径），
 * 本文件是回退路径；两侧语义必须完全一致（铁律 1）：改这里的三条校验文案 / `content` 渲染 /
 * `uiData` 结构，必须同步改 Rust 侧 `native_tools/plan/{todo_write,common}.rs`。
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
    'todo_write',
    (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const raw = args?.todos
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
      throw new Error('Error: "todos" must be an array')
    }
    const list = Array.isArray(raw) ? raw : []

    // 数量超限直接报错（不静默截断：残缺清单会让模型做出错误决策）
    const limitError = checkTodoLimit(list.length)
    if (limitError) throw new Error(limitError)

    const todos = sanitizeTodos(list)
    // 传了内容但全部无效（缺 content）→ 报错，避免模型以为写进去了
    if (list.length > 0 && todos.length === 0) {
      throw new Error(
        'Error: no valid task in "todos" (content must not be empty)',
      )
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
    t('任务清单'),
)
