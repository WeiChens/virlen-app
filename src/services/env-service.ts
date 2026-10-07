/** env-service — 获取系统环境信息（Rust get_env_info）并格式化为提示词文本。 */

import { invoke } from '@tauri-apps/api/core'

/** Rust 返回的原始数据 */
interface EnvInfo {
  os: string
  os_version: string
  cwd: string
  tools: { name: string; version: string }[]
}

let _envInfo: EnvInfo | undefined = undefined
/**
 * 获取系统环境提示词。输出形如：
 * # Current Environment
 * - OS: {name} {version}
 * - Current working directory: {path}
 * - {工具名}:{版本}
 */
export async function getEnvPrompt(workingDirectory?: string): Promise<string> {
  try {
    let info: EnvInfo | undefined = _envInfo
    if (!info) {
      info = await invoke<EnvInfo>('get_env_info')
      _envInfo = info
    }
    return formatEnvInfo(info, workingDirectory)
  } catch {
    // Rust 命令不可用时（如浏览器开发模式），返回降级信息
    return formatFallbackEnv()
  }
}

function formatEnvInfo(info: EnvInfo, workingDirectory?: string): string {
  const lines: string[] = ['# Current Environment']

  const osDisplay = info.os_version ? `${info.os} ${info.os_version}` : info.os
  lines.push(`- OS: ${osDisplay}`)

  lines.push(`- Current working directory: ${workingDirectory || info.cwd}`)

  for (const tool of info.tools) {
    lines.push(`- ${tool.name}:${tool.version}`)
  }

  return lines.join('\n')
}

/** 浏览器降级：获取基本 JS 环境信息 */
function formatFallbackEnv(): string {
  const lines: string[] = ['# Current Environment']

  const ua = navigator.userAgent
  if (ua.includes('Windows')) lines.push('- OS: Windows (browser)')
  else if (ua.includes('Macintosh')) lines.push('- OS: macOS (browser)')
  else if (ua.includes('Linux')) lines.push('- OS: Linux (browser)')
  else lines.push('- OS: Unknown')

  lines.push(`- Current working directory: N/A (browser mode)`)

  return lines.join('\n')
}

export async function initEvnService() {
  await getEnvPrompt()
}
