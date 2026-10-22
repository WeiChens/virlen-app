/**
 * 文件面板「读取中」的统一视觉：**一颗转圈 + 一句话**，内容没到之前不摆空编辑器。
 *
 * 为什么值得一条用例：这一态只存在几百毫秒，人工看只分辨得出「有个东西」，
 * 分辨不出「转圈在不在、内容是不是提前挂上来了」——而内容提前挂上来（空编辑器）
 * 会被读成「这个文件是空的」。转圈的样式约束（`will-change`、深色舞台的配色）
 * 在 `model-preview-contract.test.ts`，这里只管「什么时候出现、什么时候消失」。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkspaceFilePanel from '@/ui/pages/chat/components/workspace-file'
import {
  WorkspaceFileError,
  type LoadedTextFile,
} from '@/services/workspace-file-service'

/** 手动控制何时「读完 / 读失败」：用例要停在读取中那一帧上断言 */
let resolveLoad: (file: LoadedTextFile) => void = () => {}
let rejectLoad: (error: unknown) => void = () => {}

const { loadMock, watchMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  watchMock: vi.fn(),
}))

vi.mock('@/services/workspace-file-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workspace-file-service')>()
  return { ...actual, loadWorkspaceFile: loadMock }
})
vi.mock('@tauri-apps/plugin-fs', () => ({ watch: watchMock }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@/services/security-service', () => ({
  securityService: {
    getWorkspace: async (): Promise<string> => 'E:/repo',
    resolveSafePath: async (path: string): Promise<string> => path,
  },
}))
/** Monaco / Markdown 渲染器在 jsdom 里加载不了（面板静态引了它们） */
vi.mock('@/ui/components/code-editor/CodeEditor', () => ({
  default: () => <textarea className="mock-code-editor" />,
}))
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div className="mock-markdown">{content}</div>,
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

async function mount(path: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <WorkspaceFilePanel path={path} onClose={() => {}} onDirtyChange={() => {}} />,
    ),
  )
  await act(async () => {})
}

const TEXT_FILE: LoadedTextFile = {
  kind: 'text',
  content: 'hello',
  hash10: 'abcdef0123',
  byteSize: 5,
  lineCount: 1,
}

beforeEach(() => {
  document.body.innerHTML = ''
  loadMock.mockReset()
  loadMock.mockImplementation(
    () =>
      new Promise<LoadedTextFile>((resolve, reject) => {
        resolveLoad = resolve
        rejectLoad = reject
      }),
  )
  watchMock.mockReset()
  watchMock.mockResolvedValue(() => {})
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('读取中：只给转圈（不挂空编辑器），读完后转圈消失、正文一次性出现', async () => {
  await mount('E:/repo/a.txt')

  const hint = document.querySelector('.wfp-hint')
  expect(hint?.querySelector('.wfp-spinner')).not.toBeNull()
  expect(hint?.textContent).toContain('正在读取文件')
  // 内容没到之前不能挂编辑器 —— 空编辑器会被误读成「文件是空的」
  expect(document.querySelector('.mock-code-editor')).toBeNull()

  await act(async () => resolveLoad(TEXT_FILE))
  await act(async () => {})

  expect(document.querySelector('.wfp-spinner')).toBeNull()
  expect(document.querySelector('.mock-code-editor')).not.toBeNull()
})

it('读失败：转圈收掉，落到带「在系统程序中打开」出口的错误态', async () => {
  await mount('E:/repo/b.txt')
  expect(document.querySelector('.wfp-spinner')).not.toBeNull()

  await act(async () => rejectLoad(new WorkspaceFileError('not-found', '文件不存在')))
  await act(async () => {})

  // 失败还留着转圈的话，用户会以为还在等
  expect(document.querySelector('.wfp-spinner')).toBeNull()
  const hint = document.querySelector('.wfp-hint.is-error')
  expect(hint?.textContent).toContain('在系统程序中打开')
})
