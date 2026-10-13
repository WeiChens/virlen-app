/**
 * session-text — 会话消息的纯文本投影（「导入知识库」功能共用）。
 *
 * 两处都要用：整会话导出（`sidebar/index.tsx::formatSessionForKB`）与弹窗里的消息预览行。
 * 从 sidebar 里提出来共用一份，是因为「什么才算正文」的口径必须一致 ——
 * 预览里看得见的文字，导入后一定在文档里（两处各写一份必然漂移）。
 */

/** 从 MessageContent 中提取纯文本 */
export function extractPlainText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c: any) =>
        c.type === 'text' || (c.type === 'tool_result' && typeof c.content === 'string'),
    )
    .map((c: any) => (c.type === 'text' ? c.text : c.content))
    .join('\n\n')
}
