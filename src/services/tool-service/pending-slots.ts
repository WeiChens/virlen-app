/**
 * 一个会话的「待应答交互」槽位表（按 `interactionId`，多槽 —— 并发提问 / 并行审批各占一格）。
 *
 * 除了存 `resolve` / `reject`，它还负责**同步侧边栏徽标**（`ui/store/pendingInteractionStore`）：
 * 这儿的增 / 删 / 清就是「那个会话还有几个交互在等我」的全部事实来源。
 * ⚠️ 所以别退回裸 `Map`：三条路（应答 / 拒绝 / 运行结束收敛）各手写一次计数，漏一处就是
 * 徽标永远红着（或该红时不红）—— 这类缺陷在单会话里根本看不出来。
 *
 * 直接继承 `Map`（而不是包一层）：现有 `size` / `[...pendings]` / `for..of` / `delete` 用法一行都不用改。
 */
import { setPendingInteractionCount } from '@/ui/store/pendingInteractionStore'

export class PendingSlots<T> extends Map<string, T> {
  constructor(private readonly sessionId: string) {
    super()
  }

  private sync(): void {
    setPendingInteractionCount(this.sessionId, this.size)
  }

  set(key: string, value: T): this {
    super.set(key, value)
    this.sync()
    return this
  }

  delete(key: string): boolean {
    const ok = super.delete(key)
    this.sync()
    return ok
  }

  clear(): void {
    super.clear()
    this.sync()
  }
}
