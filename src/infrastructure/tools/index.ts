/**
 * 注册工具 — 按分类聚合
 *
 * 目录结构与 src/domain/tools/category.ts 的 TOOL_CATEGORIES 一一对应：
 *   file/          → file（文件操作，8 个工具）
 *   search/        → search（搜索，2 个）
 *   execute/       → execute（代码执行，2 个）
 *   knowledge-base/→ knowledge_base（知识库，6 个）
 *   web/           → web（网络，2 个）
 *   vision/        → vision（视觉，1 个）
 *   skill/         → skill（技能，2 个）
 *   system/        → system（系统，2 个）
 *   chat/          → chat（会话消息，2 个）
 *
 * 每个分类目录内：一个工具一个文件 + common.ts（分类内公共函数）；
 * 分类 index.ts 负责 import 各工具文件（注册副作用）。
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
  await import('@/infrastructure/tools/chat')
}
