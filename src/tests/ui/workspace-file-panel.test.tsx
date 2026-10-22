/**
 * 工作目录文件面板（右侧）的界面口径。
 *
 * 1. **文本可编辑，但不自动保存**：改动只进草稿，Ctrl+S / 「保存」才落盘；
 * 2. **关闭 / 刷新前有未保存草稿必须确认**（面板自己一颗按钮，宿主还有切文件 / 切会话两处）；
 * 3. **图片 / 音频 / 视频各自渲染对应的原生标签**，blob URL 由本组件负责创建与释放；
 * 4. **保存冲突不静默覆盖**：错误弹窗说明「文件已被其他程序修改」。
 *
 * 读取 / 写入与 Monaco 全部 mock：真实文件语义在 `workspace-file-service` 的用例里。
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkspaceFilePanel from '@/ui/pages/chat/components/workspace-file'
import { settingsState } from '@/ui/store'
import settingsEvent from '@/events/settingsEvent'
import {
  WorkspaceFileError,
  type LoadedWorkspaceFile,
} from '@/services/workspace-file-service'

const {
  loadMock,
  saveMock,
  messageBoxMock,
  openPathMock,
  toastMock,
  allowPreviewRootMock,
  revokePreviewRootMock,
} = vi.hoisted(() => ({
  loadMock: vi.fn(),
  saveMock: vi.fn(),
  messageBoxMock: vi.fn(),
  openPathMock: vi.fn(),
  toastMock: vi.fn(),
  allowPreviewRootMock: vi.fn(),
  revokePreviewRootMock: vi.fn(),
}))

vi.mock('@/services/workspace-file-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workspace-file-service')>()
  return {
    ...actual,
    loadWorkspaceFile: loadMock,
    saveWorkspaceText: saveMock,
  }
})
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: messageBoxMock },
}))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: toastMock }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: openPathMock }))
/** 预览协议：只验前端有没有登记、有没有把 base 拼进 srcDoc；路径校验在 Rust 用例里 */
vi.mock('@/infrastructure/preview-asset', () => ({
  allowPreviewRoot: allowPreviewRootMock,
  revokePreviewRoot: revokePreviewRootMock,
  previewBaseUrl: (token: string, dir = '') =>
    `http://virlen-preview.localhost/${token}/${dir ? `${dir}/` : ''}`,
  newPreviewToken: () => 'test-token-0001',
}))
vi.mock('@/services/security-service', () => ({
  securityService: { getWorkspace: async (): Promise<string> => 'E:/repo' },
}))
/** 真实 MarkdownRenderer 静态引 monaco（jsdom 里加载不了样式）：换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="mock-markdown">{content}</div>
  ),
}))
/** Monaco 在 jsdom 里起不来：换成同语义的 textarea（受控 + onChange） */
vi.mock('@/ui/components/code-editor/CodeEditor', () => ({
  default: (props: {
    value: string
    onChange: (value: string) => void
    ariaLabel?: string
  }) => (
    <textarea
      className="mock-code-editor"
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function textFile(content = 'hello'): LoadedWorkspaceFile {
  return {
    kind: 'text',
    content,
    hash10: 'hash1',
    byteSize: content.length,
    lineCount: content.split('\n').length,
  }
}

let root: ReturnType<typeof createRoot> | null = null
let closed = 0
let dirtyCalls: boolean[] = []

async function mount(path = 'E:/repo/src/a.ts') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <WorkspaceFilePanel
        path={path}
        onClose={() => {
          closed += 1
        }}
        onDirtyChange={(dirty) => dirtyCalls.push(dirty)}
      />,
    )
  })
}

const panel = () => document.querySelector('.workspace-file-panel') as HTMLElement
const saveBtn = () =>
  document.querySelector<HTMLButtonElement>('.wfp-action.is-primary')
const closeBtn = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.wfp-icon-btn')].find(
    (btn) => btn.getAttribute('aria-label') === '关闭',
  )
const editor = () =>
  document.querySelector<HTMLTextAreaElement>('.mock-code-editor')

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

