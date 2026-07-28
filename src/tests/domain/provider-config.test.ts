/**
 * Provider Config 测试 — 供应商模板配置
 *
 * 覆盖场景：
 * - 所有预定义模板的完整性
 * - 每个模板的类型和必填字段
 * - DeepSeek 模板的多协议支持
 * - 千问模板的 reasoningEffort 配置
 * - OpenAI 模板的 reasoningEffort 配置
 * - 自定义模板的默认值
 */
import { describe, it, expect } from 'vitest'
import { PROVIDER_TEMPLATES } from '@/domain/provider/config'

describe('PROVIDER_TEMPLATES', () => {
  it('应包含所有预定义模板', () => {
    const templateNames = PROVIDER_TEMPLATES.map((t) => t.templateName)
    expect(templateNames).toContain('deepseek')
    expect(templateNames).toContain('zhipu')
    expect(templateNames).toContain('qwen')
    expect(templateNames).toContain('openai')
    expect(templateNames).toContain('anthropic')
    expect(templateNames).toContain('gemini')
    expect(templateNames).toContain('custom')
  })

  it('每个模板都应包含必填字段', () => {
    for (const tmpl of PROVIDER_TEMPLATES) {
      expect(tmpl.templateName).toBeTruthy()
      expect(tmpl.type).toBeTruthy()
      expect(tmpl.label).toBeTruthy()
      expect(typeof tmpl.baseUrl).toBe('string')
      expect(tmpl.baseUrl).not.toBeUndefined()
    }
  })

  it('模板类型应为 openai、anthropic 或 gemini', () => {
    const validTypes = ['openai', 'anthropic', 'gemini']
    for (const tmpl of PROVIDER_TEMPLATES) {
      expect(validTypes).toContain(tmpl.type)
    }
  })

  describe('DeepSeek', () => {
    const deepseek = PROVIDER_TEMPLATES.find((t) => t.templateName === 'deepseek')

    it('应支持多协议切换', () => {
      expect(deepseek!.allowTypeList).toHaveLength(2)
      expect(deepseek!.allowTypeList![0].type).toBe('openai')
      expect(deepseek!.allowTypeList![1].type).toBe('anthropic')
    })

    it('应支持 reasoningEffort', () => {
      expect(deepseek!.allowReasoningEffortList).toContain('high')
      expect(deepseek!.allowReasoningEffortList).toContain('max')
    })

    it('应包含官网链接', () => {
      expect(deepseek!.officialLink).toBe('https://platform.deepseek.com')
    })
  })

  describe('千问 (Qwen)', () => {
    const qwen = PROVIDER_TEMPLATES.find((t) => t.templateName === 'qwen')

    it('应支持 URL 兼容格式', () => {
      expect(qwen!.baseUrl).toContain('dashscope.aliyuncs.com')
    })

    it('应支持多协议切换', () => {
      expect(qwen!.allowTypeList).toHaveLength(2)
      expect(qwen!.allowTypeList![0].type).toBe('openai')
      expect(qwen!.allowTypeList![1].type).toBe('anthropic')
    })

    it('应支持 reasoningEffort', () => {
      expect(qwen!.allowReasoningEffortList).toEqual(['low', 'medium', 'high'])
    })
  })

  describe('OpenAI', () => {
    const openai = PROVIDER_TEMPLATES.find((t) => t.templateName === 'openai')

    it('应使用正确的 API 端点', () => {
      expect(openai!.baseUrl).toBe('https://api.openai.com/v1')
    })

    it('应支持 reasoningEffort', () => {
      expect(openai!.allowReasoningEffortList).toEqual(['low', 'medium', 'high'])
    })
  })

  describe('Anthropic', () => {
    const anthropic = PROVIDER_TEMPLATES.find((t) => t.templateName === 'anthropic')

    it('应使用正确的 API 端点', () => {
      expect(anthropic!.baseUrl).toBe('https://api.anthropic.com/v1')
    })

    it('不应设置 reasoningEffort', () => {
      expect(anthropic!.allowReasoningEffortList).toBeUndefined()
    })
  })

  describe('Gemini', () => {
    const gemini = PROVIDER_TEMPLATES.find((t) => t.templateName === 'gemini')

    it('应使用正确的 API 端点', () => {
      expect(gemini!.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
    })

    it('不应设置 reasoningEffort', () => {
      expect(gemini!.allowReasoningEffortList).toBeUndefined()
    })
  })

  describe('自定义模板', () => {
    const custom = PROVIDER_TEMPLATES.find((t) => t.templateName === 'custom')

    it('baseUrl 应为空字符串（用户自行填写）', () => {
      expect(custom!.baseUrl).toBe('')
    })

    it('类型应为 openai', () => {
      expect(custom!.type).toBe('openai')
    })

    it('应支持 reasoningEffort', () => {
      expect(custom!.allowReasoningEffortList).toEqual(['low', 'medium', 'high'])
    })
  })

  describe('模板类型兼容性', () => {
    it('openai 类型的模板应包含正确的类型', () => {
      const openaiTemplates = PROVIDER_TEMPLATES.filter((t) => t.type === 'openai')
      expect(openaiTemplates.length).toBeGreaterThanOrEqual(4) // deepseek, zhipu, qwen, openai, custom
    })

    it('每个 allowTypeList 中的类型和 baseUrl 应有效', () => {
      for (const tmpl of PROVIDER_TEMPLATES) {
        if (!tmpl.allowTypeList) continue
        for (const alt of tmpl.allowTypeList) {
          expect(alt.type).toBeTruthy()
          expect(alt.baseUrl).toBeTruthy()
          expect(alt.baseUrl).toMatch(/^https?:\/\//)
        }
      }
    })
  })
})
