/** agent-service — Application 层 Agent 服务（系统提示词模板从外部 .md 导入，便于与文档同步）。 */
import { settingsState } from '@/ui/store'
import { agentRepo } from '@/infrastructure/agentRepo'
import type { Agent } from '@/types'
import { getEnvPrompt } from '@/services/env-service'
import { loadProjectRulesPrompt } from '@/services/project-rules-service'
import { loadMemorySection, touchMemories } from '@/infrastructure/memoryRepo'
import { mcpRepo } from '@/infrastructure/mcp/repo'
import { parseMcpToolName } from '@/domain/mcp/naming'
import {
  DEFAULT_PROJECT_RULES_FILE,
  resolveProjectRulesFile,
} from '@/domain/agent/project-rules'
import { listRegisteredSkills } from '@/skill'
import { DEFAULT_AGENT_ID } from '@/ui/constants'
import { appName } from '@/ui/constants'
import { toolRegistry } from '@/domain/tools'
import { filterAllowedToolDefs } from '@/domain/tools/allowed'
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

  // MCP 服务器说明书：只收「已就绪 + 开了 injectInstructions + **该 Agent 白名单里确实有它的工具**」
  // 的服务器，Rust 侧拼好带归属前缀。
  // 范围必须与「工具实际下发」（`filterAllowedToolDefs`，唯一实现）同口径：白名单把某台服务器的
  // 工具全摘掉后，注入它的说明书只会教模型用一批它完全看不到的工具
  //（真实事故：默认 Agent 0 个 MCP 工具，说明书照旧整段注入，见 §11.70）。
  // 归属取自定义的 `mcpServer`（Rust 随定义下发）：工具名里已经没有服务器名，不能靠拆名字。
  const mcpServers =
    agent.allowTools === undefined
      ? null
      : [
          ...new Set(
            filterAllowedToolDefs(
              await toolRegistry.listDefinitions(),
              agent.allowTools,
            )
              .filter((def) => def.origin === 'mcp' && !!def.mcpServer)
              .map((def) => def.mcpServer as string),
          ),
        ]
  // 与记忆同理 —— 只在建会话那一刻取一次，中途改配置不影响已建会话的 systemPrompt。
  const mcpInstructions = await mcpRepo.instructions(mcpServers)

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
    mcpInstructions,
  })
}

// 默认 Agent 初始化

/**
 * 构建默认 Agent（含**当时**所有已注册工具）。无副作用；工具定义读取是异步的（来自权威源，机制 C）。
 *
 * 这份快照会被永久保留（[`initDefaultAgent`] 不再补全），所以它只在「默认 Agent 不存在」时跑一次：
 * 早装机的用户可能看到已连上的 MCP 工具，晚装机的看不到 —— 之后一律由用户在编辑器里勾选。
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
 * 启动时确保默认 Agent 存在（须在 toolsInit() + toolRegistry.init() 之后）。
 *
 * ⚠️ **只建、不补**：不存在就按「当时可用的全部工具」建一份快照；已存在则一个字都不动。
 * 以前每次 `mcp:changed` 都把缺失的工具名补回白名单，于是用户在默认 Agent 里取消勾选的
 * MCP 工具会被反复加回来（界面的意图与用户的意图打架）。白名单此后**只由用户在编辑器里决定**。
 */
export async function initDefaultAgent(): Promise<void> {
  const data = agentRepo.load()
  if (data.agents.some((a) => a.id === DEFAULT_AGENT_ID)) return
  data.agents = [...data.agents, await _buildDefaultAgent()]
  agentRepo.save(data)
}

/** 一次工具改名：`from` = 旧公开名，`to` = 新公开名 */
export interface ToolRename {
  from: string
  to: string
}

/**
 * 把 Agent 白名单里的旧工具名换成新工具名（用户给 MCP 工具改公开名后调用；返回改写的 Agent 数）。
 *
 * 为什么必须迁：`allowTools` 存的是**公开名**，改名后旧名字就是幽灵条目 —— 工具还在服务器上，
 * 却因为名字对不上被 `filterAllowedToolDefs` 求交掉（§11.69 的事故就是这么来的）。
 * 历史会话里的旧卡片不在此列（消息已落库，只能按旧名展示或退回通用卡片）。
 *
 * 幂等：换完再调一次没有任何匹配，不写库、不刷 `updatedAt`。
 */
export function migrateAgentToolNames(renames: readonly ToolRename[]): number {
  const mapping = new Map(
    renames.filter((item) => item.from !== item.to).map((item) => [item.from, item.to]),
  )
  if (mapping.size === 0) return 0
  const data = agentRepo.load()
  let migrated = 0
  const agents = data.agents.map((agent) => {
    // 换完可能撞名（旧名 A → B，而 B 本来就在名单里）：保序去重
    const next = [...new Set(agent.allowTools.map((name) => mapping.get(name) ?? name))]
    const unchanged =
      next.length === agent.allowTools.length &&
      next.every((name, index) => name === agent.allowTools[index])
    if (unchanged) return agent
    migrated += 1
    return { ...agent, allowTools: next, updatedAt: Date.now() }
  })
  if (migrated > 0) agentRepo.save({ ...data, agents })
  return migrated
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

/**
 * 一次性迁移：旧白名单里的 `mcp__<server>__<raw>` → 裸工具名（返回改写的 Agent 数）。
 *
 * 旧公开名把服务器名编进了名字，改一次服务器名就让所有 Agent 的白名单失效（§11.69 的事故）。
 * 现在工具名与服务器无关，旧条目只剩「剥掉前缀」这一条路，而且剥离后就是新名字。
 * 幂等：没有旧名前缀时一条都不写（不刷 `updatedAt`）。带哈希后缀的旧条目剥出来仍是错的，
 * 留给编辑器里的「已失效 + 清理」处理。
 */
export function migrateLegacyMcpToolNames(): number {
  const data = agentRepo.load()
  let migrated = 0
  const agents = data.agents.map((agent) => {
    const stripped = agent.allowTools.map((name) => parseMcpToolName(name)?.raw ?? name)
    // 剥离后可能撞名（`mcp__a__x` 与 `x` 并存）：保序去重
    const next = [...new Set(stripped)]
    const unchanged =
      next.length === agent.allowTools.length &&
      next.every((name, index) => name === agent.allowTools[index])
    if (unchanged) return agent
    migrated += 1
    return { ...agent, allowTools: next, updatedAt: Date.now() }
  })
  if (migrated > 0) agentRepo.save({ ...data, agents })
  return migrated
}
