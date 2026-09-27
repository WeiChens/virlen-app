import { track } from '@/utils/telemetry'
import { PHONE_EVENTS, setSubscribedCount } from './telemetry'

/**
 * 会话订阅登记表 —— 电脑侧「哪些会话正在被手机关注」。
 *
 * 手机 `host.session.subscribe` 后，电脑侧的 store-bridge 才会把该会话的
 * 消息 / 流式 / 运行时 / 占用事件推给它（`host.event.session.list.changed` 恒推，不受此限）。
 *
 * ⚠️ 除了 `host.session.subscribe`，`host-source.createSession` 也会把一个会话加进来：
 * 手机自建的会话就是它马上要看的会话。没有这条兜底时，「创建后忘了订阅」的客户端会看到最迷惑的
 * 现象 —— **标题更新了，消息永远空白**（2026-09-29 真机缺陷，§24）。
 *
 * 普通 `Set`（非 observable）：store-bridge 的 reaction 只在**被观测的 store 变化**时触发，
 * 订阅变化本身不触发推送 —— 符合预期（订阅只是"换个窗口看"，不产生新数据）。
 */
export class SubscriptionRegistry {
  private readonly ids = new Set<string>()

  /**
   * 加入订阅集合。
   *
   * @param reason 谁把这条会话加进来的（`subscribe` = 手机显式订阅；`create` = 手机自建会话的兑底）——
   *               「这个会话为何会被推」在排查时总要回答一次。
   */
  add(sessionId: string, reason: string = 'subscribe'): void {
    const already = this.ids.has(sessionId)
    this.ids.add(sessionId)
    setSubscribedCount(this.ids.size)
    track(PHONE_EVENTS.subAdd, {
      session_id: sessionId,
      reason,
      already,
      count: this.ids.size,
    })
  }

  remove(sessionId: string): void {
    const existed = this.ids.delete(sessionId)
    setSubscribedCount(this.ids.size)
    if (existed) {
      track(PHONE_EVENTS.subRemove, { session_id: sessionId, count: this.ids.size })
    }
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId)
  }

  snapshot(): string[] {
    return [...this.ids]
  }

  clear(): void {
    if (this.ids.size > 0) {
      track(PHONE_EVENTS.subClear, { count: this.ids.size })
    }
    this.ids.clear()
    setSubscribedCount(0)
  }
}
