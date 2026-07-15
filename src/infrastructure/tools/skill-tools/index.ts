/**
 * skill-tools — AI 可调用的技能相关工具
 *
 * 提供给 LLM 的两个 tool：
 * 1. list_skills        — 查看当前代理拥有的所有技能
 * 2. read_skill_source  — 查看指定技能的源代码目录结构 + SKILL.md
 *
 * ⚠️ 只读操作，不提供写能力。
 */
import { toolRegistry } from '@/domain/tools'
import type {
  ToolContext,
  ToolExecutor,
  ToolResult,
} from '@/domain/tools/types'

// ==================== Tool 1: list_skills ====================

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

// ==================== Tool 2: read_skill_source ====================

toolRegistry.register(
  {
    name: 'read_skill_source',
    label: '查看技能源代码',
    description:
      '查看指定技能的源代码目录结构和 SKILL.md 文本内容，同时返回技能文件夹的绝对路径。' +
      '输入技能名称（文件夹名），返回该 skill 目录下的所有文件列表、SKILL.md 全文和技能路径。' +
      '拿到技能路径后，你可以使用 read_file 工具读取该路径下的其他文件。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            '技能名称（文件夹名），例如 "code-reviewer"。使用 list_skills 查看所有可用技能的名称。',
        },
      },
      required: ['name'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const skillName = args.name as string

    if (!skillName) {
      return { content: '错误：请提供技能名称（name 参数）。' }
    }

    // 检查当前 agent 是否有此技能
    const agentSkills = ctx.skills || []
    if (agentSkills.length > 0 && !agentSkills.includes(skillName)) {
      return {
        content: `错误：当前代理没有启用 "${skillName}" 技能。可使用 list_skills 查看已启用的技能。`,
      }
    }

    try {
      const { getRegisteredSkill, getSkillFileTree, readSkillMd } =
        await import('@/skill')

      const skill = getRegisteredSkill(skillName)
      if (!skill) {
        return {
          content: `错误：技能 "${skillName}" 未注册。请先在设置中导入该技能。`,
        }
      }

      // 1. 获取目录结构
      const fileTree = await getSkillFileTree(skillName)
      const mdContent = await readSkillMd(skillName)

      // 渲染目录树
      const treeLines: string[] = [`📂 ${skill.meta.name}/`]

      function renderTree(
        entries: { name: string; isDir: boolean; children?: any[] }[],
        prefix: string,
      ) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          const isLast = i === entries.length - 1
          const connector = isLast ? '└── ' : '├── '
          const nextPrefix = prefix + (isLast ? '    ' : '│   ')

          treeLines.push(`${prefix}${connector}${entry.name}`)

          if (entry.children && entry.children.length > 0) {
            renderTree(entry.children, nextPrefix)
          }
        }
      }

      renderTree(fileTree, '  ')

      // 组装结果 — 顶部给出技能路径，AI 可用 read_file 读取其他文件
      const result = [
        `**📁 技能路径**: \`${skill.path}\``,
        '',
        '---',
        '',
        '# 📂 目录结构',
        ...treeLines,
        '',
        '---',
        '',
        '# 📄 SKILL.md',
        '',
        mdContent,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: result }
    } catch (e: any) {
      return {
        content: `读取技能 "${skillName}" 失败: ${e.message || String(e)}`,
      }
    }
  }) as ToolExecutor,
)
