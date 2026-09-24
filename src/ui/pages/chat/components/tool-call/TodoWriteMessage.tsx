/**
 * TodoWriteMessage — todo_write 在消息流里的一行
 *
 * ⚠️ 刻意**不在消息流里展开清单内容**：用户层面任务只有一份，
 * 清单统一在标题栏的「任务清单」浮层里查看 / 编辑（见 components/todo/）。
 * 消息流只留一行摘要，保证「AI 编辑了流程」这件事可见、可回溯。
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { isTodoUiData } from '@/domain/todo/state'

class TodoWriteMessage implements IToolCallMessage {
  getToolName(): string {
    return 'todo_write'
  }

  getToolLabel(): string {
    return t('任务清单')
  }

  getShortText(props: ToolMessageProps): string {
    try {
      const ui = props.message?.uiData
      if (isTodoUiData(ui)) {
        const stats = ui.stats
        if (stats.total === 0) return t('清单已清空')
        const running = ui.todos.find((x) => x.status === 'in_progress')
        const base = tpl('$__done__/$__total__ 完成', {
          done: stats.completed,
          total: stats.total,
        })
        return running ? `${base} · ▶ ${running.content}` : base
      }
      // 工具尚未产出结果（执行中）：退回入参展示条数
      const input = props.useContent.input as { todos?: unknown } | undefined
      if (Array.isArray(input?.todos)) {
        return tpl('更新了 $__count__ 项任务', { count: input.todos.length })
      }
      return ''
    } catch {
      return t('解析异常')
    }
  }

  /** 无展开内容：清单只在标题栏浮层里 */
  getExpandView(): React.ReactNode {
    return null
  }

  diyWrapper(): boolean {
    return true
  }
}

export default TodoWriteMessage
