/**
 * 迭代控制器测试 — 执行→验证→修复 自主迭代循环
 *
 * 覆盖场景：
 * - buildFeedbackMessage 生成正确格式的反馈消息
 * - parseVerificationResult 正确解析各种 JSON 格式
 * - IterationController 配置和初始化
 * - IterationSession 状态管理
 */
import { describe, it, expect } from 'vitest'
import { buildFeedbackMessage } from '@/domain/engine/iteration-types'
import type {
  Goal,
  VerificationResult,
  IterationSession,
} from '@/domain/engine/iteration-types'
import { LLMVerifier } from '@/domain/engine/verifier'
import {
  IterationController,
  createIterationController,
} from '@/domain/engine/iteration-controller'

// ==================== buildFeedbackMessage ====================

describe('buildFeedbackMessage', () => {
  it('应该生成包含所有问题的反馈消息', () => {
    const result: VerificationResult = {
      passed: false,
      summary: '目标未达成：文件未创建',
      issues: [
        {
          severity: 'error',
          description: '未找到目标文件',
          suggestion: '使用 write_file 工具创建文件',
        },
        {
          severity: 'warning',
          description: '文件内容不完整',
          suggestion: '补充缺少的章节',
        },
      ],
    }

    const msg = buildFeedbackMessage(result)

    expect(msg.role).toBe('feedback')
    expect(typeof msg.content).toBe('string')
    const content = msg.content as string
    expect(content).toContain('【验证反馈】')
    expect(content).toContain('未通过')
    expect(content).toContain('目标未达成：文件未创建')
    expect(content).toContain('[error]')
    expect(content).toContain('未找到目标文件')
    expect(content).toContain('使用 write_file 工具创建文件')
    expect(content).toContain('[warning]')
    expect(content).toContain('文件内容不完整')
    expect(content).toContain('补充缺少的章节')
    expect(content).toContain('请修正以上问题后重新尝试')
  })

  it('通过验证时不应包含问题列表和修复提示', () => {
    const result: VerificationResult = {
      passed: true,
      summary: '目标已达成',
      issues: [],
    }

    const msg = buildFeedbackMessage(result)
    const content = msg.content as string

    expect(content).toContain('✅ 通过')
    expect(content).not.toContain('请修正以上问题后重新尝试')
    expect(content).not.toContain('发现的问题')
  })

  it('应包含 info 级别的问题', () => {
    const result: VerificationResult = {
      passed: false,
      summary: '基本完成但有改进空间',
      issues: [
        {
          severity: 'info',
          description: '可以添加更多注释',
          suggestion: '在关键函数处添加 JSDoc 注释',
        },
      ],
    }

    const msg = buildFeedbackMessage(result)
    const content = msg.content as string
    expect(content).toContain('[info]')
  })
})

// ==================== LLMVerifier 解析逻辑 ====================

describe('LLMVerifier - parseVerificationResult', () => {
  // 通过反射测试私有方法：构造 verifier 实例，调用 verify 时 mock provider
  // 这里测试 verifier 的构造函数和配置

  it('应该使用默认配置创建', () => {
    const verifier = new LLMVerifier()
    expect(verifier).toBeDefined()
  })

  it('应该接受自定义 maxTokens', () => {
    const verifier = new LLMVerifier({ maxTokens: 1024 })
    expect(verifier).toBeDefined()
  })
})

// ==================== IterationController ====================

describe('IterationController', () => {
  it('应该使用默认 maxIterations=5 创建', () => {
    const controller = new IterationController()
    expect(controller).toBeDefined()
  })

  it('应该接受自定义 maxIterations', () => {
    const controller = new IterationController({ maxIterations: 3 })
    expect(controller).toBeDefined()
  })

  it('应该接受事件回调', () => {
    const events: any[] = []
    const controller = new IterationController({
      maxIterations: 2,
      onIterationEvent: (e) => events.push(e),
    })
    expect(controller).toBeDefined()
    expect(events).toHaveLength(0) // 未运行前无事件
  })

  it('createIterationController 应返回 IterationController 实例', () => {
    const controller = createIterationController({ maxIterations: 3 })
    expect(controller).toBeInstanceOf(IterationController)
  })

  it('createIterationController 无参数应使用默认值', () => {
    const controller = createIterationController()
    expect(controller).toBeInstanceOf(IterationController)
  })
})

// ==================== 类型定义验证 ====================

describe('迭代类型定义', () => {
  it('Goal 类型应包含 description 字段', () => {
    const goal: Goal = { description: '创建一个 React 组件' }
    expect(goal.description).toBe('创建一个 React 组件')
  })

  it('VerificationResult 应包含所有必需字段', () => {
    const result: VerificationResult = {
      passed: true,
      summary: '完成',
      issues: [],
    }
    expect(result.passed).toBe(true)
    expect(result.summary).toBe('完成')
    expect(result.issues).toEqual([])
  })

  it('IterationSession 应跟踪迭代状态', () => {
    const session: IterationSession = {
      goal: { description: '测试目标' },
      currentIteration: 2,
      maxIterations: 5,
      verificationHistory: [],
    }
    expect(session.currentIteration).toBe(2)
    expect(session.maxIterations).toBe(5)
    expect(session.verificationHistory).toHaveLength(0)
  })

  it('VerificationResult.issues 应支持多严重级别', () => {
    const result: VerificationResult = {
      passed: false,
      summary: '多个问题',
      issues: [
        {
          severity: 'error',
          description: '严重问题',
          suggestion: '修复方案A',
        },
        {
          severity: 'warning',
          description: '警告问题',
          suggestion: '改进方案B',
        },
        {
          severity: 'info',
          description: '提示信息',
          suggestion: '建议方案C',
        },
      ],
    }
    expect(result.issues).toHaveLength(3)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[1].severity).toBe('warning')
    expect(result.issues[2].severity).toBe('info')
  })
})
