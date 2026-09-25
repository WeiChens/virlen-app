/**
 * `web_search` 结果格式 golden 一致性测试（TS 侧）
 *
 * 目的：把「TS 格式化」与「Rust 原生格式化」钉死在同一份输出上。
 *
 * 背景（S5）：`web_search` 已原生化（`src-tauri/virlen-core/src/agent/native_tools/web/web_search.rs`），
 * 但结果文本是**直接进模型上下文**的内容，两侧各写一份实现就必然漂移。
 * 契约文件（唯一事实源，两侧共读）：
 *   src/tests/fixtures/web-search-format.golden.json
 *   - TS：本测试（`@/infrastructure/tools/web/common.ts::formatSearchResults`）
 *   - Rust：`native_tools/web/common.rs::tests::golden_matches_ts_implementation`
 * 任一侧改了分隔符 / 缩进 / 字段顺序 / 截断文案，两侧测试都会失败。
 *
 * ⚠️ fixture 里的 `expected` 由 TS 实现生成（生成脚本已删），Rust 侧负责「跟随」。
 *   若确实要改格式，请**先改 TS、再重新生成 expected、最后让 Rust 对齐**（铁律 1 的方向性）。
 */
import { describe, it, expect } from 'vitest'
import GOLDEN from '@/tests/fixtures/web-search-format.golden.json'
import { formatSearchResults } from '@/infrastructure/tools/web/common'
import type { SearchResultItem } from '@/domain/search/types'

interface GoldenCase {
  name: string
  query: string
  providerName: string
  elapsedMs: number | null
  items: SearchResultItem[]
  expected: string
}

const CASES = GOLDEN as unknown as GoldenCase[]

describe('web_search 结果格式 golden（TS ↔ Rust 逐字一致）', () => {
  it('每个用例的输出与 fixture 的 expected 逐字相同', () => {
    for (const c of CASES) {
      const actual = formatSearchResults(
        c.items,
        c.query,
        c.providerName,
        c.elapsedMs || undefined,
      )
      expect(actual, `用例 ${c.name} 输出漂移`).toBe(c.expected)
    }
  })

  it('覆盖面足够（多条目 / 空列表 / 缺失可选字段 / content 截断）', () => {
    const names = CASES.map((c) => c.name).join(',')
    expect(names).toContain('empty-items')
    expect(names).toContain('optional-fields-missing')
    expect(names).toContain('content-truncation')
    // 至少有一个用例同时含 publishedDate / source / score
    expect(
      CASES.some(
        (c) =>
          c.items.some((i) => i.publishedDate && i.source && i.score !== undefined),
      ),
    ).toBe(true)
  })
})
