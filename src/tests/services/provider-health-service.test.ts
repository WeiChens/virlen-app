// @vitest-environment node
/**
 * 「获取模型 / 测试连接」的后端化契约（`src/services/provider-health-service.ts`）。
 *
 * 钉住三条不能靠读代码才发现的口径：
 *   1. 有 Tauri 运行时的原生协议 → **只**走 `invoke`（这是 CORS 问题的解法本身）；
 *   2. 桥接协议（gemini）/ 没有 Tauri 运行时 → 回落 TS，且 `invoke` 一次都不能发；
 *   3. 后端**报错不回落**：回落等于同一个请求打两遍（服务商按次数计费），
 *      且真正的 401/404 原文会被第二个请求掩盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@/types'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invoke(...args),
}))

const listModels = vi.fn()
const validateApiKey = vi.fn()
vi.mock('@/infrastructure/provider', () => ({
  createProviderInstance: () => ({ listModels, validateApiKey }),
}))

import {
  fetchProviderModels,
  testProviderConnection,
} from '@/services/provider-health-service'

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'p1',
    type: 'openai',
    apiKey: 'k',
    baseUrl: 'https://api.test.com/v1',
    models: ['m1'],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as ProviderConfig
}

/** 模拟运行在 Tauri 宿主里（`isTauri()` 的判定依据） */
function enterTauri() {
  ;(globalThis as any).window = { __TAURI_INTERNALS__: {} }
}

afterEach(() => {
  delete (globalThis as any).window
  invoke.mockReset()
  listModels.mockReset()
  validateApiKey.mockReset()
})

describe('provider-health-service', () => {
  it('原生协议 + Tauri：获取模型只走后端命令', async () => {
    enterTauri()
    invoke.mockResolvedValue(['a', 'b'])
    await expect(fetchProviderModels(cfg())).resolves.toEqual(['a', 'b'])
    expect(invoke).toHaveBeenCalledWith('list_provider_models', {
      conn: {
        providerType: 'openai',
        providerId: 'p1',
        apiKey: 'k',
        baseUrl: 'https://api.test.com/v1',
      },
    })
    expect(listModels).not.toHaveBeenCalled()
  })

  it('桥接协议（gemini）：回落 TS，不发 invoke', async () => {
    enterTauri()
    listModels.mockResolvedValue(['gemini-2.5-pro'])
    await expect(fetchProviderModels(cfg({ type: 'gemini' }))).resolves.toEqual([
      'gemini-2.5-pro',
    ])
    expect(invoke).not.toHaveBeenCalled()
    expect(listModels).toHaveBeenCalledTimes(1)
  })

  it('没有 Tauri 运行时（浏览器 dev / vitest）：回落 TS', async () => {
    listModels.mockResolvedValue(['m'])
    await expect(fetchProviderModels(cfg())).resolves.toEqual(['m'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('后端报错原样抛出，且**不**回落（否则同一请求打两遍 / 掩盖 401 原文）', async () => {
    enterTauri()
    invoke.mockRejectedValue('API Error (401): invalid key')
    await expect(fetchProviderModels(cfg())).rejects.toBe(
      'API Error (401): invalid key',
    )
    expect(listModels).not.toHaveBeenCalled()
  })

  it('测试连接：原生协议走 verify_provider_connection，成功即 true', async () => {
    enterTauri()
    invoke.mockResolvedValue('')
    await expect(testProviderConnection(cfg())).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('verify_provider_connection', {
      conn: {
        providerType: 'openai',
        providerId: 'p1',
        apiKey: 'k',
        baseUrl: 'https://api.test.com/v1',
      },
      model: 'm1',
    })
  })

  it('测试连接：没配模型就明确报错，一个请求都不发', async () => {
    enterTauri()
    await expect(testProviderConnection(cfg({ models: [] }))).rejects.toThrow(
      '请先为该 Provider 配置至少一个模型',
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(validateApiKey).not.toHaveBeenCalled()
  })
})
