/**
 * 握手闸门 —— 「没通过 `hello` 的链路，`host.*` 一律拒」（M10 真机缺陷回归）。
 *
 * **缺陷现场**：在设置页点「移除」，那台手机断开后**自动重连**，结果又连上了（还能操作本机）。
 *
 * 根因不在配对表（记录、凭证、墓碑都删对了），而在**链路上没有任何授权检查**：
 *  - 房间号由电脑设备 key 派生（被移除的手机也拿得到）→ 它随时能重进房间、重建 WebRTC 链路；
 *  - 而 `host.*` 是**无条件注册**的（共享包 `registerHostHandlers`），`acl.assert` 只看静态能力集
 *    （默认全开），**不看这条连接是谁**。
 * 于是「删掉记录」对一条已经跑起来的链路毫无约束力 —— 用户的观感就是「移除没用」。
 *
 * 本文件钉四件事：
 *  1. 开闸门：**没握过手**就调 `host.*` → `E_DENIED`（伪造的 RPC 也拦得住）；
 *  2. 开闸门：`hello` 通过后正常放行；
 *  3. 开闸门：`hello` **被拒**之后依然一律拒 —— 这才是「移除」真正生效的地方；
 *  4. 不开闸门（默认）：行为与从前一致 —— 单测 / 联调里直接打 RPC 是既有约定。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HelloParams,
  type HostApi,
  type HostEvents,
} from 'virlen-remote'
import { PhoneControlService, startPhoneBridge, type PhoneBridge, type PhoneControlOptions } from '@/bridge'
import { sessionStore } from '@/ui/store'
import type { Session } from '@/types'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
})

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

function makeSession(id: string, title: string): Session {
  const now = Date.now()
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SECRET-SYSTEM-PROMPT',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    workspace: 'C:/secret/workspace',
  }
}

const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

/** 一条 hello 调用（与其它 phone 用例同一口径）。 */
function helloParams(token?: string): HelloParams {
  return {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: [],
    mobileKey: MOBILE_KEY,
    mobileName: '测试手机',
    ...(token === undefined ? {} : { token }),
  }
}

/** 裸 bridge（不经服务）：直接观察闸门本身的语义。 */
function setupBridge(requireAuthorization?: boolean): {
  bridge: PhoneBridge
  caller: ReturnType<typeof createCaller<HostApi>>
  sub: ReturnType<typeof createSubscriber<HostEvents>>
  device: { deviceId: string; token: string }
} {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-gate',
    ...(requireAuthorization === undefined ? {} : { requireAuthorization }),
  })
  const device = bridge.pairing.register('已配对手机', { mobileKey: MOBILE_KEY })
  cleanups.push(() => {
    bridge.dispose()
    hostEp.dispose()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  return {
    bridge,
    caller: createCaller<HostApi>(mobileEp),
    sub: createSubscriber<HostEvents>(mobileEp),
    device,
  }
}

describe('握手闸门（requireAuthorization）', () => {
  it('开闸门：未授权的链路连**推送**都收不到（侧路事件也不行）', async () => {
    const { caller, sub, device } = setupBridge(true)
    const lists: number[] = []
    sub.subscribe('host.event.session.list.changed', (e) => lists.push(e.sessions.length))

    // 侧路推送：不经过 `host.*`，由 mobx reaction 直接 emit（store-bridge 的那条路）
    sessionStore.saveSession(makeSession('s-gate-1', '未授权不该看到'))
    await flush(50)
    expect(lists).toEqual([])

    // 握手之后，同一条链路就能收到（证明不是「永远收不到」）
    await caller.call('host.hello', helloParams(device.token))
    sessionStore.saveSession(makeSession('s-gate-2', '握手后该看到'))
    await waitFor(() => lists.length > 0)
  })

  it('开闸门：没握过手就调 host.* → E_DENIED（连「裸连」也拦得住）', async () => {
    const { caller } = setupBridge(true)

    await expect(caller.call('host.session.list', {})).rejects.toMatchObject({ code: 'E_DENIED' })
  })

  it('开闸门：hello 通过后正常放行', async () => {
    const { caller, device } = setupBridge(true)

    await expect(caller.call('host.hello', helloParams(device.token))).resolves.toMatchObject({
      paired: true,
    })
    await expect(caller.call('host.session.list', {})).resolves.toMatchObject({
      sessions: expect.any(Array),
    })
  })

  it('开闸门：hello 被拒（已被移除）之后**依然**一律拒 —— 「移除」生效的关键', async () => {
    const { caller, bridge, device } = setupBridge(true)
    bridge.pairing.revoke(device.deviceId)

    await expect(caller.call('host.hello', helloParams(device.token))).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'revoked' },
    })
    // 拒了之后不是「hello 报错、RPC 照做」—— 读和写都得拦
    await expect(caller.call('host.session.list', {})).rejects.toMatchObject({ code: 'E_DENIED' })
    await expect(caller.call('host.model.list', {})).rejects.toMatchObject({ code: 'E_DENIED' })
  })

  it('开闸门：伪造的串（invalid）同样只换来一条未授权的链路', async () => {
    const { caller } = setupBridge(true)

    await expect(caller.call('host.hello', helloParams('gt-forged'))).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    await expect(caller.call('host.session.list', {})).rejects.toMatchObject({ code: 'E_DENIED' })
  })

  it('闸门是**链路级**的：授权不跨链路复用', async () => {
    const first = setupBridge(true)
    await first.caller.call('host.hello', helloParams(first.device.token))
    await expect(first.caller.call('host.session.list', {})).resolves.toBeTruthy()

    // 另一条链路（同一台电脑）：没握过手 → 拒
    const second = setupBridge(true)
    await expect(second.caller.call('host.session.list', {})).rejects.toMatchObject({
      code: 'E_DENIED',
    })
  })

  it('不开闸门（默认）：行为与从前一致（单测 / 联调直接打 RPC 的既有约定）', async () => {
    const { caller } = setupBridge()

    await expect(caller.call('host.session.list', {})).resolves.toMatchObject({
      sessions: expect.any(Array),
    })
  })
})

