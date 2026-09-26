/**
 * execute_script — 创建脚本文件并执行，可选执行后立即删除
 *
 * 与 `execute_command` 的分工：后者执行一条内联 shell 命令（多行脚本在内联时转义 / 引号很痛苦），本工
 * 具适合「需要一段较长的脚本」—— 先落盘成文件再执行，执行完默认删除，避免污染工作目录。
 *
 * 审批：独立门禁 `script.execute`（与终端命令风险分类无关）；申请不使用沙盒（`sandbox:"off"`）时另过
 * 「沙盒脱壳·脚本执行」门禁（取更严格者）；命中「忽略沙盒命令」规则（设置 → 安全）时免脱壳审批并强制
 * 无沙盒执行。写文件走 `securityService.resolveSafePath(mode='w')`，超范围直接报错。
 *
 * ⚠️ 规则语义与 Rust 原生路径（`execute_script.rs`）对齐，匹配对象是**运行命令**（不是脚本正文）。
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
import { track } from '@/utils/telemetry'
import {
  SANDBOX_BYPASS_HINT,
  SANDBOX_RULE_BYPASS_HINT,
  classifyCommand,
  detectPlatform,
  getRiskInfo,
  registerPendingApproval,
  runCommand,
} from './common'

// 工具描述（含三平台变体）已收敛到权威源（机制 C）：
// src-tauri/virlen-core/src/agent/tool_defs/definitions.json —— 见 docs/rust-engine.md §12。

toolRegistry.register(
    'execute_script',
    (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult | UserInteractionRequired> => {
    if (!tauriFs)
      throw '[execute_script] Error: not running in a Tauri environment'

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

    // ⚠️ 以下报错为模型侧文案：固定英文，与 Rust `execute_script.rs` 逐字对齐（铁律 1）。
    if (!filePath) throw 'Missing required parameter: "file_path"'
    if (!command) throw 'Missing required parameter: "command"'

    const fullPath = await securityService.resolveSafePath(
      filePath,
      'w',
      ctx.sessionId,
    )
    const cwd = await securityService.getWorkspace(ctx.sessionId)

    // sandbox: 'off' → 申请「不使用沙盒」执行脚本（与 execute_command 同语义）。
    const aiRequestedBypass = ['off', 'none'].includes(
      String(args.sandbox ?? '').toLowerCase(),
    )
    const sandboxMode = settingsState.value.sandboxMode ?? 'on'
    // 只读模式禁止 AI 显式申请绕过沙盒（与 Rust 原生路径一致）。
    // ⚠️ 但只针对 AI 的显式申请：命中「忽略沙盒命令」规则时只读模式静默忽略规则（脚本继续走沙盒）。
    if (aiRequestedBypass && sandboxMode === 'readonly') {
      throw new Error(
        'The sandbox is in read-only mode, so bypassing it to run a script is not allowed; switch the sandbox mode in settings first (or use a regular terminal)',
      )
    }
    // 「忽略沙盒命令」规则（设置 → 安全）：命中即**免脱壳审批 + 强制无沙盒执行**。
    // 匹配对象是**运行命令**（如 node temp/run.js），不是脚本正文（与 Rust 侧一致）。
    const ruleHit =
      sandboxMode === 'on'
        ? await securityService.matchSandboxIgnoreRule(command)
        : null
    const bypassSandbox = aiRequestedBypass || !!ruleHit
    if (ruleHit) {
      // 留痕（只记工具名 / 原因，不记命令正文与规则名，遵循 §9）
      track('tool.sandbox.bypass', {
        tool_name: 'execute_script',
        status: 'auto_rule',
      })
    }

    // 目标文件已存在则驳回，避免覆盖既有文件
    if (await tauriFs.exists(fullPath).catch(() => false)) {
      throw `Error: the script file already exists; refusing to overwrite it — ${fullPath}`
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
            content: result.content + '\n' + note.text,
            uiData: {
              ...(result.uiData ?? {}),
              // note：模型侧 + 旧消息回退用的英文文本；其余三个字段供 UI 本地化渲染
              note: note.text,
              noteKind: note.kind,
              notePath: note.path,
              ...(note.error ? { noteError: note.error } : {}),
            },
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

    // 权限：脚本执行独立门禁（script.execute，默认每次弹窗；与命令风险分类无关）
    const base = await securityService.getPermissionDecision(PERM_SCRIPT)
    // 申请绕过沙盒且沙盒启用 → 额外过「沙盒脱壳·脚本执行」权限（与脚本权限取更严格者）
    const configuredEscape =
      bypassSandbox && sandboxMode !== 'off'
        ? await securityService.getPermissionDecision(PERM_SANDBOX_SCRIPT)
        : undefined
    // 命中规则 → 用户已用规则预先授权脱壳（ask 视作 allow）；⚠️ deny 优先
    const escapeDecision =
      ruleHit && configuredEscape === 'ask' ? 'allow' : configuredEscape
    const decision = resolveCommandDecision(base, { escapeDecision })
    if (decision === 'deny') {
      // 禁止：不执行、不弹窗，返回拒绝文本给模型（标明是哪个权限拦下的）
      const deniedPerm =
        escapeDecision === 'deny' ? PERM_SANDBOX_SCRIPT : PERM_SCRIPT
      // 只报**权限 name**（与设置页一一对应的稳定 key）：语言无关，
      // 且与 Rust 原生实现逐字对齐
      throw new Error(
        `Operation denied by the permission settings: ${deniedPerm}`,
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
    // 追加沙盒脱壳警告（让用户看到后果）：命中规则时说明「为什么没申请也脱壳了」
    const hint = ruleHit
      ? [baseHint, tpl(SANDBOX_RULE_BYPASS_HINT, { rule: ruleHit.name })]
          .filter(Boolean)
          .join('\n')
      : bypassSandbox
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
      // ⚠️ 正文展示脚本内容（用户据此判断是否放行），运行命令放在 command 作说明
      desc: content,
      command,
      hint,
      risk,
    }
    if (bypassSandbox) payload.sandboxBypass = true
    return new UserInteractionRequired('confirm_command', payload)
  }) as ToolExecutor,
    t('执行脚本'),
)

/** Windows 上会按「系统 ANSI 代码页」解析无 BOM 脚本的 shell 扩展名（PowerShell 脚本） */
const PS_SCRIPT_EXT = /\.ps(m)?1$/i

