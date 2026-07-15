/**
 * 注册工具
 */
export const toolsInit = async () => {
  await import('@/infrastructure/tools/builtin')
  await import('@/infrastructure/tools/file-tools')
  await import('@/infrastructure/tools/file-tools/copy-move')
  await import('@/infrastructure/tools/builtin/web-fetch')
  await import('@/infrastructure/tools/builtin/execute-command')
  await import('@/infrastructure/tools/builtin/search-tools')
  await import('@/infrastructure/tools/builtin/web-search')
  await import('@/infrastructure/tools/skill-tools')
  await import('@/infrastructure/tools/vision/index')
}
