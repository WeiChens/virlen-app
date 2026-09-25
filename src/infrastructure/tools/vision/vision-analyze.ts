/**
 * vision_analyze — 全能视觉分析（端侧推理，图片不出本机）
 *
 * UI 检测 + OCR 文字识别 + 图标分类 + 物体检测 合并输出 tree text。
 */
import { toolRegistry } from '@/domain/tools'
import { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { vision } from '@/infrastructure/vision'
import { securityService } from '@/services/security-service'
import { t } from '@/ui/i18n'
import * as tauriFs from '@tauri-apps/plugin-fs'

toolRegistry.register(
    'vision_analyze',
    (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const sourcePath = await securityService.resolveSafePath(
      args.path as string,
      'r',
      ctx.sessionId,
    )
    const exists = await tauriFs.exists(sourcePath)
    if (!exists) {
      return {
        content: `Error: source path does not exist — ${sourcePath}`,
      }
    }
    const result = await vision.analyze(sourcePath)
    // 直接返回合并后的 tree text（纯文本，最省 token）
    return {
      content: result.combined_text,
    }
  }) as ToolExecutor,
    t('视觉分析'),
)
