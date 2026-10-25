/**
 * node 环境的全局垫片（只在 `// @vitest-environment node` 的用例里生效）。
 *
 * ⚠️ 为什么需要：仓库层（`infrastructure/agentRepo` → `utils/localStorage`）在 **import 期**就读 `localStorage`，
 * 所以纯逻辑用例一旦离开 jsdom，就会在 setup 阶段整份挂掉（与用例内容无关）。
 * 这里补一个与 jsdom 同语义（空白起步、字符串存储）的内存实现，让「不需要 DOM」的文件能跑 node 环境
 * —— 实测 jsdom 每文件约 0.68s 环境开销、node 约 0ms，这是测试提速的主要来源。
 *
 * 只在 `localStorage` 不存在时挂载，jsdom 环境（有真实现）不受影响。
 */
function installMemoryStorage(key: 'localStorage' | 'sessionStorage'): void {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => void map.set(String(k), String(v)),
    removeItem: (k: string): void => void map.delete(k),
    clear: (): void => map.clear(),
    key: (i: number): string | null => [...map.keys()][i] ?? null,
    get length(): number {
      return map.size
    },
  }
  Object.defineProperty(globalThis, key, { value: storage, configurable: true, writable: true })
}

if (typeof globalThis.localStorage === 'undefined') installMemoryStorage('localStorage')
if (typeof globalThis.sessionStorage === 'undefined') installMemoryStorage('sessionStorage')
