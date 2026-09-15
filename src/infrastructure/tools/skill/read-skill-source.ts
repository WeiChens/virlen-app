/**
 * read_skill_source — 查看指定技能的源代码目录结构 + SKILL.md 全文
 *
 * 同时返回技能文件夹的绝对路径，AI 可据此用 read_file 读取其他文件。
 * ⚠️ 只读操作，不提供写能力。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { renderFileTree } from './common'

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
      renderFileTree(fileTree, '  ', treeLines)

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
