/**
 * useUserConsole — 用户终端面板的数据源：**推送为主，慢轮询兜底**。
 *
 * ## 为什么不是纯轮询
 *
 * ConPTY 把用户键入**回显进输出流**，而轮询的间隔就是回显延迟 —— 350ms 的轮询意味着
 * 「敲一下等一帧」（快打时几个字符攒成一批跳出来），终端因此不像终端。现在的实时路径是
 * Rust 推、这里接（`onUserTerminalOutput`）：事件带的 `from` 与本地位移一致就**立刻追加**，
 * 一次 setState 到 xterm，不等任何定时器。参考实现是 dsh 的终端（输出是带 `sequence` 的帧流，
 * 不是拉取；前端写完再 ack 做背压）。
 *
 * ## 两条来源，一套偏移
 *
 * - **推送**（`terminal:output`）：输出一到就来，只有 `text` / `reset` / `running`；
 * - **读命令**（`readUserTerminal`）：权威快照 + 增量，`exitCode` / `interactive` /
 *   `headDropped` / 「被摘出注册表（`null`）」这些**只有它给**。
 *
 * 两者共用 `cursorRef.offset`：推送 `from` 对不上（事件丢了 / 首帧与自己的首次读重叠）就回头
 * 用读命令按游标补一帧 —— 所以**丢一帧不丢内容**，只是慢一小下。
 * ⚠️ 绝不按字符下标切字符串：Rust 的偏移是 `char` 数，JS 的 `slice` 是 UTF-16 码元，emoji 会错位。
 * 所以补帧要么整帧用、要么整帧弃（读的过程中游标被推送推进了就重读）。
 *
 * ## 慢轮询（1s）为什么还要留
 *
 * 推送只在「有新输出 / 终态变化」时来，而退出码、还能不能输入、被外面关掉这些**没有事件**；
 * 它同时是推送链路的兜底（真丢了一帧，最多 1s 后自己补上）。
 *
 * 三条旧口径照旧：
 * - 「切走再切回」**不重置**偏移与累积串（标签一直挂着，重置会让每次切回来整屏重绘闪一下）；
 * - 终端被摘出注册表（读回 `null`）→ `gone`，停止一切请求；
 * - 读失败（IPC 异常）**不算** `gone`，保留上一帧继续。
 */
import { useEffect, useRef, useState } from 'react'
import {
  onUserTerminalOutput,
  readUserTerminal,
  type UserTerminalChunk,
  type UserTerminalOutput,
} from '@/infrastructure/terminal'

/** 运行中的**慢**轮询间隔（ms）：实时性由推送负责，它只管状态与兜底 */
const SAFETY_MS = 1000
/** 已结束时的轮询间隔（ms）：内容不会变了，只为发现「被外面关掉」这类变化 */
const IDLE_MS = 2000

export interface UserConsoleState {
  /** 终端要渲染的累积流（`reset` 那帧会整段替换） */
  stream: string
  /** 最近一帧的状态（输入开关 / 退出码 / 提示文案用） */
  info: UserTerminalChunk | null
  /** 已不在本会话的注册表里（被关掉了）—— 提示 + 停止请求 */
  gone: boolean
}

/** 供慢轮询调用的补帧入口（由订阅那个 effect 装配，两个 effect 因此不必互相依赖） */
interface Helpers {
  /** `null` = 终端已不在表里；`undefined` = 这一帧没读到（IPC 异常） */
  catchUp: () => Promise<UserTerminalChunk | null | undefined>
}

/** 两帧的状态字段是否一样（内容为空的帧据此决定「要不要重渲染」） */
function sameStatus(a: UserTerminalChunk | null, b: UserTerminalChunk): boolean {
  return (
    !!a &&
    a.running === b.running &&
    a.interactive === b.interactive &&
    a.exitCode === b.exitCode &&
    a.killed === b.killed &&
    a.headDropped === b.headDropped
  )
}

