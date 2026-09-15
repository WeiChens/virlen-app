/**
 * list_skills — 查看当前代理拥有的所有技能
 *
 * ⚠️ 只读操作，不提供写能力。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor } from '@/domain/tools/types'

toolRegistry.register(
  {
    name: 'list_skills',
    label: '查看技能列表',
    description:
      '查看当前代理拥有的所有技能。返回技能名称和描述列表，让你了解自己可以使用的技能。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  (async (_args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    const skillNames = ctx.skills || []

    if (skillNames.length === 0) {
      return '当前没有启用的技能。'
    }

    try {
      const { listRegisteredSkills } = await import('@/skill')
      const allSkills = listRegisteredSkills()

      // 只返回当前 agent 拥有的技能
      const agentSkills = allSkills.filter((s) =>
        skillNames.includes(s.meta.name),
      )

      if (agentSkills.length === 0) {
        // 技能已注册但未启用的情况
        return '当前没有启用的技能。'
      }

      const lines: string[] = [`已启用技能 (${agentSkills.length} 个)`, '']

      for (const skill of agentSkills) {
        lines.push(`  📌 **${skill.meta.name}**`)
        lines.push(`     ${skill.meta.description}`)
        if (skill.meta.version) {
          lines.push(`     版本: ${skill.meta.version}`)
        }
        if (skill.meta.tags?.length) {
          lines.push(`     标签: ${skill.meta.tags.join(', ')}`)
        }
        lines.push('')
      }

      lines.push('💡 使用 `read_skill_source` 查看某个技能的源代码详情。')

      return lines.join('\n')
    } catch (e: any) {
      return `获取技能列表失败: ${e.message || String(e)}`
    }
  }) as ToolExecutor,
)
