/**
 * execute_script — 创建脚本文件并执行，可选执行后立即删除
 *
 * 与 `execute_command` 的分工：
 * - `execute_command`：执行一条内联 shell 命令（复杂多行脚本在内联时转义/引号很痛苦）
 * - `execute_script`：适合「需要一段较长的脚本」的场景——先落盘成文件，再用命令执行，
 *   执行完默认删除，避免污染工作目录。
 *
 * 审批：复用 `execute_command` 的审批机制（跟随 commandApprovalMode + 命令名风险分类）。
 * 沙盒：写文件走 securityService.resolveSafePath(mode='w')，超范围直接报错。
 */

import * as tauriFs from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'

import { toolRegistry } from '@/domain/tools'
import {
  UserInteractionRequired,
  type ToolContext,
  type ToolExecutor,
  type ToolResult,
} from '@/domain/tools/types'
import { t, tpl } from '@/ui/i18n'
import { securityService } from '@/services/security-service'
import { settingsState } from '@/ui/store'
import { registerPendingApproval } from './command-approval'
import { classifyCommand, getRiskInfo, runCommand } from './execute-command'

/**
 * ===== 平台探测（与 execute_command 对齐）=====
 * 主来源：Rust os_platform；UA 仅兜底。
 */

/** UA 启发式兜底 */
function platformFromUA(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
}

let _platform: string | undefined

async function detectPlatform(): Promise<string> {
  if (_platform) return _platform
  try {
    _platform = await invoke<string>('os_platform')
  } catch {
    _platform = platformFromUA()
  }
  return _platform
}

function platformSnapshot(): string {
  return _platform || platformFromUA()
}

void detectPlatform()

/** 平台特定的 command 参数描述（与 execute_command 对齐）。 */
function buildCommandDescription(platform: string): string {
  if (platform === 'windows') {
    return (
      '用于执行脚本文件的命令（PowerShell 语法），如 "node script.js"、"python task.py"、".\\run.ps1"。' +
      '命令中请引用 file_path 指定的脚本文件；支持管道、重定向、分号顺序执行，不支持 && / ||。'
    )
  }
  if (platform === 'macos') {
    return (
      '用于执行脚本文件的命令（zsh 语法），如 "node script.js"、"python task.py"、"bash run.sh"。' +
      '命令中请引用 file_path 指定的脚本文件；支持 &&/|| 串联、管道、重定向。'
    )
  }
  return (
    '用于执行脚本文件的命令（sh/POSIX 语法），如 "node script.js"、"python task.py"、"sh run.sh"。' +
    '命令中请引用 file_path 指定的脚本文件；支持 &&/|| 串联、管道、重定向。'
  )
}

