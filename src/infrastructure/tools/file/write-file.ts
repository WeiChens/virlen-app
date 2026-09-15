/**
 * write_file — 写入（整文件覆盖）文件
 *
 * 自动创建父目录；返回归一化后内容的 hash10，可直接作为后续 edit_file 的 expected_hash。
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t, tpl } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { computeContentHash10, formatSize, isTauriFsAvailable } from './common'

toolRegistry.register(
  {
    name: 'write_file',
    label: t('写入文件'),
    description:
      'Write content to a file (full overwrite). Creates parent directories if they do not exist. ' +
      '⚠️ Use edit_file for partial modifications instead of reading and re-writing entire files. ' +
      'Returns the hash10 (short fingerprint) of the written content (normalized to LF), which can be used ' +
      'as expected_hash for subsequent edit_file calls.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (relative to workspace or absolute).',
        },
        content: { type: 'string', description: 'Content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!isTauriFsAvailable())
      throw t('[write_file] 错误：当前不是 Tauri 环境')

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

      const returnContent = existed
        ? tpl('✅ 已覆写文件 ($__size__): $__path__', {
            size,
            path: fullPath,
          })
        : tpl('✅ 已创建文件 ($__size__): $__path__', {
            size,
            path: fullPath,
          })

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
      throw tpl('错误：写入文件失败 — $__error__', {
        error: e.message || String(e),
      })
    }
  }) as ToolExecutor,
)
