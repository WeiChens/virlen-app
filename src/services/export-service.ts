/**
 * export-service — 会话导出服务层
 *
 * 将会话导出为 Markdown 文件。
 * 包含格式转换、文件保存等业务逻辑，不依赖持久层以外的底层模块。
 */
import { t, tpl, getCurrentLanguage } from '@/ui/i18n'
import type {
  Session,
  MessageContent,
  TextContent,
  ImageContent,
  ToolResultContent,
} from '@/types'
import { sessionStore } from '@/ui/store'
import { agentRepo } from '@/infrastructure/agentRepo'

// ==================== 导出选项 ====================

export interface ExportOptions {
  /** 是否省略工具调用信息（tool_use + tool_result） */
  omitToolCalls: boolean
  /** 是否省略思考文本（reasoningContent） */
  omitThinking: boolean
}

const DEFAULT_OPTIONS: ExportOptions = {
  omitToolCalls: false,
  omitThinking: false,
}

// ==================== 文本提取辅助 ====================

/** 从 MessageContent 中提取纯文本 */
function extractText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter(
      (c): c is TextContent | ToolResultContent =>
        c.type === 'text' ||
        (c.type === 'tool_result' && typeof c.content === 'string'),
    )
    .map((c) => (c.type === 'text' ? c.text : c.content))
    .join('\n\n')
}

/** 从 MessageContent 中提取图片 */
function extractImages(content: MessageContent): ImageContent[] {
  if (typeof content === 'string') return []
  return content.filter((c): c is ImageContent => c.type === 'image_url')
}

// ==================== Markdown 转换 ====================

/**
 * 将会话转换为 Markdown 字符串
 */
export function sessionToMarkdown(
  session: Session,
  options: ExportOptions = DEFAULT_OPTIONS,
): string {
  const lines: string[] = []

  // ---------- 文件头部 ----------
  lines.push(`# ${session.title}`)
  lines.push('')
  const dateStr = new Date().toLocaleString(getCurrentLanguage(), {
    hour12: false,
  })
  lines.push(tpl('> 导出时间：$__date__', { date: dateStr }))
  lines.push(tpl('> 模型：$__model__', { model: session.modelId || t('未知') }))
  if (session.agentId) {
    const agent = agentRepo.load().agents.find((a) => a.id === session.agentId)
    if (agent) lines.push(tpl('> Agent：$__name__', { name: agent.name }))
  }
  lines.push(tpl('> 消息数：$__count__', { count: session.messages.length }))
  lines.push('')
  lines.push('---')
  lines.push('')

  // ---------- 逐条消息 ----------
  for (const msg of session.messages) {
    const roleLabel =
      msg.role === 'user'
        ? '### 👤 User'
        : msg.role === 'assistant'
          ? '### 🤖 Assistant'
          : msg.role === 'tool'
            ? '### 🔧 Tool Call'
            : msg.role === 'summary'
              ? `### 📋 ${t('上下文摘要')}`
              : '### 📝 System'

    lines.push(roleLabel)
    lines.push('')

    // 1) 思考内容（reasoning）
    if (msg.reasoningContent && !options.omitThinking) {
      lines.push('> 💭 思考过程')
      lines.push('>')
      for (const line of msg.reasoningContent.split('\n')) {
        lines.push(`> ${line}`)
      }
      lines.push('')
    }

    // 2) 文本内容
    const text = extractText(msg.content)
    if (text) {
      lines.push(text)
      lines.push('')
    }

    // 3) 图片
    const images = extractImages(msg.content)
    for (const img of images) {
      lines.push(`![图片](${img.image_url.url})`)
      lines.push('')
    }

    // 4) 工具调用（assistant 消息的 toolCalls 字段）
    if (
      msg.role === 'assistant' &&
      msg.toolCalls &&
      msg.toolCalls.length > 0 &&
      !options.omitToolCalls
    ) {
      for (const tc of msg.toolCalls) {
        lines.push(`**工具调用：\`${tc.name}\`**`)
        lines.push('')
        lines.push('```json')
        lines.push(JSON.stringify(tc.input, null, 2))
        lines.push('```')
        lines.push('')
      }
    }

    // 5) Tool 角色时标记来源（tool_use_id）
    if (msg.role === 'tool' && msg.content && !options.omitToolCalls) {
      const toolText = extractText(msg.content)
      if (toolText) {
        if (msg.isError) {
          const errLabel = msg.toolCallId
            ? tpl('**⚠️ 执行失败**（ID: $__id__）', { id: msg.toolCallId })
            : t('**⚠️ 执行失败**')
          lines.push(errLabel)
          lines.push('')
        }
        lines.push(toolText)
        lines.push('')
      }
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

// ==================== 文件写入 ====================

/**
 * 导出会话到 Markdown 文件
 *
 * 流程：
 *  1. 获取会话数据
 *  2. 转为 Markdown
 *  3. 弹出 Tauri 保存对话框
 *  4. 写入 .md 文件
 *
 * @param sessionId  会话 ID
 * @param options    导出选项
 * @returns 保存的文件路径，取消返回 null
 */
export async function exportSessionToFile(
  sessionId: string,
  options: ExportOptions = DEFAULT_OPTIONS,
): Promise<string | null> {
  const session = sessionStore.getSession(sessionId)
  if (!session) return null

  // 转为 Markdown
  const markdown = sessionToMarkdown(session, options)

  try {
    // 动态导入 Tauri API（非 Tauri 环境优雅降级）
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')

    // 安全的文件名
    const safeName =
      session.title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || t('对话')

    const filePath = await save({
      title: t('导出会话为 Markdown'),
      defaultPath: `${safeName}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: t('所有文件'), extensions: ['*'] },
      ],
    })

    if (!filePath) return null // 用户取消

    // 写入文件（UTF-8）
    await writeTextFile(filePath, markdown)
    return filePath
  } catch (e) {
    // 非 Tauri 环境：降级为下载
    console.warn('Tauri API 不可用，使用浏览器下载方式', e)
    downloadAsFile(markdown, session.title)
    return null
  }
}

/**
 * 浏览器降级方案：创建 Blob 下载
 */
function downloadAsFile(content: string, title: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[<>:"/\\|?*]/g, '_')}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
