/**
 * provider-service — Provider 初始化服务层
 *
 * 将已持久化的 provider 配置注册到运行时注册中心。
 * 属于 Store 与 Engine 之间的编排逻辑，不应在 Store 层处理。
 */
import { providerPort } from '@/domain'
import { PROVIDER_TEMPLATES } from '@/domain/provider/config'
import { createProviderInstance } from '@/infrastructure/provider'
import { IProvider } from '@/infrastructure/provider/types'
import { settingsState } from '@/ui/store'
import { ProviderConfig, ProviderConfigTemplate } from '@/types'

class ProviderServiceImpl implements ProviderService {
  registerByConfig(config: ProviderConfig): boolean {
    throw new Error('Method not implemented.')
  }
  initProviders(): void {
    for (const p of settingsState.value.providers) {
      if (p.enabled) {
        try {
          const provider = createProviderInstance(p)
          providerPort.register(p.id, provider)
        } catch (e) {
          console.error('Failed to register provider:', p.id, e)
        }
      }
    }
  }
  getDefaultProviderList(): ProviderConfigTemplate[] {
    return PROVIDER_TEMPLATES
  }
  register(config: ProviderConfig): boolean {
    const provider = createProviderInstance(config)
    if (config) {
      providerPort.register(config.id, provider)
      return true
    }
    return false
  }

  unregister(providerId: string): void {
    providerPort.unregister(providerId)
  }
  async getProvider(providerId: string): Promise<IProvider | undefined> {
    return await providerPort.get(providerId)
  }
}
export interface ProviderService {
  initProviders(): void
  getDefaultProviderList(): ProviderConfigTemplate[]
  register(config: ProviderConfig): boolean
  unregister(providerId: string): void
  getProvider(providerId: string): Promise<IProvider | undefined>

  registerByConfig(config: ProviderConfig): boolean
}
export const providerService: ProviderService = new ProviderServiceImpl()
