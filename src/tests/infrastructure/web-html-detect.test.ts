/**
 * `web_fetch` 的 HTML 判定（`isHtml`）golden 一致性测试（TS 侧）
 *
 * 目的：把「TS 判定」与「Rust 原生判定」钉死在同一份输入/输出上 —— 它决定
 * `htmlToMd` 是否生效，直接影响**模型读到的是 Markdown 还是原始 HTML**。
 *
 * 背景：`web_fetch` 已原生化（`src-tauri/src/agent/native_tools/web/web_fetch.rs`），
 * 判定逻辑两侧各写一份（`isHtml` ↔ `is_html`），必须逐字等价（铁律 1）。
 * 契约文件（唯一事实源，两侧共读）：
 *   src/tests/fixtures/web-html-detect.golden.json
 *   - TS：本测试（`@/infrastructure/tools/web/common.ts::isHtml`）
 *   - Rust：`native_tools/web/common.rs::tests::golden_html_detect_matches_ts`
 *
 * ⚠️ 判定规则（两侧一致）：
 *   ① Content-Type 优先：媒体类型 `text/html` / `application/xhtml+xml` → 直接认定；
 *   ② 否则回退形状判定（大小写不敏感）：剥 BOM + trim 后，`<!doctype html…` / `<html…`
 *      开头（后接标签边界）且 `</html>` 结尾。
 *
 * ⚠️ fixture 里的 `contentType: null` 表示「响应头未提供」；两侧都按空串处理。
 */
import { describe, it, expect } from 'vitest'
import GOLDEN from '@/tests/fixtures/web-html-detect.golden.json'
import { isHtml } from '@/infrastructure/tools/web/common'

interface GoldenCase {
  name: string
  contentType: string | null
  content: string
  expected: boolean
}

const CASES = GOLDEN as unknown as GoldenCase[]

describe('web_fetch HTML 判定 golden（TS ↔ Rust 一致）', () => {
  it('每个用例的判定结果与 fixture 的 expected 相同', () => {
    for (const c of CASES) {
      const actual = isHtml(c.content, c.contentType ?? undefined)
      expect(actual, `用例 ${c.name} 判定漂移`).toBe(c.expected)
    }
  })

  it('覆盖面足够（Content-Type 优先 / 形状兜底 / BOM / 假前缀）', () => {
    const names = CASES.map((c) => c.name).join(',')
    expect(names).toContain('ct-text-html-wins-over-shape')
    expect(names).toContain('wrong-ct-falls-back-lowercase-doctype')
    expect(names).toContain('leading-bom')
    expect(names).toContain('fake-prefix-htmlfoo')
    // 必须有「Content-Type 命中但正文形状完全不成立」的用例（证明优先关系是真的）
    expect(
      CASES.some((c) => {
        if (c.contentType === null) return false
        const media = c.contentType.split(';')[0].trim().toLowerCase()
        const isHtmlCt = media === 'text/html' || media === 'application/xhtml+xml'
        return isHtmlCt && c.expected === true && !c.content.includes('</html>')
      }),
    ).toBe(true)
  })
})
