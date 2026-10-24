/**
 * 右侧面板的 UI 文案契约（铁律 7：新增 UI 文案必须同步 `en-US.json`）。
 *
 * 扫源码而不是维护硬编码清单：清单会跟着新文案一起漂移，要守的恰恰是「新加了一句 t()
 * 但忘了翻译」这件事。只覆盖面板这一域（全仓扫描会引出一堆历史遗留缺键，超出本功能范围）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DICT = JSON.parse(
  readFileSync(resolve(ROOT, 'src/ui/i18n/lang/en-US.json'), 'utf8'),
) as Record<string, string>

const FILES = [
  // 容器：标签栏的关闭 / 未保存 / 放下未保存修改的确认
  'src/ui/pages/chat/components/side-panel/index.tsx',
  // 开始页（三扇门）与浏览器标签（地址栏 / 兜底提示 / 空白页）
  'src/ui/pages/chat/components/side-panel/guide.tsx',
  'src/ui/pages/chat/components/side-panel/browser/BrowserPane.tsx',
  // 内容区：文件面板的全部文案（保存 / 重新加载 / 在系统程序中打开 / HTML 预览提示…）
  'src/ui/pages/chat/components/workspace-file/index.tsx',
  // 第二种内容：后台服务入口浮层 + 终端标签
  'src/ui/pages/chat/components/service/ServiceEntry.tsx',
  'src/ui/pages/chat/components/service/ServiceTerminal.tsx',
  // 用户自己的终端（退出码 / 被关掉的提示）
  'src/ui/pages/chat/components/terminal/UserTerminal.tsx',
  // 预览组件：表格（行号 / 截断提示）、文稿 / 演示（长度截断）、PDF（页码 / 缩放）
  'src/ui/pages/chat/components/workspace-file/data-table.tsx',
  'src/ui/pages/chat/components/workspace-file/sheet-view.tsx',
  'src/ui/pages/chat/components/workspace-file/document-view.tsx',
  'src/ui/pages/chat/components/workspace-file/pdf-view.tsx',
]

describe('右侧面板文案', () => {
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
