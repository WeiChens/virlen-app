/**
 * 复制/移动文件工具 — copy_move_file
 *
 * 支持两种模式（默认 move）：
 *   - move: 使用 Tauri rename API 移动/重命名文件或目录
 *   - copy: 使用 Tauri copyFile API 复制文件（目前不支持目录复制）
 */
import { toolRegistry } from '@/domain/tools'
import type {
  ToolContext,
  ToolExecutor,
  ToolResult,
} from '@/domain/tools/types'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t, tpl } from '@/ui/i18n'
import { securityService } from '@/services/security-service'

toolRegistry.register(
  {
    name: 'copy_move_file',
    label: t('复制/移动文件'),
    description:
      'Copy or move a file or directory. ' +
      'By default moves (renames) the source to destination. ' +
      'Set mode="copy" to copy instead. ' +
      'Note: copy mode only supports files, not directories; use move mode for directories.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'Source file or directory path (relative to workspace or absolute).',
        },
        destination: {
          type: 'string',
          description:
            'Destination file or directory path (relative to workspace or absolute).',
        },
        mode: {
          type: 'string',
          description:
            'Operation mode: "move" (default) to move/rename, "copy" to copy.',
          enum: ['move', 'copy'],
          default: 'move',
        },
      },
      required: ['source', 'destination'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!tauriFs) throw '[copy_move_file] 错误：当前不是 Tauri 环境'

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

    try {
      // 检查源路径是否存在
      const exists = await tauriFs.exists(sourcePath)
      if (!exists) {
        return {
          content: tpl('错误：源路径不存在 — $__path__', { path: sourcePath }),
        }
      }

      // 检查目标路径是否已存在，避免误覆盖
      const destExists = await tauriFs.exists(destPath)
      if (destExists) {
        return {
          content: tpl(
            '错误：目标路径已存在 — $__path__，请先删除或选择其他路径',
            { path: destPath },
          ),
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
                t('无法跨设备移动目录，请先手动复制内容到目标设备后删除原目录'),
              )
            }
            // 文件跨设备移动：先复制再删除
            const normalizedDest = destPath.replace(/\\/g, '/')
            const parent = normalizedDest.substring(0, normalizedDest.lastIndexOf('/'))
            if (parent) {
              await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
            }
            await tauriFs.copyFile(sourcePath, destPath)
            await tauriFs.remove(sourcePath)
          } else {
            throw renameErr
          }
        }
        const type = stat.isDirectory ? t('目录') : t('文件')
        return {
          content: tpl('✅ 已移动 $__type__: $__source__\n   → $__dest__', {
            type,
            source: sourcePath,
            dest: destPath,
          }),
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
            content: t(
              '错误：暂不支持复制目录，请使用 move 模式移动目录，或逐个复制目录内的文件',
            ),
          }
        }

        // 确保目标父目录存在（兼容 Windows 反斜杠路径）
        const normalizedDest = destPath.replace(/\\/g, '/')
        const parent = normalizedDest.substring(0, normalizedDest.lastIndexOf('/'))
        if (parent) {
          await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
        }

        await tauriFs.copyFile(sourcePath, destPath)
        return {
          content: tpl('✅ 已复制文件: $__source__\n   → $__dest__', {
            source: sourcePath,
            dest: destPath,
          }),
          uiData: {
            mode: 'copy',
            source: sourcePath,
            destination: destPath,
            isDirectory: false,
          },
        }
      }
    } catch (e: any) {
      const opKey =
        mode === 'move'
          ? '错误：移动失败 — $__error__'
          : '错误：复制失败 — $__error__'
      throw tpl(opKey, { error: e.message || String(e) })
    }
  }) as ToolExecutor,
)
