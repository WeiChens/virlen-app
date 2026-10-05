/**
 * store 级：待应答交互注册表的**所有权与推送出口**（真机缺陷回归，2026-10）。
 *
 * 守的是 store 那层胶水（`ensureInteractions`）—— 它是「改 ICE 换服务实例后表还在」的最后一环：
 *  1. 表**懒建、且跨服务实例复用**（改 ICE 前 / 后交给服务的是同一个实例）；
 *  2. 表里排队的交互在重建后**仍在**；
 *  3. 推送出口指向**当前**那个服务实例（不是被丢掉的那个）—— `emitToLink` 必须现取，不能闭包住旧实例；
 *  4. 启停（`setEnabled(false/true)`）不换表也不换实例。
 *
 * 为什么用**假服务**：这一层要单独钉「store 给了什么」，而不是服务怎么用（jsdom 里没有
 * `RTCPeerConnection`，真服务跑不起来）。既有 `phone-control-link.test.ts` 是同一套做法。
 * 真服务（接线 + 表跨实例存活 + 真链路）在 `phone-control-relink.test.ts` 里钉。
 *
 * ⚠️ 假服务与**真实现同构**的两点（否则这个用例是自证）：
 *  - 接线**随启用走**：构造时不接，`enable()` 挂、`disable()` 解 —— 对应服务的
 *    `attachInteractions` / `detachInteractions`（即接线生命周期 = 启用）；
 *  - 同一张表只接一次线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import toolInteractEvent from '@/events/toolInteractEvent'

/** 假服务实例（只记「store 给了什么 + 收到哪些推送」）。 */
interface FakeService {
  name: string
  options: Record<string, any>
  /** 本实例通过 `emitToLink` 收到的推送 —— 用来验证 store 的出口指向当前实例。 */
  emitted: Array<{ topic: string; payload: any }>
}

const h = vi.hoisted(() => ({ created: [] as FakeService[] }))

vi.mock('@/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/bridge')>()
  // 走内部路径取「接线」入口（它不在 barrel 的导出面上；这里要的就是真实现）
  const { wireInteractionSources } = await import('@/bridge/interaction-source')

  let seq = 0
  class FakePhoneControlService {
    readonly name: string
    readonly emitted: Array<{ topic: string; payload: any }> = []
    private detach: (() => void) | null = null
    private readonly interactions: any

    constructor(readonly options: Record<string, any>) {
      seq += 1
      this.name = `svc-${seq}`
      this.interactions = options.interactions
      h.created.push(this as unknown as FakeService)
    }

    /** 真实现是 `bridge.emit` 的转发入口（未握手 / 没链路时丢弃）。 */
    emitToLink = (topic: string, payload: any): void => {
      this.emitted.push({ topic, payload })
    }

    /** 接线：表归调用方持有（跨实例复用），同一个实例只接一次（见文件头的「同构」说明）。 */
    private attach(): void {
      if (this.detach || !this.interactions) return
      this.detach = wireInteractionSources(this.interactions)
    }

    private unwire(): void {
      this.detach?.()
      this.detach = null
    }

    enable(): void {
      this.attach()
    }
    disable(): void {
      this.unwire()
    }
    dispose(): void {
      this.disable()
    }

    pairingPayload() {
      return { host: 'dk-fake', name: '假电脑', ticket: 'pr-fake', signal: 'https://fake/' }
    }
    get ticketDeadline(): number {
      return Date.now() + 60_000
    }
    rotateTicketIfStale(): boolean {
      return false
    }
    refreshTicket() {
      return this.pairingPayload()
    }
  }

  return { ...actual, PhoneControlService: FakePhoneControlService }
})

import { phoneControlStore } from '@/ui/store/phoneControlStore'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等条件成立（`setEnabled` / `saveIceConfig` 之后的重建都是异步的）。
 *
 * ⚠️ 服务实例是**跨用例复用**的（store 只在没有实例时才新建，见 `ensureService`），
 * 所以一律用「调用前的基线计数」判定「新建了几个实例」，不要假设从 0 开始。
 */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return
    await sleep(5)
  }
  throw new Error(`等待超时：${what}`)
}

/** 当前的假服务实例（可能由前面的用例建出）。 */
function currentService(): FakeService {
  const service = h.created[h.created.length - 1]
  if (!service) throw new Error('还没有服务实例')
  return service
}

/**
 * 把上一用例留在表里的待应答交互收敛掉。
 *
 * ⚠️ store / 表都是**模块级单例**（跨用例复用），不清就会让下一个用例看到上一个用例的条目。
 */
