/**
 * Skill 注册与存储：元信息存 localStorage，SKILL.md 在 appDataDir/skills（只读）。
 * ⚠️ Rust 原生路径不再读这个注册表（直接扫盘），parseSkillMeta / scanAndRegisterSkills /
 * getSkillFileTree 与 native_tools/skill/common.rs 是两份镜像，改一边同步另一边。
 */
import StorageState from '@/utils/storageState'
import type {
  RegisteredSkill,
  SkillMeta,
  SkillStoreData,
  SkillFileEntry,
} from './types'
import { normalizeSkillName } from './types'
import { parseSkillMdMeta } from '@/utils/mdYamlFrontmatter'
import { readDir, readTextFile, stat } from '@tauri-apps/plugin-fs'

// 常量

/** localStorage key */
const STORAGE_KEY = 'virlen-skills'

/** 默认空数据 */
const defaultData: SkillStoreData = {
  skills: [],
}

// Store 实例

export const skillStore = new StorageState(STORAGE_KEY, defaultData, 1000)

// 内部缓存

/** 缓存 appDataDir/skills 路径，避免重复异步调用 */
let _skillsDirPath: string | null = null

// 工具函数

/** 获取 skills 目录绝对路径（appDataDir/skills） */
async function getSkillsDir(): Promise<string> {
  if (_skillsDirPath) return _skillsDirPath

  try {
    const { appDataDir } = await import('@tauri-apps/api/path')
    const dir = (await appDataDir()).replace(/\\/g, '/').replace(/\/+$/, '')
    _skillsDirPath = `${dir}/skills`
  } catch {
    // 非 Tauri 环境：使用一个相对路径兜底
    _skillsDirPath = './skills'
  }
  return _skillsDirPath
}

/** 确保 skills 目录存在 */
async function ensureSkillsDir(): Promise<string> {
  const dir = await getSkillsDir()
  try {
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    await mkdir(dir, { recursive: true })
  } catch {
    // 非 Tauri 环境忽略
  }
  return dir
}

/** 读取 SKILL.md 内容 */
export async function readSkillMd(name: string): Promise<string> {
  const skillsDir = await getSkillsDir()
  const mdPath = `${skillsDir}/${name}/SKILL.md`
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    return await readTextFile(mdPath)
  } catch (e: any) {
    throw new Error(`读取 SKILL.md 失败: ${e.message || String(e)}`)
  }
}

/**
 * 解析 SKILL.md 元信息（兼容 YAML frontmatter 与纯 Markdown）。
 * 技能唯一标识 = name 或文件夹名（归一化后），保证不重复注册。
 */
function parseSkillMeta(folderName: string, mdContent: string): SkillMeta {
  const result = parseSkillMdMeta(mdContent, folderName)

  // name 优先级：解析结果 > 文件夹名，均需归一化
  let name: string
  try {
    name = normalizeSkillName(result.name || folderName)
  } catch {
    name = normalizeSkillName(folderName)
  }

  return {
    name,
    description: result.description || '',
    version: result.version,
    tags: result.tags?.length ? result.tags : undefined,
  }
}

// ==================== CRUD 操作 ====================

/**
 * 扫描 skills 目录并注册含 SKILL.md 的子目录。
 * 异常向上抛给调用方（UI 展示）；单个目录不合法则静默跳过。
 * @returns 本次新注册的 skill
 */