export function useUserConsole(
  sessionId: string,
  termId: string,
  active = true,
): UserConsoleState {
  const [state, setState] = useState<UserConsoleState>({
    stream: '',
    info: null,
    gone: false,
  })
  const key = `${sessionId}\u0000${termId}`
  /** 偏移与累积串活在这里（暂停 / 恢复、重渲染都不该丢）：它们是「这一路终端」的私有状态 */
  const cursorRef = useRef({ key: '', offset: 0, stream: '' })
  const helpersRef = useRef<Helpers | null>(null)

  // ── 推送订阅 + 补帧（换终端才重建；切走标签不重注册，避免在重注册的空档丢帧）──
  useEffect(() => {
    if (cursorRef.current.key !== key) {
      cursorRef.current = { key, offset: 0, stream: '' }
      setState({ stream: '', info: null, gone: false })
    }
    let alive = true
    let unlisten: (() => void) | undefined
    /** 补帧的串行化令牌：同一时刻只允许一个读请求；期间再有人要就置 `again`，读完补一次 */
    const gate = { inFlight: false, again: false }

    /** 一帧读命令应答落地。返回这一帧（`null` = 终端已摘表，`undefined` = 没读成） */
    const apply = (
      chunk: UserTerminalChunk | null,
    ): UserTerminalChunk | null | undefined => {
      if (!alive) return undefined
      if (!chunk) {
        setState((s) => (s.gone ? s : { ...s, gone: true }))
        return null
      }
      const cursor = cursorRef.current
      cursor.offset = chunk.next
      // 没有新内容的帧（慢轮询大多数时候如此）不该触发一次整块面板的重渲染：
      // 状态字段没变就原样返回上一个 state
      if (!chunk.reset && !chunk.text) {
        setState((s) => (sameStatus(s.info, chunk) && !s.gone ? s : { ...s, info: chunk, gone: false }))
        return chunk
      }
      cursor.stream = chunk.reset ? chunk.text : cursor.stream + chunk.text
      setState({ stream: cursor.stream, info: chunk, gone: false })
      return chunk
    }

    /** 按当前游标补一帧（推送断档 / 慢轮询共用） */
    const catchUp = async (): Promise<UserTerminalChunk | null | undefined> => {
      if (gate.inFlight) {
        gate.again = true
        return undefined
      }
      gate.inFlight = true
      try {
        let latest: UserTerminalChunk | null | undefined
        do {
          gate.again = false
          const from = cursorRef.current.offset
          let chunk: UserTerminalChunk | null
          try {
            chunk = await readUserTerminal(sessionId, termId, from)
          } catch {
            // 读失败：保留上一帧，稍后再试（不能当成「终端没了」）
            return undefined
          }
          if (!alive) return undefined
          if (chunk && !chunk.reset && cursorRef.current.offset !== from) {
            // 读的过程中推送抢先推进了游标 —— 这一帧的起点已经过时，按新游标重读
            gate.again = true
            continue
          }
          latest = apply(chunk)
          if (latest === null) return null // 已摘表：没有继续读的必要
        } while (gate.again && alive)
        return latest
      } finally {
        gate.inFlight = false
      }
    }
    helpersRef.current = { catchUp }

    /** 推送帧：只有 `from` 与本地位移严丝合缝时才直接落地（一次 setState，不等定时器） */
    const onFrame = (frame: UserTerminalOutput) => {
      if (!alive || frame.sessionId !== sessionId || frame.id !== termId) return
      const cursor = cursorRef.current
      if (frame.from === cursor.offset) {
        cursor.offset = frame.next
        cursor.stream = frame.reset ? frame.text : cursor.stream + frame.text
        // 终态（`running=false`）也走这条：退出那一帧不必等下一次轮询才禁掉输入
        setState((s) => ({
          stream: cursor.stream,
          gone: s.gone,
          info: s.info
            ? {
              ...s.info,
              running: frame.running,
              interactive: s.info.interactive && frame.running,
            }
            : s.info,
        }))
        // 退出那一帧：顺手补一次读，把退出码 / `killed` 这些「只有读命令才给」的字段拿回来
        // （不必等 1s 的慢轮询）。补读会按新的游标走，与后面的尾巴帧不冲突。
        if (!frame.running) void catchUp()
        return
      }
      // 全是已经有的（首帧与自己的首次读重叠 / 重复投递）：无需补读
      if (!frame.reset && frame.next <= cursor.offset) return
      // 断档（或起点比本地早，可能半截重叠）：交给读命令按游标补
      void catchUp()
    }

    void onUserTerminalOutput(onFrame).then((off) => {
      if (alive) unlisten = off
      else off() // 订阅回来时组件已经卸载 / 换了终端
    })

    return () => {
      alive = false
      helpersRef.current = null
      if (unlisten) unlisten()
    }
  }, [sessionId, termId, key])

  // ── 慢轮询：状态与兜底。切走（`active=false`）时一个请求都不发 ──
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (stopped) return
      // 窗口不可见时不发请求（没人看着），但保留节奏 —— 回到前台立刻续上
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(tick, IDLE_MS)
        return
      }
      const chunk = await helpersRef.current?.catchUp()
      if (stopped) return
      // 已摘表 → 停；没读成（undefined）也退到 IDLE_MS 再试
      if (chunk === null) return
      timer = setTimeout(tick, chunk?.running ? SAFETY_MS : IDLE_MS)
    }

    timer = setTimeout(tick, 0)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, termId, active])

  return state
}
