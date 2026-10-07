import { track } from '@/utils/telemetry'
import { PHONE_EVENTS, setSubscribedCount } from './telemetry'

/**
 * 会话订阅登记表 —— 电脑侧「哪些会话正在被手机关注」。
 *
 * 手机 host.session.subscribe 后，store-bridge 才把该会话的消息 / 流式 / 运行时 / 占用事件推给它
 *（host.event.session.list.changed 恒推，不受此限）。
 *
 * ⚠️ 除 subscribe 外，host-source.createSession 也会把会话加进来：手机自建的会话就是它马上要看的，
 * 否则会出现「标题更新了、消息永远空白」（§24）。普通 Set（非 observable）：订阅变化本身不触发推送。
 */
export class SubscriptionRegistry {
  private readonly ids = new Set<string>()

  /**
   * 加入订阅集合。
   * @param reason 谁把这条会话加进来（subscribe = 手机显式订阅；create = 手机自建会话的兜底）—— 排查「为何被推」总要答一次。
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