function settleLeftovers(): void {
  const table = h.created[h.created.length - 1]?.options.interactions
  if (!table) return
  for (const item of table.list() as Array<{ interactionId: string }>) {
    table.settle(item.interactionId, 'expired', 'host')
  }
}

/** 手机侧「AI 提问」的真实入口（`user_choice` 在电脑侧就是发这个事件）。 */
function ask(interactionId: string): void {
  toolInteractEvent.emit('showChoice', {
    interactionId,
    sessionId: 's-1',
    toolCallId: 'tc-1',
    question: '选哪个？',
    options: ['A', 'B'],
    multi: false,
  })
}

function requestedIds(service: FakeService): string[] {
  return service.emitted
    .filter((e) => e.topic === 'host.event.interaction.requested')
    .map((e) => e.payload.interaction.interactionId)
}

beforeEach(() => {
  settleLeftovers()
  localStorage.clear()
  phoneControlStore.pairing.restore({ devices: [], tickets: [] })
})

afterEach(() => {
  phoneControlStore.setEnabled(false)
})

describe('store 持有交互注册表：改 ICE / 启停都不换表', () => {
  it('改 ICE 换服务实例：同一个表、条目仍在、出口指向新实例', async () => {
    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled, '启用')
    const a = currentService()
    const table = a.options.interactions
    expect(table).toBeTruthy()

    // ① 表是 store 建的，并已接上本机交互来源（服务构造时接线）
    ask('it-store')
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-store'])
    expect(requestedIds(a)).toEqual(['it-store'])

    // ② 改 ICE（用户路径：设置页保存自定义 ICE）→ store 丢旧实例、建新实例
    const base = h.created.length // 改 ICE 前的实例数（服务实例可能由前面的用例建出）
    phoneControlStore.setIceText(JSON.stringify([{ urls: 'stun:mine:3478' }]))
    expect(await phoneControlStore.saveIceConfig()).toBe(true)
    await waitFor(
      () => h.created.length === base + 1 && phoneControlStore.enabled,
      `改 ICE 重建服务（created=${h.created.length}/${base + 1}、enabled=${phoneControlStore.enabled}、identity=${!!phoneControlStore.identity}）`,
    )
    const b = currentService()
    expect(b).not.toBe(a)

    // ③ 交给新实例的是**同一个表**（修复前：新实例拿到新表 → 手机上的卡片变僵尸）
    expect(b.options.interactions).toBe(table)
    // ④ 排队中的交互仍在
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-store'])

    // ⑤ 出口指向**新**实例：新交互的推送由 b 收下，旧实例不再收到任何东西
    ask('it-store-2')
    expect(requestedIds(b)).toEqual(['it-store-2'])
    expect(requestedIds(a)).toEqual(['it-store'])
    // ⑥ 接线也被新实例重挂上了（旧实例 dispose 时已解绑）
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-store', 'it-store-2'])
  })

  it('停用 → 解绑接线：关掉期间不再登记；重新启用后恢复（已排队的条目不清）', async () => {
    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled, '启用')
    const a = currentService()
    const table = a.options.interactions

    ask('it-before-off')
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-before-off'])
    const pushedBefore = requestedIds(a).length

    phoneControlStore.setEnabled(false)
    expect(phoneControlStore.enabled).toBe(false)

    ask('it-while-off')
    // 远端已经下线：不登记、也不上报 `phone.interaction.*`（旧实现：照样登记 + 上报，纯噪音）
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-before-off'])
    expect(requestedIds(a)).toHaveLength(pushedBefore)

    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled, '重新启用')
    ask('it-after-on')
    expect(requestedIds(currentService())).toContain('it-after-on')
    /*
     * 关闭前挂起的那条**仍在表里**：表代表「电脑侧真正还在等的交互」，本机弹窗与引擎都没停，
     * 手机重新连上就该能应答它。刻意不「停用即清空」—— 见 `detachInteractions` 的说明。
     */
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-before-off', 'it-after-on'])
  })

  it('停用再启用：复用同一个服务实例与同一张表（表不会因启停丢条目）', async () => {
    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled, '启用')
    const before = h.created.length
    const a = currentService()
    const table = a.options.interactions
    ask('it-keep')

    phoneControlStore.setEnabled(false)
    expect(phoneControlStore.enabled).toBe(false)

    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled, '重新启用')

    expect(h.created).toHaveLength(before) // 复用实例，不重建
    expect(currentService()).toBe(a)
    expect(a.options.interactions).toBe(table)
    expect(table.list().map((i: any) => i.interactionId)).toEqual(['it-keep'])
  })
})
