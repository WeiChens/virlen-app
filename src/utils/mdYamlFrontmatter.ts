/**
 * mdYamlFrontmatter — Markdown YAML frontmatter 解析工具
 *
 * 支持：
 *  - 简单 key: value
 *  - 字面量块 description: | （保留换行）
 *  - 折叠块 description: >- （空格连接）
 *  - Windows \r\n / Unix \n 换行
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
 * 从 Markdown 内容中提取并解析 YAML frontmatter
 *
 * @param mdContent - 完整 Markdown 文本
 * @returns 解析结果，含 fields 对象
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
 * 从 frontmatter 提取 tags 字段（转为数组）
 * 支持 JSON 数组格式 [a, b, c] 或逗号分隔
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
