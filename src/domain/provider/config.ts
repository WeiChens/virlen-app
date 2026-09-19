import { ProviderType } from '@/types'

/**
 * 推理强度档位并集
 *
 * 各厂商实际支持的 reasoning_effort 取值互不相同（OpenAI / Claude / Gemini / Grok /
 * Kimi / GLM …），这里取全部枚举值的并集作为用户可勾选的候选项（见 docs/推理强度值.md）。
 * 用户在服务商配置里勾选后，聊天界面里的「推理强度」只能从勾选出的子集中选。
 */
export const REASONING_EFFORT_UNION = [
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** 新建服务商时默认勾选的推理强度档位（行业通用基础档位） */
export const DEFAULT_REASONING_EFFORT_LIST: string[] = [
  'low',
  'medium',
  'high',
]

/** 并集档位的排序权重（未知值排到最后） */
function effortRank(val: string): number {
  const i = (REASONING_EFFORT_UNION as readonly string[]).indexOf(val)
  return i === -1 ? REASONING_EFFORT_UNION.length : i
}

/**
 * 按并集顺序重排档位列表
 *
 * 拖动条要求档位单调（none → minimal → low → … → max），而用户勾选的先后顺序是任意的，
 * 因此落库前统一按并集顺序归一化。
 */
export function sortReasoningEfforts(list: string[]): string[] {
  return [...list].sort((a, b) => effortRank(a) - effortRank(b))
}

export const PROVIDER_TEMPLATES: {
  templateName: string
  type: ProviderType
  label: string
  baseUrl: string
  allowTypeList?: {
    type: ProviderType
    baseUrl: string
  }[]
  /**
   * 允许的 reasoningEffort 值列表（如 ['low', 'medium', 'high']），不设置则表示不支持
   * @deprecated 选项已改为「用户从 REASONING_EFFORT_UNION 里多选」（ProviderConfig.reasoningEffortList），
   *             此字段仅保留作为各平台支持情况的参考数据，不再参与 UI 选项计算。
   */
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
