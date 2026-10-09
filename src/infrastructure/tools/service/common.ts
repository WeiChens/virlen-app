/**
 * service — 后台服务分类公共（id: service）。
 *
 * ⚠️ 本分类的四个工具**只有 Rust 原生实现**，前端不提供回退实现：
 * 服务的状态（进程、输出窗口、寿命）必须**只有一份**，放在 Rust 注册表里
 * （`virlen-core/src/agent/native_tools/service/registry.rs`）。前端再实现一份 = 两份状态要同步，
 * 必然分叉（AGENTS 铁律 1）。
 *
 * 因此这里的执行器只是**占位**（`toolRegistry` 要求契约里的每个定义都有执行器才能列给模型），
 * 真被调用时如实报错 —— 现实中不会发生：Rust 引擎对这四个名字走 `is_native_tool` 原生路径，
 * 不会经 `agent:tool-request` 回到前端（TS 引擎已移除，见 docs/AGENTS.md §11.37）。
 */
import { ToolError } from '@/domain/tools/types'

/** 本分类工具的执行器占位：只有桌面端（Rust 原生引擎）能执行。 */
export function nativeOnly(toolName: string) {
  return async (): Promise<never> => {
    throw new ToolError(
      `"${toolName}" is only available in the desktop app (the native engine owns background services).`,
    )
  }
}
