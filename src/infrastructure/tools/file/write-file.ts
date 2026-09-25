/**
 * write_file — 写入（整文件覆盖）文件
 *
 * 自动创建父目录；返回归一化后内容的 hash10，可直接作为后续 edit_file 的 expected_hash。
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { computeContentHash10, formatSize, isTauriFsAvailable } from './common'

toolRegistry.register(
    'write_file',
    (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!isTauriFsAvailable())
      throw '[write_file] Error: not running in a Tauri environment'

    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'w',
      ctx.sessionId,
    )
    const content = args.content as string
    try {
      // 创建父目录（兼容 Windows 反斜杠路径）
      const normalizedPath = fullPath.replace(/\\/g, '/')
      const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
      if (parent) {
        await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
      }
      const existed = await tauriFs.exists(fullPath).catch(() => false)
      await tauriFs.writeTextFile(fullPath, content)

      // 计算归一化内容的 hash10，与 read_file/edit_file 一致
      const hash10 = await computeContentHash10(content)
      const lineCount = content.replace(/\r\n/g, '\n').split('\n').length
      const size = formatSize(new TextEncoder().encode(content).length)

      // ⚠️ 模型侧固定英文（P4b/D2-A）。
      // 文案与 Rust `native_tools/file/write_file.rs` 一致（铁律 1）。
      const returnContent = existed
        ? `✅ File overwritten (${size}): ${fullPath}`
        : `✅ File created (${size}): ${fullPath}`

      return {
        uiData: {
          hash10,
          fullPath,
          lineCount,
          byteSize: new TextEncoder().encode(content).length,
        },
        content: returnContent + `\n🔑 hash10: ${hash10}`,
      }
    } catch (e: any) {
      throw `Error: failed to write file — ${e.message || String(e)}`
    }
  }) as ToolExecutor,
    t('写入文件'),
)
