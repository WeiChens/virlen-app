// @vitest-environment node
/**
 * 差异弹窗左清单的行右键菜单项（`git/side-menu.ts`）：**给了哪些项、按什么顺序、路径是不是绝对的**。
 *
 * 菜单本体（定位 / 点外面关闭 / 禁用态）由 `context-menu.test.tsx` 守，提交详情弹窗的接线由
 * `git-commit-modal.test.tsx` 守（差异弹窗那份 `git-diff-modal.test.tsx` 已随测试提速删除，历史见 git）—— 这里只钉「组装口径」：
 * 写入口在最前、引用居中、打开类在后且带分隔线；已删除的文件只留「复制路径」；
 * 仓库根相对路径必须补成绝对路径（`openPath` / `revealItemInDir` 只认绝对）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
  copyImageToClipboard: vi.fn(() => Promise.resolve(true)),
  saveImageAs: vi.fn(() => Promise.resolve('E:/tmp/a.png')),
  defaultImageName: vi.fn(() => 'image-1'),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): unknown => ({ Toast: (): null => null, showToast: vi.fn() }),
}))
vi.mock('@/services/editor-service', () => ({
  editorService: {
    isEnabled: vi.fn(() => true),
    getSelectedConfig: vi.fn(() => undefined),
    getSelectedCommand: vi.fn(() => ''),
    openFile: vi.fn(() => Promise.resolve({ ok: true })),
    openWithConfig: vi.fn(() => Promise.resolve({ ok: true })),
  },
}))

import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { copyText } from '@/utils/clipboard'
import { editorService } from '@/services/editor-service'
import { diffSideMenuItems } from '@/ui/pages/chat/components/git/side-menu'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'

const labels = (items: ContextMenuItem[]): unknown[] => items.map((i) => i.label)
const keyOf = (items: ContextMenuItem[], label: string): ContextMenuItem => {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`菜单里没有「${label}」`)
  return found
}

beforeEach(() => {
  vi.mocked(openPath).mockClear()
  vi.mocked(revealItemInDir).mockClear()
  vi.mocked(copyText).mockClear()
  vi.mocked(editorService.openFile).mockClear()
})

describe('差异弹窗左清单的行右键菜单', () => {
  it('只有文件动作时：打开 / 编辑器打开 / 在文件管理器中显示 / 复制路径（首项不带分隔线）', () => {
    const items = diffSideMenuItems({ path: 'src/a.ts' })

    expect(labels(items)).toEqual([
      '打开',
      '编辑器打开',
      '在文件管理器中显示',
      '复制路径',
    ])
    expect(items[0].divider).toBeFalsy()
  })

  it('工作区侧：写入口在最前、引用居中、文件动作在后且首项带分隔线', () => {
    const items = diffSideMenuItems({
      path: 'src/a.ts',
      staging: { label: '暂存更改', run: () => {} },
      onAttach: () => {},
    })

    expect(labels(items)).toEqual([
      '暂存更改',
      '引用到输入框',
      '打开',
      '编辑器打开',
      '在文件管理器中显示',
      '复制路径',
    ])
    // 写 / 引用与「把文件交给系统」之间那条线：误点写操作的机会少一次
    expect(items[2].divider).toBe(true)
    expect(items[0].divider).toBeFalsy()
    expect(items[1].divider).toBeFalsy()
  })

  it('已删除的文件（exists: false）：打开类全部摘掉，只剩「复制路径」', () => {
    const items = diffSideMenuItems({
      path: 'src/gone.ts',
      exists: false,
      staging: { label: '暂存更改', run: () => {} },
    })

    // 文件在磁盘上已经不存在：打开 / 定位必然失败，点一下弹「打开失败」不如不给
    expect(labels(items)).toEqual(['暂存更改', '复制路径'])
  })

  it('写入口的禁用态照抄（只读沙盒下面板与菜单同时灰掉）', () => {
    const run = vi.fn()
    const items = diffSideMenuItems({
      path: 'src/a.ts',
      staging: { label: '暂存更改', disabled: true, run },
    })

    expect(items[0].disabled).toBe(true)
    // 禁用项由 ContextMenu 拦点击；即便被调用，动作也只作用于这一行
    expect(run).not.toHaveBeenCalled()
  })

  it('打开类动作拿到的是绝对路径（仓库根 + 相对路径）', async () => {
    const items = diffSideMenuItems({
      path: 'src/a.ts',
      workspace: 'E:/ws',
    })

    await keyOf(items, '打开').onClick()
    expect(openPath).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await keyOf(items, '编辑器打开').onClick()
    expect(editorService.openFile).toHaveBeenCalledWith({
      filePath: 'E:/ws/src/a.ts',
      line: undefined,
    })

    await keyOf(items, '在文件管理器中显示').onClick()
    expect(revealItemInDir).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await keyOf(items, '复制路径').onClick()
    expect(copyText).toHaveBeenCalledWith('E:/ws/src/a.ts')
  })

  it('「引用到输入框」把点击原样交给调用方（路径换算与剔除已删除文件归它）', async () => {
    const onAttach = vi.fn()
    const items = diffSideMenuItems({ path: 'src/a.ts', onAttach })

    await keyOf(items, '引用到输入框').onClick()
    expect(onAttach).toHaveBeenCalledTimes(1)
  })
})
