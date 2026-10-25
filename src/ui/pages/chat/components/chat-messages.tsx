/**
 * ChatMessages — 会话消息的**镜像容器**（`chat-view` 与消息列表之间的一层）。
 *
 * 为什么要有它：流式期间每一帧都要把「消息数组」换成新引用（`onMessagesUpdate` 经 rAF 合批）。
 * 这层状态原先挂在 1678 行的 `ChatView` 上 —— 每个 token 一拍就把 header / 侧栏 / 右侧面板 /
 * 输入框的 JSX 整棵重建一遍（子组件虽有 memo / observer，元素创建与 props 比对省不掉）。
 * 下沉到这里后，每帧只重渲染消息列表这棵子树。
 *
 * 四条口径与搬家前逐条一致：
 * 1. **帧合批**：高频路径（流式 chunk / 引擎事件）走 `schedule`，一拍最多一次；
 * 2. **立即生效**：发送 / 回填走 `syncNow`（丢弃排队中的旧更新）；
 * 3. **兜底订阅**：`sessionStore.onMessagesChanged` 是消息 CRUD 的唯一收口点，
 *    手机 bridge 这类非组件来源也由它到达这里；
 * 4. **换会话与懒加载**：`sessionId` 变走 layout effect（**上屏前**换掉，不闪一帧旧会话）；
 *    而 `ensureMessagesLoaded` 直接替换 `session.messages`、**不发** `messagesChanged` ——
 *    数据侧准备完由宿主自增 `syncKey` 补一次。
 *
 * ⚠️ 高频道（`schedule` / `syncNow`）走 ref，不经过 props：它们每秒上百次，走 props 就得
 * 让宿主 setState，等于把刚搬下去的重渲染又搬回来。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Message } from '@/types'
import { chatState, sessionStore } from '@/ui/store'
import { createFrameBatcher } from '@/utils/frameBatch'
import ChatMessageList, {
  type ChatMessageListProps,
} from './message/message-list'
import {
  TrajectoryView,
  type TrajectoryViewProps,
} from './trajectory/trajectory-view'

/** 空消息数组的稳定引用（首次渲染共用） */
const EMPTY_MESSAGES: Message[] = []

/** 宿主手里的两个入口（都按会话过滤，非当前会话的调用直接丢弃） */
export interface ChatMessagesHandle {
  /** 帧合批（流式高频路径）：一拍最多同步一次 */
  schedule: (sessionId: string) => void
  /** 立即同步并丢弃排队中的旧更新 */
  syncNow: (sessionId: string) => void
}

export interface ChatMessagesProps {
  sessionId: string
  /** 对话列表 / 轨迹视图二选一（两者用的是同一份消息镜像） */
  view: 'chat' | 'trajectory'
  /**
   * 强制刷新计数：宿主在「数据侧准备完」（懒加载 / 悬空 tool_calls 修复）后自增。
   * 这些写路径不发 `messagesChanged`，只靠订阅会漏掉那一批消息。
   */
  syncKey?: number
  /** 传给 `ChatMessageList` 的其余 props（`messages` / `setMessages` 由本组件注入） */
  listProps: Omit<ChatMessageListProps, 'messages' | 'setMessages'>
  /** 传给 `TrajectoryView` 的其余 props（`sessionId` / `messages` 由本组件注入） */
  trajectoryProps: Omit<TrajectoryViewProps, 'sessionId' | 'messages'>
  /** 轨迹视图下挂在下面的那块（交互卡片）：轨迹没有滚动容器，单独摆一条尾巴 */
  trajectoryTail?: React.ReactNode
}

/** 从 store 里取当前消息的**副本**（直接读 store，不校验当前会话 —— 挂载/切换时用） */
function messagesOf(sessionId: string): Message[] {
  const session = sessionStore.getSession(sessionId)
  return session ? [...session.messages] : EMPTY_MESSAGES
}

function ChatMessages(
  {
    sessionId,
    view,
    syncKey = 0,
    listProps,
    trajectoryProps,
    trajectoryTail,
  }: ChatMessagesProps,
  ref: React.Ref<ChatMessagesHandle>,
) {
  const [messages, setMessages] = useState<Message[]>(() =>
    messagesOf(sessionId),
  )

  /** 从 store 同步到本地镜像（只在「是当前会话」时生效，避免后台会话的更新抢前台） */
  const applyMessagesUpdate = useCallback((sid: string) => {
    if (sid !== chatState.value.currentSessionId) return
    const session = sessionStore.getSession(sid)
    if (session) setMessages([...session.messages])
  }, [])

  /**
   * 帧合批：流式期间 `onMessagesUpdate` 每秒上百次，逐次 setMessages 会把重渲染拉到与 chunk
   * 同量级；合并到每帧一次后上限钉在帧率，视觉无差别。
   */
  const batchRef = useRef<ReturnType<
    typeof createFrameBatcher<[string]>
  > | null>(null)
  if (!batchRef.current) {
    batchRef.current = createFrameBatcher(applyMessagesUpdate)
  }
  useEffect(() => () => batchRef.current?.cancel(), [])

  /** 高频路径（流式 chunk / 引擎事件）：帧合批 */
  const schedule = useCallback((sid: string) => {
    if (sid !== chatState.value.currentSessionId) return
    batchRef.current?.schedule(sid)
  }, [])

  /** 低频路径（发送、图片分析结果回填）：立即生效，并丢弃排队中的旧更新 */
  const syncNow = useCallback(
    (sid: string) => {
      batchRef.current?.cancel()
      applyMessagesUpdate(sid)
    },
    [applyMessagesUpdate],
  )

  // 消息镜像的兜底同步：messagesChanged 是消息 CRUD 的唯一收口点，任何来源都会到达这里
  useEffect(() => sessionStore.onMessagesChanged(schedule), [schedule])

  /**
   * 换会话：**上屏前**把镜像换掉（layout effect）。用 effect 的话会先画一帧上一个会话的
   * 消息，再被纠正 —— 切会话时肉眼可见的闪动。
   */
  const appliedSessionRef = useRef(sessionId)
  useLayoutEffect(() => {
    if (appliedSessionRef.current === sessionId) return
    appliedSessionRef.current = sessionId
    const session = sessionStore.getSession(sessionId)
    setMessages(session ? [...session.messages] : EMPTY_MESSAGES)
  }, [sessionId])

  // 数据侧准备完（懒加载 / 修复）再补一次：这些写路径不发 messagesChanged
  const appliedSyncKeyRef = useRef(syncKey)
  useEffect(() => {
    if (appliedSyncKeyRef.current === syncKey) return
    appliedSyncKeyRef.current = syncKey
    applyMessagesUpdate(sessionId)
  }, [syncKey, sessionId, applyMessagesUpdate])

  useImperativeHandle(ref, () => ({ schedule, syncNow }), [schedule, syncNow])

  if (view === 'trajectory') {
    return (
      <>
        <TrajectoryView {...trajectoryProps} sessionId={sessionId} messages={messages} />
        {trajectoryTail}
      </>
    )
  }
  return (
    <ChatMessageList {...listProps} messages={messages} setMessages={setMessages} />
  )
}

export default forwardRef(ChatMessages)