export async function scanAndRegisterSkills(): Promise<RegisteredSkill[]> {
  const skillsDir = await ensureSkillsDir()
  const newlyRegistered: RegisteredSkill[] = []

  const entries = await readDir(skillsDir)

  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name) continue

    const skillPath = `${skillsDir}/${entry.name}`
    const mdPath = `${skillPath}/SKILL.md`

    try {
      // 确保 SKILL.md 存在；去重键用归一化后的 name
      await stat(mdPath)
      const mdContent = await readTextFile(mdPath)

      // 去重键用 frontmatter 解析后的 name（已归一化）
      const meta = parseSkillMeta(entry.name, mdContent)

      // 检查 name 是否已注册（主键唯一）
      const exists = skillStore.value.skills.some(
        (s) => s.meta.name === meta.name,
      )
      if (exists) {
        continue
      }

      const registered: RegisteredSkill = {
        meta,
        path: skillPath,
        registeredAt: Date.now(),
      }
      skillStore.setValue('skills', [...skillStore.value.skills, registered])
      newlyRegistered.push(registered)
    } catch {
      // 没有 SKILL.md 的目录跳过，非异常
      continue
    }
  }

  // 清理：store 中有但磁盘已删除的 skill。用 s.path 判，不能用 meta.name 拼
  // （用户可能手动拷贝文件夹，目录名 ≠ SKILL.md 的 name）
  const cleanupRemoved: string[] = []
  for (const s of skillStore.value.skills) {
    try {
      await stat(s.path)
    } catch {
      // 目录已不存在 → 自动清理
      cleanupRemoved.push(s.meta.name)
    }
  }
  if (cleanupRemoved.length > 0) {
    const remaining = skillStore.value.skills.filter(
      (s) => !cleanupRemoved.includes(s.meta.name),
    )
    skillStore.setValue('skills', remaining)
    console.warn(
      `[skillStore] 扫描时清理了 ${cleanupRemoved.length} 个已删除的 skill: ${cleanupRemoved.join(', ')}`,
    )
  }

  return newlyRegistered
}

/**
 * 注册单个 skill（ZIP 导入后用）。以归一化 name 为主键：已存在则覆盖，否则新增。
 */
export async function registerSkill(
  folderName: string,
  skipNameCheck = false,
): Promise<RegisteredSkill | null> {
  const skillsDir = await getSkillsDir()
  const skillPath = `${skillsDir}/${folderName}`

  try {
    const { readTextFile, stat } = await import('@tauri-apps/plugin-fs')
    await stat(skillPath) // 确认目录存在
    const mdContent = await readTextFile(`${skillPath}/SKILL.md`)

    const meta = parseSkillMeta(folderName, mdContent)

    // 主键唯一性检查（非跳过模式才提醒文件夹名与技能名不一致）
    if (!skipNameCheck && folderName !== meta.name) {
      console.warn(
        `[skillStore] 文件夹名「${folderName}」与技能名「${meta.name}」不一致，以技能名为准`,
      )
    }

    const registered: RegisteredSkill = {
      meta,
      path: skillPath,
      registeredAt: Date.now(),
    }

    // 用归一化后的 name 查重
    const idx = skillStore.value.skills.findIndex(
      (s) => s.meta.name === meta.name,
    )
    if (idx >= 0) {
      const skills = [...skillStore.value.skills]
      skills[idx] = registered
      skillStore.setValue('skills', skills)
    } else {
      skillStore.setValue('skills', [...skillStore.value.skills, registered])
    }

    return registered
  } catch {
    return null
  }
}

/** 删除 skill（store + 磁盘）。name 自动归一化 */
export async function deleteSkill(name: string): Promise<boolean> {
  const normalized = name.toLowerCase().trim()

  const skill = skillStore.value.skills.find((s) => s.meta.name === normalized)
  if (!skill) return false

  // 1. 从 store 移除
  const skills = skillStore.value.skills.filter(
    (s) => s.meta.name !== normalized,
  )
  skillStore.setValue('skills', skills)

  // 2. 删除磁盘目录
  try {
    const { remove } = await import('@tauri-apps/plugin-fs')
    await remove(skill.path, { recursive: true })
  } catch (e: any) {
    console.warn(`[skillStore] 删除 skill 文件失败: ${e.message || String(e)}`)
  }

  return true
}

/** 仅从 store 注销（不动磁盘），用于扫描时清理已删除的目录 */
export function unregisterSkill(name: string): boolean {
  const normalized = name.toLowerCase().trim()
  const skills = skillStore.value.skills.filter(
    (s) => s.meta.name !== normalized,
  )
  if (skills.length === skillStore.value.skills.length) return false
  skillStore.setValue('skills', skills)
  return true
}

/** 取单个已注册 skill（name 自动归一化） */
export function getRegisteredSkill(name: string): RegisteredSkill | undefined {
  const normalized = name.toLowerCase().trim()
  return skillStore.value.skills.find((s) => s.meta.name === normalized)
}

/** 列出所有已注册 skill */
export function listRegisteredSkills(): RegisteredSkill[] {
  return [...skillStore.value.skills]
}

