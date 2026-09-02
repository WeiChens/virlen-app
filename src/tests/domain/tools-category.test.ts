/**
 * Tool Category 测试 — 工具分类映射
 *
 * 覆盖场景：
 * - 所有工具都能找到对应的分类
 * - getCategoryId 正确返回分类 ID
 * - getCategoryByToolName 正确返回分类对象
 * - 未注册的工具名返回 undefined
 * - 每个分类包含预期的工具列表
 * - 分类无重复的工具名称
 */
import { describe, it, expect } from 'vitest'
import {
  TOOL_CATEGORIES,
  getCategoryId,
  getCategoryByToolName,
} from '@/domain/tools/category'

describe('TOOL_CATEGORIES', () => {
  it('应该包含 8 个分类', () => {
    expect(TOOL_CATEGORIES).toHaveLength(8)
  })

  it('每个分类都应该有 id、label 和 toolNames', () => {
    for (const cat of TOOL_CATEGORIES) {
      expect(cat.id).toBeTruthy()
      expect(cat.label).toBeTruthy()
      expect(Array.isArray(cat.toolNames)).toBe(true)
      expect(cat.toolNames.length).toBeGreaterThan(0)
    }
  })

  it('所有分类的工具名不应重复', () => {
    const allNames = TOOL_CATEGORIES.flatMap((c) => c.toolNames)
    const uniqueNames = new Set(allNames)
    expect(uniqueNames.size).toBe(allNames.length)
  })

  it('文件操作分类应包含预期的工具', () => {
    const fileCat = TOOL_CATEGORIES.find((c) => c.id === 'file')
    expect(fileCat).toBeDefined()
    expect(fileCat!.toolNames).toContain('read_file')
    expect(fileCat!.toolNames).toContain('write_file')
    expect(fileCat!.toolNames).toContain('edit_file')
    expect(fileCat!.toolNames).toContain('delete_file')
    expect(fileCat!.toolNames).toContain('copy_move_file')
    expect(fileCat!.toolNames).toContain('list_files')
    expect(fileCat!.toolNames).toContain('file_info')
    expect(fileCat!.toolNames).toContain('mkdir')
  })

  it('搜索分类应包含预期工具', () => {
    const searchCat = TOOL_CATEGORIES.find((c) => c.id === 'search')
    expect(searchCat).toBeDefined()
    expect(searchCat!.toolNames).toContain('search_files_by_name')
    expect(searchCat!.toolNames).toContain('search_text_in_files')
  })

  it('知识库分类应包含预期工具', () => {
    const kbCat = TOOL_CATEGORIES.find((c) => c.id === 'knowledge_base')
    expect(kbCat).toBeDefined()
    expect(kbCat!.toolNames).toContain('search_knowledge_base')
    expect(kbCat!.toolNames).toContain('list_knowledge_bases')
    expect(kbCat!.toolNames).toContain('write_to_knowledge_base')
    expect(kbCat!.toolNames).toContain('delete_knowledge_base_document')
  })

  it('网络分类应包含 web_search 和 web_fetch', () => {
    const webCat = TOOL_CATEGORIES.find((c) => c.id === 'web')
    expect(webCat).toBeDefined()
    expect(webCat!.toolNames).toContain('web_search')
    expect(webCat!.toolNames).toContain('web_fetch')
  })

  it('系统分类应包含 user_choice', () => {
    const sysCat = TOOL_CATEGORIES.find((c) => c.id === 'system')
    expect(sysCat).toBeDefined()
    expect(sysCat!.toolNames).toContain('user_choice')
    expect(sysCat!.toolNames).toContain('get_current_time')
  })
})

describe('getCategoryId', () => {
  it('应返回已知工具的分类 ID', () => {
    expect(getCategoryId('read_file')).toBe('file')
    expect(getCategoryId('web_search')).toBe('web')
    expect(getCategoryId('execute_command')).toBe('execute')
    expect(getCategoryId('vision_analyze')).toBe('vision')
    expect(getCategoryId('list_skills')).toBe('skill')
    expect(getCategoryId('get_current_time')).toBe('system')
    expect(getCategoryId('search_knowledge_base')).toBe('knowledge_base')
    expect(getCategoryId('mkdir')).toBe('file')
  })

  it('未知工具应返回 undefined', () => {
    expect(getCategoryId('nonexistent_tool')).toBeUndefined()
    expect(getCategoryId('')).toBeUndefined()
  })
})

describe('getCategoryByToolName', () => {
  it('应返回已知工具的分类对象', () => {
    const cat = getCategoryByToolName('edit_file')
    expect(cat).toBeDefined()
    expect(cat!.id).toBe('file')
    expect(cat!.label).toBe('文件操作')
  })

  it('未知工具应返回 undefined', () => {
    expect(getCategoryByToolName('unknown_tool')).toBeUndefined()
  })
})
