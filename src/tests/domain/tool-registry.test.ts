/**
 * ToolRegistry 测试（机制 C：定义来自权威源，前端只注册执行器）
 *
 * 覆盖：
 * - 注册 / 注销 / 清空，以及 UI 文案（label）的补齐
 * - `listDefinitions` = **契约 ∩ 执行器**，顺序以契约为准
 * - 诊断接口：契约缺执行器 / 执行器缺契约
 * - 定义缓存：只载入一次；`invalidateDefinitions` 后可重新载入
 * - 未注入加载器时报**可操作**的错误（而不是静默返回空表）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ToolRegistryImpl,
  setToolDefinitionsLoader,
} from '@/domain/tools'
import type { ResolvedToolDefinition, ToolExecutor } from '@/domain/tools/types'

const executor: ToolExecutor = async () => 'ok'

/** 假契约：顺序为 alpha → beta → gamma（listDefinitions 必须按这个顺序返回） */
const contract: ResolvedToolDefinition[] = [
  {
    name: 'alpha',
    description: 'A',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'beta',
    description: 'B',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'gamma',
    description: 'G',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]

function injectContract(defs: ResolvedToolDefinition[] = contract) {
  const loader = vi.fn(async () => defs)
  setToolDefinitionsLoader(loader)
  return loader
}

describe('ToolRegistryImpl（机制 C）', () => {
  let registry: ToolRegistryImpl

  beforeEach(() => {
    registry = new ToolRegistryImpl()
    injectContract()
  })

  it('listDefinitions 只返回「契约 ∩ 已注册执行器」，且顺序以契约为准', async () => {
    await registry.register('gamma', executor)
    await registry.register('alpha', executor)

    const defs = await registry.listDefinitions()
    expect(defs.map((d) => d.name)).toEqual(['alpha', 'gamma']) // beta 没有执行器 → 不出现
  })

  it('label 由注册提供（契约里没有 label，UI 文案不进契约）', async () => {
    await registry.register('alpha', executor, '阿尔法')
    await registry.register('beta', executor)

    const defs = await registry.listDefinitions()
    expect(defs[0].label).toBe('阿尔法')
    expect(defs[1].label).toBeUndefined()
  })

  it('get 需要定义与执行器同时存在', async () => {
    await registry.register('alpha', executor, '阿尔法')

    const found = await registry.get('alpha')
    expect(found?.definition.name).toBe('alpha')
    expect(found?.definition.label).toBe('阿尔法')
    expect(found?.executor).toBe(executor)
    // beta 在契约里但没有执行器 → undefined
    expect(await registry.get('beta')).toBeUndefined()
  })

  it('listAll 返回契约顺序的 定义+执行器 组合', async () => {
    await registry.register('beta', executor)
    await registry.register('gamma', executor)

    const all = await registry.listAll()
    expect(all.map((t) => t.definition.name)).toEqual(['beta', 'gamma'])
  })

  it('诊断：契约缺执行器 / 执行器缺契约', async () => {
    await registry.register('alpha', executor)
    await registry.register('ghost', executor)

    expect(await registry.missingExecutorNames()).toEqual(['beta', 'gamma'])
    expect(await registry.missingDefinitionNames()).toEqual(['ghost'])
  })

  it('unregister / has / clear', async () => {
    await registry.register('alpha', executor)
    expect(await registry.has('alpha')).toBe(true)

    expect(await registry.unregister('alpha')).toBe(true)
    expect(await registry.has('alpha')).toBe(false)
    expect(await registry.listDefinitions()).toHaveLength(0)

    await registry.register('beta', executor)
    await registry.clear()
    expect(await registry.listDefinitions()).toHaveLength(0)
  })

  it('定义只载入一次（缓存），invalidateDefinitions 后可重新载入', async () => {
    const loader = injectContract()
    await registry.listDefinitions()
    await registry.listDefinitions()
    expect(loader).toHaveBeenCalledTimes(1)

    registry.invalidateDefinitions()
    await registry.listDefinitions()
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('未注入加载器时给出可操作的报错', async () => {
    setToolDefinitionsLoader(null)
    await expect(registry.listDefinitions()).rejects.toThrow(/加载器未注入/)
  })
})
