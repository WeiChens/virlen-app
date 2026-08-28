/**
 * editorCommand — 打开编辑器命令工具
 *
 * 提供命令模板占位符替换与跨平台命令启动能力。
 * 模板示例：
 *   code -g "${filePath}:${line}"          // VS Code 定位到文件行
 *   code --reuse-window "${filePath}"      // VS Code 复用窗口打开
 *   webstorm64.exe --line ${line} "${filePath}"
 */

import { Command } from '@tauri-apps/plugin-shell'

/** 命令模板参数 */
export interface EditorCommandParams {
  /** 文件绝对路径 */
  filePath?: string
  /** 行号（从 1 开始） */
  line?: number
  /** 列号 */
  column?: number
  [key: string]: string | number | undefined
}

/** 同步猜测平台（基于 UA，构造函数中用） */
function guessPlatformSync(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
}

/** 检测命令是否包含 cmd 特有语法（&&、||、>nul 等），与 execute-command 保持一致 */
function hasCmdSyntax(cmd: string): boolean {
  if (/&&|\|\|/.test(cmd)) return true
  if (/[12]?>nul\b/.test(cmd)) return true
  if (/<nul\b/.test(cmd)) return true
  if (/\becho\b/i.test(cmd) && /[>|]/.test(cmd)) return true
  return false
}

/**
 * 将命令模板中的 ${xxx} 占位符替换为实际参数。
 * 未提供的占位符保持原样（便于调试）。
 *
 * @example
 * buildEditorCommand('code -g "${filePath}:${line}"', {
 *   filePath: 'C:/a/b.ts',
 *   line: 42,
 * })
 * // → 'code -g "C:/a/b.ts:42"'
 */
export function buildEditorCommand(
  template: string,
  params: EditorCommandParams,
): string {
  return template.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    const val = params[name]
    return val !== undefined ? String(val) : match
  })
}

export interface SpawnResult {
  ok: boolean
  command?: string
  message?: string
}

/**
 * 使用 shell 启动打开编辑器命令（fire-and-forget，不等待进程退出）。
 * 适用于 GUI 编辑器场景（进程常驻，不能阻塞等待）。
 *
 * - Windows：含 cmd 特有语法时用 cmd /c，否则用 PowerShell
 * - macOS：zsh -c
 * - Linux：sh -c
 */
export async function spawnEditorCommand(
  template: string,
  params: EditorCommandParams,
): Promise<SpawnResult> {
  const command = buildEditorCommand(template, params)
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, command, message: 'empty command' }
  }

  const platform = guessPlatformSync()
  try {
    if (platform === 'windows') {
      if (hasCmdSyntax(trimmed)) {
        await Command.create('cmd', ['/c', trimmed]).spawn()
      } else {
        await Command.create('powershell', [
          '-NoProfile',
          '-Command',
          trimmed,
        ]).spawn()
      }
    } else if (platform === 'macos') {
      await Command.create('zsh', ['-c', trimmed]).spawn()
    } else {
      await Command.create('sh', ['-c', trimmed]).spawn()
    }
    return { ok: true, command }
  } catch (e: any) {
    return { ok: false, command, message: e?.message ?? String(e) }
  }
}
