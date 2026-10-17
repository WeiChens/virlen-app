/**
 * GitCommitModal — 一条提交的详情（「点提交行看它改了什么」）。
 *
 * 四条口径（错了都是「看起来没反应 / 看错东西」那一类）：
 * 1. **打开即取详情，默认选中第一个文件**：点开提交总要先看到点什么；
 * 2. **换文件才重取差异**，并把 `orig_path` 一起交下去（改名时旧侧在旧路径上，漏了就会显示成
 *    「整文件新增 + 整文件删除」）；
 * 3. **完整提交信息只在「有正文」时展示**（正文 == 标题时再画一遍只是重复）；
 * 4. **空清单给空态**（空提交 / 纯合并），不留一块白板。
 *
 * 差异正文换成最小替身（只验交下去的接口），Monaco 那份契约由 `monaco-diff-view.test.tsx` 守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import GitCommitModal from '@/ui/pages/chat/components/git/GitCommitModal'
import type { GitCommitDetail } from '@/domain/git'
import { loadCommitDetail, loadCommitFileSides } from '@/services/git-service'

vi.mock('@/services/git-service', () => ({
  loadCommitDetail: vi.fn(),
  loadCommitFileSides: vi.fn(),
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

beforeEach(() => {
  document.body.innerHTML = ''
  closed = false
  vi.mocked(loadCommitDetail).mockReset()
  vi.mocked(loadCommitFileSides).mockReset()
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
  expect(document.querySelector('.git-commit-message')?.textContent).toContain(
    '这行是正文',
  )
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
