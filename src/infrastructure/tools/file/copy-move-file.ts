/**
 * copy_move_file — 复制/移动文件或目录
 *
 * 支持两种模式（默认 move）：
 *   - move: 使用 Tauri rename API 移动/重命名文件或目录（跨设备时文件回退 copy+remove）
 *   - copy: 使用 Tauri copyFile API 复制文件（目前不支持目录复制）
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t } from '@/ui/i18n'
import { securityService } from '@/services/security-service'
import { isTauriFsAvailable } from './common'

toolRegistry.register(
    'copy_move_file',
    (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!isTauriFsAvailable())
      throw '[copy_move_file] Error: not running in a Tauri environment'

    const sourcePath = await securityService.resolveSafePath(
      args.source as string,
      'r',
      ctx.sessionId,
    )
    const destPath = await securityService.resolveSafePath(
      args.destination as string,
      'w',
      ctx.sessionId,
    )
    const mode = (args.mode as string) || 'move'

    // ⚠️ 模型侧固定英文（P4b/D2-A）；UI 侧走 uiData。文案与 Rust
    // `native_tools/file/copy_move_file.rs` 逐字一致（铁律 1）。
    try {
      // 检查源路径是否存在
      const exists = await tauriFs.exists(sourcePath)
      if (!exists) {
        return {
          content: `Error: source path does not exist — ${sourcePath}`,
        }
      }

      // 检查目标路径是否已存在，避免误覆盖
      const destExists = await tauriFs.exists(destPath)
      if (destExists) {
        return {
          content: `Error: destination path already exists — ${destPath}; delete it first or pick another path`,
        }
      }

      const stat = await tauriFs.stat(sourcePath)

      if (mode === 'move') {
        // 移动/重命名 — rename 同时支持文件和目录
        try {
          await tauriFs.rename(sourcePath, destPath)
        } catch (renameErr: any) {
          // rename 跨设备会失败，此时尝试 copy+remove
          if (
            renameErr.message?.includes('cross-device') ||
            renameErr.message?.includes('跨设备')
          ) {
            if (stat.isDirectory) {
              throw new Error(
                'Error: cannot move a directory across devices; copy its contents manually and delete the original directory',
              )
            }
            // 文件跨设备移动：先复制再删除
            const normalizedDest = destPath.replace(/\\/g, '/')
            const parent = normalizedDest.substring(
              0,
              normalizedDest.lastIndexOf('/'),
            )
            if (parent) {
              await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
            }
            await tauriFs.copyFile(sourcePath, destPath)
            await tauriFs.remove(sourcePath)
          } else {
            throw renameErr
          }
        }
        const type = stat.isDirectory ? 'directory' : 'file'
        return {
          content: `✅ Moved ${type}: ${sourcePath}\n   → ${destPath}`,
          uiData: {
            mode: 'move',
            source: sourcePath,
            destination: destPath,
            isDirectory: stat.isDirectory,
          },
        }
      } else {
        // 复制模式
        if (stat.isDirectory) {
          return {
            content:
              'Error: copying directories is not supported yet; use the move mode to move a directory, or copy the files inside it one by one',
          }
        }

        // 确保目标父目录存在（兼容 Windows 反斜杠路径）
        const normalizedDest = destPath.replace(/\\/g, '/')
        const parent = normalizedDest.substring(
          0,
          normalizedDest.lastIndexOf('/'),
        )
        if (parent) {
          await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
        }

        await tauriFs.copyFile(sourcePath, destPath)
        return {
          content: `✅ File copied: ${sourcePath}\n   → ${destPath}`,
          uiData: {
            mode: 'copy',
            source: sourcePath,
            destination: destPath,
            isDirectory: false,
          },
        }
      }
    } catch (e: any) {
      throw `Error: ${mode === 'move' ? 'move' : 'copy'} failed — ${e.message || String(e)}`
    }
  }) as ToolExecutor,
    t('复制/移动文件'),
)
