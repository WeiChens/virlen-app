/**
 * 埋点链路上下文（§5.4 / §5.5）
 *
 * 抽到独立模块：编排层（flow）负责开启/回收链路，事件处理器（event-handler）
 * 负责读取/更新（首 token、轮次、工具调用、错误标记），二者共享同一张表。
 */

/** 当前活跃请求的链路上下文 */
const activeTraces = new Map<
  string,
  {
    traceId: string
    startTime: number
    firstTokenSeen: boolean
    /** 本轮是否发生过错误（供 engine.finish / chat.stream.end 推导 status） */
    errored: boolean
    /** 本轮 LLM 轮次计数（assistant_message_created 次数，供 engine.finish.rounds） */
    rounds: number
    /** 本轮去重后的工具调用 ID 集合（供 engine.finish.tool_calls_total） */
    toolCallIds: Set<string>
  }
>()

/** 标记本轮链路发生过错误 */
function markErrored(sessionId: string): void {
  const tr = activeTraces.get(sessionId)
  if (tr) tr.errored = true
}

export { activeTraces, markErrored }
