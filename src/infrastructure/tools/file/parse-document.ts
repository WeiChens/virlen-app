/**
 * parse_document — 文档解析（PDF / Word / Excel / PowerPoint / CSV / 纯文本）
 *
 * ⚠️ 已原生化：Rust 引擎走 `native_tools/file/parse_document.rs`（默认路径，自己走
 * `resolve_safe_path`），本文件只是**回退 / 浏览器 dev 路径**。解析的唯一实现在 core `doc_parse`，
 * 组装版式在 core 的 `parse_targets`（与工具同一条链）→ 这里**只做转发**，不存在第二份文案（铁律 1）。
 *
 * 与 `read_file` 同一种约定：路径先在**前端**过安全校验（`securityService.resolveSafePath`，
 * 相对路径按会话工作目录展开），命令只认已经校验过的绝对路径。
 * `outTxtFile`（选填）同样先校验，但用**写模式**（`'w'`，与原生工具 `resolve_safe_path(.., "w", ..)`
 * 等价）：白名单 + 工作目录，黑名单优先。
 */
import { invoke } from '@tauri-apps/api/core'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { t } from '@/ui/i18n'

// 工具描述已收敛到权威源（机制 C）：src-tauri/virlen-core/src/agent/tool_defs/definitions.json

/** `cmd_parse_document` 的返回（与 Rust `ParsedDocumentResult` 一致） */
interface ParsedDocumentResult {
  content: string
  uiData: any
  ok: boolean
}

toolRegistry.register(
  'parse_document',
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    // 与原生工具同口径：`paths` 优先，`path` 是单文件写法
    const paths: string[] = Array.isArray(args.paths)
      ? (args.paths as any[]).filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        )
      : []
    const single =
      typeof args.path === 'string' && args.path.trim() !== ''
        ? [args.path as string]
        : []
    const inputs = paths.length > 0 ? paths : single
    if (inputs.length === 0) {
      throw 'Missing required parameter: "path" or "paths"'
    }

    // 相对路径按工作目录展开 + 黑名单 / 白名单校验（前端这一侧与原生工具两侧规则必须等价）
    const resolved: string[] = []
    for (const p of inputs) {
      resolved.push(await securityService.resolveSafePath(p, 'r', ctx.sessionId))
    }

    // 输出文件（选填）：全文落盘的目标路径，**写模式**校验（与原生工具的 `resolve_safe_path("w")` 等价）
    let outTxtFile: string | undefined
    if (typeof args.outTxtFile === 'string' && args.outTxtFile.trim() !== '') {
      outTxtFile = await securityService.resolveSafePath(
        args.outTxtFile,
        'w',
        ctx.sessionId,
      )
    }

    const out = await invoke<ParsedDocumentResult>('cmd_parse_document', {
      paths: resolved,
      sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
      maxChars: typeof args.max_chars === 'number' ? args.max_chars : undefined,
      offset: typeof args.offset === 'number' ? args.offset : undefined,
      outTxtFile,
    })

    // 全部失败 → 按失败抛出（与原生工具 `NativeToolOutcome::Error` 同语义）
    if (!out.ok) throw out.content
    return { content: out.content, uiData: out.uiData }
  }) as ToolExecutor,
  t('解析文档'),
)