/**
 * 给脚本内容加 UTF-8 BOM（幂等）—— 与 Rust 侧 `with_script_bom` 等价。
 *
 * 必须加：PowerShell 5.1 读无 BOM 的 .ps1 时不猜 UTF-8，而按系统 ANSI 代码页
 * （中文系统 CP936/GBK）解析，中文字面量在解析阶段就已乱码（"脚本" → "鑴氭湰"），
 * 之后设 `[Console]::OutputEncoding` 也还原不回来（问题在输入端）。带 BOM 即按 UTF-8 解析。
 *
 * 只对 Windows 的 .ps1/.psm1 生效：.sh 加 BOM 会让 shebang 失效，.js/.py 虽能容忍但没必要。
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
    throw `Error: failed to write the script file — ${e?.message || String(e)}`
  }
}

/** 脚本删除结果：模型侧英文文本 + 供 UI 按界面语言渲染的结构化字段。 */
interface ScriptDeleteNote {
  /** 模型侧文本（与 Rust 侧 `delete_script_file` 逐字对齐） */
  text: string
  kind: 'deleted' | 'delete_failed'
  path: string
  error?: string
}

/** 删除脚本文件（移至回收站），返回模型侧文本 + 结构化字段（UI 侧本地化渲染） */
async function deleteScriptFile(fullPath: string): Promise<ScriptDeleteNote> {
  try {
    await invoke('move_to_trash', { path: fullPath })
    return {
      text: `🗑️ Script file deleted: ${fullPath}`,
      kind: 'deleted',
      path: fullPath,
    }
  } catch (e: any) {
    const error = e?.message || String(e)
    return {
      text: `⚠️ Failed to delete the script file: ${fullPath} — ${error}`,
      kind: 'delete_failed',
      path: fullPath,
      error,
    }
  }
}
