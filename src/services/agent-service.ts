/**
 * agent-service — Application 层 Agent 服务
 *
 * 包含 Agent 相关的业务流程。
 * 系统提示词模板从外部 .md 文件导入，便于与文档同步维护。
 */
import { settingsState } from '@/ui/store'
import { agentRepo } from '@/infrastructure/agentRepo'
import type { Agent } from '@/types'
import { getEnvPrompt } from '@/services/env-service'
import { listRegisteredSkills } from '@/skill'
import { DEFAULT_AGENT_ID } from '@/ui/constants'
import { appName } from '@/ui/constants'
import { toolRegistry } from '@/domain/tools'
import {
  AI_AGENT_PRINCIPLE_PROMPT,
  AI_AGENT_TOOL_USE_PROMPT,
} from '@/domain/agent'

const baseSystemPrompt = `${AI_AGENT_TOOL_USE_PROMPT}\n\n${AI_AGENT_PRINCIPLE_PROMPT}`

/**
 * 组装 Agent 系统提示词
 * 在创建会话时调用，结果快照到 session.systemPrompt
 */
export async function assembleAgentPrompt(
  agent: Agent,
  workingDir?: string,
): Promise<string> {
  const parts: string[] = [baseSystemPrompt]
  if (settingsState.value.allowEnvPrompt) {
    const envInfo = await getEnvPrompt(workingDir || agent.defaultWorkspace)
    parts.push(envInfo)
  }
  if (agent.name || agent.description) {
    parts.push(
      `# 角色\n你是 ${agent.name}${agent.description ? '，' + agent.description : ''}`,
    )
  }
  if (agent.identity) {
    parts.push(`# 身份设定\n${agent.identity}`)
  }
  if (agent.personality) {
    parts.push(`# 性格\n${agent.personality}`)
  }

  // 注入技能信息
  if (settingsState.value.skillMetaPreload && agent.skills?.length > 0) {
    const allSkills = listRegisteredSkills()
    const agentSkills = allSkills.filter((s) =>
      agent.skills!.includes(s.meta.name),
    )
    if (agentSkills.length > 0) {
      const skillLines: string[] = ['# 已启用的技能', '']
      for (const skill of agentSkills) {
        skillLines.push(`## ${skill.meta.name}`)
        skillLines.push(skill.meta.description)
        skillLines.push('')
      }
      skillLines.push(
        '你可以使用以下工具查看和管理技能：',
        '- `read_skill_source`：查看某个技能的源代码目录结构和 SKILL.md 全文',
        '',
      )
      parts.push(skillLines.join('\n'))
    }
  }

  // console.log(parts.join('\n\n'))
  return parts.join('\n\n')
}

// ==================== 默认 Agent 初始化 ====================

/**
 * 构建默认 Agent（所有已注册工具）
 * 纯函数，无副作用
 */
function _buildDefaultAgent(): Agent {
  const allTools = toolRegistry.listDefinitions().map((t) => t.name)
  return {
    id: DEFAULT_AGENT_ID,
    name: appName,
    description: '全能型 AI 助手，可以使用所有内置工具',
    personality: '',
    identity: '',
    defaultWorkspace: '',
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
 * 应用启动时调用：确保默认 Agent 存在
 * 必须在 toolsInit() 之后调用（依赖 toolRegistry.listDefinitions()）
 */
export function initDefaultAgent(): void {
  const data = agentRepo.load()
  const exists = data.agents.some((a) => a.id === DEFAULT_AGENT_ID)
  if (!exists) {
    const agent = _buildDefaultAgent()
    data.agents = [...data.agents, agent]
    agentRepo.save(data)
  }
}

/**
 * 获取默认 Agent
 * 纯查询，无副作用。必须在 initDefaultAgent() 之后调用。
 */
export function getDefaultAgent(): Agent {
  const data = agentRepo.load()
  const agent = data.agents.find((a) => a.id === DEFAULT_AGENT_ID)
  if (!agent) {
    throw new Error('默认 Agent 不存在 — 请确保 initDefaultAgent() 已调用')
  }
  return agent
}
