/**
 * list_skills — 查看当前代理拥有的所有技能
 *
 * 只读操作，不提供写能力。
 *
 * ⚠️ 模型侧固定英文（与 Rust 原生实现 / CLI 一致，铁律 1）；UI 侧下发结构化 `uiData.skills`
 * （语言无关），由组件按 UI 语言渲染（`tool-call/ListSkillsMessage`）。
 *
 * ⚠️ 已原生化（Step 2）：Rust 引擎走 `native_tools/skill/list_skills.rs`（默认路径），
 * 本文件是回退路径。元信息解析 / 扫盘逻辑在 `src/skill/*` + `src/utils/mdYamlFrontmatter.ts` ↔
 * `native_tools/skill/common.rs` 两份镜像，改一边必须同步另一边（铁律 1）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'

/** 单个技能交给 UI 的最小结构化信息（语言无关，供组件本地化渲染） */
export interface SkillBrief {
  name: string
  description?: string
  version?: string
  tags?: string[]
}

toolRegistry.register(
    'list_skills',
    (async (_args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const skillNames = ctx.skills || []

    const empty = (): ToolResult => ({
      content: 'No skills are currently enabled for this agent.',
      uiData: { skills: [] as SkillBrief[] },
    })

    if (skillNames.length === 0) return empty()

    try {
      const { listRegisteredSkills } = await import('@/skill')
      const allSkills = listRegisteredSkills()

      // 只返回当前 agent 拥有的技能
      const agentSkills = allSkills.filter((s) =>
        skillNames.includes(s.meta.name),
      )

      // 技能已注册但未启用的情况
      if (agentSkills.length === 0) return empty()

      const skills: SkillBrief[] = agentSkills.map((s) => ({
        name: s.meta.name,
        description: s.meta.description,
        version: s.meta.version,
        tags: s.meta.tags,
      }))

      const lines: string[] = [`Enabled skills (${skills.length})`, '']
      for (const s of skills) {
        lines.push(`  📌 **${s.name}**`)
        if (s.description) lines.push(`     ${s.description}`)
        if (s.version) lines.push(`     Version: ${s.version}`)
        if (s.tags?.length) lines.push(`     Tags: ${s.tags.join(', ')}`)
        lines.push('')
      }
      lines.push("💡 Use `read_skill_source` to inspect a skill's source code.")

      return { content: lines.join('\n'), uiData: { skills } }
    } catch (e: any) {
      return {
        content: `Failed to list skills: ${e.message || String(e)}`,
        uiData: { skills: [] as SkillBrief[] },
      }
    }
  }) as ToolExecutor,
    t('查看技能列表'),
)