describe('服务路径必须带着闸门（真机缺陷的完整回放）', () => {
  /**
   * 「移除一台正在连接手机 → 它自动重连到新链路上」的完整回放。
   *
   * 三步都在：① 第一次配对拿到凭证；② 电脑端移除（删记录 + 断链重开，店里那条链路真的关了）；
   * ③ 手机拿**旧凭证**在**新链路**上重连 —— 期望是「hello 被拒，且之后什么都做不了」。
   */
  it('移除在线手机 → 它重连到新链路：hello 被拒，host.* 全部拒', async () => {
    const links: Array<[MemoryTransport, MemoryTransport]> = []
    const service = new PhoneControlService({
      signalUrl: 'https://virlen.cn/api/rtc',
      deviceName: '我的电脑',
      deviceKey: DEVICE_KEY,
      createTransport: () => {
        const [host, mobile] = createMemoryPair()
        links.push([host, mobile])
        return host
      },
    } satisfies PhoneControlOptions)
    cleanups.push(() => {
      service.disable()
      for (const [host, peer] of links) {
        host.close()
        peer.close()
      }
    })
    service.enable()

    // ① 手机扫码 → 桌面确认（缺省放行）→ 签发凭证
    const mobileOf = (index: number) => {
      const endpoint = new Endpoint({ transport: links[index][1], defaultTimeoutMs: 2000 })
      cleanups.push(() => endpoint.dispose())
      return createCaller<HostApi>(endpoint)
    }
    const granted = await mobileOf(0).call('host.hello', helloParams(service.pairingPayload().ticket))
    const device = service.pairing.list()[0]
    expect(device).toBeTruthy()
    expect(granted.grant?.token).toMatch(/^gt-/)

    // ② 设置页「移除」：删记录（含凭证与墓碑）+ 断链重开
    service.pairing.revoke(device.deviceId)
    service.dropLink()
    expect(links[0][0].state).toBe('closed')
    expect(links).toHaveLength(2)

    // ③ 手机自动重连（新链路、旧凭证）
    const reconnected = mobileOf(1)
    await expect(
      reconnected.call('host.hello', helloParams(granted.grant!.token)),
    ).rejects.toMatchObject({ code: 'E_DENIED', data: { reason: 'revoked' } })
    // 「又连上了」的真相就在这两行：拒完之后，这条链路上**任何** host.* 也不通
    await expect(reconnected.call('host.session.list', {})).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    expect(service.pairing.list()).toEqual([])
  })
})
