/**
 * compose-prompt — 系统提示词的纯组装策略（无 I/O，可被固定输入逐字节断言）。
 *
 * 存在意义：Rust `prompts/assemble.rs` 要组装**同一份**提示词并得到逐字节相同的结果，
 * 本函数即 TS 侧的被比对对象（见 `tests/domain/compose-prompt-golden.test.ts`）。
 *
 * ⚠️ 两个 md（工具规范 / 核心原则）的权威源在 Rust `prompts/*.md`：前端经 `promptText()` 读快照，
 * 本模块只管组装顺序与分隔符，不持有文本副本。
 */
import { promptText } from './prompt-texts'

/** 技能元信息（只取注入提示词需要的两项） */
export interface SkillMetaLike {
  name: string
  description: string
}

/** 组装输入（全部来自调用方，本模块不读取任何状态） */
export interface SystemPromptParts {
  /** 环境信息片段；`undefined` 表示不注入（对应 `settings.allowEnvPrompt` 关闭） */
  envPrompt?: string
  /** 项目规则片段（`buildProjectRulesPrompt` 的产物）；空串/undefined 表示不注入 */
  projectRules?: string
  /** 长期记忆片段（`# Memory`），由 Rust `agent::memory::render_memory_section` 渲染好传入；前端不复制选取规则（见 `docs/memory-plan.md` §4.5） */
  memory?: string
  agentName?: string
  agentDescription?: string
  identity?: string
  personality?: string
  /** 已按 Agent 白名单过滤后的技能；空数组表示不注入 */
  skills?: SkillMetaLike[]
}

/** 基础提示词：工具调用规范 + 核心原则（与 Rust `prompts::base_system_prompt` 对应） */
export function baseSystemPrompt(): string {
  return `${promptText('toolCallSpec')}\n\n${promptText('corePrinciples')}`
}

/**
 * 按固定顺序拼接：基础规范 → 环境 → 项目规则 → 记忆 → 角色/身份/性格 → 技能。
 * 顺序即优先级；片段间空行分隔，技能段内部单换行。
 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  const out: string[] = [baseSystemPrompt()]

  // `undefined` = 不注入；空串 = 注入了但内容为空（与旧行为一致）
  if (parts.envPrompt !== undefined) out.push(parts.envPrompt)
  if (parts.projectRules) out.push(parts.projectRules)
  // 记忆优先级低于项目规则（后者是用户手写的本项目约定）
  if (parts.memory) out.push(parts.memory)

  const name = parts.agentName ?? ''
  const description = parts.agentDescription ?? ''
  if (name || description) {
    out.push(`# Role\nYou are ${name}${description ? ', ' + description : ''}`)
  }
  if (parts.identity) out.push(`# Identity\n${parts.identity}`)
  if (parts.personality) out.push(`# Personality\n${parts.personality}`)

  const skills = parts.skills ?? []
  if (skills.length > 0) {
    const lines: string[] = ['# Enabled Skills', '']
    for (const skill of skills) {
      lines.push(`## ${skill.name}`)
      lines.push(skill.description)
      lines.push('')
    }
    lines.push('You can use the following tools to inspect and manage skills:')
    lines.push('- `read_skill_source`: show the source-code directory structure of a skill and the full text of its SKILL.md')
    lines.push('')
    out.push(lines.join('\n'))
  }

  return out.join('\n\n')
}
