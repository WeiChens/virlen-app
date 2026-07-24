/**
 * plazaService — 技能广场远程 API 服务
 *
 * 调用 virlen-api 的公开接口获取技能列表、分类、详情、SKILL.md 预览。
 * 使用浏览器原生 fetch。
 * 导入流程：获取 download_url → 下载 ZIP → 调用 importSkillFromZip 安装。
 */
import { importSkillFromZip } from './importService'
import { getRegisteredSkill } from './skillStore'
import { domain } from '@/ui/constants'
import { t, tpl } from '@/ui/i18n'

// ==================== 类型定义 ====================

/** 远程技能信息（来自 API） */
export interface RemoteSkill {
  id: number
  name: string
  description: string
  version?: string | null
  tags: string[]
  author: string
  status: string
  download_count: number
  file_size?: number | null
  category_id?: number | null
  category_name?: string | null
  created_at: string
  updated_at: string
}

/** 远程分类信息 */
export interface RemoteCategory {
  id: number
  name: string
  description: string
  sort_order: number
  skill_count: number
}

/** 分页响应 */
export interface PaginatedData<T> {
  data: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

/** 技能详情（含 download_url） */
export interface RemoteSkillDetail extends RemoteSkill {
  download_url: string
}

// ==================== API 客户端 ====================

/** 构建 API 请求 URL */
function buildApiUrl(path: string): string {
  return `${domain}/api/public${path}`
}

/** 通用 GET 请求 */
async function apiGet<T>(path: string): Promise<T> {
  const url = buildApiUrl(path)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
    throw new Error(body.message || `请求失败 (${res.status})`)
  }
  const json = await res.json()
  if (json.code !== 200) throw new Error(json.message || '请求失败')
  return json.data as T
}

/** 通用 POST 请求 */
async function apiPost(path: string): Promise<void> {
  const url = buildApiUrl(path)
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
    throw new Error(body.message || `请求失败 (${res.status})`)
  }
}

// ==================== 公开接口 ====================

/**
 * 获取已发布的技能列表（分页）
 */
export async function fetchPlazaSkills(params?: {
  page?: number
  page_size?: number
  keyword?: string
  category_id?: number
}): Promise<PaginatedData<RemoteSkill>> {
  const query = new URLSearchParams()
  if (params?.page) query.set('page', String(params.page))
  if (params?.page_size) query.set('page_size', String(params.page_size))
  if (params?.keyword) query.set('keyword', params.keyword)
  if (params?.category_id) query.set('category_id', String(params.category_id))
  const qs = query.toString()
  return apiGet<PaginatedData<RemoteSkill>>(`/skills${qs ? '?' + qs : ''}`)
}

/**
 * 获取技能分类列表
 */
export async function fetchPlazaCategories(): Promise<RemoteCategory[]> {
  return apiGet<RemoteCategory[]>('/skills/categories')
}

/**
 * 获取技能详情（含 download_url）
 */
export async function fetchPlazaSkillDetail(id: number): Promise<RemoteSkillDetail> {
  return apiGet<RemoteSkillDetail>(`/skills/${id}`)
}

/**
 * 获取技能 SKILL.md 内容（预览）
 * 直接请求静态文件 URL: {domain}/uploads/skills/{name}/SKILL.md
 */
export async function fetchPlazaSkillReadme(id: number): Promise<string> {
  // 先获取技能详情得到 name
  const detail = await fetchPlazaSkillDetail(id)
  const url = `${domain}/uploads/skills/${detail.name}/SKILL.md`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(t('无法获取 SKILL.md 内容'))
  }
  return res.text()
}

/**
 * 上报下载计数
 */
export async function reportPlazaDownload(id: number): Promise<void> {
  try {
    await apiPost(`/skills/${id}/download-count`)
  } catch {
    // 静默失败，不影响用户体验
  }
}

// ==================== 导入逻辑 ====================

/**
 * 从技能广场导入技能到本地
 *
 * 流程：
 * 1. 获取技能详情 → 得到 download_url
 * 2. 上报下载计数
 * 3. 下载 ZIP 到临时目录
 * 4. 调用 importSkillFromZip 安装
 * 5. 清理临时文件
 *
 * @returns 导入成功的 skill 名称
 */
export async function importSkillFromPlaza(skillId: number): Promise<string> {
  // 1. 检查是否已安装
  const detail = await fetchPlazaSkillDetail(skillId)
  const existing = getRegisteredSkill(detail.name)
  if (existing) {
    throw new Error(tpl('技能「$__name__」已安装，请先删除后再导入', { name: detail.name }))
  }

  // 2. 上报下载计数
  await reportPlazaDownload(skillId)

  // 3. 下载 ZIP
  const downloadUrl = detail.download_url
  if (!downloadUrl) {
    throw new Error(t('该技能暂无可用的下载链接'))
  }

  const response = await fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(tpl('下载失败: HTTP $__status__', { status: response.status }))
  }

  const arrayBuffer = await response.arrayBuffer()
  const zipData = new Uint8Array(arrayBuffer)

  // 4. 写入临时文件，然后使用 importSkillFromZip 安装
  try {
    const { writeFile, remove } = await import('@tauri-apps/plugin-fs')
    const { tempDir } = await import('@tauri-apps/api/path')
    const tmpDir = await tempDir()
    const tmpZipPath = `${tmpDir}/plaza_import_${skillId}_${Date.now()}.zip`

    await writeFile(tmpZipPath, zipData)

    // 5. 导入
    const names = await importSkillFromZip(tmpZipPath)
    if (names.length === 0) {
      throw new Error(t('导入失败'))
    }

    // 6. 清理临时文件
    try {
      await remove(tmpZipPath)
    } catch {
      // 清理失败不影响
    }

    return names[0]
  } catch (e: any) {
    // 如果是 importSkillFromZip 内部抛出的错误，直接抛出
    if (e.message?.includes('导入 skill 失败') || e.message?.includes('SKILL.md')) {
      throw e
    }
    throw new Error(tpl('导入失败: $__error__', { error: e.message || String(e) }))
  }
}

/**
 * 检查远程技能是否已本地安装
 */
export function isSkillInstalled(name: string): boolean {
  return !!getRegisteredSkill(name)
}
