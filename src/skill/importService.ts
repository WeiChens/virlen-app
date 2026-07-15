/**
 * importService — Skill ZIP 导入
 *
 * 流程：
 * 1. 用户选择 ZIP 文件（Tauri 文件对话框）
 * 2. 读取 ZIP 中的 SKILL.md，解析 frontmatter 获取 name
 * 3. 校验 SKILL.md 格式（必须有 frontmatter 且包含 name）
 * 4. 解压到 appDataDir/skills/{name}/
 * 5. 自动注册 skill
 */
import { getSkillsDirPath, registerSkill, getRegisteredSkill } from './skillStore'
import { normalizeSkillName } from './types'
import { parseMdFrontmatter } from '@/utils/mdYamlFrontmatter'

// ==================== SKILL.md 格式校验 ====================

interface ParsedSkillMeta {
  name: string
  description: string
  version?: string
  tags?: string[]
}

/**
 * 解析 SKILL.md 内容，提取 frontmatter 元信息
 * 要求：必须有 frontmatter 且包含 name 字段
 *
 * 合法格式：
 * ---
 * name: my-skill
 * description: My awesome skill
 * version: 1.0.0
 * ---
 * ...content...
 *
 * ⚠️ name 经过 normalizeSkillName 归一化（转小写、去空格、校验格式）
 */
function parseSkillMetaFromContent(
  _folderName: string,
  mdContent: string,
): ParsedSkillMeta {
  const result = parseMdFrontmatter(mdContent)

  if (!result.success) {
    throw new Error(`SKILL.md 格式错误：${result.error}`)
  }

  const { fields } = result

  if (!fields.name) {
    throw new Error(
      `SKILL.md 格式错误：frontmatter 中缺少 name 字段\n\n示例格式：\n---\nname: my-skill\ndescription: 技能描述\n---`,
    )
  }

  // 使用共享的 normalizeSkillName（统一校验 + 转小写 + 去空格）
  const name = normalizeSkillName(fields.name)

  const meta: ParsedSkillMeta = {
    name,
    description: fields.description || '',
  }

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

  // fallback：从正文第一行取 description
  if (!meta.description) {
    const body = mdContent.slice(mdContent.indexOf('---', 3) + 3).trim()
    const firstLine =
      body
        .split('\n')[0]
        ?.replace(/^#+\s*/, '')
        .trim() || ''
    meta.description = firstLine
  }

  return meta
}

/**
 * 在 ZIP 中查找 SKILL.md 文件
 * 优先根目录，其次任意子目录
 */
function findSkillMdFile(
  files: Record<string, { dir: boolean; name: string }>,
): string | null {
  // 先找根目录下的 SKILL.md
  if (files['SKILL.md'] && !files['SKILL.md'].dir) return 'SKILL.md'
  if (files['skill.md'] && !files['skill.md'].dir) return 'skill.md'

  // 再找任意子目录下的 SKILL.md
  for (const relPath of Object.keys(files)) {
    const lower = relPath.toLowerCase()
    if (!lower.endsWith('/skill.md')) continue
    if (files[relPath].dir) continue
    return relPath
  }

  return null
}

// ==================== 对外接口 ====================

/**
 * 打开文件对话框选择 ZIP 并导入
 * @returns 导入成功的 skill 名称列表
 */
export async function importSkillFromZipDialog(): Promise<string[]> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
    })

    if (!selected) return []

    const filePath = selected as string
    return await importSkillFromZip(filePath)
  } catch {
    return []
  }
}

/**
 * 从指定路径的 ZIP 文件导入 skill
 *
 * 流程：
 * 1. 读取 ZIP 找到 SKILL.md，解析 name
 * 2. 校验 frontmatter 合法性
 * 3. 解压到 skills/{name}/
 * 4. 注册 skill
 *
 * @param zipPath ZIP 文件绝对路径
 * @returns 导入成功的 skill 名称列表
 */
export async function importSkillFromZip(zipPath: string): Promise<string[]> {
  const skillsDir = await getSkillsDirPath()

  try {
    const JSZip = (await import('jszip')).default
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const { writeFile, mkdir } = await import('@tauri-apps/plugin-fs')

    // 1. 读取 ZIP
    const zipData = await readFile(zipPath)
    const zip = await JSZip.loadAsync(zipData)
    const fileEntries = zip.files as Record<
      string,
      { dir: boolean; name: string }
    >

    // 2. 查找 SKILL.md
    const skillMdPath = findSkillMdFile(fileEntries)
    if (!skillMdPath) {
      throw new Error(
        'ZIP 中未找到 SKILL.md 文件\n\n' +
          '技能包必须包含 SKILL.md，格式：\n' +
          '---\nname: my-skill\ndescription: 技能描述\n---\n\n技能内容...',
      )
    }

    // 3. 读取并解析 SKILL.md
    const skillMdFile = zip.files[skillMdPath]
    const mdContent = await skillMdFile.async('string')
    const meta = parseSkillMetaFromContent('', mdContent)

    // 4. ⚠️ 主键唯一性检查：如果该 name 已注册，给出明确提示
    const existing = getRegisteredSkill(meta.name)
    if (existing) {
      console.warn(
        `[importService] 技能「${meta.name}」已存在，将覆盖更新（路径: ${existing.path}）`,
      )
    }

    // 5. 计算 skill 目录前缀
    // 如果 SKILL.md 在子目录中（如 my-skill/SKILL.md），需要去掉该前缀
    const zipPrefix = skillMdPath.replace(/\/?SKILL\.md$/i, '')
    const targetDir = `${skillsDir}/${meta.name}`

    // 6. 清理旧目录（如果存在）
    try {
      const { remove } = await import('@tauri-apps/plugin-fs')
      await remove(targetDir, { recursive: true })
    } catch {
      // 目录不存在，忽略
    }

    // 7. 解压到 skills/{name}/
    const extractedFiles: string[] = []

    for (const [relPath, file] of Object.entries(zip.files)) {
      if (file.dir) continue // 目录由 writeFile 自动创建

      // 去掉 zip 内部前缀，确保文件放到 skills/{name}/
      const relative = zipPrefix ? relPath.slice(zipPrefix.length + 1) : relPath
      const targetPath = `${targetDir}/${relative}`

      const content = await file.async('uint8array')
      const parent = targetPath.substring(0, targetPath.lastIndexOf('/'))
      await mkdir(parent, { recursive: true })
      await writeFile(targetPath, content)
      extractedFiles.push(relative)
    }

    // 8. 注册 skill
    const registered = await registerSkill(meta.name)
    if (!registered) {
      // 清理已解压的文件
      try {
        const { remove } = await import('@tauri-apps/plugin-fs')
        await remove(targetDir, { recursive: true })
      } catch {}
      throw new Error(`技能「${meta.name}」注册失败`)
    }

    return [meta.name]
  } catch (e: any) {
    throw new Error(`导入 skill 失败: ${e.message || String(e)}`)
  }
}

/**
 * 校验 SKILL.md 文件内容
 * @returns 解析后的技能元信息
 */
export function validateSkillMd(
  mdContent: string,
  fallbackName: string = '',
): ParsedSkillMeta {
  return parseSkillMetaFromContent(fallbackName, mdContent)
}
