import { ProviderType } from '@/types'

export const PROVIDER_TEMPLATES: {
  templateName: string
  type: ProviderType
  label: string
  baseUrl: string
  allowTypeList?: {
    type: ProviderType
    baseUrl: string
  }[]
  /** 允许的 reasoningEffort 值列表（如 ['low', 'medium', 'high']），不设置则表示不支持 */
  allowReasoningEffortList?: string[]
  /**
   * 官网地址
   */
  officialLink?: string
}[] = [
  {
    templateName: 'deepseek',
    type: 'openai',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    allowTypeList: [
      {
        type: 'openai',
        baseUrl: 'https://api.deepseek.com',
      },
      {
        type: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
      },
    ],
    officialLink: 'https://platform.deepseek.com',
    allowReasoningEffortList: ['high', 'max'],
  },
  {
    templateName: 'zhipu',
    type: 'openai',
    label: '智普',
    officialLink: 'https://open.bigmodel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    templateName: 'qwen',
    type: 'openai',
    label: '千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    allowReasoningEffortList: ['low', 'medium', 'high'],
    officialLink: 'https://bailian.console.aliyun.com',
    allowTypeList: [
      {
        type: 'openai',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      {
        type: 'anthropic',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic/v1',
      },
    ],
  },
  // {
  //   templateName: 'doubao',
  //   type: 'openai',
  //   label: '豆包',
  //   officialLink: 'https://console.volcengine.com',
  //   baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  // },
  {
    templateName: 'openai',
    type: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    officialLink: 'https://platform.openai.com',
    allowReasoningEffortList: ['low', 'medium', 'high'],
  },
  {
    templateName: 'anthropic',
    type: 'anthropic',
    label: 'Anthropic',
    officialLink: 'https://www.anthropic.com',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  {
    templateName: 'gemini',
    type: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  {
    templateName: 'custom',
    type: 'openai',
    label: '自定义',
    baseUrl: '',
    allowReasoningEffortList: ['low', 'medium', 'high'],
  },
] as const
