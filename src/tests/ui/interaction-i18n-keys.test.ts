/**
 * 交互 UI 的文案契约（铁律 7：新增 UI 文案必须同步 `en-US.json`）。
 *
 * 覆盖「提问 / 授权」这一域的两条呈现通道 —— 弹窗（`modals/*`）与会话内卡片（`inline-interactions/*`），
 * 外加调度层 `tool-ui.tsx`。扫源码而不是维护硬编码清单：要守的恰恰是「新加了一句 t() 却忘了翻译」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DICT = JSON.parse(
  readFileSync(resolve(ROOT, 'src/ui/i18n/lang/en-US.json'), 'utf8'),
) as Record<string, string>

const FILES = [
  'src/ui/pages/chat/components/tool-ui.tsx',
  'src/ui/pages/chat/components/inline-interactions/index.tsx',
  'src/ui/pages/chat/components/inline-interactions/auth-body.tsx',
  'src/ui/pages/chat/components/modals/user-choice.tsx',
  'src/ui/pages/chat/components/modals/choice-body.tsx',
  'src/ui/pages/chat/components/modals/authorization.tsx',
  'src/ui/pages/chat/components/modals/authorization-body.tsx',
  'src/ui/pages/chat/components/modals/pending-switcher.tsx',
]

describe('待应答交互的文案', () => {
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
