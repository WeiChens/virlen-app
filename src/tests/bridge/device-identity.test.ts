/**
 * 电脑设备身份（M6，§30.1）—— 「重新获取还是同一个」的用例。
 *
 * 这条性质的失败方式很隐蔽：不是报错，而是**某天手机全部连不上**（房间号变了）。
 * 所以四级来源的优先级与「回写」都要有用例钉住。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostIdentity, loadHostIdentity, type IdentityPersistence } from '@/bridge/device-identity'

const STORAGE_KEY = 'virlen.phone.identity'
const LEGACY_KEY = 'virlen.phone.hostId'

/** 内存版持久化端口（模拟 Tauri 文件）。 */
function memoryPersistence(initial = ''): IdentityPersistence & { saved: string[] } {
  let data = initial
  const saved: string[] = []
  return {
    saved,
    load: async () => data,
    save: (json: string) => {
      data = json
      saved.push(json)
    },
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('loadHostIdentity', () => {
  it('首次运行：生成 dk- 前缀的 key，并同时落盘到文件与 localStorage', async () => {
    const persistence = memoryPersistence()
    const identity = await loadHostIdentity(persistence)
    expect(identity.deviceKey).toMatch(/^dk-[0-9a-f]{32}$/)
    expect(localStorage.getItem(STORAGE_KEY)).toContain(identity.deviceKey)
    expect(persistence.saved).toHaveLength(1)
    expect(JSON.parse(persistence.saved[0]).deviceKey).toBe(identity.deviceKey)
  })

  it('第二次运行：**同一个 key**（文件优先）', async () => {
    const persistence = memoryPersistence()
    const first = await loadHostIdentity(persistence)
    const second = await loadHostIdentity(persistence)
    expect(second.deviceKey).toBe(first.deviceKey)
    // 重新启动（localStorage 被清）也只认文件
    localStorage.clear()
    const third = await loadHostIdentity(persistence)
    expect(third.deviceKey).toBe(first.deviceKey)
  })

  it('文件不可用（浏览器 harness）→ 用 localStorage 里的那份', async () => {
    const first = await loadHostIdentity(memoryPersistence())
    const again = await loadHostIdentity(undefined)
    expect(again.deviceKey).toBe(first.deviceKey)
  })

  it('旧版 hostId 在场时**沿用旧 id**（房间号与旧实现逐字一致 → 已配对手机不失联）', async () => {
    localStorage.setItem(LEGACY_KEY, 'host-ab12cd34')
    const identity = await loadHostIdentity(memoryPersistence())
    expect(identity.deviceKey).toBe('host-ab12cd34')
    // 且被回写到新位置（下次直接走新路径）
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).deviceKey).toBe('host-ab12cd34')
  })

  it('文件里是坏数据 → 忽略并继续往下找（不能因为一次写坏就换身份）', async () => {
    const persistence = memoryPersistence('{"deviceKey": ')
    const identity = await loadHostIdentity(persistence)
    expect(identity.deviceKey).toMatch(/^dk-/)
    // 坏数据被新身份覆盖
    expect(JSON.parse(persistence.saved[0]).deviceKey).toBe(identity.deviceKey)
  })

  it('文件里的 deviceKey 为空串 → 同样视为无效', async () => {
    const identity = await loadHostIdentity(memoryPersistence('{"deviceKey":"   "}'))
    expect(identity.deviceKey).toMatch(/^dk-/)
  })

  it('load 抛错（权限 / IO 异常）→ 不影响本次运行', async () => {
    const persistence: IdentityPersistence = {
      load: async () => {
        throw new Error('boom')
      },
      save: () => {},
    }
    const identity = await loadHostIdentity(persistence)
    expect(identity.deviceKey).toMatch(/^dk-/)
  })

  it('save 抛错（落盘失败）→ 本次会话仍返回可用身份', async () => {
    const persistence: IdentityPersistence = {
      load: async () => '',
      save: () => {
        throw new Error('disk full')
      },
    }
    await expect(loadHostIdentity(persistence)).resolves.toMatchObject({
      deviceKey: expect.stringMatching(/^dk-/),
    })
  })
})

describe('createHostIdentity', () => {
  it('纯函数：每次不同、createdAt 可注入', () => {
    const a = createHostIdentity(1000)
    const b = createHostIdentity(1000)
    expect(a.deviceKey).not.toBe(b.deviceKey)
    expect(a.createdAt).toBe(1000)
  })

  it('不依赖 localStorage 也能生成（隐私模式下可用）', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => loadHostIdentity(undefined)).not.toThrow()
    spy.mockRestore()
  })
})
