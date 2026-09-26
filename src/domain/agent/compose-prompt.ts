/**
 * compose-prompt — 系统提示词「纯组装」策略
 *
 * 只做一件事：把各来源的片段按固定顺序拼成一个字符串。**不做任何 I/O**（取数在 `agent-service.ts` +
 * `env-service` + `project-rules-service`），因此可以被固定输入驱动、逐字节断言。
 *
 * 抽成独立文件的原因：Rust 侧要组装**同一份**提示词（`virlen-core/src/agent/prompts/assemble.rs`），
 * 两侧用同一组输入必须得到逐字节相同的结果 —— 本函数就是 TS 侧的被比对对象，见
 * `src/tests/domain/compose-prompt-golden.test.ts`。
 *
 * ⚠️ 两个 md 资源（工具规范 / 核心原则）的唯一事实源在 Rust `virlen-core/src/agent/prompts/*.md`：
 * 前端经 `promptText()` 读已水合的快照。本模块只负责组装顺序与分隔符，不持有文本副本。
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
 * 按固定顺序拼接系统提示词。
 *
 * 顺序即优先级：基础规范 → 环境 → 项目规则 → 角色/身份/性格 → 技能。
 * 片段之间用空行分隔；技能段内部用单换行（末尾保留一个换行）。
 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  const out: string[] = [baseSystemPrompt()]

  // 注意：`undefined` 才代表「不注入」；空串是「注入了但内容为空」（与旧行为一致）
  if (parts.envPrompt !== undefined) out.push(parts.envPrompt)
  if (parts.projectRules) out.push(parts.projectRules)

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
