/**
 * 跨会话的「待用户回答的交互」计数 —— 侧边栏红点的数据源。
 *
 * 为什么必须存在：交互走「会话内回答」时**不会**弹窗打断（也不闪任务栏），而引擎在那条 tool call 上
 * `await` 着。跑到别的会话里的提问如果没有任何标记，就是静默挂死 —— 用户根本不知道那边在等他。
 *
 * 写点只有工具侧三处 handles（`user_choice` / 命令审批 / 原生命令审批）：入表 +1、出表 -1、收敛清零，
 * 每处都按 `pendings.size` 直接写，不做引用计数（少一次减就永远红着，这类 bug 最难查）。
 * 读点是侧边栏（MobX observable，切换 / 重排都会重渲染）。
 *
 * ⚠️ 别改成「由 UI 队列反推」：那个队列只在 `chat-view` 挂载时存在，而这个标记要在任何页面都成立。
 */
import { runInAction } from 'mobx'
import RuntimeState from '@/utils/runtimeState'

export const pendingInteractionState = new RuntimeState<{
  /** 会话 id → 待回答的交互数（没有该键 = 0） */
  counts: Record<string, number>
}>({ counts: {} })

/** 该会话还有几个待回答的交互；0 = 摘掉条目（避免 map 随会话数无限增长） */
export function setPendingInteractionCount(
  sessionId: string,
  count: number,
): void {
  if (!sessionId) return
  runInAction(() => {
    const counts = { ...pendingInteractionState.value.counts }
    if (count > 0) counts[sessionId] = count
    else delete counts[sessionId]
    pendingInteractionState.value.counts = counts
  })
}

/** 侧边栏徽标用：> 0 = 这个会话在等你回答 */
export function pendingInteractionCount(sessionId: string): number {
  return pendingInteractionState.value.counts[sessionId] ?? 0
}

/** 会话被删掉：连计数一起清（运行结束的收敛路径通常已经清过，这里兜一层） */
export function dropPendingInteractions(ids: Iterable<string>): void {
  const drop = new Set(ids)
  if (drop.size === 0) return
  runInAction(() => {
    const counts = { ...pendingInteractionState.value.counts }
    for (const id of drop) delete counts[id]
    pendingInteractionState.value.counts = counts
  })
}
