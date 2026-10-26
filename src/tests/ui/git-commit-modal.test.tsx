/**
 * GitCommitModal — 一条提交的详情（「点提交行看它改了什么」）。
 *
 * 四条口径（错了都是「看起来没反应 / 看错东西」那一类）：
 * 1. **打开即取详情，默认选中第一个文件**：点开提交总要先看到点什么；
 * 2. **换文件才重取差异**，并把 `orig_path` 一起交下去（改名时旧侧在旧路径上，漏了就会显示成
 *    「整文件新增 + 整文件删除」）；
 * 3. **完整提交信息只在「有正文」时展示**（只有一行 = 正文 == 标题，再画一遍只是重复）；
 * 3b. **正文块住左栏顶部**（不再趴在头部下方把清单与差异一起往下压），可折叠。
 * 4. **空清单给空态**（空提交 / 纯合并），不留一块白板。
 *
 * 差异正文换成最小替身（只验交下去的接口）；两栏 / 单栏的 DOM 版正文由 `side-by-side-diff.test.tsx` 守
 *（真正用 Monaco 的那份契约用例 `monaco-diff-view.test.tsx` 已随测试提速删除，历史见 git）。
 *
 * 5. **左清单行右键给基本操作**（打开 / 编辑器打开 / 在文件管理器中显示 / 复制路径）：
 *    历史提交不可暂存，所以**没有**写入口；菜单项组装口径由 `git-side-menu.test.ts` 守。
 * 6. **全屏**：头部图标按钮铺满遮罩；Esc 先退全屏、再一下才关详情。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import GitCommitModal from '@/ui/pages/chat/components/git/GitCommitModal'
import type { GitCommitDetail } from '@/domain/git'
import { loadCommitDetail, loadCommitFileSides } from '@/services/git-service'
import { copyText } from '@/utils/clipboard'

vi.mock('@/services/git-service', () => ({
  loadCommitDetail: vi.fn(),
  loadCommitFileSides: vi.fn(),
}))

// 右键菜单的打开类动作（menus.ts）：mock 掉就不必拉真实的编辑器服务（它会拉整个 store barrel）
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

vi.mock('@/ui/pages/chat/components/message/MonacoDiffView', () => {
  function MonacoDiffView({
    oldText,
    newText,
    fileName,
    singleSide,
  }: {
    oldText: string
    newText: string
    fileName: string
    singleSide?: 'old' | 'new'
  }) {
    return (
      <div
        className="mono-diff-stub"
        data-old={oldText}
        data-new={newText}
        data-file={fileName}
        data-side={singleSide ?? ''}
      />
    )
  }
  return { MonacoDiffView, default: MonacoDiffView }
})

// 引用链里还有 monaco（jsdom 里导入即崩，缺 `CSS.escape`）
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const OID = 'a'.repeat(40)

function detail(over: Partial<GitCommitDetail> = {}): GitCommitDetail {
  return {
    oid: OID,
    short_oid: 'aaaaaaa',
    author_name: 'virlen',
    author_email: 'v@example.com',
    author_time: '2026-10-16T10:29:46+08:00',
    message: '第二个提交',
    parents: ['b'.repeat(40)],
    files: [
      { path: 'src/a.ts', orig_path: null, status: 'M' },
      { path: 'src/new.ts', orig_path: null, status: 'A' },
    ],
    ...over,
  }
}

let root: ReturnType<typeof createRoot> | null = null
let closed = false

async function mount(oid = OID) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<GitCommitModal oid={oid} onClose={() => (closed = true)} />)
  })
}

const sideRows = () => [...document.querySelectorAll('.git-diff-side-row')]

/** 在某个元素上模拟右键 */
async function rightClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 90,
      }),
    )
  })
}
const menuLabels = (): (string | null)[] =>
  [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent)
const menuItem = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
    (el) => el.textContent === label,
  )
  if (!found) throw new Error(`菜单里没有「${label}」`)
  return found
}

