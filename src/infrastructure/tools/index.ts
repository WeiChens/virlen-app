/**
 * 注册工具 —— 按分类聚合（目录与 src/domain/tools/category.ts 的 TOOL_CATEGORIES 一一对应）。
 * 每分类目录内：一个工具一个文件 + common.ts；分类 index.ts import 各工具文件（注册副作用）。
 */
export const toolsInit = async () => {
  await import('@/infrastructure/tools/file')
  await import('@/infrastructure/tools/search')
  await import('@/infrastructure/tools/execute')
  await import('@/infrastructure/tools/knowledge-base')
  await import('@/infrastructure/tools/web')
  await import('@/infrastructure/tools/vision')
  await import('@/infrastructure/tools/skill')
  await import('@/infrastructure/tools/system')
  await import('@/infrastructure/tools/plan')
  await import('@/infrastructure/tools/chat')
  await import('@/infrastructure/tools/memory')
}
