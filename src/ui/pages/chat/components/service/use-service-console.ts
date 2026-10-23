/**
 * useServiceConsole — 服务终端面板的数据源：轮询服务的**合并输出流** + 状态。
 *
 * 为什么不订阅事件：与 `use-service-list` 同一条理由（「进程自己退出」发生在常驻任务里，
 * 那里拿不到工具上下文的 sink；为它拉一条跨 crate 的事件通道不划算）。面板可见时才轮询：
 * - 运行中 350ms（用户正看着终端，键击回显 / 新日志都要跟得上；每次只传增量，一帧 IPC 很小）；
 * - 已结束 / 管道模式 1500ms（内容不会变了，只为发现「被 AI 摘出注册表」这类变化）；
 * - **标签切走**（`active=false`）时停发请求；窗口不可见（最小化 / 切托盘）时也不发，只保留节奏。
 *
 * ⚠️ 「切走再切回」不能重置已读偏移与累积串：面板的标签**一直挂着**（只切 `hidden`），
 * 重置会让每次切回来都从 0 重读整段（服务窗口上限 20 万字符）并让终端整屏重绘闪一下。
 * 只有换服务（`sessionId` / `serviceId` 变了）才清屏。
 *
 * 终止条件只有一条：Rust 回 `null`（本会话已没有这个 id）→ `gone`，停止轮询。
 * 读失败（IPC 异常）**不算** `gone` —— 保留上一帧内容继续轮询，两种语义必须分开。
 */
import { useEffect, useRef, useState } from 'react'
import {
  readServiceConsole,
  type ServiceConsoleChunk,
} from '@/infrastructure/backgroundService'

/** 运行中的轮询间隔（ms） */
const LIVE_MS = 350
/** 已结束 / 不可交互时的轮询间隔（ms） */
const IDLE_MS = 1500

export interface ServiceConsoleState {
  /** 终端要渲染的累积流（`reset` 那帧会整段替换） */
  stream: string
  /** 最近一帧的控制台状态（输入开关 / 提示文案用） */
  info: ServiceConsoleChunk | null
  /** 已不在本会话的注册表里（AI 杀了它并清出表）—— 提示 + 停止轮询 */
  gone: boolean
}

export function useServiceConsole(
  sessionId: string,
  serviceId: string,
  active = true,
): ServiceConsoleState {
  const [state, setState] = useState<ServiceConsoleState>({
    stream: '',
    info: null,
    gone: false,
  })
  const key = `${sessionId}\u0000${serviceId}`
  /** 偏移与累积串活在这里（暂停 / 恢复、重渲染都不该丢）：它们是「这一路终端」的私有状态 */
  const cursorRef = useRef({ key: '', offset: 0, stream: '' })

  useEffect(() => {
    if (cursorRef.current.key === key) return
    cursorRef.current = { key, offset: 0, stream: '' }
    setState({ stream: '', info: null, gone: false })
  }, [key])

  useEffect(() => {
    // 标签不可见：一个请求都不发，切回来时带着原偏移续上（effect 重跑即续连）
    if (!active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      // 窗口不可见时不发请求（没人看着），但保留节奏 —— 回到前台立刻续上
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(tick, IDLE_MS)
        return
      }
      let chunk: ServiceConsoleChunk | null
      try {
        chunk = await readServiceConsole(
          sessionId,
          serviceId,
          cursorRef.current.offset,
        )
      } catch {
        if (!alive) return
        // 读失败：保留上一帧，稍后再试（不能当成「服务没了」）
        timer = setTimeout(tick, IDLE_MS)
        return
      }
      if (!alive) return
      if (!chunk) {
        setState((s) => (s.gone ? s : { ...s, gone: true }))
        return
      }
      const cursor = cursorRef.current
      cursor.offset = chunk.next
      cursor.stream = chunk.reset ? chunk.text : cursor.stream + chunk.text
      setState({ stream: cursor.stream, info: chunk, gone: false })
      timer = setTimeout(tick, chunk.running ? LIVE_MS : IDLE_MS)
    }

    timer = setTimeout(tick, 0)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, serviceId, active])

  return state
}
