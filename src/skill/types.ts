/**
 * Skill 系统类型定义
 */

/** Skill 元信息 */
export interface SkillMeta {
  /** 技能唯一标识（全小写字母、数字、中划线），主键 */
  name: string
  /** 简短描述 */
  description: string
  /** 版本号 */
  version?: string
  /** 标签 */
  tags?: string[]
}

/**
 * 校验并归一化技能名称
 * - 转小写
 * - 只允许 [a-z0-9-]
 * - 禁止为空
 */
export function normalizeSkillName(raw: string): string {
  const name = raw.replace(/"/g, '').toLowerCase().trim()
  if (!name) throw new Error('技能名称不能为空')
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `技能名称「${raw}」不合法：只允许小写字母、数字和中划线（例如：my-code-reviewer）`,
    )
  }
  return name
}

/** 已注册的 Skill（存储在 skillStore） */
export interface RegisteredSkill {
  meta: SkillMeta
  /** skill 文件夹的绝对路径 */
  path: string
  /** 注册时间 */
  registeredAt: number
}

/** SkillStore 持久化结构 */
export interface SkillStoreData {
  skills: RegisteredSkill[]
}

/** Skill 目录文件条目 */
export interface SkillFileEntry {
  name: string
  isDir: boolean
  children?: SkillFileEntry[]
}
