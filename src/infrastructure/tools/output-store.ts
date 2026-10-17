/**
 * 每个 tool call 的运行中输出与终止句柄（全局单例，key = toolCallId），
 * 供 execute_command 等长耗时工具向 UI 推实时输出。
 */

/**
 * 「终端内确认」的待确认命令。命令此时尚未执行：UI 渲染成一行可编辑命令，用户按 Enter 才执行。
 */
export interface PendingConfirmInfo {
  /**
   * 本次交互的 id：终端内确认不弹 modal，手机控制侧要靠它把卡片与 interactionSettled 对齐。
   */
  interactionId?: string
  /** 权限唯一 key（展示） */
  permName?: string
  /** 权限名称（展示） */
  title?: string
  /** 副标题：AI 操作说明 */
  subTitle?: string
  /** 正文：待确认的命令内容（用户可编辑） */
  desc?: string
  /** 风险 / 警告提示 */
  hint?: string
  /** 风险等级（配色） */
  risk?: string
  /** AI 申请不使用沙盒执行（手机控制侧分级用，不影响前端渲染） */
  sandboxBypass?: boolean
}

export interface ToolOutput {
  /** 工具名称 */
  toolName: string
  /** 当前累积的输出 */
  output: string
  /**
   * 终止回调（kill 子进程、取消请求等）。
   * 返回 Promise<boolean> 时可告知「是否真的命中了运行中的命令」，false 用于复位按钮。
   */
  kill?: () => void | Promise<boolean | void>
  /**
   * 输出是否为 PTY 原始流（带 ANSI/VT 控制序列，须交给 xterm 而非 <pre>）。
   * 后端权威标记是完成态 uiData.pty，这里用于运行中提前定渲染方式。
   */
  pty?: boolean
  /** 待确认命令（存在时 UI 渲染确认块）；提交 / 取消后由 clearPendingConfirm 清空 */
  pendingConfirm?: PendingConfirmInfo
  /**
   * 本次命令实际的沙盒模式（Rust 判定后下发），运行中经 agent:tool-env 写入；
   * 完成态以后端权威字段 uiData.sandbox 为准。
   */
  sandbox?: string
}

/**
 * 输出通知的节流窗口（ms）：高频 stdout 下最多每窗口通知一次 UI；窗口内后续分片由尾沿补发兜底。
 */
export const NOTIFY_INTERVAL_MS = 50

class ToolOutputStore {
  private map = new Map<string, ToolOutput>()
  private listeners = new Set<
    (toolCallId: string, output: ToolOutput) => void
  >()
  /** 节流用：每个 toolCallId 上次通知时间 */
  private lastNotify = new Map<string, number>()
  /**
   * 尾沿补发定时器。只做前沿节流是错的：同一窗口内的后续分片只入缓冲、永不通知 ——
   * 交互式命令（npm init）的尾片（无换行的提示符）落在窗口内就一直不上屏。
   */
  private trailing = new Map<string, ReturnType<typeof setTimeout>>()

  /** 注册一个 tool 输出状态 */
  register(toolCallId: string, output: ToolOutput) {
    // 保留已由 agent:tool-env 写入的 sandbox：register 会替换 entry，但沙盒模式不能丢。
    const prev = this.map.get(toolCallId)
    const next: ToolOutput = prev?.sandbox
      ? { ...output, sandbox: prev.sandbox }
      : { ...output }
    this.map.set(toolCallId, next)
    this.cancelTrailing(toolCallId)
    this.notify(toolCallId)
  }

  /** 追加输出内容（前沿节流：最多每 NOTIFY_INTERVAL_MS 通知一次，命中间隔则尾沿补发） */
  append(toolCallId: string, chunk: string) {
    const existing = this.map.get(toolCallId)
    if (existing) {
      existing.output += chunk
      const now = Date.now()
      const last = this.lastNotify.get(toolCallId) ?? 0
      if (now - last >= NOTIFY_INTERVAL_MS) {
        // 前沿：距上次通知已过窗口 → 立即通知，并取消挂起的尾沿
        this.cancelTrailing(toolCallId)
        this.lastNotify.set(toolCallId, now)
        this.notify(toolCallId)
      } else {
        // 窗口内：先不通知，但挂尾沿保证「最后一片」在窗口结束补发（否则会丢帧）
        this.scheduleNotify(toolCallId)
      }
    } else {
      this.map.set(toolCallId, {
        toolName: '',
        output: chunk,
      })
      this.notify(toolCallId)
    }
  }

  /** 强制通知（tool 结束时确保刷新 UI）；取消未触发的尾沿 */
  flush(toolCallId: string) {
    this.cancelTrailing(toolCallId)
    this.lastNotify.set(toolCallId, Date.now())
    this.notify(toolCallId)
  }

  /** 写入待确认命令（此时命令尚未执行）。 */
  setPendingConfirm(toolCallId: string, info: PendingConfirmInfo) {
    // 必须替换为新对象：UI 的 useToolLiveOutput 靠引用变化重渲染，就地改字段永远不会出现。
    const existing = this.map.get(toolCallId) ?? {
      toolName: 'execute_command',
      output: '',
    }
    this.map.set(toolCallId, { ...existing, pendingConfirm: info })
    this.notify(toolCallId)
  }

  /** 清除待确认（用户提交 / 取消后）。 */
  clearPendingConfirm(toolCallId: string) {
    const entry = this.map.get(toolCallId)
    if (!entry?.pendingConfirm) return
    const next = { ...entry }
    delete next.pendingConfirm
    this.map.set(toolCallId, next)
    this.notify(toolCallId)
  }

  /**
   * 写入命令实际的沙盒模式（运行中经 agent:tool-env 下发）。同上必须替换为新对象；同值幂等。
   */
  setSandbox(toolCallId: string, sandbox: string) {
    const existing = this.map.get(toolCallId) ?? {
      toolName: 'execute_command',
      output: '',
    }
    if (existing.sandbox === sandbox) return
    this.map.set(toolCallId, { ...existing, sandbox })
    this.notify(toolCallId)
  }

  /** 获取工具输出 */
  get(toolCallId: string): ToolOutput | undefined {
    return this.map.get(toolCallId)
  }

  /** 移除并取消未触发的尾沿（避免补发已删除的 id） */
  remove(toolCallId: string) {
    this.cancelTrailing(toolCallId)
    this.map.delete(toolCallId)
    this.lastNotify.delete(toolCallId)
  }

  /** 订阅变化 */
  subscribe(cb: (toolCallId: string, output: ToolOutput) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 挂尾沿补发（同一 id 只挂一个；窗口结束时补发一次最新全量） */
  private scheduleNotify(toolCallId: string) {
    if (this.trailing.has(toolCallId)) return
    const last = this.lastNotify.get(toolCallId) ?? 0
    const delay = Math.max(0, NOTIFY_INTERVAL_MS - (Date.now() - last))
    const timer = setTimeout(() => {
      this.trailing.delete(toolCallId)
      if (!this.map.has(toolCallId)) return
      this.lastNotify.set(toolCallId, Date.now())
      this.notify(toolCallId)
    }, delay)
    this.trailing.set(toolCallId, timer)
  }

  /** 取消未触发的尾沿补发 */
  private cancelTrailing(toolCallId: string) {
    const timer = this.trailing.get(toolCallId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.trailing.delete(toolCallId)
    }
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
