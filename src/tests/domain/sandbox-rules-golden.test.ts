/**
 * 「忽略沙盒命令」规则 golden 一致性测试（TS 侧）
 *
 * 目的：把「TS 匹配」与「Rust 匹配」钉死在同一份判定上。
 *
 * 背景（D4 / 配置下沉）：纯 Rust CLI 没有 JS 进程，所以 `js` 类规则改由 Rust 侧内嵌
 * QuickJS 求值（`src-tauri/virlen-core/src/security/js_rule.rs`），`text` / `regex` 也由 Rust 原生实现
 * （`src-tauri/virlen-core/src/security/rules.rs`）—— 即**默认引擎（Rust）+ CLI 的权威实现**。
 * TS 实现（`domain/security/sandbox-ignore-rules`）仍然保留：浏览器 dev、用户关闭 Rust 引擎
 * 的降级路径、设置页「测试」按钮、保存期 `compileSandboxRule` 都要用它。
 * 两份实现必须行为一致 —— 由本测试 + Rust 侧 `rules.rs::tests::golden_matches_ts_implementation` 保证。
 *
 * 契约文件（唯一事实源，两侧共读）：
 *   src/tests/fixtures/sandbox-rules.golden.json
 *   - TS：Vite `?raw` 导入（下方 import）+ `JSON.parse`
 *   - Rust：`CARGO_MANIFEST_DIR/../src/tests/fixtures/sandbox-rules.golden.json`（运行时读取）
 *
 * ⚠️ fixture 里只放「两侧都能求值」的用例：死循环 / 超内存 / host 能力探测只在 Rust 单测里
 *    （TS 侧是渲染进程内的 `new Function`，**没有**超时保护，跑死循环会卡死测试）。
 */
import { describe, expect, it } from 'vitest'
import GOLDEN_RAW from '@/tests/fixtures/sandbox-rules.golden.json?raw'
import {
  findMatchingSandboxRule,
  type SandboxIgnoreRule,
} from '@/domain/security/sandbox-ignore-rules'

interface GoldenDoc {
  rules: Array<Record<string, unknown>>
  cases: Array<{ command: string; expectRuleId: string | null }>
}

const GOLDEN = JSON.parse(GOLDEN_RAW) as GoldenDoc
/** fixture 里的规则刻意含「缺 enabled 字段」的一条 → 不能用严格类型断言 */
const RULES = GOLDEN.rules as unknown as SandboxIgnoreRule[]

describe('忽略沙盒命令规则 golden（TS ↔ Rust 判定一致）', () => {
  it('每条命令命中的规则 id 与 Rust 侧一致', () => {
    const mismatches: string[] = []
    for (const c of GOLDEN.cases) {
      const hit = findMatchingSandboxRule(RULES, c.command)
      const actual = hit?.id ?? null
      if (actual !== c.expectRuleId) {
        mismatches.push(
          `命令 ${JSON.stringify(c.command)}: TS=${actual ?? 'null'} / golden=${c.expectRuleId ?? 'null'}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  it('用例覆盖面足够，且三种 kind 都覆盖到', () => {
    // Rust 侧有同样的下限断言，避免「加规则不加用例」导致契约悄悄变松
    expect(GOLDEN.cases.length).toBeGreaterThanOrEqual(15)
    const kinds = new Set(RULES.map((r) => r.kind))
    expect(kinds.has('text')).toBe(true)
    expect(kinds.has('regex')).toBe(true)
    expect(kinds.has('js')).toBe(true)
  })

  it('禁用规则与缺 enabled 字段的规则都不参与匹配', () => {
    // 显式钉死两条容易漂移的语义（Rust `#[serde(default)]` 与 TS 的 falsy 判定）
    const disabled = RULES.find((r) => r.id === 'disabled-noise')!
    expect(disabled.enabled).toBe(false)
    expect(findMatchingSandboxRule([disabled], 'pnpm install')).toBeNull()

    const missingEnabled = RULES.find((r) => r.id === 'missing-enabled')!
    expect(missingEnabled.enabled).toBeUndefined()
    expect(findMatchingSandboxRule([missingEnabled], 'SENTINEL xyz')).toBeNull()
  })

  it('运行期抛错的 js 规则一律按未命中，且不影响后续规则', () => {
    const throwing = RULES.find((r) => r.id === 'js-throws')!
    expect(findMatchingSandboxRule([throwing], 'whatever')).toBeNull()

    // 后面还有一条能命中的规则 → 抛错的规则被跳过，继续往后找
    const fallback: SandboxIgnoreRule = {
      id: 'fallback',
      name: '兜底',
      enabled: true,
      kind: 'text',
      textMode: 'prefix',
      pattern: 'whatever',
      caseSensitive: false,
    }
    expect(findMatchingSandboxRule([throwing, fallback], 'whatever')?.id).toBe('fallback')
  })
})
