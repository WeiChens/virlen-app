/**
 * 电脑设备身份（M6，见 docs/phone-control-bridge.md §30.1）。
 *
 * 「重新获取还是同一个」在这里实现：**首次生成随机 key → 立刻持久化 → 之后只读不再生成**。
 * 为什么不取硬件指纹（用户曾提的备选）：拿不到可靠的 —— 浏览器/系统升级、隐私模式、
 * 清数据都会变，同型号机器还会撞；而这个 key 要用来派生房间号并长期记录在手机端，
 * 「偶发变化」的代价是**已配对的手机全部失联**。
 *
 * 三级来源，优先级从高到低（每一级命中后都会回写上一级）：
 *   1. Tauri 文件 `<data_dir>/phone-identity.json`（最稳，不受浏览器存储清理影响）；
 *   2. `localStorage['virlen.phone.identity']`（浏览器 harness / 开发联调）；
 *   3. **旧 `virlen.phone.hostId` 迁移**：直接沿用旧 id 作为 deviceKey ——
 *      `roomFor()` 对无前缀的旧 id 得到的房间名与旧实现**逐字一致**，
 *      于是「已用旧版配对的手机」不会因为这次升级而失效（§30.6）。
 *   4. 全新生成（`newDeviceKey('host')`，与手机端同一份生成实现）。
 */
import { newDeviceKey } from 'virlen-remote'

export interface HostIdentity {
  /** 电脑设备 key（`dk-…`；从旧版本迁移来的可能是 `host-…` 形态）。 */
  deviceKey: string
  /** 首次生成时刻（列表展示 / 排查用）。 */
  createdAt: number
}

/** 身份持久化端口（Tauri 侧实现：读 / 写 JSON 文件）。 */
export interface IdentityPersistence {
  load(): Promise<string>
  save(json: string): void
}

const STORAGE_KEY = 'virlen.phone.identity'
const LEGACY_HOST_ID_KEY = 'virlen.phone.hostId'

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等场景忽略：本次会话内仍可用内存里的那份 */
  }
}

/** 解析身份 JSON（不合法返回 `null`，由调用方继续往下一级来源找）。 */
function parseIdentity(raw: string | null | undefined): HostIdentity | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Partial<HostIdentity>
    if (typeof obj.deviceKey === 'string' && obj.deviceKey.trim()) {
      return {
        deviceKey: obj.deviceKey.trim(),
        createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
      }
    }
  } catch {
    /* 坏数据 */
  }
  return null
}

/** 生成一份新身份（纯函数，供测试注入 `now`）。 */
export function createHostIdentity(now: number = Date.now()): HostIdentity {
  return { deviceKey: newDeviceKey('host'), createdAt: now }
}

/**
 * 读取（必要时创建）本机设备身份。
 *
 * 一定会把结果写回 Tauri 文件与 localStorage —— 少写一处，下次就可能在另一级读到旧值。
 */
export async function loadHostIdentity(
  persistence?: IdentityPersistence,
  now: number = Date.now(),
): Promise<HostIdentity> {
  const fromFile = parseIdentity(persistence ? await persistence.load().catch(() => '') : '')

  // 旧 hostId 迁移优先于「新建」，这样已配对的手机不会因为升级而失联
  const legacyId = readLocal(LEGACY_HOST_ID_KEY)
  const fromLegacy = legacyId ? { deviceKey: legacyId, createdAt: now } : null
  const fromLocal = parseIdentity(readLocal(STORAGE_KEY))

  const identity = fromFile ?? fromLocal ?? fromLegacy ?? createHostIdentity(now)
  persistIdentity(identity, persistence)
  return identity
}

/** 持久化（Tauri 文件 + localStorage 双写）。 */
export function persistIdentity(identity: HostIdentity, persistence?: IdentityPersistence): void {
  const json = JSON.stringify(identity)
  writeLocal(STORAGE_KEY, json)
  try {
    persistence?.save(json)
  } catch {
    /* 落盘失败不阻断本次会话（文件下次再写） */
  }
}
