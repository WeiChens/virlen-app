/**
 * editor — 打开编辑器领域层
 *
 * 提供命令模板占位符替换与跨平台命令启动能力，不关心「选哪个编辑器」——
 * 配置解析与编排由 services/editor-service.ts 负责。
 *
 * 模板示例：
 *   code -g "${filePath}:${line}"          // VS Code 定位到文件行
 *   code --reuse-window "${filePath}"      // VS Code 复用窗口打开
 *   webstorm64.exe --line ${line} "${filePath}"
 */
import { Command } from '@tauri-apps/plugin-shell'
import type { EditorCommandParams, SpawnResult } from './types'
import { getPlatform } from '@/utils/common'

export type {
  EditorCommandParams,
  SpawnResult,
  EditorOpenConfig,
  EditorPreset,
} from './types'
export { EDITOR_PRESETS } from './config'


/**
 * 将命令模板中的 ${xxx} 占位符替换为实际参数。
 * 未提供的 line / column 默认补 0（便于定位到文件首行）。
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
  if (!params.line) {
    params.line = 0
  }
  if (!params.column) {
    params.column = 0
  }
  return template.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    const val = params[name]
    return val !== undefined ? String(val) : match
  })
}

/**
 * 使用 shell 启动打开编辑器命令（fire-and-forget，不等待进程退出）。
 * 适用于 GUI 编辑器场景（进程常驻，不能阻塞等待）。
 *
 * - Windows：PowerShell
 * - macOS/Linux：bash -c
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

  const platform = await getPlatform()
  try {
    if (platform === 'windows') {
      await Command.create('powershell', [
        '-NoProfile',
        '-Command',
        trimmed,
      ]).spawn()
    } else {
      await Command.create('bash', ['-c', trimmed]).spawn()
    }
    return { ok: true, command }
  } catch (e: any) {
    return { ok: false, command, message: e?.message ?? String(e) }
  }
}
