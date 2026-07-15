import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { IProvider } from './types'
import { OpenAiProvider } from './openai'

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

      default:
        return new OpenAiProvider(id, apiKey, baseUrl)
    }
  } catch (e) {
    console.error('Failed to create provider:', config.type, e)
    return null
  }
}
