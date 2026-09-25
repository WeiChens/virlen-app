/**
 * compose-prompt — 系统提示词「纯组装」策略
 *
 * 只做一件事：把各来源的提示词片段按固定顺序拼成一个字符串。
 * **不做任何 I/O**（取数在 `services/agent-service.ts` + `env-service` + `project-rules-service`），
 * 因此可以被固定输入驱动、逐字节断言。
 *
 * 为什么单独抽成文件：
 * Rust 引擎侧要组装**同一份**提示词（`src-tauri/src/agent/prompts/assemble.rs`，
 * 为 headless / CLI 做前置）。两侧用同一组输入必须得到逐字节相同的结果 ——
 * 这个函数就是 TS 侧的被比对对象，见 `src/tests/domain/compose-prompt-golden.test.ts`
 * 与 Rust 侧 `prompts::assemble::tests::golden_system_prompt_matches_fixture`。
 *
 * ⚠️ 两个 md 资源是本项目提示词的**唯一事实源**，Rust 侧用 `include_str!` 直接引用
 * 同一路径，不允许在任何一侧复制副本。
 */
import TOOL_CALL_SPEC from './prompts/tool-call-spec.md?raw'
import CORE_PRINCIPLES from './prompts/core-principles.md?raw'

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
  return `${TOOL_CALL_SPEC}\n\n${CORE_PRINCIPLES}`
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
