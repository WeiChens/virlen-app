/**
 * message-list 类型与稳定空值
 */
import type { Message } from '@/types'

/** 锚点列表项：全量用户消息索引（后端）与本地已加载消息合并后的结果 */
export interface AnchorUser {
  id: string
  /** 纯文本摘要（tooltip 用） */
  preview: string
}

/**
 * 「跳转并高亮」目标（消息检索弹窗选中结果时下发）。
 * 通过 nonce 区分「同一消息被反复选中」，确保每次都能重新触发定位。
 */
export interface MessageJumpTarget {
  /** 目标消息 id */
  id: string
  /** 目标消息所属会话（与当前会话不一致时先等待会话切换完成） */
  sessionId: string
  /** 递增序号（每次选中自增） */
  nonce: number
}

/** ChatMessageList 组件 props */
export interface ChatMessageListProps {
  /** 当前已加载的所有消息（可能只是 SQLite 中的尾部若干页） */
  messages: Message[]
  /** 更新消息（触发父组件重渲染 / 虚拟列表 count 变化） */
  setMessages: (msgs: Message[]) => void
  /** 输入框设置文本回调 */
  setText: (text: string) => void
  /** 引用某条消息（交给输入框挂成引用 chip） */
  onQuote?: (quote: {
    messageId: string
    role: 'user' | 'assistant'
    text: string
  }) => void
  /** 点击引用 chip：跳转定位到被引用的原消息 */
  onQuoteJump?: (messageId: string) => void
  /** 外部请求滚动定位并临时高亮的目标消息（Ctrl+P 检索结果跳转） */
  jumpTarget?: MessageJumpTarget | null
}

/** 稳定的空锚点数组（索引未加载时共用，保证 useMemo 依赖稳定） */
export const EMPTY_ANCHOR_USERS: AnchorUser[] = []
