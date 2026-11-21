/**
 * 「📋 获取模型」/「🔗 测试连接」的唯一出口 —— **走 Rust 命令，不走 webview 里的 fetch**。
 *
 * 为什么必须后端化：这两个请求打的是第三方网关（自建 / 内网 / 中转站 / 自定义 Base URL），
 * 其中相当一部分不返回 `Access-Control-Allow-Origin` —— 浏览器侧的 fetch 被 CORS 拦成
 * 「Failed to fetch」，用户看到「获取模型失败」，而 key 与地址其实是好的（同一个请求用
 * curl 一发就通）。Rust 侧的 reqwest 没有同源策略。
 * 语义也不在这里另写一份：后端命令转交 `virlen-core` 的 `provider::{list_models,
 * verify_connection}`，与 CLI `config verify` 是同一份实现。
 *
 * 两条**确定不会发请求**的回落（其余情况一律把后端错误原样抛出）：
 * - **桥接协议（gemini）**：core 明确报「需要前端 JS 桥」→ 回落 TS 实现（Google 官方接口
 *   带 CORS 头，不受本问题影响）；
 * - **非 Tauri 环境**（浏览器 dev / vitest）：没有 `invoke` 运行时。
 *
 * ⚠️ 后端**报错不回落**：回落会把这个请求再打一遍 —— 服务商按次数计费，且真正的 401 / 404
 * 文案会被第二个请求掩盖（那条才是要展示给用户的）。
 */
import { invoke } from '@tauri-apps/api/core'
import { t } from '@/ui/i18n'
import { createProviderInstance } from '@/infrastructure/provider'
import type { ProviderConfig } from '@/types'

/**
 * 后端有原生实现的协议（`virlen-core::provider::{list_models, verify_connection}` 的 match）。
 *
 * ⚠️ 与 `provider/mod.rs` 的 `create_native_provider` 同一份事实：这里多列一个 → 后端报
 * 「暂不支持」；少列一个 → 明明能后端化却仍在受 CORS 限制。
 */
const BACKEND_PROTOCOLS: ReadonlyArray<ProviderConfig['type']> = [
  'openai',
  'anthropic',
  'responses',
]

/** 是否运行在 Tauri 宿主里（与 `infrastructure/agentRepo`、`backgroundService` 同一口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 后端吃 `ProviderConnection`（serde camelCase）：四处字段，不要塞整个 config */
function connectionOf(config: ProviderConfig) {
  return {
    providerType: config.type,
    providerId: config.id,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  }
}

/** 该走 TS 回落吗（桥接协议 / 没有 Tauri 运行时） */
function shouldFallbackToJs(config: ProviderConfig): boolean {
  return !isTauri() || !BACKEND_PROTOCOLS.includes(config.type)
}

/** 桥接协议 / 非 Tauri 环境下的 TS 实例；造不出来说明配置缺字段 */
function jsProvider(config: ProviderConfig) {
  const provider = createProviderInstance(config)
  if (!provider) throw new Error(t('无法创建模型服务配置'))
  return provider
}

/** 拉取模型列表（「📋 获取模型」）。失败一律 throw，消息尽量保留服务端原文 */
export async function fetchProviderModels(
  config: ProviderConfig,
): Promise<string[]> {
  if (shouldFallbackToJs(config)) return jsProvider(config).listModels()
  return invoke<string[]>('list_provider_models', { conn: connectionOf(config) })
}

/**
 * 验证连接（「🔗 测试连接」）：发一条最小真实请求。
 *
 * 返回 `true` / 抛错（**不**返回 `false`）：调用方要能把 401 / 404 / 额度不足的原文展示出来，
 * 吞成 `false` 只会让用户看到「测试失败」却不知道该改哪里。
 */
export async function testProviderConnection(
  config: ProviderConfig,
): Promise<boolean> {
  const model = config.models?.[0]
  if (!model) throw new Error(t('请先为该 Provider 配置至少一个模型'))
  if (shouldFallbackToJs(config)) return jsProvider(config).validateApiKey(config)
  await invoke<string>('verify_provider_connection', {
    conn: connectionOf(config),
    model,
  })
  return true
}
