/**
 * tool-category — 工具分类定义
 *
 * 将工具按功能分组，方便用户在 Agent 编辑器中按组批量选择/取消。
 */

/** 工具分类 */
export interface ToolCategory {
  id: string
  label: string
  toolNames: string[]
}

/** 所有内置工具的分类映射 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'file',
    label: '文件操作',
    toolNames: [
      'read_file',
      'write_file',
      'edit_file',
      'delete_file',
      'copy_move_file',
      'list_files',
      'file_info',
    ],
  },
  {
    id: 'search',
    label: '搜索',
    toolNames: [
      'search_files_by_name',
      'search_text_in_files',
    ],
  },
  {
    id: 'execute',
    label: '代码执行',
    toolNames: [
      'execute_command',
    ],
  },
  {
    id: 'knowledge_base',
    label: '知识库',
    toolNames: [
      'search_knowledge_base',
      'list_knowledge_bases',
      'list_knowledge_base_documents',
      'get_knowledge_base_document',
      'write_to_knowledge_base',
      'delete_knowledge_base_document',
    ],
  },
  {
    id: 'web',
    label: '网络',
    toolNames: [
      'web_search',
      'web_fetch',
    ],
  },
  {
    id: 'vision',
    label: '视觉',
    toolNames: [
      'vision_analyze',
    ],
  },
  {
    id: 'skill',
    label: '技能',
    toolNames: [
      'list_skills',
      'read_skill_source',
    ],
  },
  {
    id: 'system',
    label: '系统',
    toolNames: [
      'get_current_time',
      'user_choice',
    ],
  },
]

/** 工具名 → 分类 ID 的快速查找 Map */
const toolToCategoryMap = new Map<string, string>()
for (const cat of TOOL_CATEGORIES) {
  for (const name of cat.toolNames) {
    toolToCategoryMap.set(name, cat.id)
  }
}

/** 根据工具名获取分类 ID */
export function getCategoryId(toolName: string): string | undefined {
  return toolToCategoryMap.get(toolName)
}

/** 获取工具名所属的分类 */
export function getCategoryByToolName(toolName: string): ToolCategory | undefined {
  const catId = toolToCategoryMap.get(toolName)
  return TOOL_CATEGORIES.find((c) => c.id === catId)
}
