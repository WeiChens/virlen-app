/**
 * telemetry/common — 公共字段（§4）采集
 *
 * base 部分（平台/版本/OS）在启动时异步初始化一次；
 * 运行时部分（engine/theme/font_size/locale）通过 UI 注入的 provider 实时读取；
 * 窗口尺寸每次事件实时读取。
 *
 * 本模块不 import UI / domain，保持底层纯净。
 */
import { invoke } from '@tauri-apps/api/core'
import type { TelemetryCommonProps, TelemetryRuntimeContext } from './types'

/** 运行时上下文 provider（由 UI 层注入，可实时变化） */
let runtimeContextProvider: (() => TelemetryRuntimeContext) | null = null

export function setTelemetryRuntimeContextProvider(
  provider: () => TelemetryRuntimeContext,
): void {
  runtimeContextProvider = provider
}

/** 相对静态的 base 字段（启动时异步填充一次） */
const base = {
  app_version: '',
  platform: detectPlatformFromUA(),
  os_version: '',
  arch: '',
}

/** 归一化平台名 */
function normalizePlatform(raw: string): string {
  const p = (raw || '').toLowerCase()
  if (p.includes('darwin') || p.includes('mac')) return 'macos'
  if (p.includes('win')) return 'windows'
  if (p.includes('linux')) return 'linux'
  if (p.includes('android')) return 'android'
  if (p.includes('ios')) return 'ios'
  return p || 'unknown'
}

/** 无 Tauri 环境时通过 UA 判断平台 */
export function detectPlatformFromUA(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent || ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Linux/i.test(ua)) return 'linux'
  return 'unknown'
}

/**
 * 初始化 base 公共字段（应用启动时调用一次）
 * 所有失败均静默降级，绝不阻塞主流程。
 */
export async function initTelemetryCommon(): Promise<void> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    base.app_version = await getVersion()
  } catch {
    // 非 Tauri 环境
  }
  try {
    const p = await invoke<string>('os_platform')
    if (p) base.platform = normalizePlatform(p)
  } catch {
    // ignore
  }
  try {
    const info = await invoke<any>('get_env_info')
    if (info) {
      if (info.os) base.platform = normalizePlatform(info.os)
      if (info.os_version) base.os_version = String(info.os_version)
    }
  } catch {
    // ignore
  }
  try {
    const uaData = (navigator as any)?.userAgentData
    if (uaData?.architecture) base.arch = String(uaData.architecture)
  } catch {
    // ignore
  }
}

/** 获取 base 中的 app_version（用于导出包头部） */
export function getBaseAppVersion(): string {
  return base.app_version
}

/** 获取 base 中的 platform（用于导出包头部） */
export function getBasePlatform(): string {
  return base.platform
}

/**
 * 组装完整公共字段（每次事件实时读取窗口尺寸与运行时上下文）
 */
export function buildCommon(): TelemetryCommonProps {
  const ctx = runtimeContextProvider ? runtimeContextProvider() : {}
  const hasWindow = typeof window !== 'undefined'
  return {
    app_version: ctx.app_version || base.app_version || '',
    platform: base.platform,
    os_version: base.os_version,
    arch: base.arch,
    locale:
      ctx.locale ||
      (typeof navigator !== 'undefined' ? navigator.language : 'zh-CN'),
    theme: ctx.theme || 'system',
    font_size: ctx.font_size || 'medium',
    engine: ctx.engine || 'ts',
    window_w: hasWindow ? Math.round(window.innerWidth) : 0,
    window_h: hasWindow ? Math.round(window.innerHeight) : 0,
    dpr: hasWindow ? window.devicePixelRatio || 1 : 1,
    is_dev: ctx.is_dev ?? !!(import.meta as any)?.env?.DEV,
  }
}
