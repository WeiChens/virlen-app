/**
 * skillStore — Skill 注册与存储
 *
 * 存储已注册的 Skill 元信息（RegisteredSkill[]）到 localStorage。
 * SKILLs 文件夹路径固定为 Tauri appDataDir/skills。
 * Skill 的实际文件内容通过文件系统读取（只读）。
 */
import StorageState from '@/utils/storageState'
import type {
  RegisteredSkill,
  SkillMeta,
  SkillStoreData,
  SkillFileEntry,
} from './types'
import { normalizeSkillName } from './types'
import { parseMdFrontmatter } from '@/utils/mdYamlFrontmatter'
import { readDir, readTextFile, stat } from '@tauri-apps/plugin-fs'

// ==================== 常量 ====================

/** localStorage key */
const STORAGE_KEY = 'virlen-skills'

/** 默认空数据 */
const defaultData: SkillStoreData = {
  skills: [],
}

// ==================== Store 实例 ====================

export const skillStore = new StorageState(STORAGE_KEY, defaultData, 1000)

// ==================== 内部缓存 ====================

/** 缓存 appDataDir/skills 路径，避免重复异步调用 */
let _skillsDirPath: string | null = null

// ==================== 工具函数 ====================

/**
 * 获取 SKILLs 文件夹绝对路径
 * 固定为 appDataDir/skills
 */
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

/**
 * 确保 SKILLs 目录存在
 */
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

/**
 * 读取 SKILL.md 文件内容
 */
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
 * 解析 SKILL.md 提取元信息
 *
 * 强制约束：技能唯一标识 = frontmatter 的 name 字段（归一化后）或文件夹名。
 * 确保同一 name 不会被注册两次（主键唯一）。
 *
 * 支持 YAML frontmatter 格式（含块标量 | 和 >-）：
 * ---
 * name: xxx
 * description: xxx
 * version: 1.0.0
 * tags: [a, b]
 * ---
 */
function parseSkillMeta(folderName: string, mdContent: string): SkillMeta {
  const result = parseMdFrontmatter(mdContent)

  // name 优先级：frontmatter.name > 文件夹名，均需归一化
  let name: string
  try {
    name = normalizeSkillName(result.fields.name || folderName)
  } catch {
    name = normalizeSkillName(folderName)
  }

  const meta: SkillMeta = {
    name,
    description: '',
  }

  if (result.success) {
    const { fields } = result
    if (fields.description) meta.description = fields.description
    if (fields.version) meta.version = fields.version
    if (fields.tags) {
      try {
        meta.tags = JSON.parse(fields.tags.replace(/'/g, '"'))
      } catch {
        meta.tags = fields.tags
          .replace(/[\[\]]/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      }
    }
  }

  // 如果没有 description，从正文第一行取
  if (!meta.description) {
    const bodyStart = mdContent.indexOf('---', 3)
    const body =
      bodyStart >= 0 ? mdContent.slice(bodyStart + 3).trim() : mdContent.trim()
    const firstLine =
      body
        .split('\n')[0]
        ?.replace(/^#+\s*/, '')
        .trim() || ''
    meta.description = firstLine
  }

  return meta
}

// ==================== CRUD 操作 ====================

/**
 * 扫描 SKILLs 目录下所有子文件夹，注册其中包含 SKILL.md 的 skill
 *
 * ⚠️ 异常会向上抛出，由调用方（如 UI 层）捕获并展示给用户。
 * 只有单个目录不是合法 skill 时静默跳过（内层 catch）。
 *
 * @returns 本次新注册的 skill 列表
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
      // 确保 SKILL.md 存在
      await stat(mdPath)
      const mdContent = await readTextFile(mdPath)

      // ⚠️ 必须用 frontmatter 解析后的 name（归一化）做去重键
      const meta = parseSkillMeta(entry.name, mdContent)

      // 检查 name 是否已注册（主键唯一性检查）
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

  // ===== 清理：store 中有但磁盘目录已删除的 skill =====
  // ⚠️ 用 s.path（注册时记录的实际路径）判断，不能用 meta.name 拼接
  // 用户可能手动拷贝文件夹，目录名 ≠ SKILL.md 的 name
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
 * 注册单个 skill（从指定路径）
 * 用于 ZIP 导入后的手动注册
 *
 * 主键唯一性保证：
 *  - 以 SKILL.md frontmatter 解析后的 name（归一化）为主键
 *  - 已存在同名 skill → 更新（覆盖）
 *  - 不存在 → 新增
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

    // 主键唯一性检查（仅在非跳过模式下检查文件夹名 === name 的一致性）
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

/**
 * 删除 skill（从 store 移除 + 删除磁盘文件）
 * name 自动归一化，忽略大小写
 */
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

/**
 * 仅从 store 注销（不移除磁盘文件）
 * 用于扫描时清理已删除的目录
 */
export function unregisterSkill(name: string): boolean {
  const normalized = name.toLowerCase().trim()
  const skills = skillStore.value.skills.filter(
    (s) => s.meta.name !== normalized,
  )
  if (skills.length === skillStore.value.skills.length) return false
  skillStore.setValue('skills', skills)
  return true
}

/**
 * 获取单个已注册 skill（name 自动归一化，忽略大小写）
 */
export function getRegisteredSkill(name: string): RegisteredSkill | undefined {
  const normalized = name.toLowerCase().trim()
  return skillStore.value.skills.find((s) => s.meta.name === normalized)
}

/**
 * 列出所有已注册 skill
 */
export function listRegisteredSkills(): RegisteredSkill[] {
  return [...skillStore.value.skills]
}

/**
 * 刷新所有已注册 skill 的元信息（重新读取 SKILL.md）
 * 在手动修改了 SKILL.md 后调用
 */
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

/**
 * 获取 skill 目录的文件树结构（不含文件内容）
 * 用于 AI tool read_skill_source
 */
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

/**
 * 获取 SKILLs 目录的绝对路径
 */
export async function getSkillsDirPath(): Promise<string> {
  return getSkillsDir()
}

// ==================== 初始化 ====================

/** 标记文件名，用于判断是否已初始化默认 skill */
const INIT_MARKER_FILENAME = '.init-skills-marker'

/** 打包的默认 skill 目录名（对应 tauri.conf.json bundle.resources 中的目标路径） */
const DEFAULT_SKILLS_DIR_NAME = 'default-skills'

/**
 * 首次运行时，将打包的默认 skill 拷贝到 appDataDir/skills 下
 */
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
      // 创建目标目录
      await mkdir(destSkillDir, { recursive: true })

      // 读取源目录下所有文件并拷贝
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
    const skillsDir = await getSkillsDir()
    let markerExists = false

    try {
      const { stat } = await import('@tauri-apps/plugin-fs')
      await stat(`${skillsDir}/${INIT_MARKER_FILENAME}`)
      markerExists = true
    } catch {
      // 标记文件不存在，需要初始化
    }

    if (!markerExists) {
      await copyDefaultSkills(skillsDir)

      // 写入标记文件
      try {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs')
        await writeTextFile(
          `${skillsDir}/${INIT_MARKER_FILENAME}`,
          `Initialized at ${new Date().toISOString()}`,
        )
      } catch (e) {
        console.warn('[skillStore] 写入初始化标记文件失败:', e)
      }
    }

    await scanAndRegisterSkills()
  } catch (e) {
    console.warn(e)
    // 静默失败，首次运行无 skills 目录正常
  }
}
