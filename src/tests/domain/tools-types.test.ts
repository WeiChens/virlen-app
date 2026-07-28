/**
 * Tool Types 测试 — 工具相关类型和类
 *
 * 覆盖场景：
 * - UserInteractionRequired 构造和属性
 * - ToolResult 结构
 * - ToolDefinition 结构
 * - ToolParameterProperty 结构
 * - ToolContext 结构
 * - ToolExecutor 函数签名
 */
import { describe, it, expect } from 'vitest'
import {
  UserInteractionRequired,
} from '@/domain/tools/types'
import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolParameterProperty,
  ToolExecutor,
} from '@/domain/tools/types'

describe('UserInteractionRequired', () => {
  it('应正确存储 interactionType 和 interactionData', () => {
    const ui = new UserInteractionRequired('command_confirm', {
      command: 'rm -rf /',
      description: '确认删除',
    })
    expect(ui.interactionType).toBe('command_confirm')
    expect(ui.interactionData.command).toBe('rm -rf /')
    expect(ui.interactionData.description).toBe('确认删除')
  })

  it('interactionData 应为空对象当未传数据时', () => {
    const ui = new UserInteractionRequired('user_choice', {})
    expect(ui.interactionType).toBe('user_choice')
    expect(ui.interactionData).toEqual({})
  })

  it('应支持 instanceof 检测', () => {
    const ui = new UserInteractionRequired('test', {})
    expect(ui).toBeInstanceOf(UserInteractionRequired)
  })
})

describe('ToolDefinition 类型结构', () => {
  it('应能构建有效的 ToolDefinition', () => {
    const def: ToolDefinition = {
      name: 'read_file',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径',
          },
        },
        required: ['path'],
      },
    }
    expect(def.name).toBe('read_file')
    expect(def.parameters.required).toContain('path')
    expect(def.parameters.properties.path.description).toBe('文件路径')
  })

  it('label 为可选项', () => {
    const def: ToolDefinition = {
      name: 'no_label',
      description: 'A tool without label',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    }
    expect(def.label).toBeUndefined()
  })

  it('支持带 enum 的参数属性', () => {
    const prop: ToolParameterProperty = {
      type: 'string',
      description: '模式选择',
      enum: ['auto', 'manual'],
    }
    expect(prop.enum).toHaveLength(2)
    expect(prop.enum).toContain('auto')
  })

  it('支持带默认值的参数', () => {
    const prop: ToolParameterProperty = {
      type: 'number',
      description: '温度参数',
      default: 0.7,
    }
    expect(prop.default).toBe(0.7)
  })
})

describe('ToolResult 类型结构', () => {
  it('应能构建 ToolResult（带 uiData）', () => {
    const result: ToolResult = {
      content: '文件已创建',
      uiData: { filePath: '/path/to/file.ts' },
    }
    expect(result.content).toBe('文件已创建')
    expect(result.uiData!.filePath).toBe('/path/to/file.ts')
  })

  it('应能构建 ToolResult（不带 uiData）', () => {
    const result: ToolResult = {
      content: '操作成功',
    }
    expect(result.content).toBe('操作成功')
    expect(result.uiData).toBeUndefined()
  })
})

describe('ToolContext 类型结构', () => {
  it('应能构建 ToolContext', () => {
    const abortController = new AbortController()
    const writeFn = vi.fn()

    const ctx: ToolContext = {
      sessionId: 'session-1',
      toolCallId: 'call-1',
      abortSignal: abortController.signal,
      write: writeFn,
      skills: ['code-reviewer', 'doc-writer'],
    }

    expect(ctx.sessionId).toBe('session-1')
    expect(ctx.toolCallId).toBe('call-1')
    expect(ctx.skills).toHaveLength(2)
    expect(typeof ctx.write).toBe('function')
  })

  it('skills 为可选项', () => {
    const ctx: ToolContext = {
      sessionId: 's1',
      toolCallId: 'c1',
      abortSignal: new AbortController().signal,
      write: vi.fn(),
    }
    expect(ctx.skills).toBeUndefined()
  })
})

describe('ToolExecutor 类型签名', () => {
  it('应支持返回 string 类型', async () => {
    const executor: ToolExecutor = async (_args, _ctx) => 'simple string result'
    const result = await executor({}, {
      sessionId: 's1',
      toolCallId: 'c1',
      abortSignal: new AbortController().signal,
      write: vi.fn(),
    })
    expect(result).toBe('simple string result')
  })

  it('应支持返回 UserInteractionRequired', async () => {
    const executor: ToolExecutor = async (_args, _ctx) =>
      new UserInteractionRequired('user_choice', { options: ['A', 'B'] })
    const result = await executor({}, {
      sessionId: 's1',
      toolCallId: 'c1',
      abortSignal: new AbortController().signal,
      write: vi.fn(),
    })
    expect(result).toBeInstanceOf(UserInteractionRequired)
  })

  it('应支持返回 ToolResult 对象', async () => {
    const executor: ToolExecutor = async (_args, _ctx) => ({
      content: 'result with UI data',
      uiData: { key: 'value' },
    })
    const result = await executor({}, {
      sessionId: 's1',
      toolCallId: 'c1',
      abortSignal: new AbortController().signal,
      write: vi.fn(),
    })
    expect(typeof result).toBe('object')
    if (typeof result !== 'string' && !(result instanceof UserInteractionRequired)) {
      expect(result.content).toBe('result with UI data')
      expect(result.uiData!.key).toBe('value')
    }
  })
})
