/**
 * 供应商目录来源适配器（infrastructure）—— 把 Rust 侧的目录交给 domain 层
 *
 * 两条路径读的是**同一份物理文件**
 * `src-tauri/virlen-core/src/agent/provider/provider_catalog.json`：
 *
 * | 环境 | 取值方式 | 说明 |
 * |---|---|---|
 * | Tauri 运行时 | `cmd_provider_catalog` | Rust `include_str!` 已把 json 嵌进二进制；权威且只有一份 |
 * | 浏览器 dev / vitest | 静态 `?raw` 导入 | 构建期从 core 目录读同一份文件 |
 *
 * 因为两条路径同源，这里不需要任何「差异检查」逻辑（与 `prompts/prompt-source.ts` 同一取舍）。
 *
 * 用静态 import：目录要在启动阶段同步水合（`setProviderCatalog`），且整个 json 约 2.7 KB，
 * 不值得引入 async 分支。
 */
import { invoke } from '@tauri-apps/api/core'
import { setProviderCatalog, type ProviderCatalog } from '@/domain/provider/catalog'
import CATALOG_JSON from '../../../src-tauri/virlen-core/src/agent/provider/provider_catalog.json?raw'

/** 是否在 Tauri 环境（与 `services/rust-engine.ts::isTauriAvailable` 同一判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 内嵌目录（构建期从 core 目录读入）。
 *
 * 它既是**浏览器 dev / vitest** 的取值路径，也是 Tauri 下命令失败时的兜底 ——
 * 兜底给的仍是同一份数据，所以降级不会改变结果。
 */
export function embeddedProviderCatalog(): ProviderCatalog {
  return JSON.parse(CATALOG_JSON) as ProviderCatalog
}

/** 默认加载器：Tauri 优先命令，失败 / 非 Tauri 环境走内嵌文本 */
export async function loadProviderCatalog(): Promise<ProviderCatalog> {
  if (isTauriEnv()) {
    try {
      return await invoke<ProviderCatalog>('cmd_provider_catalog')
    } catch (e: any) {
      console.warn(
        `[provider-catalog] cmd_provider_catalog 失败，降级到内嵌目录（同一份 json）：${e?.message || String(e)}`,
      )
    }
  }
  return embeddedProviderCatalog()
}

/**
 * 组合根的一步：取目录并水合到 domain 层快照（幂等）。
 *
 * `main.ts` 的 `providerCatalog` 步骤调它；测试 setup 直接调 `setProviderCatalog()`
 * （没必要走异步分支）。
 */
export async function hydrateProviderCatalog(): Promise<void> {
  setProviderCatalog(await loadProviderCatalog())
}
