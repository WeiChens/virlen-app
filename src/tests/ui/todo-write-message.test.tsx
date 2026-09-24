/**
 * TodoWriteMessage — 消息流一行的渲染测试
 *
 * 关键约定：清单**不在消息流里展开**（用户层面任务只有一份，统一在标题栏浮层），
 * 所以 getExpandView 必须返回 null（空），摘要只保留「x/y 完成 + 当前进行项」。
 */
import { describe, it, expect } from 'vitest'
import TodoWriteMessage from '@/ui/pages/chat/components/tool-call/TodoWriteMessage'
import type { Message, ToolUseContent } from '@/types'

function toolUse(input: Record<string, any>): ToolUseContent {
  return { type: 'tool_use', id: 'tc1', name: 'todo_write', input }
}

function resultMessage(uiData: Record<string, any> | undefined): Message {
  return {
    id: 'm1',
    role: 'tool',
    content: '...',
    toolCallId: 'tc1',
    uiData,
    timestamp: 0,
  }
}

const message = new TodoWriteMessage()

describe('TodoWriteMessage', () => {
  it('工具名与标签', () => {
    expect(message.getToolName()).toBe('todo_write')
    expect(message.getToolLabel()).toBe('任务清单')
  })

  it('摘要 = 完成进度 + 当前进行项', () => {
    const text = message.getShortText({
      useContent: toolUse({ todos: [] }),
      message: resultMessage({
        type: 'todo',
        todos: [
          { id: '1', content: '读文档', status: 'completed' },
          { id: '2', content: '写工具', status: 'in_progress' },
          { id: '3', content: '补测试', status: 'pending' },
        ],
        stats: { total: 3, completed: 1, inProgress: 1, pending: 1 },
        source: 'model',
      }),
    })
    expect(text).toContain('1/3 完成')
    expect(text).toContain('写工具')
  })

  it('空清单显示「清单已清空」', () => {
    const text = message.getShortText({
      useContent: toolUse({ todos: [] }),
      message: resultMessage({
        type: 'todo',
        todos: [],
        stats: { total: 0, completed: 0, inProgress: 0, pending: 0 },
        source: 'model',
      }),
    })
    expect(text).toBe('清单已清空')
  })

  it('工具还没执行完时退回入参条数', () => {
    const text = message.getShortText({
      useContent: toolUse({ todos: [{ id: '1', content: 'a' }] }),
    })
    expect(text).toContain('1')
  })

  it('不在消息流里展开清单（getExpandView 返回 null）', () => {
    expect(message.getExpandView()).toBeNull()
    // diyWrapper() = true：这一行不走默认的展开包裹（没有可展开的内容）
    expect(message.diyWrapper()).toBe(true)
  })
})
