/**
 * skill — 技能分类公共函数（分类 id: skill）
 *
 * 供 list_skills / read_skill_source 复用。
 */
import type { SkillFileEntry } from '@/skill'

/**
 * 把技能目录树渲染成 ├── / └── 风格的文本行，追加到 lines 后返回。
 *
 * @param entries 目录条目（getSkillFileTree 的结果）
 * @param prefix  当前层级前缀（根层级传 '  '）
 * @param lines   结果累积数组（便于调用方先写入标题行）
 */
export function renderFileTree(
  entries: SkillFileEntry[],
  prefix: string,
  lines: string[] = [],
): string[] {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const isLast = i === entries.length - 1
    const connector = isLast ? '└── ' : '├── '
    const nextPrefix = prefix + (isLast ? '    ' : '│   ')

    lines.push(`${prefix}${connector}${entry.name}`)

    if (entry.children && entry.children.length > 0) {
      renderFileTree(entry.children, nextPrefix, lines)
    }
  }
  return lines
}
