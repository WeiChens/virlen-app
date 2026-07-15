/**
 * ToolOutputStore — 管理每个 tool call 的运行中输出和终止句柄
 *
 * 全局单例，key 为 toolCallId。
 * 用于 execute_command 等长耗时的 tool 向 UI 推送实时输出。
 */

export interface ToolOutput {
  /** 工具名称 */
  toolName: string
  /** 当前累积的输出 */
  output: string
  /** 终止回调（kill 子进程、取消请求等） */
  kill?: () => void
}

class ToolOutputStore {
  private map = new Map<string, ToolOutput>()
  private listeners = new Set<
    (toolCallId: string, output: ToolOutput) => void
  >()
  /** 节流用：每个 toolCallId 上次通知时间 */
  private lastNotify = new Map<string, number>()

  /** 注册一个 tool 输出状态 */
  register(toolCallId: string, output: ToolOutput) {
    this.map.set(toolCallId, output)
    this.notify(toolCallId)
  }

  /** 追加输出内容（节流：最多每 50ms 通知一次） */
  append(toolCallId: string, chunk: string) {
    const existing = this.map.get(toolCallId)
    if (existing) {
      existing.output += chunk
      // 节流：最多每 50ms 通知一次，高频 stdout 时避免过度 re-render
      const now = Date.now()
      const last = this.lastNotify.get(toolCallId) ?? 0
      if (now - last >= 50) {
        this.lastNotify.set(toolCallId, now)
        this.notify(toolCallId)
      }
    } else {
      this.map.set(toolCallId, { toolName: '', output: chunk })
      this.notify(toolCallId)
    }
  }

  /** 强制通知（tool 结束时确保刷新 UI） */
  flush(toolCallId: string) {
    this.notify(toolCallId)
  }

  /** 获取工具输出 */
  get(toolCallId: string): ToolOutput | undefined {
    return this.map.get(toolCallId)
  }

  /** 移除（tool 执行完毕后清理） */
  remove(toolCallId: string) {
    this.map.delete(toolCallId)
    this.lastNotify.delete(toolCallId)
  }

  /** 订阅变化 */
  subscribe(cb: (toolCallId: string, output: ToolOutput) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(toolCallId: string) {
    const entry = this.map.get(toolCallId)
    if (!entry) return
    for (const cb of this.listeners) {
      cb(toolCallId, entry)
    }
  }
}

export const toolOutputStore = new ToolOutputStore()
