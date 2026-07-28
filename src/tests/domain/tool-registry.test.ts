/**
 * ToolRegistry 测试 — 工具注册中心
 *
 * 覆盖场景：
 * - register 注册工具
 * - get 获取已注册的工具
 * - unregister 注销工具
 * - listDefinitions 列出所有定义
 * - listAll 列出所有注册的工具
 * - has 检查工具是否存在
 * - clear 清空所有工具
 * - 重复注册覆盖旧工具
 * - 注销不存在的工具返回 false
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistryImpl } from '@/domain/tools'
import type { ToolDefinition, ToolExecutor } from '@/domain/tools/types'

describe('ToolRegistryImpl', () => {
  let registry: ToolRegistryImpl

  const makeDef = (name: string): ToolDefinition => ({
    name,
    description: `Tool ${name}`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  })

  const makeExecutor = (): ToolExecutor =>
    vi.fn(async () => 'executed')

  beforeEach(() => {
    registry = new ToolRegistryImpl()
  })

  it('register 应注册工具', async () => {
    const def = makeDef('read_file')
    const exec = makeExecutor()
    await registry.register(def, exec)

    const tool = await registry.get('read_file')
    expect(tool).toBeDefined()
    expect(tool!.definition.name).toBe('read_file')
    expect(tool!.executor).toBe(exec)
  })

  it('重复注册应覆盖旧工具', async () => {
    const def1 = makeDef('test_tool')
    const exec1 = makeExecutor()
    await registry.register(def1, exec1)

    const def2: ToolDefinition = {
      ...def1,
      description: 'Updated description',
    }
    const exec2 = makeExecutor()
    await registry.register(def2, exec2)

    const tool = await registry.get('test_tool')
    expect(tool!.definition.description).toBe('Updated description')
    expect(tool!.executor).toBe(exec2)
  })

  it('get 不存在的工具应返回 undefined', async () => {
    const tool = await registry.get('nonexistent')
    expect(tool).toBeUndefined()
  })

  it('unregister 应注销工具', async () => {
    await registry.register(makeDef('temp_tool'), makeExecutor())
    const removed = await registry.unregister('temp_tool')
    expect(removed).toBe(true)

    const tool = await registry.get('temp_tool')
    expect(tool).toBeUndefined()
  })

  it('unregister 不存在的工具应返回 false', async () => {
    const removed = await registry.unregister('nonexistent')
    expect(removed).toBe(false)
  })

  it('listDefinitions 应返回所有工具定义列表', async () => {
    await registry.register(makeDef('tool_a'), makeExecutor())
    await registry.register(makeDef('tool_b'), makeExecutor())

    const defs = registry.listDefinitions()
    expect(defs).toHaveLength(2)
    expect(defs.map((d) => d.name).sort()).toEqual(['tool_a', 'tool_b'])
  })

  it('空注册表 listDefinitions 应返回空数组', () => {
    const defs = registry.listDefinitions()
    expect(defs).toHaveLength(0)
  })

  it('listAll 应返回所有注册的工具', async () => {
    await registry.register(makeDef('tool_a'), makeExecutor())
    await registry.register(makeDef('tool_b'), makeExecutor())

    const all = await registry.listAll()
    expect(all).toHaveLength(2)
    expect(all.every((t) => 'definition' in t && 'executor' in t)).toBe(true)
  })

  it('has 应正确检测工具是否存在', async () => {
    expect(await registry.has('exists')).toBe(false)

    await registry.register(makeDef('exists'), makeExecutor())
    expect(await registry.has('exists')).toBe(true)
  })

  it('clear 应清空所有工具', async () => {
    await registry.register(makeDef('tool_a'), makeExecutor())
    await registry.register(makeDef('tool_b'), makeExecutor())
    expect(registry.listDefinitions()).toHaveLength(2)

    await registry.clear()
    expect(registry.listDefinitions()).toHaveLength(0)
  })
})
