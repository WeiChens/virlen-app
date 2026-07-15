/**
 * Provider 抽象层 — 定义 LLM Provider 接口
 */
import { IProvider } from '@/infrastructure/provider/types'
import { ProviderPort } from '../ports'
import type { Session } from '@/types'

/**
 * 供应商注册中心
 */
export class ProviderRegistry implements ProviderPort {
  async ensureProvider(session: Session): Promise<IProvider> {
    if (!session.modelId) {
      throw new Error('未选择模型，请在工具栏切换模型后重试')
    }
    const provider = await this.get(session.providerConfigId)
    if (!provider) {
      throw new Error(
        `Provider "${session.providerConfigId}" 未注册，请在设置中配置模型服务`,
      )
    }
    return provider
  }
  private providers: Map<string, IProvider> = new Map()
  private defaultProvider: string | null = null

  async register(id: string, provider: IProvider) {
    this.providers.set(id, provider)
    if (!this.defaultProvider) this.defaultProvider = id
  }
  // async registerByConfig(id: string, providerConfig: ProviderConfig) {
  //   const provider = createProviderInstance(providerConfig)
  //   this.providers.set(id, provider)
  //   if (!this.defaultProvider) this.defaultProvider = id
  // }

  async unregister(id: string) {
    if (this.defaultProvider === id) this.defaultProvider = null
    return this.providers.delete(id)
  }

  async get(id: string) {
    return this.providers.get(id)
  }

  async getDefault() {
    if (!this.defaultProvider) return undefined
    return this.providers.get(this.defaultProvider)
  }

  async list() {
    return Array.from(this.providers.entries()).map(([id, p]) => ({
      id,
      name: p.name,
    }))
  }
}

/** 全局 provider 注册中心 */
export const providerPort: ProviderPort = new ProviderRegistry()
