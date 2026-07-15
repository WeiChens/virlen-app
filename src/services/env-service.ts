/**
 * env-service — 获取系统环境信息并格式化为提示词文本
 *
 * 底层调用 Rust 命令 get_env_info，返回 OS、CWD、工具版本等信息。
 */

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
 * 获取系统环境提示词
 *
 * 输出格式：
 * ## 当前系统环境
 * - OS: {OS名称} {版本}
 * - 当前工作目录: {绝对路径}
 * - {工具名称}:{版本}
 * ...
 */
export async function getEnvPrompt(workingDirectory?: string): Promise<string> {
  try {
    let info: EnvInfo = _envInfo
    if (!info) {
      info = await invoke('get_env_info')
      _envInfo = info
    }
    return formatEnvInfo(info, workingDirectory)
  } catch {
    // Rust 命令不可用时（如浏览器开发模式），返回降级信息
    return formatFallbackEnv()
  }
}

function formatEnvInfo(info: EnvInfo, workingDirectory?: string): string {
  const lines: string[] = ['# 当前系统环境']

  // OS
  const osDisplay = info.os_version ? `${info.os} ${info.os_version}` : info.os
  lines.push(`- OS: ${osDisplay}`)

  // 工作目录
  lines.push(`- 当前工作目录: ${workingDirectory || info.cwd}`)

  // 工具版本
  for (const tool of info.tools) {
    lines.push(`- ${tool.name}:${tool.version}`)
  }

  return lines.join('\n')
}

/** 浏览器降级：获取基本 JS 环境信息 */
function formatFallbackEnv(): string {
  const lines: string[] = ['## 当前系统环境']

  // 通过 userAgent 判断
  const ua = navigator.userAgent
  if (ua.includes('Windows')) lines.push('- OS: Windows (browser)')
  else if (ua.includes('Macintosh')) lines.push('- OS: macOS (browser)')
  else if (ua.includes('Linux')) lines.push('- OS: Linux (browser)')
  else lines.push('- OS: Unknown')

  lines.push(`- 当前工作目录: N/A (browser mode)`)

  return lines.join('\n')
}

export async function initEvnService() {
  await getEnvPrompt()
}
