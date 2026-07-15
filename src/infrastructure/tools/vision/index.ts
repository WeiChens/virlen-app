import { toolRegistry } from '@/domain/tools'
import { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { vision } from '@/infrastructure/vision'
import { securityService } from '@/services/security-service'
import { tpl } from '@/ui/i18n'
import * as tauriFs from '@tauri-apps/plugin-fs'

// ══════════════════════════════════════════════════════════════════════
// Tool: vision_analyze — 全能视觉分析
// UI 检测 + OCR 文字识别 + 图标分类 + 物体检测 合并输出 tree text
// ══════════════════════════════════════════════════════════════════════

toolRegistry.register(
  {
    name: 'vision_analyze',
    label: '视觉分析',
    description: `对图片进行完整的视觉分析，一次调用返回所有检测结果：
【UI 元素检测】检测按钮(Button)、图标(Icon)、图片(Image)、文本块(Text)、容器(Block)等
【文字识别(OCR)】识别图片中所有文字内容
【图标识别】识别 81 种常见图标含义
【物体检测】识别 254 类日常物体（人、车、手机、食物、动物等），带父子包含关系
输出格式为 tree text，坐标格式 [x,y w×h]。
适合分析ui截屏、自然照片等。`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '图片文件的绝对路径或相对路径。',
        },
      },
      required: ['path'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const sourcePath = await securityService.resolveSafePath(
      args.path as string,
      'r',
      ctx.sessionId,
    )
    const exists = await tauriFs.exists(sourcePath)
    if (!exists) {
      return {
        content: tpl('错误：源路径不存在 — $__path__', { path: sourcePath }),
      }
    }
    const result = await vision.analyze(sourcePath)
    // 直接返回合并后的 tree text（纯文本，最省 token）
    return {
      content: result.combined_text,
    }
  }) as ToolExecutor,
)
