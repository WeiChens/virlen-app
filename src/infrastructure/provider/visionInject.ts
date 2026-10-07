/**
 * 在 buildRequest 中处理 vision_analyze 优化逻辑：当 Message 标记 imageVisionAnalyzeOptimize=true 时，
 * 移除 image_url 块（不把原始 base64 发给 LLM）并追加分析结果文本块；否则原样发送。
 *
 * 注：file / quote / skill 不属于「图片内容」，原样保留，交由各 Provider 的 buildRequest 降级为文本。
 * imageVisionAnalyzeResult 格式（由 doSend 构建）：`用户上传了{N}张图片\n\n第1张图片\n[分析结果]\n...`
 */
import type {
  Message,
  TextContent,
  ImageContent,
  FileContent,
  QuoteContent,
  SkillContent,
} from '@/types'

type ContentBlock =
  | TextContent
  | ImageContent
  | FileContent
  | QuoteContent
  | SkillContent

/**
 * 处理消息 content，返回适合发给 LLM 的 blocks；返回 null 表示无需变更。
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
