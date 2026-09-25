/**
 * file_info — 获取文件/目录元信息（类型、大小、访问/修改时间）
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { formatSize, isTauriFsAvailable } from './common'

/** 本地时间格式 %Y-%m-%d %H:%M:%S（与 Rust `format_system_time` 一致） */
function formatSystemTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

toolRegistry.register(
    'file_info',
    (async (
      args: Record<string, any>,
      ctx: ToolContext,
    ): Promise<ToolResult | string> => {
    if (!isTauriFsAvailable())
      return '[file_info] Error: not running in a Tauri environment'

    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'r',
      ctx.sessionId,
    )

    try {
      const exists = await tauriFs.exists(fullPath)
      if (!exists) return `Error: path does not exist — ${fullPath}`

      const stat = await tauriFs.stat(fullPath)
      const atimeMs = stat.atime ? stat.atime.getTime() : null
      const mtimeMs = stat.mtime ? stat.mtime.getTime() : null

      // ⚠️ 模型侧固定英文（P4b/D2-A）；UI 侧走 uiData 由组件按界面语言渲染。
      // 文案与 Rust `native_tools/file/file_info.rs` 逐字一致（铁律 1）。
      const content = [
        `📋 ${fullPath}`,
        `  Type: ${stat.isDirectory ? '📁 Directory' : '📄 File'}`,
        stat.size !== undefined ? `  Size: ${formatSize(stat.size)}` : '',
        atimeMs != null ? `  Accessed: ${formatSystemTime(new Date(atimeMs))}` : '',
        mtimeMs != null ? `  Modified: ${formatSystemTime(new Date(mtimeMs))}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      return {
        content,
        uiData: {
          path: fullPath,
          isDirectory: !!stat.isDirectory,
          sizeBytes: stat.size ?? null,
          atimeMs,
          mtimeMs,
        },
      }
    } catch (e: any) {
      return `Error: failed to get file info — ${e.message || String(e)}`
    }
  }) as ToolExecutor,
    t('文件信息'),
)
