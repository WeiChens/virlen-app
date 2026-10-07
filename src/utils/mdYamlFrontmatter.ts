/**
 * mdYamlFrontmatter — Markdown YAML frontmatter 解析工具。支持简单 key: value、字面量块 `|`、折叠块 `>-`、\r\n / \n 换行。
 */

/** 解析结果 */
export interface FrontmatterResult {
  /** 是否解析成功（至少包含 --- 包裹的 frontmatter） */
  success: boolean
  /** 解析后的键值对 */
  fields: Record<string, string>
  /** 错误信息（解析失败时） */
  error?: string
}

/**
 * 从 Markdown 内容中提取并解析 YAML frontmatter。
 */
export function parseMdFrontmatter(mdContent: string): FrontmatterResult {
  const frontmatterMatch = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)

  if (!frontmatterMatch) {
    return {
      success: false,
      fields: {},
      error: '缺少 YAML frontmatter（文件开头需有 --- 包裹的元数据块）',
    }
  }

  const frontmatter = frontmatterMatch[1]
  const lines = frontmatter.split('\n')
  const fields: Record<string, string> = {}

  // 状态机解析，支持块标量
  let currentKey: string | null = null
  let blockScalarType: 'literal' | 'folded' | null = null
  let blockLines: string[] = []

  function flushBlock() {
    if (currentKey && blockScalarType) {
      if (blockScalarType === 'folded') {
        fields[currentKey] = blockLines.join(' ').replace(/\s+/g, ' ')
      } else {
        fields[currentKey] = blockLines.join('\n')
      }
    }
    currentKey = null
    blockScalarType = null
    blockLines = []
  }

  for (const line of lines) {
    // 正在收集块标量
    if (currentKey && blockScalarType) {
      if (line.length === 0 || line[0] === ' ' || line[0] === '\t') {
        blockLines.push(line.trimEnd())
        continue
      }
      flushBlock()
    }

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const key = line.slice(0, colonIdx).trim()
    const valuePart = line.slice(colonIdx + 1).trim()

    // 字面量块 description: |
    if (valuePart === '|' || valuePart === '|-' || valuePart === '|+') {
      currentKey = key
      blockScalarType = 'literal'
      blockLines = []
      continue
    }

    // 折叠块 description: >-
    if (valuePart === '>' || valuePart === '>-' || valuePart === '>+') {
      currentKey = key
      blockScalarType = 'folded'
      blockLines = []
      continue
    }

    // 简单 key: value
    fields[key] = valuePart
  }

  // 文件末尾未关闭的块
  flushBlock()

  return { success: true, fields }
}

/**
 * 从 frontmatter 提取 tags 字段并转为数组（JSON 数组格式或逗号分隔）。
 */
export function parseFrontmatterTags(tagsRaw: string): string[] {
  if (!tagsRaw) return []
  try {
    return JSON.parse(tagsRaw.replace(/'/g, '"'))
  } catch {
    return tagsRaw
      .replace(/[\[\]]/g, '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
}

/**
 * 统一的 SKILL.md 元信息解析，兼容两种格式：① 标准 YAML frontmatter；② 纯 Markdown（无 frontmatter，从标题 / 正文提取）。
 * @param fallbackName 文件夹名兜底
 */
export interface ParsedSkillMeta {
  name: string
  description: string
  version?: string
  tags: string[]
}

export function parseSkillMdMeta(
  mdContent: string,
  fallbackName: string = '',
): ParsedSkillMeta {
  // 先尝试 YAML frontmatter
  const fmResult = parseMdFrontmatter(mdContent)

  // 格式一：有 frontmatter 且有 name 字段
  if (fmResult.success && fmResult.fields.name) {
    return {
      name: fmResult.fields.name,
      description: fmResult.fields.description || '',
      version: fmResult.fields.version || undefined,
      tags: parseFrontmatterTags(fmResult.fields.tags),
    }
  }

  // 格式二：纯 Markdown，从正文提取
  const body = fmResult.success
    ? mdContent.slice(mdContent.indexOf('---', 3) + 3).trim()
    : mdContent.trim()

  // 提取 name：第一个 # 标题，去掉 emoji 和特殊符号后归一化
  const headingMatch = body.match(/^#+\s+(.+)/m)
  let rawName = ''
  if (headingMatch) {
    // 去掉 emoji 和特殊符号，保留字母数字和基本符号
    rawName = headingMatch[1]
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
  }

  const name = rawName ? rawName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') : fallbackName

  // 提取 description：优先 > blockquote，其次第一段非空文本
  let description = ''
  const bqMatch = body.match(/^>\s*(.+)/m)
  if (bqMatch) {
    description = bqMatch[1].trim()
  } else {
    const lines = body.split('\n').filter(l => l.trim())
    // 跳过标题行
    for (const line of lines) {
      if (line.startsWith('#')) continue
      if (line.startsWith('>')) continue
      description = line.replace(/^\*\*.*?\*\*\s*/g, '').trim()
      if (description) break
    }
  }

  // version：兼容 `**Version:** X.X.X` / `**Version**: X.X.X` / `Version: X.X.X`（正则允许 ** 落在冒号外侧）。
  // Rust 原生镜像 native_tools/skill/common.rs::RE_VERSION 必须保持**同一结果**（铁律 1）。
  let version: string | undefined
  const versionMatch = body.match(/(?:\*\*)?[Vv]ersion(?:\*\*)?:?\s*(?:\*\*)?\s*(\d+\.\d+\.\d+)/)
  if (versionMatch) {
    version = versionMatch[1]
  }

  return { name, description, version, tags: [] }
}
