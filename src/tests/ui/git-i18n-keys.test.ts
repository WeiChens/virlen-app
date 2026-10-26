// @vitest-environment node
/**
 * 源代码管理的 UI 文案契约（铁律 7：新增 UI 文案必须同步 `en-US.json`）。
 *
 * **扫源码，而不是维护一份硬编码清单** —— 清单会随新文案一起漂移，而恰恰是「新加了一句 t() 但忘了
 * 翻译」这件事要守。这里把 `src/ui/.../git/` 与 `services/git-service.ts` 里出现的所有
 * `t('…')` / `tpl('…')` 首参收集出来，逐个查 `en-US.json`。
 *
 * 只覆盖本次新增的 git 域（全仓扫描会引出一堆历史遗留缺键，超出本功能范围）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DICT = JSON.parse(
  readFileSync(resolve(ROOT, 'src/ui/i18n/lang/en-US.json'), 'utf8'),
) as Record<string, string>

const FILES = [
  'src/services/git-service.ts',
  'src/ui/pages/chat/components/git/GitEntry.tsx',
  'src/ui/pages/chat/components/git/GitPanel.tsx',
  'src/ui/pages/chat/components/git/GitChangeRow.tsx',
  'src/ui/pages/chat/components/git/GitBranchMenu.tsx',
  'src/ui/pages/chat/components/git/GitErrorModal.tsx',
  // 虚拟列表与「左清单可拖拽宽度」：两个弹窗共用，新增文案同样要进字典
  'src/ui/pages/chat/components/git/VirtualList.tsx',
  'src/ui/pages/chat/components/git/use-side-width.tsx',
  'src/ui/pages/chat/components/git/GitDiffModal.tsx',
  // 提交详情（左栏提交信息折叠开关：`收起` / `展开`）
  'src/ui/pages/chat/components/git/GitCommitModal.tsx',
  'src/ui/pages/chat/components/git/GitLogModal.tsx',
  // 贮藏浮层（新建 / 应用 / 应用并删除 / 删除 / 撤销删除）
  'src/ui/pages/chat/components/git/GitStashModal.tsx',
  // 提交图（弹窗 + 行 + canvas + 分页 hook）：新组件都必须登记，否则「新加了一句 t() 忘了翻译」
  // 在这一块就是无人守的（本用例扫的是这份清单，不是目录）
  'src/ui/pages/chat/components/git/GitGraphModal.tsx',
  'src/ui/pages/chat/components/git/GitCommitRow.tsx',
  'src/ui/pages/chat/components/git/GraphCanvas.tsx',
  'src/ui/pages/chat/components/git/useCommitPages.ts',
  // 差异正文（复制 / 全选那套菜单文案就在它里面；现在住在 message/ 下，两处共用）
  'src/ui/pages/chat/components/message/MonacoDiffView.tsx',
  // 聊天里 edit_file 的差异输入适配层（在它里面）
  'src/ui/pages/chat/components/tool-call/EditFileMessage.tsx',
  // 差异弹窗左清单的行右键菜单（复用 fileMenuItems）：新文案同样要进字典
  'src/ui/pages/chat/components/git/side-menu.ts',
  // 提交行（提交记录 / 提交图共用）的右键菜单
  'src/ui/pages/chat/components/git/commit-menu.ts',
  // 右键菜单里「在此提交上新建分支」的输入框
  'src/ui/pages/chat/components/git/GitNewBranchPrompt.tsx',
  'src/ui/pages/chat/components/git/sections.ts',
]

describe('源代码管理文案', () => {
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
