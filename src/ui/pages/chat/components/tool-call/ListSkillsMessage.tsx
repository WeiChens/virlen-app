/**
 * ListSkillsMessage — list_skills 工具调用的消息展示组件
 *
 * 一行显示：技能数量
 * 展开显示：技能列表（由结构化 `uiData.skills` 按 UI 语言渲染）
 *
 * 模型侧文本固定英文（见 `infrastructure/tools/skill/list-skills.ts`），
 * 因此这里**不再依赖 `message.content`** 展示（仅旧数据回退）。
 */
import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 与 list-skills.ts 的 `SkillBrief` 对应（语言无关结构） */
interface SkillBrief {
  name: string
  description?: string
  version?: string
  tags?: string[]
}

/** 旧数据（无 uiData，中文文本）里提取技能数量的兜底正则 */
const LEGACY_COUNT_RE = /已启用技能\s*\((\d+)\s*个\)/

/** 结构化 skills → 本地化文本（与模型侧英文内容同构，仅语言不同） */
function renderSkills(skills: SkillBrief[]): string {
  const lines = [tpl('已启用技能 ($__count__ 个)', { count: skills.length }), '']
  for (const s of skills) {
    lines.push(`  📌 **${s.name}**`)
    if (s.description) lines.push(`     ${s.description}`)
    if (s.version) lines.push(`     ${t('版本')}: ${s.version}`)
    if (s.tags?.length) lines.push(`     ${t('标签')}: ${s.tags.join(', ')}`)
    lines.push('')
  }
  lines.push(t('💡 使用 read_skill_source 查看某个技能的源代码详情。'))
  return lines.join('\n')
}

const preStyle = {
  whiteSpace: 'pre-wrap' as const,
  margin: 0,
  fontSize: 'var(--font-size-sm)',
  lineHeight: 1.6,
}

class ListSkillsMessage implements IToolCallMessage {
  getToolName(): string {
    return 'list_skills'
  }

  getToolLabel(_type: string): string {
    return t('技能')
  }

  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const skills = (props.message?.uiData as any)?.skills as
        | SkillBrief[]
        | undefined
      if (Array.isArray(skills)) {
        if (skills.length === 0) {
          return <span style={{ color: '#999' }}>{t('暂无技能')}</span>
        }
        return <span>{tpl('$__count__ 个技能', { count: skills.length })}</span>
      }
      // 旧数据：从结果文本里提取数量
      const content = props.message?.content as string | undefined
      if (content) {
        const match = content.match(LEGACY_COUNT_RE)
        if (match) {
          return <span>{tpl('$__count__ 个技能', { count: match[1] })}</span>
        }
        if (content.includes('没有启用的技能') || content.includes('0 个')) {
          return <span style={{ color: '#999' }}>{t('暂无技能')}</span>
        }
      }
      return t('查看技能列表')
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    const skills = (props.message?.uiData as any)?.skills as
      | SkillBrief[]
      | undefined
    if (Array.isArray(skills) && skills.length > 0) {
      return <pre style={preStyle}>{renderSkills(skills)}</pre>
    }
    if (props.message?.content) {
      return <pre style={preStyle}>{props.message.content as string}</pre>
    }
    return null
  }

  diyWrapper(): boolean {
    return false
  }
}

export default ListSkillsMessage
