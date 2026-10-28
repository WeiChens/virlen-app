/**
 * 跨分类公共：**只有 Rust 原生实现**的工具在 TS 侧的占位执行器。
 *
 * 为什么需要占位：`toolRegistry` 要求「契约里的每个定义都有执行器」才能把定义列给模型
 * （`missingExecutorNames()` 是启动门禁），而服务 / MCP 资源这类工具的事实只在 Rust 侧
 * （进程、注册表、服务器连接），前端**不能**再实现一份（两份状态必然分叉，见 AGENTS 铁律 1）。
 *
 * 现实中这些占位不会被调用：Rust 引擎对它们走 `is_native_tool` 原生路径，不会经
 * `agent:tool-request` 回到前端（TS 引擎已移除，见 docs/AGENTS.md §11.37）。
 */
import { ToolError } from '@/domain/tools/types'

/** 本分类工具的执行器占位：只有桌面端（Rust 原生引擎）能执行。 */
export function nativeOnly(toolName: string) {
  return async (): Promise<never> => {
    throw new ToolError(
      `"${toolName}" is only available in the desktop app (the native Rust engine owns it).`,
    )
  }
}