beforeAll(() => {
  // jsdom 没有实现这两支：媒体预览只能自己 stub
  Object.defineProperty(URL, 'createObjectURL', {
    writable: true,
    value: vi.fn(() => 'blob:mock'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    writable: true,
    value: vi.fn(),
  })
})

beforeEach(() => {
  document.body.innerHTML = ''
  closed = 0
  dirtyCalls = []
  loadMock.mockReset()
  saveMock.mockReset()
  messageBoxMock.mockReset()
  openPathMock.mockReset()
  toastMock.mockReset()
  messageBoxMock.mockResolvedValue(true)
  openPathMock.mockResolvedValue(undefined)
  allowPreviewRootMock.mockReset()
  allowPreviewRootMock.mockResolvedValue(undefined)
  revokePreviewRootMock.mockReset()
  // 两个预览安全开关是**全局设置**：每个用例从头开始（默认关）
  settingsState.value.htmlPreviewAllowScripts = false
  settingsState.value.htmlPreviewAllowRemote = false
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('文本：进编辑器，未改动时保存按钮禁用', async () => {
  loadMock.mockResolvedValue(textFile())
  await mount()

  expect(editor()!.value).toBe('hello')
  expect(saveBtn()!.disabled).toBe(true)
  expect(document.querySelector('.wfp-dirty')).toBeNull()
})

it('改动后出现未保存标记；Ctrl+S 才落盘，成功后标记消失', async () => {
  loadMock.mockResolvedValue(textFile())
  saveMock.mockResolvedValue({ hash10: 'hash2', lineCount: 1, byteSize: 7 })
  await mount()

  type('changed')
  expect(document.querySelector('.wfp-dirty')).not.toBeNull()
  expect(saveBtn()!.disabled).toBe(false)
  expect(dirtyCalls[dirtyCalls.length - 1]).toBe(true)

  await act(async () => {
    panel().dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
    )
  })

  expect(saveMock).toHaveBeenCalledWith(
    'E:/repo/src/a.ts',
    'changed',
    'hash1',
    undefined,
  )
  expect(document.querySelector('.wfp-dirty')).toBeNull()
  expect(dirtyCalls[dirtyCalls.length - 1]).toBe(false)
  expect(editor()!.value).toBe('changed')
})

it('保存冲突：弹窗说明「已被其他程序修改」，草稿保留', async () => {
  loadMock.mockResolvedValue(textFile())
  saveMock.mockRejectedValue(new WorkspaceFileError('conflict', 'changed'))
  await mount()

  type('draft')
  await act(async () => {
    saveBtn()!.click()
  })

  expect(messageBoxMock).toHaveBeenCalled()
  expect(messageBoxMock.mock.calls[0][1]).toContain('文件已被其他程序修改')
  expect(editor()!.value).toBe('draft')
  expect(document.querySelector('.wfp-dirty')).not.toBeNull()
})

it('图片：渲染 img（图片查看器），src 是释放得掉的 blob URL', async () => {
  loadMock.mockResolvedValue({
    kind: 'image',
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
    byteSize: 3,
  })
  await mount('E:/repo/pic.png')

  const img = document.querySelector<HTMLImageElement>('.wfp-image-content')
  expect(img?.getAttribute('src')).toBe('blob:mock')
})

it('音频与视频：各自给原生播放器', async () => {
  loadMock.mockResolvedValue({
    kind: 'audio',
    bytes: new Uint8Array([1]),
    mime: 'audio/mpeg',
    byteSize: 1,
  })
  await mount('E:/repo/a.mp3')
  expect(document.querySelector('audio')).not.toBeNull()

  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''

  loadMock.mockResolvedValue({
    kind: 'video',
    bytes: new Uint8Array([1]),
    mime: 'video/mp4',
    byteSize: 1,
  })
  await mount('E:/repo/a.mp4')
  expect(document.querySelector('video')).not.toBeNull()
})

it('不支持预览的类型：给「在系统程序中打开」', async () => {
  loadMock.mockResolvedValue({ kind: 'other', byteSize: 1024 })
  await mount('E:/repo/a.zip')

  expect(document.body.textContent).toContain('暂不支持预览该类型')
  const open = [...document.querySelectorAll<HTMLButtonElement>('.wfp-action')].find(
    (btn) => btn.textContent === '在系统程序中打开',
  )
  act(() => open!.click())
  expect(openPathMock).toHaveBeenCalledWith('E:/repo/a.zip')
})

it('文件过大：说明原因，仍可交给系统程序', async () => {
  loadMock.mockRejectedValue(new WorkspaceFileError('too-large', '2 MB'))
  await mount('E:/repo/big.log')

  expect(document.body.textContent).toContain('文件过大，无法在应用内打开')
  expect(document.body.textContent).toContain('在系统程序中打开')
})

it('有未保存草稿时点关闭：先确认；取消则不关', async () => {
  loadMock.mockResolvedValue(textFile())
  await mount()
  type('draft')

  messageBoxMock.mockResolvedValueOnce(false)
  await act(async () => {
    closeBtn()!.click()
  })
  expect(closed).toBe(0)

  messageBoxMock.mockResolvedValueOnce(true)
  await act(async () => {
    closeBtn()!.click()
  })
  expect(closed).toBe(1)
})

it('没有改动时关闭不问', async () => {
  loadMock.mockResolvedValue(textFile())
  await mount()

  await act(async () => {
    closeBtn()!.click()
  })
  expect(messageBoxMock).not.toHaveBeenCalled()
  expect(closed).toBe(1)
})

/** md / html / svg：多一个「预览」，默认停在编辑 */
it('markdown：两个 tab，默认编辑，点预览才渲染', async () => {
  loadMock.mockResolvedValue(textFile('# 标题'))
  await mount('E:/repo/README.md')

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')]
  expect(tabs.map((tab) => tab.textContent)).toEqual(['编辑', '预览'])
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  expect(editor()).not.toBeNull()

  act(() => tabs[1].click())

  expect(document.querySelector('.mock-markdown')?.textContent).toBe('# 标题')
  expect(editor()).toBeNull()
})

it('html：预览用沙箱 iframe；登记成功后注入 base（相对路径可解析）', async () => {
  loadMock.mockResolvedValue(textFile('<h1>hi</h1>'))
  await mount('E:/repo/page.html')

  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  // 登记的是「打开文件时的工作区」（沙箱范围），不是文件所在目录
  expect(allowPreviewRootMock).toHaveBeenCalledWith(
    'test-token-0001',
    'E:/repo',
    false,
  )

  const frame = document.querySelector('iframe.wfp-frame')
  expect(frame).not.toBeNull()
  expect(frame!.getAttribute('sandbox')).toBe('')
  expect(frame!.getAttribute('srcdoc')).toContain(
    '<base href="http://virlen-preview.localhost/test-token-0001/">',
  )
  expect(frame!.getAttribute('srcdoc')).toContain('<h1>hi</h1>')
})

/**
 * 子目录里的页面：`./app.css` 相对的是**文件目录**，基址必须补上这一段 ——
 * 否则请求会落到工作区根的 app.css 上（必然 404）。
 */
it('html 在子目录：基址带上文件所在目录', async () => {
  loadMock.mockResolvedValue(textFile('<link href="./app.css">'))
  await mount('E:/repo/docs/demo/index.html')

  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  // 根仍是工作区（沙箱不缩小、`../` 也不会跑出工作区）
  expect(allowPreviewRootMock).toHaveBeenCalledWith(
    'test-token-0001',
    'E:/repo',
    false,
  )
  const frame = document.querySelector('iframe.wfp-frame')
  expect(frame!.getAttribute('srcdoc')).toContain(
    '<base href="http://virlen-preview.localhost/test-token-0001/docs/demo/">',
  )
})

/**
 * 脚本权限住在设置里（设置 → 安全 → HTML 预览）：开着才给 allow-scripts 并注入 CSP。
 * 面板里不再有开关 —— 每打开一个文件重勾一次不现实（实测反馈）。
 */
it('设置开启「允许运行脚本」后：preview 给 allow-scripts、带 CSP，且本地协议回 JS', async () => {
  settingsState.value.htmlPreviewAllowScripts = true
  loadMock.mockResolvedValue(textFile('<h1>hi</h1>'))
  await mount('E:/repo/page.html')
  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  const frame = document.querySelector('iframe.wfp-frame')!
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
  expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
  // 协议侧也要知道自己可以回 .js（否则相对路径的 JS / CSS 全 404）
  expect(allowPreviewRootMock).toHaveBeenCalledWith('test-token-0001', 'E:/repo', true)
  // 预览区不该再出现安全开关（只在设置里）
  expect(document.querySelector('.wfp-script-toggle')).toBeNull()
})

/** 外部资源是设置里的第二项：开了才放行 CDN 脚本与 fetch */
it('设置开启「允许外部资源」后：CSP 的 script-src / connect-src 都带上 https', async () => {
  settingsState.value.htmlPreviewAllowScripts = true
  settingsState.value.htmlPreviewAllowRemote = true
  loadMock.mockResolvedValue(
    textFile('<script type="module" src="https://cdn.example/three.js"></script>'),
  )
  await mount('E:/repo/page.html')
  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  const csp = document.querySelector('iframe.wfp-frame')!.getAttribute('srcdoc') ?? ''
  expect(csp).toMatch(/script-src [^;]*https:/)
  expect(csp).toContain('connect-src https:')
  // 两道关都开了，提示条不该再占地方
  expect(document.querySelector('.wfp-preview-note')).toBeNull()
})

/** 页面含脚本但设置里没开：控制台报错用户看不到，就在预览上方给一句话 + 把人送到设置 */
it('页面含脚本而设置没开：预览上方给提示，按钮跳「设置 → 安全 → HTML 预览」', async () => {
  loadMock.mockResolvedValue(textFile('<script>document.title = "x"</script>'))
  await mount('E:/repo/page.html')
  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  const opened: string[] = []
  const off = settingsEvent.on('openSettings', (page) => opened.push(page))

  const note = document.querySelector('.wfp-preview-note')
  expect(note?.textContent).toContain('已按安全默认阻止运行')
  expect(document.querySelector('iframe.wfp-frame')!.getAttribute('sandbox')).toBe('')

  await act(async () => note!.querySelector<HTMLButtonElement>('.wfp-action')!.click())
  expect(opened).toEqual(['security-preview'])
  // 提示条只指路：不替用户改安全设置（开关只住在设置里）
  expect(settingsState.value.htmlPreviewAllowScripts).toBe(false)
  off()
})

/** 全局设置与「重读同一个文件」无关：会话 ID 变化后仍按设置放行（不会被悄悄重置） */
it('会话 ID 变化重读文件时，预览仍按设置放行脚本', async () => {
  settingsState.value.htmlPreviewAllowScripts = true
  loadMock.mockResolvedValue(textFile('<p>x</p>'))
  await mount('E:/repo/page.html')
  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  await act(async () => {
    root!.render(
      <WorkspaceFilePanel
        path="E:/repo/page.html"
        sessionId="s-1"
        onClose={() => {}}
        onDirtyChange={() => {}}
      />,
    )
  })

  expect(loadMock.mock.calls.length).toBeGreaterThan(1)
  expect(document.querySelector('iframe.wfp-frame')!.getAttribute('sandbox')).toBe(
    'allow-scripts',
  )
})

/** 登记失败（非 Tauri / 权限）不能把预览变成报错，也不能卡在「准备中」 */
it('HTML 登记失败：预览仍显示，只是不注入 base', async () => {
  allowPreviewRootMock.mockRejectedValueOnce('not available')
  loadMock.mockResolvedValue(textFile('<h1>hi</h1>'))
  await mount('E:/repo/page.html')

  await act(async () => {
    ;[...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click()
  })

  const frame = document.querySelector('iframe.wfp-frame')
  expect(frame).not.toBeNull()
  expect(frame!.getAttribute('srcdoc')).not.toContain('<base')
  expect(frame!.getAttribute('srcdoc')).toContain('<h1>hi</h1>')
  expect(document.body.textContent).not.toContain('无法')
})

it('svg：预览当图片渲染，不是把源码注进 DOM', async () => {
  loadMock.mockResolvedValue(
    textFile('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  )
  await mount('E:/repo/icon.svg')

  act(() => [...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click())

  const img = document.querySelector<HTMLImageElement>('.wfp-image-content')
  expect(img?.getAttribute('src')).toBe('blob:mock')
})

it('普通文本没有预览 tab（只有编辑）', async () => {
  loadMock.mockResolvedValue(textFile('const a = 1'))
  await mount('E:/repo/a.ts')
  expect(document.querySelector('.wfp-tabs')).toBeNull()
})

it('换文件回到默认的编辑模式', async () => {
  loadMock.mockResolvedValue(textFile('# 标题'))
  await mount('E:/repo/README.md')
  act(() => [...document.querySelectorAll<HTMLButtonElement>('.wfp-tab')][1].click())
  expect(document.querySelector('.mock-markdown')).not.toBeNull()

  loadMock.mockResolvedValue(textFile('# 另一个'))
  await act(async () => {
    root!.render(
      <WorkspaceFilePanel
        path="E:/repo/other.md"
        onClose={() => {}}
        onDirtyChange={() => {}}
      />,
    )
  })

  expect(document.querySelector('.mock-markdown')).toBeNull()
  expect(editor()!.value).toBe('# 另一个')
})

/** 在标签页里（`hideTitle`）：文件名已经在标签上，头部只留目录 */
it('hideTitle：头部不重复文件名，只给一眼目录', async () => {
  loadMock.mockResolvedValue(textFile())
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <WorkspaceFilePanel
        path="E:/repo/src/ui/chat/a.ts"
        hideTitle
        onClose={() => {}}
        onDirtyChange={() => {}}
      />,
    )
  })

  expect(document.querySelector('.wfp-name')).toBeNull()
  expect(document.querySelector('.wfp-path')).toBeNull()
  // 只留最后两段：深目录里靠后的那几段才是有用的
  expect(document.querySelector('.wfp-dir')?.textContent).toBe('…/ui/chat')
})

