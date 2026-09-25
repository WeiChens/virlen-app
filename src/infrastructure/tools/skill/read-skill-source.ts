/**
 * read_skill_source — 查看指定技能的源代码目录结构 + SKILL.md 全文
 *
 * 同时返回技能文件夹的绝对路径，AI 可据此用 read_file 读取其他文件。
 * ⚠️ 只读操作，不提供写能力。
 *
 * 模型侧**固定英文**（与 Rust 原生实现 / CLI 一致，铁律 1）—— 原生实现已落地：
 * `native_tools/skill/read_skill_source.rs`（默认引擎路径）；本文件只服务 **TS 引擎**（回退路径）。
 * UI 侧下发结构化 `uiData: { skillPath, tree, md }`（语言无关），
 * 组件据此渲染卡片（旧数据无 uiData 时回退解析 `content` 的中文分段标记）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { renderFileTree } from './common'
import { t } from '@/ui/i18n'

toolRegistry.register(
    'read_skill_source',
    (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const skillName = args.name as string

    if (!skillName) {
      return {
        content: 'Error: please provide a skill name (the "name" parameter).',
      }
    }

    // 检查当前 agent 是否有此技能
    const agentSkills = ctx.skills || []
    if (agentSkills.length > 0 && !agentSkills.includes(skillName)) {
      return {
        content:
          `Error: the current agent does not have the "${skillName}" skill enabled. ` +
          'Use list_skills to see enabled skills.',
      }
    }

    try {
      const { getRegisteredSkill, getSkillFileTree, readSkillMd } =
        await import('@/skill')

      const skill = getRegisteredSkill(skillName)
      if (!skill) {
        return {
          content:
            `Error: skill "${skillName}" is not registered. ` +
            'Import it in Settings first.',
        }
      }

      // 1. 获取目录结构
      const fileTree = await getSkillFileTree(skillName)
      const mdContent = await readSkillMd(skillName)

      // 渲染目录树
      const treeLines: string[] = [`📂 ${skill.meta.name}/`]
      renderFileTree(fileTree, '  ', treeLines)
      const tree = treeLines.join('\n')

      // 组装结果（模型侧固定英文）— 顶部给出技能路径，AI 可用 read_file 读取其他文件
      const result = [
        `**📁 Skill path**: \`${skill.path}\``,
        '',
        '---',
        '',
        '# 📂 Directory structure',
        tree,
        '',
        '---',
        '',
        '# 📄 SKILL.md',
        '',
        mdContent,
      ]
        .filter(Boolean)
        .join('\n')

      // UI 侧走结构化字段（语言无关），组件不必再解析文本
      return { content: result, uiData: { skillPath: skill.path, tree, md: mdContent } }
    } catch (e: any) {
      return {
        content: `Failed to read skill "${skillName}": ${e.message || String(e)}`,
      }
    }
  }) as ToolExecutor,
    t('查看技能源代码'),
)
