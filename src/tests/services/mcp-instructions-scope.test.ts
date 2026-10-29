/**
 * 系统提示词里 MCP 说明书的**注入范围**（`assembleAgentPrompt` 的那条接缝）
 *
 * 事故：默认 Agent 的「工具选择」里一个 MCP 工具都没勾（白名单只剩内置 39 个），
 * 提示词却仍整段注入 blender 服务器说明书 —— 因为这里当年无条件调 `mcpRepo.instructions()`，
 * 与「工具实际下发」（`filterAllowedToolDefs`）是两套互不相干的判定。
 *
 * 这里只钉一件事：**传给 Rust 的服务器名单必须由 Agent 白名单折算**，
 * 三态（`undefined` / `[]` / 有名字）与工具下发逐条对齐。
 *
 * 依赖链按需 mock：真实 `env-service` / `project-rules-service` / 记忆 / 技能都要 I/O，
 * 与本测试的主题无关；被 mock 的模块都不参与「谁该被注入」的判定。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/types'

const mocks = vi.hoisted(() => ({
  instructions: vi.fn(
    async (_servers?: string[] | null): Promise<string | null> => null,
  ),
}))

vi.mock('@/infrastructure/mcp/repo', () => ({
  mcpRepo: { instructions: mocks.instructions },
}))
vi.mock('@/services/env-service', () => ({
  getEnvPrompt: async (): Promise<string | undefined> => undefined,
}))
vi.mock('@/services/project-rules-service', () => ({
  loadProjectRulesPrompt: async (): Promise<string | undefined> => undefined,
}))
vi.mock('@/infrastructure/memoryRepo', () => ({
  loadMemorySection: async (): Promise<{ text: string; ids: string[] }> => ({
    text: '',
    ids: [],
  }),
  touchMemories: (): void => {},
}))
vi.mock('@/skill', () => ({ listRegisteredSkills: (): never[] => [] }))

const { assembleAgentPrompt } = await import('@/services/agent-service')

function agentWith(allowTools: string[] | undefined): Agent {
  return {
    id: 'test',
    name: '测试助手',
    description: '',
    personality: '',
    identity: '',
    defaultWorkspace: '',
    projectRulesFile: 'AGENTS.md',
    defaultModel: { providerConfigId: '', modelId: '' },
    // `undefined` 是「没有白名单 = 全部工具」的老数据形态（类型上是 string[]）
    allowTools: allowTools as string[],
    skills: [],
    defaultParams: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('assembleAgentPrompt · MCP 说明书注入范围', () => {
  it('白名单里没有任何 MCP 工具 → 传空名单（一个都不注）', async () => {
    mocks.instructions.mockClear()
    await assembleAgentPrompt(agentWith(['read_file', 'execute_command']))
    expect(mocks.instructions).toHaveBeenCalledWith([])
  })

  it('白名单里有某台服务器的工具 → 只传这台（去重、丢内置名）', async () => {
    mocks.instructions.mockClear()
    await assembleAgentPrompt(
      agentWith(['read_file', 'mcp__blender__look', 'mcp__blender__get_scene_info']),
    )
    expect(mocks.instructions).toHaveBeenCalledWith(['blender'])
  })

  it('没有白名单（undefined = 全部工具）→ null（不过滤）', async () => {
    mocks.instructions.mockClear()
    await assembleAgentPrompt(agentWith(undefined))
    expect(mocks.instructions).toHaveBeenCalledWith(null)
  })

  it('Rust 返回的说明书进系统提示词，返回 null 时不出现该段', async () => {
    mocks.instructions.mockReturnValueOnce(Promise.resolve('# MCP Server Instructions\n\nx'))
    const withMcp = await assembleAgentPrompt(agentWith(['mcp__blender__look']))
    expect(withMcp).toContain('# MCP Server Instructions')

    mocks.instructions.mockReturnValueOnce(Promise.resolve(null))
    const withoutMcp = await assembleAgentPrompt(agentWith(['read_file']))
    expect(withoutMcp).not.toContain('# MCP Server Instructions')
  })
})
