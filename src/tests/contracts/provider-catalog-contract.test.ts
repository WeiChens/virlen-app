/**
 * 供应商目录契约一致性测试（与提示词 / 工具定义「机制 C」同一模式）
 *
 * **权威源**：`src-tauri/virlen-core/src/agent/provider/provider_catalog.json`
 *   - Rust 侧 `agent::provider::catalog` 用 `include_str!` 内嵌（`virlen-cli` 与
 *     Tauri 命令 `cmd_provider_catalog` 都取它）
 *   - 前端：Tauri 走 `cmd_provider_catalog`；浏览器 dev / vitest 直读同一份 json
 *     （`infrastructure/provider/catalog-source.ts`）
 *
 * 守三条线：
 *   1. 目录结构齐备（并集 / 默认勾选 / 模板），且关键数据没丢；
 *   2. 适配器给出的内嵌目录 == 权威源文件本身（**不存在第二份副本**）；
 *   3. `providerCatalog()` 的 fail-fast 语义：未水合时抛错，水合后同步可读。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import CATALOG_SOURCE from '../../../src-tauri/virlen-core/src/agent/provider/provider_catalog.json?raw'
import {
  hasProviderCatalog,
  providerCatalog,
  providerTemplates,
  reasoningEffortUnion,
  setProviderCatalog,
} from '@/domain/provider/catalog'
import {
  embeddedProviderCatalog,
  loadProviderCatalog,
} from '@/infrastructure/provider/catalog-source'

/** 权威源（直接读 core 目录里的同一份文件） */
const SOURCE = JSON.parse(CATALOG_SOURCE)

describe('供应商目录契约（权威源在 virlen-core）', () => {
  it('目录结构齐备', () => {
    expect(SOURCE.reasoningEffortUnion.length).toBe(8)
    expect(SOURCE.defaultReasoningEffortList).toEqual(['low', 'medium', 'high'])
    expect(SOURCE.templates.length).toBeGreaterThanOrEqual(7)
  })

  it('关键标记没丢（DeepSeek 多协议 / 自定义模板 / 官网链接）', () => {
    const byName = (n: string) =>
      SOURCE.templates.find((t: any) => t.templateName === n)
    expect(byName('deepseek').allowTypeList).toHaveLength(2)
    expect(byName('deepseek').officialLink).toBe('https://platform.deepseek.com')
    expect(byName('custom').baseUrl).toBe('')
    expect(byName('gemini').allowReasoningEffortList).toBeUndefined()
  })

  it('适配器给出的内嵌目录就是权威源本身（不存在第二份副本）', () => {
    expect(embeddedProviderCatalog()).toEqual(SOURCE)
  })

  it('非 Tauri 环境下加载器回退到内嵌目录', async () => {
    await expect(loadProviderCatalog()).resolves.toEqual(SOURCE)
  })
})

describe('providerCatalog 的 fail-fast 语义', () => {
  // 每个用例后恢复 setup.ts 的水合，避免污染同文件内后续用例
  afterEach(() => {
    setProviderCatalog(embeddedProviderCatalog())
  })

  it('未水合时抛错，而不是静默返回空模板表', () => {
    setProviderCatalog(null)
    expect(hasProviderCatalog()).toBe(false)
    expect(() => providerCatalog()).toThrow(/未水合/)
    expect(() => providerTemplates()).toThrow(/未水合/)
    expect(() => reasoningEffortUnion()).toThrow(/未水合/)
  })

  it('水合后同步可读', () => {
    setProviderCatalog(SOURCE)
    expect(hasProviderCatalog()).toBe(true)
    expect(providerTemplates()).toEqual(SOURCE.templates)
    expect(reasoningEffortUnion()).toEqual(SOURCE.reasoningEffortUnion)
  })
})

/**
 * 启动顺序契约：**模块顶层不得读快照**（2026-09-26 真踩到的启动级 bug）
 *
 * 快照是「启动水合 + 同步读」：水合发生在 `main.ts` 的 `init()` 里，而 UI 模块经
 * `App.tsx` **静态导入** —— ES 模块求值**先于** `main()`。谁在模块顶层读快照，谁就在
 * 水合之前 fail-fast 抛错；更糟的是这会让整个依赖图求值失败，`main()` 根本不执行，
 * 窗口（`visible: false`，只在 `requestAnimationFrame` 里 `show()`）永不显示。
 *
 * `tests/setup.ts` 的全局水合会把这一刻盖住，所以这里用 `vi.resetModules()` 拿一份
 * **从未水合过**的全新模块图来复现，并先向内校验它确实未水合（否则用例会真空通过）。
 */
describe('启动顺序契约：目录未水合时 UI 模块仍可导入', () => {
  // `vi.resetModules()` 只影响此后动态导入的模块图；本文件外层静态导入的那些实例
  // 仍是 setup.ts 水合过的，所以这个用例不会污染同文件的其他用例。
  it('setupFlow 不得在模块顶层读快照', async () => {
    vi.resetModules()

    // 前置校验（防止用例真空通过）：这份全新模块图确实未水合
    const freshCatalog = await import('@/domain/provider/catalog')
    expect(freshCatalog.hasProviderCatalog()).toBe(false)
    const freshService = await import('@/services/provider-service')
    expect(() => freshService.providerService.getDefaultProviderList()).toThrow(
      /未水合/,
    )

    // 正题：未水合时导入 UI 模块不得抛错
    await expect(import('@/ui/pages/setupFlow')).resolves.toBeDefined()
  })
})
