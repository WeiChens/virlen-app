/**
 * 注册工具 —— 按分类聚合（目录与 src/domain/tools/category.ts 的 TOOL_CATEGORIES 一一对应）。
 * 每分类目录内：一个工具一个文件 + common.ts；分类 index.ts import 各工具文件（注册副作用）。
 *
 * 一次并发而不是逐个 await：这些分类彼此不依赖，串行只是把 12 次模块求值排成队
 * （dev 下每次都是一轮请求/编译）；启动白屏时长会直接反映在它们的**和**上。
 */
export const toolsInit = async () => {
  await Promise.all([
    import('@/infrastructure/tools/file'),
    import('@/infrastructure/tools/search'),
    import('@/infrastructure/tools/execute'),
    import('@/infrastructure/tools/service'),
    import('@/infrastructure/tools/knowledge-base'),
    import('@/infrastructure/tools/web'),
    import('@/infrastructure/tools/vision'),
    import('@/infrastructure/tools/skill'),
    import('@/infrastructure/tools/system'),
    import('@/infrastructure/tools/plan'),
    import('@/infrastructure/tools/chat'),
    import('@/infrastructure/tools/memory'),
  ])
}
