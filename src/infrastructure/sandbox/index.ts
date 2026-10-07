/**
 * sandbox — 安全沙盒执行基础设施：导出默认实例与工厂，便于按平台切换。
 * 当前默认 PluginShellSandbox（@tauri-apps/plugin-shell）；未来可换 WsbxSandbox（受限令牌 + ACL）/ UnshareSandbox。
 */

import type { SandboxPort } from '@/domain/ports/SandboxPort'
import { PluginShellSandbox } from './plugin-shell-sandbox'

/** 全局默认沙盒实例 */
let _instance: SandboxPort | null = null

/** 获取全局沙盒实例（单例）：首次调用创建默认实现，可用 setSandbox 替换。 */
export function getSandbox(): SandboxPort {
  if (!_instance) {
    _instance = new PluginShellSandbox()
  }
  return _instance
}

/** 替换全局沙盒实现（平台切换 / 测试注入）。 */
export function setSandbox(impl: SandboxPort): void {
  _instance = impl
}

export { PluginShellSandbox } from './plugin-shell-sandbox'
