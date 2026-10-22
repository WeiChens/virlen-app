/**
 * 文件面板的 3D 模型分支：**字节原样交给 `model-view`**，面板这一层不碰 three。
 *
 * 守三件事：
 * 1. **判定 → 分支**：`model` kind 走到模型预览（这里把组件换成替身，只验数据交接）；
 * 2. **只看不改**：模型不可编辑 —— 没有保存按钮、没有「编辑 / 预览」切换；
 * 3. **读不到时给出口**：体积超限 / 解析失败这类 `WorkspaceFileError` 走面板统一的错误态，
 *    并留一个「在系统程序中打开」。
 *
 * three 在 jsdom 里起不来（没有 WebGL）：与 pdfjs 同一手法，整块换成替身。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkspaceFilePanel from '@/ui/pages/chat/components/workspace-file'
import {
  WorkspaceFileError,
  type LoadedWorkspaceFile,
} from '@/services/workspace-file-service'

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
/** 只验面板把**字节**交给了它（真组件要 WebGL 上下文） */
vi.mock('@/ui/pages/chat/components/workspace-file/model-view', () => ({
  default: ({ bytes, name }: { bytes: Uint8Array; name: string }) => (
    <div className="mock-model" data-name={name} data-bytes={String(bytes.length)} />
  ),
}))
/** Monaco / Markdown 渲染器在 jsdom 里加载不了（面板静态引了它们，与三个分支无关） */
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

beforeEach(() => {
  document.body.innerHTML = ''
  loadMock.mockReset()
  watchMock.mockReset()
  watchMock.mockResolvedValue(() => {})
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('glb：字节交给模型预览，且面板不给编辑入口', async () => {
  loadMock.mockResolvedValue({
    kind: 'model',
    bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    byteSize: 4,
  } satisfies LoadedWorkspaceFile)
  await mount('E:/repo/scene.glb')

  const model = document.querySelector<HTMLElement>('.mock-model')
  expect(model?.dataset.name).toBe('scene.glb')
  expect(model?.dataset.bytes).toBe('4')
  // 只看不改：没有保存按钮，也没有「编辑 / 预览」两个 tab
  expect(document.querySelector('.wfp-action.is-primary')).toBeNull()
  expect(document.querySelectorAll('.wfp-tab')).toHaveLength(0)
})

it('体积超限：走面板统一的错误态（含在系统程序中打开的出口）', async () => {
  loadMock.mockRejectedValue(new WorkspaceFileError('too-large', '模型文件超过 64 MB'))
  await mount('E:/repo/huge.glb')

  expect(document.querySelector('.mock-model')).toBeNull()
  const hint = document.querySelector('.wfp-hint.is-error')
  // 用户看到的是一句人话，不是 loader 的英文原文
  expect(hint?.textContent).toContain('文件过大')
  expect(hint?.querySelector('.wfp-action')?.textContent).toContain('在系统程序中打开')
})
