/**
 * store 级端到端：手机控制整链路 + 交互表跨服务实例存活（真机缺陷回归，2026-10）。
 *
 * 与前一个文件（`phone-control-interactions.test.ts`，假服务）的分工：
 *   - 那个文件钉「store 给了服务什么」（表实例是否复用、出口指向谁）；
 *   - 这个文件钉「**真的**跑起来对不对」：真 `PhoneControlService` + 真 bridge + memory transport
 *     （store 的 `createTransport` 注入口），走手机的真实路径：
 *     启用 → 手机握手 → AI 提问 → **改 ICE（换服务实例）** → 手机用 grant 重连 → 卡片仍在、能应答、
 *     新交互的推送也落到新链路。
 *
 * 为什么必须在 store 层做这件事：`RTCPeerConnection` 的 `iceServers` 只能构造时给，而「改 ICE」的
 * 用户入口就在设置页（`saveIceConfig`）—— store 是**唯一**能驱动「换实例」的地方。
 * 服务自身的链路行为（`dropLink` / 握手超时 / 移除设备）在 `src/tests/bridge/phone-*.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createCaller,
  createMemoryPair,
  type HelloResult,
  type HostApi,
  type InteractionDTO,
} from 'virlen-remote'
import toolInteractEvent from '@/events/toolInteractEvent'
import { phoneControlStore } from '@/ui/store/phoneControlStore'

const MOBILE_KEY = 'mk-store-e2e-0001'

const cleanups: Array<() => void> = []
/** 每次建链路都会新建一对 memory transport（改 ICE 后会再多一对）。 */
const links: Array<[MemoryTransport, MemoryTransport]> = []
/**
 * 手机端端点 / caller —— **按链路下标缓存**。
 *
 * ⚠️ 一条 mobile transport 上只能有一个 `Endpoint`（它才是收帧方）：重复 `new Endpoint` 会让
 * 同一个传输上挂两个收帧者，谁收到回帧就不确定了。故缓存复用。
 */
const mobileEndpoints = new Map<number, Endpoint>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return
    await sleep(5)
  }
  throw new Error(`等待超时：${what}`)
}

/** 某条链路上的手机端（懒建 + 缓存）。 */
function phone(index: number) {
  const cached = mobileEndpoints.get(index)
  if (cached) return { endpoint: cached, caller: createCaller<HostApi>(cached) }

  const [, mobile] = links[index]
  const endpoint = new Endpoint({ transport: mobile, defaultTimeoutMs: 5000 })
  mobileEndpoints.set(index, endpoint)
  cleanups.push(() => endpoint.dispose())
  return { endpoint, caller: createCaller<HostApi>(endpoint) }
}

function hello(caller: ReturnType<typeof createCaller<HostApi>>, token: string) {
  return caller.call('host.hello', {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: [],
    token,
    mobileKey: MOBILE_KEY,
    mobileName: '测试手机',
  })
}

/**
 * 手机握手：首次配对要当面确认（`confirmPair` → `store.pendingPair` → `answerPair`），
 * grant 重连则免确认（那条路根本不会走到弹窗）。
 */
async function connectPhone(index: number, token: string): Promise<HelloResult> {
  const pending = hello(phone(index).caller, token)
  for (let i = 0; i < 40 && !phoneControlStore.pendingPair; i += 1) await sleep(5)
  if (phoneControlStore.pendingPair) phoneControlStore.answerPair(true)
  return pending
}

/** AI 提问（= 手机控制里那张待应答卡片的来源，与桌面 `user_choice` 同一个入口）。 */
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

beforeEach(() => {
  links.length = 0
  mobileEndpoints.clear()
  localStorage.clear()
  phoneControlStore.pairing.restore({ devices: [], tickets: [] })
  // store 收到的传输工厂（生产不设置）→ 真服务用它建链路，jsdom 里也能跑通整条链路
  phoneControlStore.createTransport = () => {
    const [host, mobile] = createMemoryPair()
    links.push([host, mobile])
    return host
  }
})

afterEach(() => {
  phoneControlStore.setEnabled(false)
  delete phoneControlStore.createTransport
  while (cleanups.length) cleanups.pop()!()
  for (const [host, mobile] of links) {
    host.close()
    mobile.close()
  }
})

describe('手机控制端到端（store 驱动）', () => {
  it('改 ICE 换服务实例后：手机重连仍看得到那条待答交互，且能在新链路上应答', async () => {
    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled && links.length === 1, '启用建链路')

    // ① 手机握手 → 这条链路可用
    const first = await connectPhone(0, phoneControlStore.payload!.ticket)
    expect(first.grant?.token).toMatch(/^gt-/)

    // ② AI 提问 → 手机看得见（`host.interaction.list` 是手机中途接入时的补看通道）
    ask('it-e2e')
    const seen = await phone(0).caller.call('host.interaction.list', {})
    expect(seen.interactions.map((i) => i.interactionId)).toEqual(['it-e2e'])

    // ③ 改 ICE（设置页保存自定义 ICE）→ store 丢旧服务实例、建新实例、开新链路
    phoneControlStore.setIceText(JSON.stringify([{ urls: 'stun:mine:3478' }]))
    expect(await phoneControlStore.saveIceConfig()).toBe(true)
    await waitFor(() => phoneControlStore.enabled && links.length === 2, '改 ICE 后重建链路')

    // ④ 手机用 grant 重连（免扫码 —— 真机重连走的就是这条路）
    await connectPhone(1, first.grant!.token)

    // ⑤ 修复点：新链路上**仍然看得见**那条待答交互
    //    （修复前服务实例一换、表就被丢掉 → 手机上那张卡片成为点不动的僵尸）
    const after = await phone(1).caller.call('host.interaction.list', {})
    expect(after.interactions.map((i) => i.interactionId)).toEqual(['it-e2e'])

    // ⑥ 而且能在**新链路**上应答（落点仍是本机既有事件，与桌面点「确认」完全同形）
    const resolved: string[] = []
    const off = toolInteractEvent.on('resolve', (interactionId) => resolved.push(interactionId))
    cleanups.push(off)
    const answer = await phone(1).caller.call('host.interaction.answer', {
      interactionId: 'it-e2e',
      action: 'choose',
      value: { selected: ['B'], customReply: '' },
    })
    expect(answer).toEqual({ accepted: true })
    expect(resolved).toEqual(['it-e2e'])
    expect((await phone(1).caller.call('host.interaction.list', {})).interactions).toEqual([])
  })

  it('改 ICE 后**新登记**的交互照样推到新链路（出口指向当前实例）', async () => {
    phoneControlStore.setEnabled(true)
    await waitFor(() => phoneControlStore.enabled && links.length === 1, '启用建链路')
    const first = await connectPhone(0, phoneControlStore.payload!.ticket)

    phoneControlStore.setIceText(JSON.stringify([{ urls: 'stun:mine:3478' }]))
    expect(await phoneControlStore.saveIceConfig()).toBe(true)
    await waitFor(() => phoneControlStore.enabled && links.length === 2, '改 ICE 后重建链路')
    await connectPhone(1, first.grant!.token)

    const pushed: InteractionDTO[] = []
    phone(1).endpoint.subscribe('host.event.interaction.requested', (payload) => {
      pushed.push((payload as { interaction: InteractionDTO }).interaction)
    })

    ask('it-push-after-ice')
    await sleep(0)

    expect(pushed.map((i) => i.interactionId)).toEqual(['it-push-after-ice'])
  })
})
