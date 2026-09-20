/**
 * execute_script — 创建脚本文件并执行，可选执行后立即删除
 *
 * 与 `execute_command` 的分工：
 * - `execute_command`：执行一条内联 shell 命令（复杂多行脚本在内联时转义/引号很痛苦）
 * - `execute_script`：适合「需要一段较长的脚本」的场景——先落盘成文件，再用命令执行，
 *   执行完默认删除，避免污染工作目录。
 *
 * 审批：独立门禁 script.execute（允许 / 每次弹窗 / 禁止），与终端命令风险分类无关。
 * 申请不使用沙盒（sandbox:"off"）时另过「沙盒脱壳·脚本执行」门禁（与脚本权限取更严格者）。
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
import {
  PERM_SANDBOX_SCRIPT,
  PERM_SCRIPT,
  permissionLabel,
  resolveCommandDecision,
} from '@/domain/permission'
import { settingsState } from '@/ui/store'
import {
  SANDBOX_BYPASS_HINT,
  classifyCommand,
  detectPlatform,
  getRiskInfo,
  platformSnapshot,
  registerPendingApproval,
  runCommand,
} from './common'

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
        sandbox: {
          type: 'string',
          enum: ['off'],
          description:
            '默认不传（继承设置里的沙盒模式）。传 "off" 表示**申请**不使用沙盒执行脚本，' +
            '仅用于沙盒下必然失败的场景（脚本内的子进程需要用管道 stdio 拉起孙进程等）。' +
            '该请求按「沙盒脱壳·脚本执行」权限决策（默认弹窗确认）；沙盒为只读模式时会被直接拒绝。',
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

    // sandbox: 'off' → 申请「不使用沙盒」执行脚本（与 execute_command 同语义）。
    const bypassSandbox = ['off', 'none'].includes(
      String(args.sandbox ?? '').toLowerCase(),
    )
    const sandboxMode = settingsState.value.sandboxMode ?? 'on'
    // 只读模式禁止绕过沙盒（与 Rust 原生路径一致）
    if (bypassSandbox && sandboxMode === 'readonly') {
      throw new Error(
        t(
          '沙盒处于只读模式，不支持绕过沙盒执行脚本；请先在设置中切换沙盒模式（或改用常规终端）',
        ),
      )
    }

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
          { bypassSandbox },
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
          await deleteScriptFile(fullPath).catch(() => { })
        }
        throw e
      }
    }

    // 权限：脚本执行独立门禁（script.execute，默认每次弹窗；与命令风险分类无关）
    const base = await securityService.getPermissionDecision(PERM_SCRIPT)
    // 申请绕过沙盒且沙盒启用 → 额外过「沙盒脱壳·脚本执行」权限（与脚本权限取更严格者）
    const escapeDecision =
      bypassSandbox && sandboxMode !== 'off'
        ? await securityService.getPermissionDecision(PERM_SANDBOX_SCRIPT)
        : undefined
    const decision = resolveCommandDecision(base, { escapeDecision })
    if (decision === 'deny') {
      // 禁止：不执行、不弹窗，返回拒绝文本给模型（标明是哪个权限拦下的）
      const deniedPerm =
        escapeDecision === 'deny' ? PERM_SANDBOX_SCRIPT : PERM_SCRIPT
      throw new Error(
        tpl('操作已被权限设置禁止：$__perm__', {
          perm: t(permissionLabel(deniedPerm)),
        }),
      )
    }
    if (decision === 'allow') {
      return writeRunDelete()
    }

    // ask → 弹窗审批：脚本内容无法静态分析，一律交由用户确认。
    const risk = classifyCommand(command)
    const info = getRiskInfo(risk)
    const baseHint =
      info.hint || t('此操作会创建并执行脚本文件，请确认是否允许')
    // 申请绕过沙盒：追加警告，让用户看到后果
    const hint = bypassSandbox
      ? [baseHint, t(SANDBOX_BYPASS_HINT)].filter(Boolean).join('\n')
      : baseHint
    // 触发本次确认的权限（同上：仅因沙盒脱壳时展示脱壳权限）
    const shownPerm =
      bypassSandbox && base === 'allow' && escapeDecision === 'ask'
        ? PERM_SANDBOX_SCRIPT
        : PERM_SCRIPT
    const approvalId = registerPendingApproval({
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      run: writeRunDelete,
    })
    const payload: Record<string, any> = {
      approvalId,
      // 通用授权字段（弹窗展示）
      permName: shownPerm,
      title: t(permissionLabel(shownPerm)),
      subTitle: tips,
      // ⚠️ 正文展示**脚本内容**（用户据此判断是否放行），运行命令放在 command 作说明
      desc: content,
      command,
      hint,
      risk,
    }
    if (bypassSandbox) payload.sandboxBypass = true
    return new UserInteractionRequired('confirm_command', payload)
  }) as ToolExecutor,
)

/** Windows 上会按「系统 ANSI 代码页」解析无 BOM 脚本的 shell 扩展名（PowerShell 脚本） */
const PS_SCRIPT_EXT = /\.ps(m)?1$/i

/**
 * 给脚本内容加 UTF-8 BOM（幂等）—— 与 Rust 侧 `with_script_bom` 等价。
 *
 * ⚠️ 为什么必须加：Windows PowerShell 5.1 读取**无 BOM** 的 .ps1 时不猜 UTF-8，
 * 而是按**系统 ANSI 代码页**（中文系统 CP936/GBK）解析源文件，脚本里的中文字面量
 * 在「解析阶段」就已经变成乱码（"脚本" → "鑴氭湰"）—— 之后无论怎么设置
 * `[Console]::OutputEncoding` 都还原不回来（输出侧本来就是对的，问题在输入端）。
 * 带 BOM 后 5.1 会按 UTF-8 解析，中文正常。
 *
 * 只对 Windows 上的 .ps1/.psm1 生效：其它脚本加 BOM 有害（.sh 的 shebang 会失效，
 * .js/.py 虽能容忍但没必要）。
 *
 * @param filePath 脚本完整路径（按扩展名判定是否需要 BOM）
 * @param platform Rust `os_platform` 返回值（windows / macos / linux）
 */
export function applyScriptBom(
  filePath: string,
  content: string,
  platform: string,
): string {
  if (platform !== 'windows' || !PS_SCRIPT_EXT.test(filePath)) return content
  return content.startsWith('\uFEFF') ? content : '\uFEFF' + content
}

/** 写入脚本文件（自动创建父目录） */
async function writeScriptFile(
  fullPath: string,
  content: string,
): Promise<void> {
  try {
    const normalizedPath = fullPath.replace(/\\/g, '/')
    const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
    if (parent) {
      await tauriFs.mkdir(parent, { recursive: true }).catch(() => { })
    }
    // PowerShell 脚本需要 UTF-8 BOM，否则 5.1 会按 GBK 解析导致中文乱码（见 applyScriptBom）
    await tauriFs.writeTextFile(
      fullPath,
      applyScriptBom(fullPath, content, await detectPlatform()),
    )
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
