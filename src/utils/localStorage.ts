/**
 * 纯 localStorage 读写工具（无 mobx、无业务逻辑）
 * 供 Infrastructure Repository 层使用
 */

export function getLocal<T>(defaultValue: T, key: string, storage = localStorage): T {
  try {
    const str = storage.getItem(key)
    if (!str) return defaultValue
    const data = JSON.parse(str)
    return data ?? defaultValue
  } catch {
    return defaultValue
  }
}

export function setLocal(key: string, data: unknown, storage = localStorage): void {
  storage.setItem(key, JSON.stringify(data))
}
