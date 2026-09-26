/**
 * Provider Catalog 测试 — 供应商目录（模板表 + 推理强度档位表）
 *
 * ⚠️ 表的本体在 Rust（`virlen-core/src/agent/provider/provider_catalog.json`）：前端经
 * `setProviderCatalog()` 水合后同步读取（测试 setup 已完成水合）。本测试与 Rust 侧
 * `agent/provider/catalog.rs` 的单测是一对 —— 两侧盯同一批事实。
 *
 * 覆盖场景：
 * - 推理强度档位并集 / 默认勾选值 / 排序归一化
 * - 所有预定义模板的完整性（必填字段、类型、多协议、官网链接）
 * - 自定义模板的默认值
 */
import { describe, it, expect } from 'vitest'
import {
  providerTemplates,
  reasoningEffortUnion,
  defaultReasoningEffortList,
  sortReasoningEfforts,
} from '@/domain/provider/catalog'

describe('REASONING_EFFORT_UNION', () => {
  it('应覆盖各厂商档位名称的并集（共 8 个）', () => {
    // 'off' 与 'none' 同义（关闭推理），必须紧跟在 'none' 之后——
    // sortReasoningEfforts 依赖该顺序做归一化，档位需单调：
    // none/off < minimal < low < medium < high < xhigh < max
    expect([...reasoningEffortUnion()]).toEqual([
      'none',
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('默认勾选应为 low / medium / high', () => {
    expect(defaultReasoningEffortList()).toEqual(['low', 'medium', 'high'])
  })

  it('默认勾选值必须都在并集内', () => {
    for (const v of defaultReasoningEffortList()) {
      expect(reasoningEffortUnion()).toContain(v)
    }
  })
})

describe('sortReasoningEfforts', () => {
  it('应按并集顺序重排（用户勾选顺序是任意的）', () => {
    expect(sortReasoningEfforts(['high', 'none', 'low', 'max'])).toEqual([
      'none',
      'low',
      'high',
      'max',
    ])
  })

  it('不修改入参', () => {
    const input = ['high', 'low']
    sortReasoningEfforts(input)
    expect(input).toEqual(['high', 'low'])
  })

  it('未知档位排到最后（不丢值）', () => {
    expect(sortReasoningEfforts(['zzz', 'low'])).toEqual(['low', 'zzz'])
  })
})

describe('PROVIDER_TEMPLATES', () => {
  it('应包含所有预定义模板', () => {
    const templateNames = providerTemplates().map((t) => t.templateName)
    expect(templateNames).toContain('deepseek')
    expect(templateNames).toContain('zhipu')
    expect(templateNames).toContain('qwen')
    expect(templateNames).toContain('openai')
    expect(templateNames).toContain('anthropic')
    expect(templateNames).toContain('gemini')
    expect(templateNames).toContain('custom')
  })

  it('每个模板都应包含必填字段', () => {
    for (const tmpl of providerTemplates()) {
      expect(tmpl.templateName).toBeTruthy()
      expect(tmpl.type).toBeTruthy()
      expect(tmpl.label).toBeTruthy()
      expect(typeof tmpl.baseUrl).toBe('string')
      expect(tmpl.baseUrl).not.toBeUndefined()
    }
  })

  it('模板类型应为 openai、anthropic 或 gemini', () => {
    const validTypes = ['openai', 'anthropic', 'gemini']
    for (const tmpl of providerTemplates()) {
      expect(validTypes).toContain(tmpl.type)
    }
  })

  describe('DeepSeek', () => {
    const deepseek = providerTemplates().find((t) => t.templateName === 'deepseek')

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
    const qwen = providerTemplates().find((t) => t.templateName === 'qwen')

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
    const openai = providerTemplates().find((t) => t.templateName === 'openai')

    it('应使用正确的 API 端点', () => {
      expect(openai!.baseUrl).toBe('https://api.openai.com/v1')
    })

    it('应支持 reasoningEffort', () => {
      expect(openai!.allowReasoningEffortList).toEqual(['low', 'medium', 'high'])
    })
  })

  describe('Anthropic', () => {
    const anthropic = providerTemplates().find((t) => t.templateName === 'anthropic')

    it('应使用正确的 API 端点', () => {
      expect(anthropic!.baseUrl).toBe('https://api.anthropic.com/v1')
    })

    it('不应设置 reasoningEffort', () => {
      expect(anthropic!.allowReasoningEffortList).toBeUndefined()
    })
  })

  describe('Gemini', () => {
    const gemini = providerTemplates().find((t) => t.templateName === 'gemini')

    it('应使用正确的 API 端点', () => {
      expect(gemini!.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
    })

    it('不应设置 reasoningEffort', () => {
      expect(gemini!.allowReasoningEffortList).toBeUndefined()
    })
  })

  describe('自定义模板', () => {
    const custom = providerTemplates().find((t) => t.templateName === 'custom')

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
      const openaiTemplates = providerTemplates().filter((t) => t.type === 'openai')
      expect(openaiTemplates.length).toBeGreaterThanOrEqual(4) // deepseek, zhipu, qwen, openai, custom
    })

    it('每个 allowTypeList 中的类型和 baseUrl 应有效', () => {
      for (const tmpl of providerTemplates()) {
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
