import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { IProvider } from './types'
import { OpenAiProvider } from './openai'
import { ResponsesProvider } from './responses'

/** 根据 provider 类型创建对应的 IProvider 实例 */
export function createProviderInstance(config: {
  id: string
  name: string
  type: string
  apiKey: string
  baseUrl: string
}): IProvider | null {
  const { id, apiKey, baseUrl } = config
  try {
    switch (config.type) {
      case 'anthropic':
        return new AnthropicProvider(id, apiKey, baseUrl)
      case 'gemini':
        return new GeminiProvider(id, apiKey, baseUrl)
      case 'openai':
        return new OpenAiProvider(id, apiKey, baseUrl)
      // Responses API：独立协议（端点 / 请求体 / 事件名都不同），不能归到 openai 兼容
      case 'responses':
        return new ResponsesProvider(id, apiKey, baseUrl)

      default:
        return new OpenAiProvider(id, apiKey, baseUrl)
    }
  } catch (e) {
    console.error('Failed to create provider:', config.type, e)
    return null
  }
}