/** 重新读取 SKILL.md，刷新所有已注册 skill 的元信息 */
export async function refreshSkillsMeta(): Promise<void> {
  const skillsDir = await getSkillsDir()
  const updated: RegisteredSkill[] = []

  for (const existing of skillStore.value.skills) {
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      const mdContent = await readTextFile(`${existing.path}/SKILL.md`)
      const meta = parseSkillMeta(existing.meta.name, mdContent)
      updated.push({ ...existing, meta })
    } catch {
      // 保留原数据
      updated.push(existing)
    }
  }

  skillStore.setValue('skills', updated)
}

/** 取 skill 目录的文件树（不含内容），供 read_skill_source 工具用 */
export async function getSkillFileTree(
  name: string,
): Promise<SkillFileEntry[]> {
  const skill = getRegisteredSkill(name)
  if (!skill) throw new Error(`Skill "${name}" 未注册`)

  try {
    const { readDir, stat } = await import('@tauri-apps/plugin-fs')

    async function readTree(dirPath: string): Promise<SkillFileEntry[]> {
      const entries: SkillFileEntry[] = []
      const dirEntries = await readDir(dirPath)

      for (const entry of dirEntries) {
        if (!entry.name) continue
        if (entry.name.startsWith('.')) continue // 忽略隐藏文件

        if (entry.isDirectory) {
          const children = await readTree(`${dirPath}/${entry.name}`)
          entries.push({ name: entry.name + '/', isDir: true, children })
        } else {
          entries.push({ name: entry.name, isDir: false })
        }
      }

      return entries
    }

    return await readTree(skill.path)
  } catch (e: any) {
    throw new Error(`读取 skill 目录失败: ${e.message || String(e)}`)
  }
}

/** 取 skills 目录绝对路径 */
export async function getSkillsDirPath(): Promise<string> {
  return getSkillsDir()
}

// ==================== 初始化 ====================

/** 标记文件名（已不再使用） */
const INIT_MARKER_FILENAME = '.init-skills-marker'

/** 打包的默认 skill 目录名（bundle.resources 里的目标路径） */
const DEFAULT_SKILLS_DIR_NAME = 'default-skills'

/** 首次运行时拷贝打包的默认 skill（当前未启用） */
async function copyDefaultSkills(skillsDir: string): Promise<void> {
  let resourceBaseDir: string
  try {
    const { resourceDir } = await import('@tauri-apps/api/path')
    resourceBaseDir = (await resourceDir())
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
  } catch {
    // 非 Tauri 环境跳过
    return
  }

  const srcDir = `${resourceBaseDir}/${DEFAULT_SKILLS_DIR_NAME}`

  let srcEntries: { name: string }[]
  try {
    const { readDir, stat } = await import('@tauri-apps/plugin-fs')
    // 确认默认 skill 目录存在
    await stat(srcDir)
    const entries = await readDir(srcDir)
    srcEntries = entries.filter((e) => e.isDirectory && e.name)
  } catch {
    // 没有打包默认 skill 或读取失败，静默跳过
    return
  }

  const {
    mkdir,
    copyFile,
    readDir: fsReadDir,
  } = await import('@tauri-apps/plugin-fs')

  for (const entry of srcEntries) {
    const skillName = entry.name!
    const srcSkillDir = `${srcDir}/${skillName}`
    const destSkillDir = `${skillsDir}/${skillName}`

    try {
      // 创建目标目录并逐个拷贝文件
      await mkdir(destSkillDir, { recursive: true })
      const files = await fsReadDir(srcSkillDir)
      for (const file of files) {
        if (!file.name || file.isDirectory) continue
        await copyFile(
          `${srcSkillDir}/${file.name}`,
          `${destSkillDir}/${file.name}`,
        )
      }
    } catch (e) {
      console.warn(`[skillStore] 拷贝默认 skill "${skillName}" 失败:`, e)
    }
  }
}

/** 应用启动时调用：扫描注册技能 */
export async function initSkillStore(): Promise<void> {
  try {
    // 默认 skill 拷贝已停用（保留 copyDefaultSkills 备用）
    await scanAndRegisterSkills()
  } catch (e) {
    console.warn(e)
    // 静默失败，首次运行无 skills 目录正常
  }
}