beforeEach(() => {
  document.body.innerHTML = ''
  closed = false
  vi.mocked(loadCommitDetail).mockReset()
  vi.mocked(loadCommitFileSides).mockReset()
  vi.mocked(copyText).mockClear()
  vi.mocked(loadCommitDetail).mockResolvedValue(detail())
  vi.mocked(loadCommitFileSides).mockResolvedValue({
    old_text: 'old\n',
    new_text: 'new\n',
    old_label: '父提交',
    new_label: '本次提交',
    binary: false,
    truncated: false,
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

it('打开即取详情：头里是短 oid + 标题，默认选中并加载第一个文件', async () => {
  await mount()

  expect(loadCommitDetail).toHaveBeenCalledWith(OID)
  expect(document.querySelector('.git-commit-hash')?.textContent).toBe('aaaaaaa')
  expect(document.querySelector('.git-diff-path')?.textContent).toBe('第二个提交')
  expect(sideRows().length).toBe(2)
  expect(sideRows()[0].classList.contains('active')).toBe(true)
  // 默认就把第一个文件的差异取下来了
  expect(loadCommitFileSides).toHaveBeenCalledWith(OID, 'src/a.ts', null)
  const stub = document.querySelector('.mono-diff-stub')
  expect(stub?.getAttribute('data-file')).toBe('src/a.ts')
  expect(stub?.getAttribute('data-old')).toBe('old\n')
  expect(stub?.getAttribute('data-new')).toBe('new\n')
})

/** 作者 / 时间 / 文件数住在左栏顶部：原先它是弹窗头下方一整行，把清单与差异一起往下压 */
it('作者 / 时间 / 文件数在左栏顶部，不再单占弹窗头下方一整行', async () => {
  await mount()

  const meta = document.querySelector('.git-commit-meta')
  expect(meta).toBeTruthy()
  // 位置：在左栏（aside）里；弹窗头里没有它
  expect(meta!.closest('.git-commit-side')).toBeTruthy()
  expect(document.querySelector('.git-diff-head .git-commit-meta')).toBeNull()
  // 三样都在：作者 / 时间 / 文件数
  expect(meta!.querySelector('.git-commit-author')?.textContent).toBe('virlen')
  expect(meta!.querySelector('.git-commit-time')?.textContent).toBeTruthy()
  expect(meta!.querySelector('.git-commit-count')?.textContent).toBe(
    '2 个文件有变更',
  )
  // ⚠️ 计数那块不能占用左栏文件清单的容器类（`.git-commit-files` 带 flex:1 / 滚动）
  expect(meta!.querySelector('.git-commit-files')).toBeNull()
})

it('点清单里的另一行：重新取差异，改动对象跟着换（改名会把旧路径一起交下去）', async () => {
  vi.mocked(loadCommitDetail).mockResolvedValue(
    detail({
      files: [
        { path: 'src/a.ts', orig_path: null, status: 'M' },
        { path: 'src/b.ts', orig_path: 'src/old-b.ts', status: 'R' },
      ],
    }),
  )
  await mount()

  await act(async () => {
    ;(sideRows()[1] as HTMLElement).click()
  })

  expect(sideRows()[1].classList.contains('active')).toBe(true)
  // ⚠️ 第三个参数是 orig_path：漏了它，改名文件会显示成「整文件新增 + 整文件删除」
  expect(loadCommitFileSides).toHaveBeenLastCalledWith(
    OID,
    'src/b.ts',
    'src/old-b.ts',
  )
  expect(document.querySelector('.mono-diff-stub')?.getAttribute('data-file')).toBe(
    'src/b.ts',
  )
})

it('完整提交信息只在有正文时展示（正文 == 标题时不重复画一遍）', async () => {
  await mount()
  expect(document.querySelector('.git-commit-message')).toBeNull()

  vi.mocked(loadCommitDetail).mockResolvedValue(
    detail({ message: '第二个提交\n\n这行是正文' }),
  )
  await act(async () => root!.unmount())
  root = null
  await mount()
  expect(document.querySelector('.git-commit-message-body')?.textContent).toContain(
    '这行是正文',
  )
})

it('正文块在左栏顶部（不在弹窗头下方）、默认展开、标题不重画，点一下可折叠', async () => {
  vi.mocked(loadCommitDetail).mockResolvedValue(
    detail({ message: '第二个提交\n\n这行是正文' }),
  )
  await mount()

  // 位置：左栏（清单前）——它原先压在弹窗头下方，一有正文就把差异区往下顶；
  // 它上面只剩那行作者 / 时间元信息（见上一条用例），再往上就是左栏的顶边
  const side = document.querySelector('.git-commit-side')
  const box = side?.querySelector('.git-commit-message') as HTMLElement
  expect(box).toBeTruthy()
  expect(box.previousElementSibling?.classList.contains('git-commit-meta')).toBe(true)
  expect(box.classList.contains('is-collapsed')).toBe(false)
  expect(document.querySelector('.git-diff-head .git-commit-message')).toBeNull()
  // 标题已在弹窗头里，正文块只放后续段落
  expect(box.querySelector('.git-commit-message-body')?.textContent).toBe('这行是正文')
  expect(box.querySelector('.git-commit-message-title')?.textContent).toBe('第二个提交')

  await act(async () => {
    ;(box.querySelector('.git-commit-message-head') as HTMLElement).click()
  })
  expect(box.classList.contains('is-collapsed')).toBe(true)
  expect(box.querySelector('.git-commit-message-body')).toBeNull()
  // 折叠态标题还在（它不是表示「没有正文」而是「收起来了」）
  expect(box.querySelector('.git-commit-message-title')?.textContent).toBe('第二个提交')
})

it('清单为空（空提交 / 纯合并）给空态，不发差异请求', async () => {
  vi.mocked(loadCommitDetail).mockResolvedValue(detail({ files: [] }))
  await mount()

  expect(document.body.textContent).toContain('这个提交没有文件变更')
  expect(loadCommitFileSides).not.toHaveBeenCalled()
})

it('Esc 关掉详情', async () => {
  await mount()
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(closed).toBe(true)
})

/** 全屏：铺满遮罩；Esc 先退全屏（一次性关掉两层 = 「按错一下就没了」） */
it('全屏：弹窗铺满遮罩，Esc 先退全屏再一下才关详情', async () => {
  await mount()
  const btn = () =>
    document.querySelector<HTMLButtonElement>('.git-diff-head .git-icon-btn')!
  // 图标按钮：没有可见文案，名字在 title / aria-label 里
  expect(btn().textContent).toBe('')
  expect(btn().getAttribute('aria-label')).toBe('全屏')
  expect(btn().getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('.git-diff-modal.is-fullscreen')).toBeNull()

  await act(async () => {
    btn().click()
  })
  expect(document.querySelector('.git-diff-modal.is-fullscreen')).toBeTruthy()
  expect(document.querySelector('.git-diff-backdrop.is-fullscreen')).toBeTruthy()
  expect(btn().getAttribute('aria-label')).toBe('退出全屏')
  expect(btn().getAttribute('aria-pressed')).toBe('true')

  // 第一下只退全屏：详情还在
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(document.querySelector('.git-diff-modal.is-fullscreen')).toBeNull()
  expect(closed).toBe(false)

  // 第二下才关
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(closed).toBe(true)
})

it('左清单行右键：只有打开类四项（历史提交不可暂存），且不切走当前文件', async () => {
  await mount()
  await rightClick(sideRows()[1])

  expect(menuLabels()).toEqual([
    '打开',
    '编辑器打开',
    '在文件管理器中显示',
    '复制路径',
  ])
  // 右键不改变「当前在看哪个文件」（与点一下切文件区分开）
  expect(sideRows()[0].classList.contains('active')).toBe(true)

  await act(async () => menuItem('复制路径').click())
  // 仓库根未知时路径原样交出去（toAbsolutePath 不猜）
  expect(copyText).toHaveBeenCalledWith('src/new.ts')
})
