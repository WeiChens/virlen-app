/**
 * sandbox — 安全沙盒执行基础设施
 *
 * 导出默认沙盒实例和工厂函数，方便按平台切换实现。
 *
 * ── 当前实现 ──
 * - 默认：PluginShellSandbox（@tauri-apps/plugin-shell）
 *
 * ── 未来扩展 ──
 * - Windows → WsbxSandbox（受限令牌 + ACL）
 * - Linux   → UnshareSandbox（mount namespace）
 */

import type { SandboxPort } from '@/domain/ports/SandboxPort'
import { PluginShellSandbox } from './plugin-shell-sandbox'

/** 全局默认沙盒实例 */
let _instance: SandboxPort | null = null

/**
 * 获取全局沙盒实例（单例）
 *
 * 首次调用时创建默认实现，后续可通过 {@link setSandbox} 替换。
 */
export function getSandbox(): SandboxPort {
  if (!_instance) {
    _instance = new PluginShellSandbox()
  }
  return _instance
}

/**
 * 替换全局沙盒实现（用于平台切换或测试注入）
 *
 * @example
 * ```ts
 * import { WsbxSandbox } from './wsbx-sandbox'
 * setSandbox(new WsbxSandbox())
 * ```
 */
export function setSandbox(impl: SandboxPort): void {
  _instance = impl
}

export { PluginShellSandbox } from './plugin-shell-sandbox'
