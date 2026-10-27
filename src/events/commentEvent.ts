import EventEmitter from '@/utils/EventEmitter'

/**
 * 聊天页内部的 UI 事件总线（不跨模块、不进 `AgentEventType` 契约）：
 * 深层组件没法方便地拿到宿主的回调时，用它把「用户点了什么」上报给 `chat-view`。
 */
type CommonEventType = {
  requestScrollToBottom: () => void
  /**
   * 工具卡片里点了「打开终端」（后台服务）：请在右侧面板开这个服务的终端标签。
   *
   * 只带「哪一个服务」—— 标签归 `chat-view` 的 `panelBuckets` 一家所有，
   * 会话 id 由宿主按**当前会话**补齐（卡片不知道自己被哪一桶渲染）。
   */
  openServiceTerminal: (input: { serviceId: string; name: string }) => void
}
export default new EventEmitter<CommonEventType>()
