/**
 * input 组件对外类型（Props / 暴露给父组件的 RefProps）
 */
import type {
  FileAttachment,
  ImageAttachment,
  QuoteAttachment,
  SkillAttachment,
} from './hooks'

export interface Props {
  sessionId?: string
  onSend: (
    content: string,
    images?: ImageAttachment[],
    goal?: string,
    files?: FileAttachment[],
    quotes?: QuoteAttachment[],
    skills?: SkillAttachment[],
  ) => void
  /**
   * 当前引用的技能名发生变化时回调（侧边栏技能卡片据此高亮 / 再点取消）
   *
   * 单项职责：引用状态的唯一真相在输入框，外面只拿一份“名字镜像”。
   */
  onSkillsChange?: (names: string[]) => void
  onCancel?: () => void
  onMessagesUpdate?: (sessionId: string) => void
  /** 点击引用 chip：跳转定位到被引用的原消息 */
  onQuoteJump?: (messageId: string) => void
  disabled?: boolean
  loading?: boolean
  placeholder?: string
}

export interface RefProps {
  setText: (text: string) => void
  /** 添加一条引用（消息气泡的「引用」按钮调用），重复引用同一消息会被忽略 */
  addQuote: (quote: QuoteAttachment) => void
  /**
   * 按路径挂附件（侧边栏目录树「引用」/ 拖拽到输入框调用）。
   * 与系统拖文件进来同源：图片走图片链路，其余只记路径。
   */
  attachPaths: (paths: string[]) => void
  /**
   * 按技能名挂技能引用（侧边栏「技能」页签单击 / 拖拽到输入框调用）。
   * 与文件附件相反：这里会把 SKILL.md 全文读进内存随消息发出。
   */
  attachSkills: (names: string[]) => void
  /** 按技能名取消引用（侧边栏卡片「再点一下」调用，与 attachSkills 互为开关） */
  detachSkills: (names: string[]) => void
}