toolRegistry.register(
  {
    name: 'execute_script',
    label: t('执行脚本'),
    description: () =>
      'Create a script file (file_path + file_content), then execute it with a shell command, ' +
      'and by default delete the script file right after execution (end_del_file=true). ' +
      'Use this instead of execute_command when the code to run is long/multi-line and awkward to inline. ' +
      'The file is written through the same sandbox check as write_file; the command goes through the same approval flow as execute_command. ' +
      '结果首行是「终端环境」提示；退出码 >= 2 表示命令执行失败。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            '脚本文件路径（相对 workspace 或绝对路径），如 "temp/run.js"。写入前会做沙盒校验。',
        },
        file_content: {
          type: 'string',
          description: '脚本文件内容（完整覆盖写入）。父目录不存在会自动创建。',
        },
        command: {
          type: 'string',
          description: () => buildCommandDescription(platformSnapshot()),
        },
        tips: {
          type: 'string',
          description:
            '简要说明这条命令的作用和执行原因（用用户的语言）。会显示在 UI 上，帮助用户理解命令的目的。',
        },
        timeout: {
          type: 'number',
          description: '超时时间（秒）。超过该时间进程会被强制终止。默认 30。',
          default: 30,
        },
        end_del_file: {
          type: 'boolean',
          description:
            '执行完（含失败/超时）是否立即删除脚本文件。默认 true。设为 false 可保留脚本以便排查。',
          default: true,
        },
      },
      required: ['file_path', 'file_content', 'command'],
    },
  },
  (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult | UserInteractionRequired> => {
    if (!tauriFs) throw t('[execute_script] 错误：当前不是 Tauri 环境')

    const filePath = args.file_path as string
    const content = String(args.file_content ?? '')
    const command = args.command as string
    const tips = args.tips as string | undefined
    const endDelFile = args.end_del_file !== false // 默认 true
    const rawTimeout = Number(args.timeout ?? 30)
    let timeout = Number.isFinite(rawTimeout) ? rawTimeout : 30
    if (timeout < 0) timeout = 30
    if (timeout > 300) timeout = 300
    const timeoutMs = timeout * 1000

    if (!filePath) throw t('错误：请提供 file_path 参数')
    if (!command) throw t('错误：请提供 command 参数')

    const fullPath = await securityService.resolveSafePath(
      filePath,
      'w',
      ctx.sessionId,
    )
    const cwd = await securityService.getWorkspace(ctx.sessionId)

    // 目标文件已存在则驳回，避免覆盖既有文件
    if (await tauriFs.exists(fullPath).catch(() => false)) {
      throw tpl('错误：脚本文件已存在，已驳回以免覆盖 — $__path__', {
        path: fullPath,
      })
    }

    // 写文件 → 执行命令 → （可选）删除文件
    const writeRunDelete = async (): Promise<ToolResult> => {
      await writeScriptFile(fullPath, content)

      ctx.write(`> ${command}\n`)

      try {
        const result = await runCommand(
          command,
          cwd,
          timeoutMs,
          ctx,
          'execute_script',
        )
        if (endDelFile) {
          const note = await deleteScriptFile(fullPath)
          return {
            content: result.content + '\n' + note,
            uiData: { ...(result.uiData ?? {}), note },
          }
        }
        return result
      } catch (e) {
        // 执行失败/超时/取消：也照常清理脚本，避免残留
        if (endDelFile) {
          await deleteScriptFile(fullPath).catch(() => {})
        }
        throw e
      }
    }

    // 沙盒模式判定：沙盒开启（默认 on）或只读（readonly）时已有 OS 级隔离，
    // 无需再弹窗；仅「完全访问模式」（off）才强制确认。
    const sandboxMode = settingsState.value.sandboxMode ?? 'on'
    if (sandboxMode !== 'off') {
      return writeRunDelete()
    }

    // 无沙盒保护 → 强制弹窗审批：脚本内容无法静态分析，一律交由用户确认。
    const risk = classifyCommand(command)
    const info = getRiskInfo(risk)
    const label = risk === 'safe' ? t('执行脚本') : info.label
    const hint = info.hint || t('此操作会创建并执行脚本文件，请确认是否允许')
    const approvalId = registerPendingApproval({
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      run: writeRunDelete,
    })
    return new UserInteractionRequired('confirm_command', {
      approvalId,
      command,
      risk,
      label,
      hint,
      tips,
    })
  }) as ToolExecutor,
)

/** 写入脚本文件（自动创建父目录） */
async function writeScriptFile(
  fullPath: string,
  content: string,
): Promise<void> {
  try {
    const normalizedPath = fullPath.replace(/\\/g, '/')
    const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
    if (parent) {
      await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
    }
    await tauriFs.writeTextFile(fullPath, content)
  } catch (e: any) {
    throw tpl('错误：写入脚本文件失败 — $__error__', {
      error: e?.message || String(e),
    })
  }
}

/** 删除脚本文件（移至回收站），返回 UI 提示文本 */
async function deleteScriptFile(fullPath: string): Promise<string> {
  try {
    await invoke('move_to_trash', { path: fullPath })
    return tpl('🗑️ 已删除脚本文件: $__path__', { path: fullPath })
  } catch (e: any) {
    return tpl('⚠️ 脚本文件删除失败: $__path__ — $__error__', {
      path: fullPath,
      error: e?.message || String(e),
    })
  }
}
