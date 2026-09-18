/**
 * ToolOutputStore — 管理每个 tool call 的运行中输出和终止句柄
 *
 * 全局单例，key 为 toolCallId。
 * 用于 execute_command 等长耗时的 tool 向 UI 推送实时输出。
 */

/**
 * Step 2 ①：「终端内确认」的待确认命令信息。
 *
 * 命令此时**尚未执行**：UI 在终端块里渲染成一行可编辑命令，用户按 Enter 才执行。
 */
export interface PendingConfirmInfo {
  command: string
  risk?: string
  label?: string
  hint?: string
  tips?: string
}

export interface ToolOutput {
  /** 工具名称 */
  toolName: string
  /** 当前累积的输出 */
  output: string
  /** 终止回调（kill 子进程、取消请求等） */
  kill?: () => void
  /**
   * 输出是否为 PTY（伪控制台）原始流。
   *
   * `true` 表示 `output` 是带 ANSI/VT 控制序列的终端流（含光标控制），
   * 必须交给 xterm 渲染而不是 `<pre>`；同时意味着 stdout/stderr 已合并成单流。
   * 后端权威标记是完成态 `uiData.pty`，这里用于「运行中」阶段提前定渲染方式。
   */
  pty?: boolean
  /**
   * Step 2 ①：待确认命令（存在时 UI 渲染确认块，命令尚未执行）。
   * 用户提交 / 取消后由 `clearPendingConfirm` 清空。
   */
  pendingConfirm?: PendingConfirmInfo
  /**
   * 最近一次输出活动的时间戳（ms）。
   *
   * Step 2 ④：前端据此做「疑似等待输入」提示（本地计时，**零后端成本**）。
   * 注册与每次 append 都会刷新；命令结束（`running=false`）即不再参与判定。
   */
  lastOutputAt?: number
}

/**
 * 「疑似等待输入」判定的空闲阈值（ms）。
 *
 * 15s 无任何输出（且命令仍在运行）→ 提示用户可能卡在等待输入
 * （密码 / `y/n` / REPL），见 docs/pty-research.md §8 Step 2 ④。
 */
export const IDLE_HINT_MS = 15_000

/**
 * 是否应显示「疑似等待输入」提示（Step 2 ④，抽成纯函数便于单测）。
 *
 * - 未运行 → false（命令结束即无开销）；
 * - 无输出记录（`lastOutputAt` 缺失）→ false；
 * - 空闲时长 ≥ `IDLE_HINT_MS` → true。
 */
export function shouldHintIdle(
  now: number,
  lastOutputAt: number | undefined,
  running: boolean,
): boolean {
  if (!running) return false
  if (!lastOutputAt) return false
  return now - lastOutputAt >= IDLE_HINT_MS
}

/**
 * 输出通知的节流窗口（ms）。
 *
 * 高频 stdout（进度条 / `npm install`）下最多每窗口通知一次 UI，避免过度 re-render；
 * 窗口内的后续分片由**尾沿补发**兜底（见 `ToolOutputStore.trailing`），保证最后一片一定上屏。
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
   * 尾沿补发定时器。
   *
   * ⚠️ 只做「前沿节流」是**错的**：落在同一个 `NOTIFY_INTERVAL_MS` 窗口内的后续分片会
   * 只入缓冲、不通知，而且**永远不会补发**。交互式命令（`npm init`）刷一波就停在等输入，
   * 尾片（无换行的提示符 `package name: (wei) `）恰好落在窗口内 → 一直不上屏，
   * **要等用户敲一个键、子进程产生新输出时才被顺带刷出来**（这就是「按了键提示符才出现」的根因）。
   * 这里在命中间隔时挂一个定时器，窗口结束时补通知一次，保证「最后一片一定上屏」。
   */
  private trailing = new Map<string, ReturnType<typeof setTimeout>>()

  /** 注册一个 tool 输出状态 */
  register(toolCallId: string, output: ToolOutput) {
    // 注册即开始计空闲（覆盖「命令一直无输出」的等待输入场景）
    this.map.set(toolCallId, { ...output, lastOutputAt: Date.now() })
    this.cancelTrailing(toolCallId)
    this.notify(toolCallId)
  }

  /** 追加输出内容（前沿节流：最多每 NOTIFY_INTERVAL_MS 通知一次，命中间隔则尾沿补发） */
  append(toolCallId: string, chunk: string) {
    const existing = this.map.get(toolCallId)
    if (existing) {
      existing.output += chunk
      existing.lastOutputAt = Date.now()
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
        lastOutputAt: Date.now(),
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

  /** Step 2 ①：写入「终端内确认」的待确认命令（此时命令尚未执行）。 */
  setPendingConfirm(toolCallId: string, info: PendingConfirmInfo) {
    // ⚠️ 必须**替换为新对象**：UI 侧 `useToolLiveOutput` 靠对象引用变化触发重渲染
    // （就地改字段 + 同一引用 → React 不会重渲染，「待确认命令行」永远不会出现）。
    const existing = this.map.get(toolCallId) ?? {
      toolName: 'execute_command',
      output: '',
    }
    this.map.set(toolCallId, { ...existing, pendingConfirm: info })
    this.notify(toolCallId)
  }

  /** Step 2 ①：清除待确认（用户提交 / 取消后）。 */
  clearPendingConfirm(toolCallId: string) {
    const entry = this.map.get(toolCallId)
    if (!entry?.pendingConfirm) return
    const next = { ...entry }
    delete next.pendingConfirm
    this.map.set(toolCallId, next)
    this.notify(toolCallId)
  }

  /** 获取工具输出 */
  get(toolCallId: string): ToolOutput | undefined {
    return this.map.get(toolCallId)
  }

  /** 移除（tool 执行完毕后清理）；取消未触发的尾沿，避免补发已删除的 id */
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
