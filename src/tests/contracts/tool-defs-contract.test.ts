/**
 * 工具契约一致性测试（机制 C）
 *
 * **权威源**：`src-tauri/virlen-core/src/agent/tool_defs/definitions.json`
 *   - Rust 侧 `agent::tool_defs` 用 `include_str!` 引用**同一份文件**
 *   - 前端：Tauri 走 `cmd_list_tool_definitions`；浏览器 dev / vitest 直读本文件
 *
 * 步骤 ④（摘除 TS 定义体）之后，`toolRegistry` 只剩执行器，因此这里守三条线：
 *   1. 契约本身完整（三平台各 28 个、schema 结构齐全、平台描述确实区分、不含 label）；
 *   2. **契约 ↔ 执行器一一对应**（契约里有定义就必须有执行器；注册了执行器就必须在契约里）；
 *   3. 前端真能取到契约（走 infrastructure 的真实适配器，而不是把 JSON 直接塞进去）。
 *
 * 第 2 条是 ④ 之前「TS 定义 vs 契约逐字比对」的接替者：定义体摘除后，
 * 唯一还可能出错的形态就是「两边名单不一致」。
 */
import { describe, expect, it, vi } from 'vitest'
import DEFINITIONS_RAW from '../../../src-tauri/virlen-core/src/agent/tool_defs/definitions.json?raw'
import {
  PLATFORM_KEYS,
  definitionsForPlatform,
  isUsableDefinitionsFile,
  type ToolDefinitionsFile,
} from '@/domain/tools/definitions'

const FILE = JSON.parse(DEFINITIONS_RAW) as ToolDefinitionsFile
const EXPECTED_TOOLS = 28

/** 用真实适配器（走内嵌契约分支）+ 真实 toolsInit 组装一个干净的注册中心 */
async function freshRegistry() {
  vi.resetModules()
  const { toolRegistry, setToolDefinitionsLoader } = await import('@/domain/tools')
  const { loadToolDefinitions } = await import(
    '@/infrastructure/tools/definitions-source'
  )
  setToolDefinitionsLoader(loadToolDefinitions)
  const { toolsInit } = await import('@/infrastructure/tools')
  await toolsInit()
  return toolRegistry
}

describe('工具契约（权威源结构）', () => {
  it('文件可用，且三平台各 28 个工具', () => {
    expect(isUsableDefinitionsFile(FILE)).toBe(true)
    for (const platform of PLATFORM_KEYS) {
      expect(FILE.variants[platform], `缺少平台 ${platform}`).toHaveLength(
        EXPECTED_TOOLS,
      )
    }
  })

  it('每个定义都有 name / description / object schema', () => {
    for (const platform of PLATFORM_KEYS) {
      for (const def of FILE.variants[platform]) {
        expect(def.name, '工具缺少 name').toBeTruthy()
        expect(def.description, `${def.name} 缺少 description`).toBeTruthy()
        expect(def.parameters?.type, `${def.name} 的 parameters.type`).toBe('object')
        expect(
          def.parameters?.properties,
          `${def.name} 缺少 parameters.properties`,
        ).toBeTruthy()
      }
    }
  })

  it('三平台工具集合一致，且平台相关描述确实不同', () => {
    const names = (p: string) =>
      definitionsForPlatform(FILE, p)
        .map((d) => d.name)
        .sort()
        .join(',')
    expect(names('windows')).toBe(names('linux'))
    expect(names('macos')).toBe(names('linux'))

    const desc = (p: string, name: string) =>
      definitionsForPlatform(FILE, p).find((d) => d.name === name)?.description
    expect(desc('windows', 'execute_command')).not.toBe(desc('linux', 'execute_command'))
  })

  it('契约不含 label（UI 文案属前端 i18n，进了契约会把英文界面顶成中文）', () => {
    for (const platform of PLATFORM_KEYS) {
      for (const def of FILE.variants[platform]) {
        expect(def.label, `${def.name} 不该带 label`).toBeUndefined()
      }
    }
  })
})

describe('契约 ↔ 执行器一一对应（真实适配器 + 真实 toolsInit）', () => {
  it('所有契约定义都有执行器，且没有多余执行器', async () => {
    const registry = await freshRegistry()

    // 走真实适配器：非 Tauri 环境下应能取到内嵌契约（并给出 28 个工具）
    const defs = await registry.listDefinitions()
    expect(defs).toHaveLength(EXPECTED_TOOLS)

    expect(await registry.missingExecutorNames()).toEqual([])
    expect(await registry.missingDefinitionNames()).toEqual([])
  })

  it('定义顺序以契约为准（相同平台两次读取顺序一致）', async () => {
    const registry = await freshRegistry()
    const first = (await registry.listDefinitions()).map((d) => d.name)
    const second = (await registry.listDefinitions()).map((d) => d.name)
    expect(first).toEqual(second)
    // 至少包含几个关键工具，防止契约文件被误清空后仍「长度对得上」
    expect(first).toContain('read_file')
    expect(first).toContain('execute_command')
    expect(first).toContain('todo_write')
  })

  it('label 来自注册（i18n），且每个工具都有', async () => {
    const registry = await freshRegistry()
    const defs = await registry.listDefinitions()
    for (const def of defs) {
      expect(def.label, `${def.name} 缺少 label（注册时应传 i18n 文案）`).toBeTruthy()
    }
  })
})
