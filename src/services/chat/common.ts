/**
 * chat-service 公共辅助函数
 *
 * 只放不依赖其它 chat/* 子模块的纯函数 / 引擎选择逻辑，
 * 供事件处理器与编排层共用。
 */
import { settingsState } from '@/ui/store'
import type { MessageContent, ProviderConfig, Session } from '@/types'
import type { AgentEnginePort } from '@/domain/ports'
import { rustEngine } from '@/services/rust-engine'

// ==================== 埋点辅助（§5.4 / §5.5） ====================

/**
 * 引擎标识 —— 恒为 `'rust'`。
 *
 * TS 引擎已移除（引擎统一为 Rust）；保留本函数只因为埋点字段 `engine` 的**历史取值**
 * 含 `'ts'`，历史数据仍要能区分。
 */
function engineKind(): 'rust' {
  return 'rust'
}

function providerTypeOf(session: Session): string {
  const p = settingsState.value.providers.find(
    (x) => x.id === session.providerConfigId,
  )
  return p?.type || 'unknown'
}

/** 解析消息内容用于埋点统计 */
function describeContent(content: MessageContent): {
  text: string
  textLen: number
  imageCount: number
  contentType: 'text' | 'image' | 'mixed'
} {
  let text = ''
  let imageCount = 0
  if (typeof content === 'string') {
    text = content
  } else {
    for (const block of content) {
      if (block.type === 'text') {
        text += ('text' in block ? block.text : '') || ''
      } else if (block.type === 'image_url') {
        imageCount++
      }
    }
  }
  return {
    text,
    textLen: text.length,
    imageCount,
    contentType: imageCount > 0 ? (text ? 'mixed' : 'image') : 'text',
  }
}

/**
 * 获取当前 Agent 引擎 —— **恒为 Rust 引擎**。
 *
 * TS 引擎已移除（引擎统一为 Rust）；非 Tauri 环境（浏览器 dev / vitest）没有后端，
 * 不再有回退引擎 —— 产品不走纯浏览器路线。
 */
export function getEngine(): AgentEnginePort {
  return rustEngine
}

/** 压缩引擎：与 `getEngine()` 同一份（Rust，与 CLI 共用 core 实现 `cmd_compress_context`）。 */
export function getCompressEngine(): AgentEnginePort {
  return rustEngine
}

/**
 * 解析本次请求实际使用的推理强度
 *
 * 优先级：会话级选择（聊天界面切换）> 服务商配置的默认值；
 * 两者都没有则不传该参数，交给服务端默认行为。
 */
function resolveReasoningEffort(
  session: Session,
  providerCfg?: ProviderConfig,
): string | undefined {
  return (
    session.params?.reasoningEffort || providerCfg?.reasoningEffort || undefined
  )
}

/**
 * 匹配 API 错误信息中关于"模型不支持图片"的常见报错模式，
 * 转为用户友好的提示文本。不匹配则返回原始信息。
 */
function transformApiError(message: string): string {
  const imageNotSupportedPatterns = [
    /does\s+not\s+support\s+(image|multimodal)/i,
    /image\s+(input|upload|data|url)(s)?\s+(is\s+)?not\s+supported/i,
    /not\s+support\s+(image|multimodal)/i,
    /image\s+is\s+not\s+allowed/i,
    /multimodal\s+is\s+not\s+supported/i,
    /unsupported\s+(image|multimodal)/i,
    /currently\s+doesn'?t\s+support\s+(image|multimodal)/i,
    /this\s+model\s+does\s+not\s+support/i,
    /image_url.*(only|support)/i,
    // 序列化反序列化层面拒绝 image_url（如 DeepSeek）
    /unknown\s+variant\s+`?image_url`?/i,
    /expected\s+`?text`?\s*.+`?image_url`?/i,
  ]
  for (const pattern of imageNotSupportedPatterns) {
    if (pattern.test(message)) {
      return '当前模型不支持上传图片，请切换至支持视觉的模型'
    }
  }
  return message
}

/** 从 MessageContent 中提取纯文本（用于标题展示） */
function extractText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join(' ')
}

export {
  engineKind,
  providerTypeOf,
  describeContent,
  resolveReasoningEffort,
  transformApiError,
  extractText,
}
