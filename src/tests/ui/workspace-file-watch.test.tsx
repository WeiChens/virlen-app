/**
 * 面板「盯着磁盘」的行为口径（文件被 AI / 终端 / 外部编辑器改过之后）。
 *
 * 四条铁律：
 * 1. **只订阅父目录、只认自己这个文件**（别的事件不重读）；
 * 2. **hash 相同就什么都不做** —— 这也是「自己保存触发 watcher」的自激收敛点；
 * 3. **本地干净 → 新内容自动刷进来**，基线 hash 跟着换，不出现未保存标记；
 * 4. **本地有草稿 → 绝不覆盖**，只挂一条黄条；点「重新加载」才换成磁盘那版。
 *
 * 另一条（标签常驻挂载带来的）：**只有正在被看的那一个才订**（`active`）—— 不看着就退订，
 * 重新被看着时先读一次盘对齐 hash（不盯期间的落盘不会再有事件），首次挂载不重复读。
 *
 * Monaco 全部 mock（jsdom 起不来）：这里只验面板的状态机，最小编辑的区间在
 * `code-editor-apply-text-change` / `minimal-text-edit` 两个用例里各自守。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkspaceFilePanel from '@/ui/pages/chat/components/workspace-file'
import { settingsState } from '@/ui/store'
import {
  WorkspaceFileError,
  type LoadedWorkspaceFile,
} from '@/services/workspace-file-service'

const { loadMock, toastMock, watchMock, unwatchMock, callbacks } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  toastMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  callbacks: [] as ((event: { paths: string[] }) => void)[],
}))

vi.mock('@/services/workspace-file-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workspace-file-service')>()
  return {
    ...actual,
    loadWorkspaceFile: loadMock,
    // `watchWorkspaceFile` 保持真的：要验它「盯父目录 + 按文件名过滤」
  }
})
vi.mock('@tauri-apps/plugin-fs', () => ({ watch: watchMock }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: toastMock }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(async () => true) },
}))
vi.mock('@/services/security-service', () => ({
  securityService: {
    getWorkspace: async (): Promise<string> => 'E:/repo',
    // 面板传进来的已经是绝对路径，原样返回即可（真正的校验在服务层用例里）
    resolveSafePath: async (path: string): Promise<string> => path,
  },
}))
vi.mock('@/infrastructure/preview-asset', () => ({
  allowPreviewRoot: vi.fn(),
  revokePreviewRoot: vi.fn(),
  previewBaseUrl: () => '',
  newPreviewToken: () => 'token',
}))
/** 真实 MarkdownRenderer 静态引 monaco（jsdom 加载不了）：换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div className="mock-markdown">{content}</div>,
}))
/** Monaco 在 jsdom 里起不来：换成同语义的 textarea（受控 + onChange） */
vi.mock('@/ui/components/code-editor/CodeEditor', () => ({
  default: (props: {
    value: string
    onChange: (value: string) => void
    ariaLabel?: string
    onEditorMount?: (editor: unknown) => void
  }) => (
    <textarea
      className="mock-code-editor"
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function textFile(content: string, hash10 = 'hash1'): LoadedWorkspaceFile {
  return {
    kind: 'text',
    content,
    hash10,
    byteSize: content.length,
    lineCount: content.split('\n').length,
  }
}

let root: ReturnType<typeof createRoot> | null = null

async function mount(path = 'E:/repo/src/a.ts', active?: boolean) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (nextPath: string, nextActive?: boolean) =>
    root!.render(
      <WorkspaceFilePanel
        path={nextPath}
        active={nextActive}
        onClose={() => {}}
        onDirtyChange={() => {}}
      />,
    )
  await act(async () => render(path, active))
  // watch 的订阅是 `await` 出来的（先过路径校验）：再冲一轮微任务，回调才拿得到
  await act(async () => {})
  return { render }
}

const editor = () => document.querySelector<HTMLTextAreaElement>('.mock-code-editor')
const saveBtn = () => document.querySelector<HTMLButtonElement>('.wfp-icon-btn.is-primary')
const note = () => document.querySelector<HTMLElement>('.wfp-disk-note')
const noteBtn = (label: string) =>
  [...(note()?.querySelectorAll<HTMLButtonElement>('.wfp-action') ?? [])].find(
    (btn) => btn.textContent === label,
  )

/** 改 textarea 必须走原生 setter，React 才认这次 input */
function type(value: string) {
  const el = editor()!
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set
  setter?.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** watcher 送来一批变更路径 */
async function emit(paths: string[]) {
  await act(async () => {
    for (const cb of callbacks) cb({ paths })
  })
  await act(async () => {})
}

beforeEach(() => {
  document.body.innerHTML = ''
  callbacks.length = 0
  loadMock.mockReset()
  toastMock.mockReset()
  unwatchMock.mockReset()
  watchMock.mockReset()
  watchMock.mockImplementation(async (_path: string, cb: (event: { paths: string[] }) => void) => {
    callbacks.push(cb)
    return unwatchMock
  })
  loadMock.mockResolvedValue(textFile('hello'))
  settingsState.value.htmlPreviewAllowScripts = false
  settingsState.value.htmlPreviewAllowRemote = false
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('按父目录订阅（非递归），事件路径不是本文件就完全不重读', async () => {
  await mount()

  expect(watchMock).toHaveBeenCalledTimes(1)
  expect(watchMock.mock.calls[0][0]).toBe('E:/repo/src')
  expect(watchMock.mock.calls[0][2]).toEqual({ delayMs: 300 })

  // 同目录另一个文件 / 别的目录：都不该触发重读
  await emit(['E:/repo/src/b.ts'])
  await emit(['E:/repo/other/a.ts'])
  expect(loadMock).toHaveBeenCalledTimes(1)
})

it('磁盘内容变了且本地干净 → 自动刷进编辑器，基线一起换（不出现未保存标记）', async () => {
  loadMock.mockReset()
  loadMock
    .mockResolvedValueOnce(textFile('hello'))
    .mockResolvedValueOnce(textFile('hello world', 'hash2'))
  await mount()

  expect(editor()!.value).toBe('hello')
  await emit(['E:\\repo\\src\\a.ts'])

  expect(editor()!.value).toBe('hello world')
  expect(note()).toBeNull()
  expect(saveBtn()!.disabled).toBe(true)
})

it('本地有草稿 + 磁盘变了 → 只挂黄条，草稿一个字都不动；点「重新加载」才换成磁盘那版', async () => {
  loadMock.mockReset()
  loadMock
    .mockResolvedValueOnce(textFile('hello'))
    .mockResolvedValueOnce(textFile('disk version', 'hash2'))
    // 后续再被触发：磁盘上已经是那一版（hash 相同 → 面板自己会忽略）
    .mockResolvedValue(textFile('disk version', 'hash2'))
  await mount()

  type('my work')
  expect(editor()!.value).toBe('my work')

  await emit(['E:/repo/src/a.ts'])
  expect(editor()!.value).toBe('my work')
  expect(note()!.textContent).toContain('磁盘上的文件已被其他程序修改')

  // 「保留我的修改」：只收起黄条，草稿继续留着（保存时仍会被 hash 比对拦下）
  await act(async () => {
    noteBtn('保留我的修改')!.click()
  })
  expect(note()).toBeNull()
  expect(editor()!.value).toBe('my work')

  // 再变一次，这次选「重新加载」
  await emit(['E:/repo/src/a.ts'])
  await act(async () => {
    noteBtn('重新加载')!.click()
  })
  expect(editor()!.value).toBe('disk version')
  expect(note()).toBeNull()
  expect(saveBtn()!.disabled).toBe(true)
})

it('hash 没变（只是 mtime 变了 / 自己刚保存）→ 什么都不做', async () => {
  loadMock.mockReset()
  loadMock.mockResolvedValue(textFile('hello', 'same'))
  await mount()

  type('hello!')
  await emit(['E:/repo/src/a.ts'])

  expect(editor()!.value).toBe('hello!')
  expect(note()).toBeNull()
})

it('文件被删除 / 移走 → 提示一句，草稿仍然留着', async () => {
  loadMock.mockReset()
  loadMock
    .mockResolvedValueOnce(textFile('hello'))
    .mockRejectedValueOnce(new WorkspaceFileError('not-found', 'gone'))
  await mount()

  type('my work')
  await emit(['E:/repo/src/a.ts'])

  expect(note()!.textContent).toContain('文件已从磁盘删除')
  expect(editor()!.value).toBe('my work')

  await act(async () => {
    noteBtn('知道了')!.click()
  })
  expect(note()).toBeNull()
})

it('换文件时先取消订阅上一个文件', async () => {
  const { render } = await mount()
  expect(watchMock).toHaveBeenCalledTimes(1)

  await act(async () => render('E:/repo/src/b.ts'))
  await act(async () => {})

  expect(unwatchMock).toHaveBeenCalledTimes(1)
  expect(watchMock).toHaveBeenCalledTimes(2)
  expect(watchMock.mock.calls[1][0]).toBe('E:/repo/src')
})

it('关掉面板（卸载）时取消订阅', async () => {
  await mount()
  act(() => root!.unmount())
  root = null

  expect(unwatchMock).toHaveBeenCalledTimes(1)
})

/**
 * 「只盯正在被看的那一个」：标签常驻挂载（切标签不卸载 / 切会话不清状态 / 面板收起也不卸载），
 * 所以「挂在 DOM 里」不等于「该盯盘」—— 藏着的那十几个标签各订一个父目录 watcher，
 * 一次落盘就是十几次整文件重读。
 */
it('不看着（active=false）时一个 watcher 也不订，内容照样加载', async () => {
  await mount('E:/repo/src/a.ts', false)

  expect(watchMock).not.toHaveBeenCalled()
  expect(editor()!.value).toBe('hello')
})

it('首次挂上只读一次盘：不额外对齐（挂载时 load() 正在读它）', async () => {
  await mount()

  expect(watchMock).toHaveBeenCalledTimes(1)
  expect(loadMock).toHaveBeenCalledTimes(1)
})

it('收起 / 切走（true → false）退订；回来（false → true）先读一次盘对齐，变了才刷新', async () => {
  loadMock.mockReset()
  loadMock
    .mockResolvedValueOnce(textFile('hello'))
    .mockResolvedValue(textFile('hello v2', 'hash2'))
  const { render } = await mount()
  expect(watchMock).toHaveBeenCalledTimes(1)

  // 切到别的标签 / 收起面板：同一个组件不卸载，只是不盯了
  await act(async () => render('E:/repo/src/a.ts', false))
  await act(async () => {})
  expect(unwatchMock).toHaveBeenCalledTimes(1)
  expect(watchMock).toHaveBeenCalledTimes(1)

  // 回来：不等事件，先把盘读一遍（不盯期间 AI / 终端可能改过），hash 不同才刷新
  await act(async () => render('E:/repo/src/a.ts', true))
  await act(async () => {})
  await act(async () => {})
  expect(watchMock).toHaveBeenCalledTimes(2)
  expect(loadMock).toHaveBeenCalledTimes(2)
  expect(editor()!.value).toBe('hello v2')
})

it('回来时磁盘没变（hash 相同）：对齐也不动草稿、不出现黄条', async () => {
  loadMock.mockReset()
  // 每次读盘都是同一版（含回到前台时那一次对齐）
  loadMock.mockResolvedValue(textFile('hello', 'same'))
  const { render } = await mount()

  type('hello!')
  await act(async () => render('E:/repo/src/a.ts', false))
  await act(async () => {})
  await act(async () => render('E:/repo/src/a.ts', true))
  await act(async () => {})
  await act(async () => {})

  expect(loadMock).toHaveBeenCalledTimes(2)
  expect(editor()!.value).toBe('hello!')
  expect(note()).toBeNull()
})
