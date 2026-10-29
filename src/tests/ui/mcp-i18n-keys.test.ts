// @vitest-environment node
/**
 * MCP 设置页的文案契约（铁律 7：新增 UI 文案必须同步 `en-US.json`）。
 *
 * 扫源码而不是维护硬编码清单：要守的恰恰是「新加了一句 t() / tpl() 却忘了翻译」
 *（本域最容易漏 —— 工具改名、冲突横幅、诊断面板都是后加的）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DICT = JSON.parse(
  readFileSync(resolve(ROOT, 'src/ui/i18n/lang/en-US.json'), 'utf8'),
) as Record<string, string>

const FILES = [
  'src/ui/pages/Settings/mcp-settings.tsx',
  'src/ui/pages/Settings/mcp-edit-modal.tsx',
]

describe('MCP 设置的文案', () => {
  for (const file of FILES) {
    it(`${file} 的文案都在 en-US.json 里`, () => {
      const src = readFileSync(resolve(ROOT, file), 'utf8')
      const missing = new Set<string>()
      for (const m of src.matchAll(/\bt(?:pl)?\(\s*'([^']+)'/g)) {
        if (!(m[1] in DICT)) missing.add(m[1])
      }
      expect([...missing]).toEqual([])
    })
  }
})
