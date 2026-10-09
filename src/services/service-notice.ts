/**
 * service-notice — 后台服务「结束通知」的前端落点（**唯一出口**）。
 *
 * 时机与内容全在 Rust（`virlen-core/src/agent/native_tools/service/notice.rs`）：
 * - AI 正在这一轮里 → 通知留在 Rust 队列里，**下一次 LLM 请求之前**注入消息列表（前端不参与）；
 * - AI 空闲 → Rust 发 `agent:service-exit` 事件，前端**立刻**把那条消息落进会话（本文件）。
 *
 * 因此前端只有一件事要做：把 Rust 组装好的那条消息（模型侧英文正文 + `uiData`）当作**普通消息**
 * 落进会话 —— 用户看得见（消息流里一行胶囊，见 `message-bubble.tsx`），AI 下一次请求天然带上。
 *
 * ⚠️ 文案不在前端决定：正文是给模型的固定英文，界面按 `uiData` 用界面语言重建（铁律 1）。
 * 与 todo 的 feedback 消息同一套载体（`role='feedback'`），因此「落库 + 上屏」两条路都走现成设施。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Message } from '@/types'
import { isTauriAvailable } from '@/services/rust-engine'
import { sessionStore } from '@/ui/store'
import { addSessionMessage } from '@/services/chat/messages'

/** Rust → JS 的事件名（`commands/agent.rs::TauriServiceNoticeHost`；raw 事件，不进 AgentEventType 契约） */
export const EVENT_SERVICE_EXIT = 'agent:service-exit'

/** 事件载荷 */
export interface ServiceExitPayload {
  sessionId?: string
  /** 完整消息（Rust 组装：id / role='feedback' / content / uiData / timestamp） */
  message?: Message
}

let unlisten: UnlistenFn | null = null

/**
 * 挂上监听（`main.ts::init` 调一次；非 Tauri 环境 / 挂载失败一律静默 —— 这是增强能力，
 * 绝不能影响聊天主流程）。
 */
export function initServiceNotice(): void {
  if (unlisten || !isTauriAvailable()) return
  void listen<ServiceExitPayload>(EVENT_SERVICE_EXIT, (event) => {
    handleServiceExit(event.payload)
  })
    .then((off) => {
      unlisten = off
    })
    .catch(() => {
      // 事件系统不可用：不挂监听（Rust 侧会看到「没人接管」→ 通知留在队列里，
      // 下一次 LLM 请求之前注入，不影响 AI 侧）
    })
}

/**
 * 处理一条服务结束通知 —— 导出以便单测直接驱动这条路径（真正的调用方是上面的监听器）。
 *
 * @returns 是否真的收下了（会话 id / 消息缺一不可）
 */
export function handleServiceExit(payload: ServiceExitPayload): boolean {
  const sessionId = payload?.sessionId
  const message = payload?.message
  if (!sessionId || !message?.id) return false

  // 尾部窗口已在内存 → 同步写进 store（`messagesChanged` 会通知 chat-view 重渲染，消息流立刻出现）；
  // 还没加载过这个会话（用户在别的会话里 / 从未打开）→ **只落库**，等它被激活时自然带出来，
  // 否则内存里会只挂着这一条，把更早的历史「顶掉」成孤零零一条。
  if (sessionStore.isMessagesLoaded(sessionId)) {
    addSessionMessage(sessionId, message)
  }
  // 显式落库：`addSessionMessage` 的落库在 Tauri 下由引擎负责（`persistMessagesIfNeeded` 会跳过），
  // 这条不是引擎写的 —— 与 todo 落地同一条做法（id 是主键，幂等 upsert）。
  void invoke('cmd_append_messages', {
    sessionId,
    messages: [message],
  }).catch(() => {})
  return true
}
