/** agent-service — Application 层 Agent 服务（系统提示词模板从外部 .md 导入，便于与文档同步）。 */
import { settingsState } from '@/ui/store'
import { agentRepo } from '@/infrastructure/agentRepo'
import type { Agent } from '@/types'
import { getEnvPrompt } from '@/services/env-service'
import { loadProjectRulesPrompt } from '@/services/project-rules-service'
import { loadMemorySection, touchMemories } from '@/infrastructure/memoryRepo'
import {
  DEFAULT_PROJECT_RULES_FILE,
  resolveProjectRulesFile,
} from '@/domain/agent/project-rules'
import { listRegisteredSkills } from '@/skill'
import { DEFAULT_AGENT_ID } from '@/ui/constants'
import { appName } from '@/ui/constants'
import { toolRegistry } from '@/domain/tools'
import { composeSystemPrompt } from '@/domain/agent/compose-prompt'
import type { SkillMetaLike } from '@/domain/agent/compose-prompt'

/**
 * 组装 Agent 系统提示词；建会话时调用，结果快照到 session.systemPrompt。
 */
export async function assembleAgentPrompt(
  agent: Agent,
  workingDir?: string,
): Promise<string> {
  // 生效工作目录：会话指定 > Agent 默认（与 session.workspace 的取值口径一致）
  const effectiveWorkspace = workingDir || agent.defaultWorkspace

  const envPrompt = settingsState.value.allowEnvPrompt
    ? await getEnvPrompt(effectiveWorkspace)
    : undefined

  // 项目规则 / 记忆文件（默认 AGENTS.md）：与工作目录强相关，紧跟环境信息之后。
  // 无工作目录时回退默认工作目录（与文件工具 cwd 口径一致），读不到就不注入。
  const projectRules = await loadProjectRulesPrompt(
    effectiveWorkspace || settingsState.value.defaultWorkspace,
    resolveProjectRulesFile(agent),
  )

  // 长期记忆（P0）：每个新会话注入「不限定项目 + 命中本次工作目录的项目记忆」（永久全量 + 普通 top20）。
  // 段文本由 Rust 侧唯一渲染；取不到就不注入。注入只在建会话那一刻：中途新增的记忆不影响已建会话
  // 的 systemPrompt（保 prompt cache 命中率），需要时靠工具召回（P1）。
  const memorySection = await loadMemorySection(false, effectiveWorkspace)
  // 计入「被使用」（hits 是 top20 的排序输入）；fire-and-forget，不阻塞建会话
  touchMemories(memorySection.ids)

  // 技能信息：只注入「该 Agent 已启用」的那些（skillMetaPreload 关闭时不注入）
  let skills: SkillMetaLike[] = []
  if (settingsState.value.skillMetaPreload && agent.skills?.length > 0) {
    skills = listRegisteredSkills()
      .filter((s) => agent.skills!.includes(s.meta.name))
      .map((s) => ({ name: s.meta.name, description: s.meta.description }))
  }

  // 顺序与分隔符由 domain 层固定：必须与 Rust 侧 prompts/assemble.rs 逐字节一致
  // （golden 测试 src/tests/domain/compose-prompt-golden.test.ts 守这条线）
  return composeSystemPrompt({
    envPrompt,
    projectRules,
    memory: memorySection.text,
    agentName: agent.name,
    agentDescription: agent.description,
    identity: agent.identity,
    personality: agent.personality,
    skills,
  })
}

// 默认 Agent 初始化

/**
 * 构建默认 Agent（含所有已注册工具）。无副作用；工具定义读取是异步的（来自权威源，机制 C）。
 */
async function _buildDefaultAgent(): Promise<Agent> {
  const allTools = (await toolRegistry.listDefinitions()).map((t) => t.name)
  return {
    id: DEFAULT_AGENT_ID,
    name: appName,
    description: '全能型 AI 助手，可以使用所有内置工具',
    personality: '',
    identity: '',
    defaultWorkspace: '',
    projectRulesFile: DEFAULT_PROJECT_RULES_FILE,
    defaultModel: {
      providerConfigId: '',
      modelId: '',
    },
    allowTools: allTools,
    skills: [],
    defaultParams: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * 启动时确保默认 Agent 存在，并把新增内置工具补入其白名单（须在 toolsInit() + toolRegistry.init() 之后）。
 * allowTools 是「首次创建时的快照」，这里只补入缺失工具（不删除、不覆盖用户选择）；自定义 Agent 不处理。
 */
export async function initDefaultAgent(): Promise<void> {
  const data = agentRepo.load()
  const allToolNames = (await toolRegistry.listDefinitions()).map((t) => t.name)
  const idx = data.agents.findIndex((a) => a.id === DEFAULT_AGENT_ID)

  if (idx === -1) {
    data.agents = [...data.agents, await _buildDefaultAgent()]
    agentRepo.save(data)
    return
  }

  const agent = data.agents[idx]
  const missing = allToolNames.filter((n) => !agent.allowTools.includes(n))
  if (missing.length === 0) return

  const agents = [...data.agents]
  agents[idx] = {
    ...agent,
    allowTools: [...agent.allowTools, ...missing],
    updatedAt: Date.now(),
  }
  data.agents = agents
  agentRepo.save(data)
}

/** 获取默认 Agent（纯查询）。必须在 initDefaultAgent() 之后调用。 */
export function getDefaultAgent(): Agent {
  const data = agentRepo.load()
  const agent = data.agents.find((a) => a.id === DEFAULT_AGENT_ID)
  if (!agent) {
    throw new Error('默认 Agent 不存在 — 请确保 initDefaultAgent() 已调用')
  }
  return agent
}
