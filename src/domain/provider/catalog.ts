/**
 * 供应商目录（模板表 + 推理强度档位表）的**前端侧快照**（纯模块，零 I/O）
 *
 * 数据本体在 Rust —— `src-tauri/virlen-core/src/agent/provider/provider_catalog.json`。
 * 前端**不再自带副本**：组合根（`src/main.ts`）启动时经 `loadProviderCatalog()` 水合一次，
 * 此后所有消费者**同步**读取。
 *
 * 为什么是「启动水合 + 同步读」而不是「每次异步去取」：
 * `sortReasoningEfforts()` 与 `providerTemplates()` 都在**渲染期被同步调用**
 * （`provider-edit-modal` / `reasoning-effort-slider` / `provider-service`），
 * 改成 async 会把它传染给整条 UI 链 —— 代价远大于「启动时等一次 IPC」。
 * 接线与提示词（`src/domain/agent/prompt-texts.ts`）同构。
 *
 * ⚠️ 未水合时抛错，不返回空表：空模板表会让「添加服务商」页面静默变空
 * （一张没有卡片的网格，用户不知道为什么），比直接报错难排查得多。
 */
import type { ProviderConfigTemplate } from '@/types'

/** 供应商目录（与 Rust `ProviderCatalog` 逐字段对应） */
export interface ProviderCatalog {
  /** 推理强度档位并集（**顺序即语义**：拖动条单调、归一化稳定都依赖它） */
  reasoningEffortUnion: string[]
  /** 新建供应商时默认勾选的档位 */
  defaultReasoningEffortList: string[]
  /** 全部模板 */
  templates: ProviderConfigTemplate[]
}

/** 内存快照；`null` = 尚未水合 */
let snapshot: ProviderCatalog | null = null

/**
 * 水合（启动时调用一次；测试 setup 里也调一次）。
 *
 * 对数组做浅拷贝：目录是**共享常量**，谁（误）改了不该影响别处。
 *
 * `null` = 重置为「未水合」状态（单测用；与 `setPromptTexts(null)` 同款语义）。
 */
export function setProviderCatalog(catalog: ProviderCatalog | null): void {
  if (catalog === null) {
    snapshot = null
    return
  }
  snapshot = {
    reasoningEffortUnion: [...(catalog.reasoningEffortUnion ?? [])],
    defaultReasoningEffortList: [...(catalog.defaultReasoningEffortList ?? [])],
    templates: catalog.templates ?? [],
  }
}

/** 是否已水合（诊断用；`false` 时下面的取值函数会抛错） */
export function hasProviderCatalog(): boolean {
  return snapshot !== null
}

/** 取目录；未水合直接抛错（见文件头「为什么不能返回空表」） */
export function providerCatalog(): ProviderCatalog {
  if (!snapshot) {
    throw new Error(
      '供应商目录尚未水合：请在启动流程里调用 hydrateProviderCatalog()（见 src/main.ts），' +
        '或在测试 setup 里调用 setProviderCatalog(embeddedProviderCatalog())',
    )
  }
  return snapshot
}

/** 全部供应商模板 */
export function providerTemplates(): ProviderConfigTemplate[] {
  return providerCatalog().templates
}

/** 推理强度档位并集 */
export function reasoningEffortUnion(): string[] {
  return providerCatalog().reasoningEffortUnion
}

/** 默认勾选的推理强度档位 */
export function defaultReasoningEffortList(): string[] {
  return providerCatalog().defaultReasoningEffortList
}

/** 档位在并集里的排序权重（未知值排到最后） */
function effortRank(val: string): number {
  const union = reasoningEffortUnion()
  const i = union.indexOf(val)
  return i === -1 ? union.length : i
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
