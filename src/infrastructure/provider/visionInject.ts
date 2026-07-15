/**
 * 在 buildRequest 中处理 vision_analyze 优化逻辑
 *
 * 当 Message 标记了 imageVisionAnalyzeOptimize=true 时：
 *   - 移除 image_url 块（不把原始 base64 图片发给 LLM）
 *   - 追加 vision_analyze 分析结果文本块
 * 否则：不做任何处理，content 原样发送
 *
 * imageVisionAnalyzeResult 格式（由 doSend 构建）：
 *   用户上传了{N}张图片
 *
 *   第1张图片
 *   [分析结果]
 *
 *   第2张图片
 *   [分析结果]
 *   ...
 */
import type { Message, TextContent, ImageContent } from '@/types'

type ContentBlock = TextContent | ImageContent

/**
 * 处理消息的 content，返回适合发送给 LLM 的 blocks
 *
 * @returns 处理后的 blocks，或 null 表示无需变更
 */
export function processVisionContent(
  msg: Message,
): ContentBlock[] | null {
  // 仅处理 user 消息且开启了优化且有分析结果
  if (
    msg.role !== 'user' ||
    !msg.imageVisionAnalyzeOptimize ||
    !msg.imageVisionAnalyzeResult
  ) {
    return null
  }

  // 确保 content 是数组格式
  const blocks: ContentBlock[] = Array.isArray(msg.content)
    ? (msg.content as ContentBlock[])
    : typeof msg.content === 'string' && msg.content
      ? [{ type: 'text' as const, text: msg.content }]
      : []

  // 过滤掉 image_url 块
  const filtered = blocks.filter((b) => b.type !== 'image_url')

  // 直接注入分析结果（已由 doSend 按多图格式组装好）
  filtered.push({
    type: 'text',
    text: `\n\n${msg.imageVisionAnalyzeResult}`,
  })

  return filtered
}
