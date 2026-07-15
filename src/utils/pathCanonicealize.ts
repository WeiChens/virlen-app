import { invoke } from '@tauri-apps/api/core'

/** 简单 LRU 缓存，避免重复 invoke canonicalize_path */
class CanonicalizeCache {
  private cache = new Map<string, string | null>()
  private max: number

  constructor(max = 500) {
    this.max = max
  }

  get(key: string): string | null | undefined {
    return this.cache.get(key)
  }

  set(key: string, value: string | null): void {
    if (this.cache.size >= this.max) {
      const first = this.cache.keys().next().value
      if (first !== undefined) this.cache.delete(first)
    }
    this.cache.set(key, value)
  }
}

const canonicalCache = new CanonicalizeCache()

export async function tryCanonicalize(path: string): Promise<string | null> {
  const cached = canonicalCache.get(path)
  if (cached !== undefined) return cached

  try {
    const result = await invoke<string | null>('canonicalize_path', { path })
    canonicalCache.set(path, result)
    return result
  } catch {
    canonicalCache.set(path, null)
    return null
  }
}

/**
 * 对路径做 partial canonicalize：路径不存在时逐层向上取存在的父目录，
 * 返回已 canonicalize 的路径前缀（不拼接不存在部分，防止越权）。
 */
export async function tryCanonicalizePartial(
  path: string,
): Promise<string | null> {
  const c = await tryCanonicalize(path)
  if (c) return c

  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  for (let i = parts.length - 1; i >= 1; i--) {
    const parent = parts.slice(0, i).join('/')
    const cParent = await tryCanonicalize(parent)
    if (cParent) return cParent
  }
  return null
}
