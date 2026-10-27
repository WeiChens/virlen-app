/**
 * vision_analyze —— 两种「模式」下的展开视图不一样：
 *
 * 1. 本地伪视觉分析（默认开）：端侧推理出 tree text，直接按纯文本展开；
 * 2. 模型分析模式（`imageVisionAnalyzeOptimize = false`）：端侧不跑，工具结果只有一段
 *    「图片事实」信封，图片本体在一条 `role = vision_image` 的注入消息里（列表不占行）。
 *    这时按工具结果 uiData 里的 `imageMessageId` 把那条消息的图取出来渲染 —— 展开看到的
 *    就是**真正发给模型的那份字节**（按设置缩过 / 转过码，不是磁盘上的原图），下面列事实。
 *
 * 取图放在 `<Observer>` 里：注入消息在工具结果**之后**才到（本轮工具全跑完才统一 flush），
 * 而卡片本身被 memo 住、不会因 messages 变化重渲染 —— 这一小块必须自己订阅会话消息，
 * 否则展开时永远是「图片未加载」。
 */
import { Observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { VISION_IMAGE_ROLE } from '@/types'
import type { ImageContent, Message } from '@/types'
import { imageDisplaySrc } from '@/domain/files/attachment-src'
import { showImagePreview } from '@/ui/components/shared/ImagePreview'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 模型分析模式下工具结果 uiData 的形态（Rust `image_send::sent_ui_data`） */
interface SentImageData {
  /** 那条 `role = vision_image` 注入消息的 id */
  imageMessageId: string
  /** 发出去那份图的 mime（缩放 / 转码之后） */
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
  /** 原图对照：只在真的重编码 / 缩放过时才有 */
  sourceMediaType?: string
  sourceBytes?: number
  sourceWidth?: number
  sourceHeight?: number
}

/** 是不是「模型分析模式」的工具结果（本地模式没有 uiData，退回纯文本） */
function sentImageData(message?: Message): SentImageData | null {
  const ui = message?.uiData
  if (!ui || ui.type !== 'vision_image_sent') return null
  if (typeof ui.imageMessageId !== 'string') return null
  return ui as SentImageData
}

/** 注入消息里的图片地址；库里是 `attachment://<hash>.<ext>`，渲染前翻译成自定义协议 URL */
function injectedImageSrc(messageId: string): string {
  const messages =
    sessionStore.getSession(chatState.value.currentSessionId)?.messages ?? []
  const image = messages.find((m) => m.id === messageId)
  if (!image || image.role !== VISION_IMAGE_ROLE) return ''
  if (!Array.isArray(image.content)) return ''
  const block = image.content.find(
    (b): b is ImageContent => b.type === 'image_url',
  )
  return block ? imageDisplaySrc(block.image_url.url) : ''
}

/** 与 Rust `human_size` 同口径：B / KB / MB（一位小数） */
function humanSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const k = bytes / 1024
  if (k < 1024) return `${k.toFixed(1)} KB`
  return `${(k / 1024).toFixed(1)} MB`
}

/** `image/jpeg · 1568×1116 px · 512.0 KB`（缺项就跳过那一项） */
function factsLine(
  type?: string,
  bytes?: number,
  width?: number,
  height?: number,
): string {
  const dims = width && height ? `${width}×${height} px` : ''
  return [type, dims, humanSize(bytes)].filter(Boolean).join(' · ')
}

/** 图片 + 事实（发给模型的那份是压缩 / 转码后的，原图作对照） */
function SentImageView({ data }: { data: SentImageData }) {
  return (
    <Observer>
      {() => {
        const src = injectedImageSrc(data.imageMessageId)
        const facts = factsLine(
          data.mediaType,
          data.bytes,
          data.width,
          data.height,
        )
        const source = factsLine(
          data.sourceMediaType,
          data.sourceBytes,
          data.sourceWidth,
          data.sourceHeight,
        )
        return (
          <div className="vision-image-sent">
            {src ? (
              <img
                className="vision-image-sent-img"
                src={src}
                alt={facts || t('发送给模型的图片')}
                title={t('点击查看大图')}
                onClick={() => showImagePreview({ src, previewSrcList: [src] })}
              />
            ) : (
              <div className="vision-image-sent-missing">
                {t('图片未加载（该消息不在当前会话缓存中）')}
              </div>
            )}
            <div className="vision-image-sent-facts">
              <span className="vision-image-sent-title">
                {t('发送给模型的图片')}
              </span>
              {facts && <span>{facts}</span>}
              {source && (
                <span className="vision-image-sent-source">
                  {tpl('原图 $__facts__', { facts: source })}
                </span>
              )}
            </div>
          </div>
        )
      }}
    </Observer>
  )
}

class VisionAnalyzeMessage implements IToolCallMessage {
  getToolName(): string {
    return 'vision_analyze'
  }
  getToolLabel(_type: string): string {
    return t('视觉分析')
  }
  getShortText(props: ToolMessageProps): string {
    try {
      let input = props.useContent.input as any
      if (typeof input === 'object') {
        const keys = Object.keys(input)
        if (keys.length > 1) {
          if (keys.includes('path')) {
            input = input.path
          } else {
            input = JSON.stringify(input)
          }
        } else if (keys.length === 1) {
          input = input[keys[0]]
        } else {
          input = ''
        }
      }
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace
      return toShortPath(`${input}`, workspace)
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    // 模型分析模式：只给「真正发出去的那张图」+ 事实（那段给模型看的文本不再重复）
    const sent = sentImageData(props.message)
    if (sent) {
      return <SentImageView data={sent} />
    }
    // 本地伪视觉分析：端侧识别结果就是纯文本，原样展示
    if (props.message?.content) {
      return <pre>{props.message.content as string}</pre>
    }
    return null
  }
  diyWrapper(): boolean {
    return false
  }
}

export default VisionAnalyzeMessage
