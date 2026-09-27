/**
 * 「ICE 从哪来」的 store 用例（M7，§31）。
 *
 * 守的是用户可见的三条：
 *  - **默认走服务端下发**：客户端源码里不再有任何 TURN 凭证（也没了内置默认值）；
 *  - 自定义优先，且非法配置**不落盘、不阻断**（自动降级 + 标红）；
 *  - 服务端下发过的配置会缓存 —— 信令抖一下不至于退化成「仅本机候选」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ICE_CUSTOM_STORAGE_KEY, ICE_REMOTE_STORAGE_KEY } from 'virlen-remote'
import { phoneControlStore } from '@/ui/store/phoneControlStore'

/** 定制全局 fetch 的应答（`setup.ts` 默认返回 `{}`，对「下发」而言等于没答）。 */
function mockFetch(body: unknown, ok = true): ReturnType<typeof vi.mocked<typeof fetch>> {
  const spy = vi.mocked(global.fetch)
  spy.mockClear()
  spy.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response)
  return spy
}

beforeEach(() => {
  localStorage.clear()
  phoneControlStore.setIceText('')
})

describe('phoneControlStore —— ICE 解析（§31）', () => {
  it('默认：服务端下发什么就用什么，来源记 remote', async () => {
    mockFetch({
      v: 1,
      mode: 'static',
      iceServers: [
        { urls: 'stun:a:3478' },
        { urls: 'turn:a:3478', username: 'u', credential: 'p' },
      ],
    })
    await phoneControlStore.resolveIce()

    expect(phoneControlStore.iceSource).toBe('remote')
    expect(phoneControlStore.iceServers).toHaveLength(2)
    expect(phoneControlStore.iceDetail).toContain('服务端下发')
    expect(phoneControlStore.iceWarning).toBe(null)
  })

  it('服务端下发过的配置会缓存：第二次解析不再请求', async () => {
    mockFetch({ iceServers: [{ urls: 'stun:a:3478' }] })
    await phoneControlStore.resolveIce()
    expect(phoneControlStore.iceSource).toBe('remote')
    expect(localStorage.getItem(ICE_REMOTE_STORAGE_KEY)).toBeTruthy()

    const spy = mockFetch({ iceServers: [{ urls: 'stun:b:3478' }] })
    await phoneControlStore.resolveIce()
    expect(phoneControlStore.iceSource).toBe('cache')
    expect(phoneControlStore.iceServers).toEqual([{ urls: 'stun:a:3478' }])
    expect(spy).not.toHaveBeenCalled()
  })

  it('自定义优先：保存后立刻生效，且**不再请求**服务端', async () => {
    const spy = mockFetch({ iceServers: [{ urls: 'stun:server:3478' }] })
    phoneControlStore.setIceText('[{"urls":"stun:mine:3478"}]')
    expect(await phoneControlStore.saveIceConfig()).toBe(true)

    expect(JSON.parse(localStorage.getItem(ICE_CUSTOM_STORAGE_KEY)!)).toEqual([
      { urls: 'stun:mine:3478' },
    ])
    expect(phoneControlStore.iceSource).toBe('custom')
    expect(phoneControlStore.iceServers).toEqual([{ urls: 'stun:mine:3478' }])
    expect(spy).not.toHaveBeenCalled()
  })

  it('非法自定义：不落盘、标红，并保留上一份生效配置（连接不被阻断）', async () => {
    // 先建立基线：当前生效 = 服务端下发
    localStorage.removeItem(ICE_REMOTE_STORAGE_KEY)
    mockFetch({ iceServers: [{ urls: 'stun:server:3478' }] })
    await phoneControlStore.resetIceConfig()
    expect(phoneControlStore.iceSource).toBe('remote')

    phoneControlStore.setIceText('[{') // 少了个右括号
    expect(await phoneControlStore.saveIceConfig()).toBe(false)

    expect(localStorage.getItem(ICE_CUSTOM_STORAGE_KEY)).toBe('')
    expect(phoneControlStore.iceCustomError).toBeTruthy()
    // 关键：非法输入**不带崩**已生效的配置
    expect(phoneControlStore.iceSource).toBe('remote')
    expect(phoneControlStore.iceServers).toEqual([{ urls: 'stun:server:3478' }])
  })

  it('恢复服务端默认：清掉自定义并重新解析', async () => {
    mockFetch({ iceServers: [{ urls: 'stun:mine:3478' }] })
    phoneControlStore.setIceText('[{"urls":"stun:mine:3478"}]')
    await phoneControlStore.saveIceConfig()
    expect(phoneControlStore.iceSource).toBe('custom')

    localStorage.removeItem(ICE_REMOTE_STORAGE_KEY)
    mockFetch({ iceServers: [{ urls: 'stun:server:3478' }] })
    await phoneControlStore.resetIceConfig()

    expect(localStorage.getItem(ICE_CUSTOM_STORAGE_KEY)).toBe('')
    expect(phoneControlStore.iceText).toBe('')
    expect(phoneControlStore.iceSource).toBe('remote')
    expect(phoneControlStore.iceServers).toEqual([{ urls: 'stun:server:3478' }])
  })

  it('服务端没配 → 如实报「未配置」并带提示（不抛错，仅本机候选）', async () => {
    mockFetch({ v: 1, mode: 'none', iceServers: [] })
    await phoneControlStore.resolveIce()

    expect(phoneControlStore.iceSource).toBe('none')
    expect(phoneControlStore.iceServers).toEqual([])
    expect(phoneControlStore.iceDetail).toContain('仅本机候选')
    expect(phoneControlStore.iceWarning).toBeTruthy()
  })

  it('服务端不可达（非 2xx）→ 未配置 + 提示，而不是把「启用手机控制」搞挂', async () => {
    mockFetch({}, false)
    await phoneControlStore.resolveIce()

    expect(phoneControlStore.iceSource).toBe('none')
    expect(phoneControlStore.iceWarning).toContain('不可达')
  })

  it('文本框回填：把已保存的自定义规范化后显示（坏数据按空处理）', async () => {
    mockFetch({ iceServers: [] })
    localStorage.setItem(ICE_CUSTOM_STORAGE_KEY, '[{"urls":"stun:mine:3478"}]')
    phoneControlStore.loadIceText()
    expect(phoneControlStore.iceText).toBe('[\n  {\n    "urls": "stun:mine:3478"\n  }\n]')

    localStorage.setItem(ICE_CUSTOM_STORAGE_KEY, '<<bad')
    phoneControlStore.loadIceText()
    expect(phoneControlStore.iceText).toBe('')
  })
})
