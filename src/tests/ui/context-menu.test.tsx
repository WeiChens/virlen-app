/**
 * 右键菜单（共享组件 + 各处接线）
 *
 * 背景：自绘窗口在生产环境全局禁用了浏览器原生右键菜单（WindowLayout），
 * 所以消息正文 / 图片 / 文件 chip / 深度思考 / 工具卡片各自补了自定义菜单。
 * 这里覆盖三层：
 *   1. ContextMenu 组件本身（禁用、危险色、分隔线、keepOpen、关闭时机、贴边钳制）；
 *   2. 菜单项工厂（文件 / 图片 / 文本）确实调到了对应的原生能力；
 *   3. 各处的接线：右键**哪个元素**、弹出**哪些项**、带的是**完整路径**还是显示用的短路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
  copyImageToClipboard: vi.fn(() => Promise.resolve(true)),
  saveImageAs: vi.fn(() => Promise.resolve('E:/tmp/a.png')),
  defaultImageName: vi.fn(() => 'image-1'),
  imageMimeOf: vi.fn(() => 'image/png'),
  imageExtOf: vi.fn(() => 'png'),
  readImageBytes: vi.fn(() => Promise.resolve(new Uint8Array())),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))
/** Monaco 在 jsdom 里跑不起来（缺 CSS.escape / canvas）——工具卡片会间接触发它 */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))
/** Monaco 在 jsdom 里跑不起来（与 tool-call-terminal.test.tsx 同款替身） */
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: any) => <pre className="code-block-body">{children}</pre>,
}))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { warn: vi.fn(async () => false) },
  useMessageBox: () => ({ MessageBox: { warn: vi.fn(async () => false) } }),
}))
/** 编辑器服务（真实实现会拉 plugin-shell 起进程）——这里只断言「调了 openFile」 */
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
import { copyImageToClipboard, copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import ContextMenu from '@/ui/components/shared/ContextMenu'
import {
  fileMenuItems,
  imageMenuItems,
} from '@/ui/components/shared/ContextMenu/menus'
import { primaryPathOf } from '@/ui/pages/chat/components/tool-call/primary-path'
import { ToolCallMessage } from '@/ui/pages/chat/components/tool-call'
import MessageBubble from '@/ui/pages/chat/components/message/message-bubble'
import { settingsState } from '@/ui/store'
import { editorService } from '@/services/editor-service'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

/** 当前菜单里的项文案（按 DOM 顺序） */
const menuLabels = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.context-menu-item')).map(
    (el) => el.textContent,
  )

const menuButtons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll('.context-menu-item'))

/** 在指定元素上模拟右键 */
async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      }),
    )
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(openPath).mockClear()
  vi.mocked(revealItemInDir).mockClear()
  vi.mocked(copyText).mockClear()
  vi.mocked(copyImageToClipboard).mockClear()
  vi.mocked(showToast).mockClear()
  vi.mocked(MessageBox.warn).mockClear()
  vi.mocked(editorService.openFile).mockClear()
})

describe('ContextMenu 组件', () => {
  const baseItems = () => [
    { key: 'copy', label: '复制', onClick: vi.fn() },
    {
      key: 'delete',
      label: '删除',
      danger: true,
      divider: true,
      onClick: vi.fn(),
    },
    { key: 'disabled', label: '禁用的项', disabled: true, onClick: vi.fn() },
  ]

  it('渲染项、危险色、分隔线；普通项点击后关闭，禁用项不触发也不关闭', async () => {
    const onClose = vi.fn()
    const items = baseItems()
    const { root } = await render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        items={items}
        onClose={onClose}
      />,
    )

    expect(menuLabels()).toEqual(['复制', '删除', '禁用的项'])
    expect(document.querySelectorAll('.context-menu-divider')).toHaveLength(1)
    const buttons = menuButtons()
    expect(buttons[1].classList.contains('is-danger')).toBe(true)

    // 禁用项：不动
    await act(async () => {
      buttons[2].click()
    })
    expect(items[2].onClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // 普通项：先关菜单再执行动作（动作可能弹 Modal，菜单留着会压在上面）
    await act(async () => {
      buttons[0].click()
    })
    expect(items[0].onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(items[1].onClick).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('keepOpen：点击后不关闭（「全选」→ 紧接着还要「复制」）', async () => {
    const onClose = vi.fn()
    const onSelectAll = vi.fn()
    const { root } = await render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        onClose={onClose}
        items={[{ key: 'all', label: '全选', keepOpen: true, onClick: onSelectAll }]}
      />,
    )

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('点菜单外关闭，点菜单内不关闭', async () => {
    const onClose = vi.fn()
    const { root } = await render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        onClose={onClose}
        items={[{ key: 'a', label: 'A', onClick: vi.fn() }]}
      />,
    )

    await act(async () => {
      document.querySelector('.context-menu')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      )
    })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
  })

  it('Esc 关闭，且不把按键漏给外层冒泡监听（否则会连带退出全屏）', async () => {
    const onClose = vi.fn()
    /** 模拟终端全屏 / 图片预览挂在 document 上的 Esc 监听 */
    const outerEsc = vi.fn()
    document.addEventListener('keydown', outerEsc)

    const { root } = await render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        onClose={onClose}
        items={[{ key: 'a', label: 'A', onClick: vi.fn() }]}
      />,
    )
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(outerEsc).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    document.removeEventListener('keydown', outerEsc)
  })

  it('贴边时把菜单钳进视口（右侧/下侧留 8px）', async () => {
    const { root } = await render(
      <ContextMenu
        position={{ x: window.innerWidth - 5, y: window.innerHeight - 5 }}
        onClose={vi.fn()}
        items={[{ key: 'a', label: 'A', onClick: vi.fn() }]}
      />,
    )

    const el = document.querySelector('.context-menu') as HTMLElement
    // jsdom 不做布局：offsetWidth/Height 为 0 → 钳到 inner - 8
    expect(el.style.left).toBe(`${window.innerWidth - 8}px`)
    expect(el.style.top).toBe(`${window.innerHeight - 8}px`)

    await act(async () => root.unmount())
  })

  it('placement="top-left"：菜单以右下角贴锚点（用于「贴在按钮左上方」）', async () => {
    const items = [{ key: 'a', label: 'A', onClick: vi.fn() }]
    const { root } = await render(
      <ContextMenu
        position={{ x: 400, y: 300 }}
        placement="top-left"
        onClose={vi.fn()}
        items={items}
      />,
    )

    const el = document.querySelector('.context-menu') as HTMLElement
    // jsdom 不做布局（offsetWidth/Height 恒为 0）→ 先手工给个尺寸，再让定位 effect 重跑一次
    Object.defineProperty(el, 'offsetWidth', { value: 120, configurable: true })
    Object.defineProperty(el, 'offsetHeight', { value: 80, configurable: true })
    await act(async () => {
      root.render(
        <ContextMenu
          position={{ x: 401, y: 301 }}
          placement="top-left"
          onClose={vi.fn()}
          items={items}
        />,
      )
    })

    // 锚点 = 菜单右下角 ⇒ 菜单整体落在锚点左上方（仍受视口钳制）
    expect(el.style.left).toBe(`${401 - 120}px`)
    expect(el.style.top).toBe(`${301 - 80}px`)

    await act(async () => root.unmount())
  })
})

describe('菜单项工厂', () => {
  it('文件菜单：打开 / 编辑器打开 / 在文件管理器中显示 / 复制路径', async () => {
    const { root } = await render(
      <ContextMenu
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        items={fileMenuItems('E:/ws/src/a.ts')}
      />,
    )
    expect(menuLabels()).toEqual([
      '打开',
      '编辑器打开',
      '在文件管理器中显示',
      '复制路径',
    ])

    // 编辑器打开：走 editorService.openFile（与文件卡片里的 CodeBlock 动作同源）
    await act(async () => {
      menuButtons()[1].click()
    })
    expect(editorService.openFile).toHaveBeenCalledWith({
      filePath: 'E:/ws/src/a.ts',
      line: undefined,
    })

    await act(async () => {
      menuButtons()[2].click()
    })
    expect(revealItemInDir).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(openPath).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => {
      menuButtons()[3].click()
    })
    expect(copyText).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => root.unmount())
  })

  it('文件菜单：相对路径按工作目录补齐为绝对路径（LLM 常写相对路径）', async () => {
    const { root } = await render(
      <ContextMenu
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        items={fileMenuItems('src/a.ts', { workspace: 'E:/ws' })}
      />,
    )

    await act(async () => {
      menuButtons()[2].click()
    })
    expect(revealItemInDir).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(openPath).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => {
      menuButtons()[3].click()
    })
    expect(copyText).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => root.unmount())
  })

  it('目录项文案为「打开文件夹」（fileMenuItems 的 isDir）', async () => {
    const { root } = await render(
      <ContextMenu
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        items={fileMenuItems('E:/ws/src', { isDir: true })}
      />,
    )
    // 目录不适用「编辑器打开」，故只有三项
    expect(menuLabels()).toEqual(['打开文件夹', '在文件管理器中显示', '复制路径'])
    await act(async () => root.unmount())
  })

  it('图片菜单：复制图片 / 另存为', async () => {
    const src = 'data:image/png;base64,AAEC'
    const { root } = await render(
      <ContextMenu
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        items={imageMenuItems(src)}
      />,
    )
    expect(menuLabels()).toEqual(['复制图片', '另存为'])

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyImageToClipboard).toHaveBeenCalledWith(src)

    await act(async () => root.unmount())
  })
})

describe('primaryPathOf（工具入参 → 主路径）', () => {
  it('按优先级取主路径', () => {
    expect(primaryPathOf({ path: 'E:/a.ts' })).toBe('E:/a.ts')
    expect(primaryPathOf({ file_path: 'E:/s.js' })).toBe('E:/s.js')
    expect(primaryPathOf({ paths: ['E:/1.ts', 'E:/2.ts'] })).toBe('E:/1.ts')
    expect(primaryPathOf({ source: 'E:/s', destination: 'E:/d' })).toBe('E:/s')
    expect(primaryPathOf({ destination: 'E:/d' })).toBe('E:/d')
    // path 优先于 paths
    expect(primaryPathOf({ path: 'E:/p', paths: ['E:/x'] })).toBe('E:/p')
  })

  it('取不到一律 undefined（调用方据此不开菜单，而不是猜）', () => {
    expect(primaryPathOf({})).toBeUndefined()
    expect(primaryPathOf({ path: '   ' })).toBeUndefined()
    expect(primaryPathOf({ paths: [] })).toBeUndefined()
    expect(primaryPathOf({ path: 123 })).toBeUndefined()
    expect(primaryPathOf(null)).toBeUndefined()
    expect(primaryPathOf('E:/a.ts')).toBeUndefined()
  })
})

describe('工具调用卡片右键', () => {
  const toolCall = (name: string, input: Record<string, unknown>) =>
    ({ type: 'tool_use', id: 'tc1', name, input }) as any

  it('有路径：弹出文件菜单，且用的是完整路径（不是卡片上显示的短路径）', async () => {
    const { root } = await render(
      <ToolCallMessage
        message={toolCall('read_file', { path: 'E:/ws/src/a.ts' })}
      />,
    )

    await rightClick(document.querySelector('.tool-call-message')!)
    expect(menuLabels()).toEqual([
      '打开',
      '编辑器打开',
      '在文件管理器中显示',
      '复制路径',
    ])

    await act(async () => {
      menuButtons()[2].click()
    })
    expect(revealItemInDir).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => root.unmount())
  })

  it('编辑器打开：按工作目录补齐路径，并带上 read_file 的起始行', async () => {
    settingsState.setValue('defaultWorkspace', 'E:/ws')
    try {
      const { root } = await render(
        <ToolCallMessage
          message={toolCall('read_file', { path: 'src/a.ts' })}
          result={{ uiData: { startLine: 42 } } as any}
        />,
      )

      await rightClick(document.querySelector('.tool-call-message')!)
      expect(menuLabels()[1]).toBe('编辑器打开')
      await act(async () => {
        menuButtons()[1].click()
      })
      expect(editorService.openFile).toHaveBeenCalledWith({
        filePath: 'E:/ws/src/a.ts',
        line: 42,
      })

      await act(async () => root.unmount())
    } finally {
      settingsState.setValue('defaultWorkspace', '')
    }
  })

  it('相对路径入参：菜单按工作目录补齐为绝对路径（LLM 常写相对路径）', async () => {
    settingsState.setValue('defaultWorkspace', 'E:/ws')
    try {
      const { root } = await render(
        <ToolCallMessage
          message={toolCall('read_file', { path: 'src/a.ts' })}
        />,
      )

      await rightClick(document.querySelector('.tool-call-message')!)
      await act(async () => {
        menuButtons()[2].click()
      })
      expect(revealItemInDir).toHaveBeenCalledWith('E:/ws/src/a.ts')

      await act(async () => root.unmount())
    } finally {
      settingsState.setValue('defaultWorkspace', '')
    }
  })

  it('没有路径：右键不弹菜单（宁可不响应，也不打开一个打不开的路径）', async () => {
    const { root } = await render(
      <ToolCallMessage message={toolCall('get_current_time', {})} />,
    )

    await rightClick(document.querySelector('.tool-call-message')!)
    expect(document.querySelector('.context-menu')).toBeNull()

    await act(async () => root.unmount())
  })
})

describe('消息气泡右键', () => {
  const userMessage = (content: any) =>
    ({ id: 'm1', role: 'user', content, timestamp: 0 }) as any

  it('正文：复制 / 引用 / 编辑 / 删除（与底部操作栏同源）', async () => {
    const onQuote = vi.fn()
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const { root } = await render(
      <MessageBubble
        message={userMessage('hello world')}
        onQuote={onQuote}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    )

    await rightClick(document.querySelector('.message-body')!)
    expect(menuLabels()).toEqual(['复制', '引用', '编辑', '删除'])

    // 无选区 → 复制整条正文
    await rightClick(document.querySelector('.message-body')!)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('hello world')

    // 点任一项后菜单即关（普通项行为）→ 后续动作先重新右键打开
    await rightClick(document.querySelector('.message-body')!)
    await act(async () => {
      menuButtons()[2].click()
    })
    expect(onEdit).toHaveBeenCalledWith('hello world')

    // 删除：先二次确认，返回 false → 不删
    await rightClick(document.querySelector('.message-body')!)
    await act(async () => {
      menuButtons()[3].click()
    })
    expect(MessageBox.warn).toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('正文：有选区时「复制」只复制选区', async () => {
    const { root } = await render(
      <MessageBubble message={userMessage('hello world')} />,
    )
    // 选中「hello」
    const textNode = document.querySelector('.message-content')!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 5)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    await rightClick(document.querySelector('.message-body')!)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('hello')

    window.getSelection()!.removeAllRanges()
    await act(async () => root.unmount())
  })

  it('图片：复制图片 / 另存为（数据在缩略图 URL 上）', async () => {
    const url = 'data:image/png;base64,IMG1'
    const { root } = await render(
      <MessageBubble
        message={userMessage([
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url } },
        ])}
      />,
    )

    await rightClick(document.querySelector('.message-image')!)
    expect(menuLabels()).toEqual(['复制图片', '另存为'])

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyImageToClipboard).toHaveBeenCalledWith(url)

    await act(async () => root.unmount())
  })

  it('文件 chip：打开 / 在文件管理器中显示 / 复制路径', async () => {
    const { root } = await render(
      <MessageBubble
        message={userMessage([
          { type: 'text', text: '看文件' },
          { type: 'file', path: 'E:/ws/src/a.ts', name: 'a.ts', size: 10 },
        ])}
      />,
    )

    await rightClick(document.querySelector('.file-chip')!)
    expect(menuLabels()).toEqual([
      '打开',
      '编辑器打开',
      '在文件管理器中显示',
      '复制路径',
    ])

    await act(async () => {
      menuButtons()[2].click()
    })
    expect(revealItemInDir).toHaveBeenCalledWith('E:/ws/src/a.ts')

    await act(async () => root.unmount())
  })

  it('压缩摘要：复制摘要 / 删除（删除即放弃压缩，删本条及之后）', async () => {
    const onDelete = vi.fn()
    const { root } = await render(
      <MessageBubble
        message={
          {
            id: 'sum1',
            role: 'summary',
            content: 'SUMMARY_BODY',
            timestamp: 0,
          } as any
        }
        onDelete={onDelete}
      />,
    )

    window.getSelection()!.removeAllRanges()
    await rightClick(document.querySelector('.message-compress-summary')!)
    expect(menuLabels()).toEqual(['复制', '删除'])

    // 复制的是摘要正文（不是提示条上的文案）
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('SUMMARY_BODY')

    // 删除：先二次确认；取消 → 不删
    await rightClick(document.querySelector('.message-compress-summary')!)
    await act(async () => {
      menuButtons()[1].click()
    })
    expect(MessageBox.warn).toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()

    // 确认后才真正删除（调用方按「本条及之后」整体截断）
    vi.mocked(MessageBox.warn).mockResolvedValueOnce(true)
    await rightClick(document.querySelector('.message-compress-summary')!)
    await act(async () => {
      menuButtons()[1].click()
    })
    expect(onDelete).toHaveBeenCalledWith('sum1')

    await act(async () => root.unmount())
  })

  it('深度思考：展开后右键文本 → 复制 / 全选', async () => {
    const { root } = await render(
      <MessageBubble
        message={
          {
            id: 'm2',
            role: 'assistant',
            content: '答案',
            reasoningContent: '先想一下',
            timestamp: 0,
          } as any
        }
      />,
    )

    // 默认折叠 → 先点标题展开
    await act(async () => {
      ;(document.querySelector('.reasoning-header') as HTMLElement).click()
    })
    const reasoningText = document.querySelector('.reasoning-text')!
    expect(reasoningText).toBeTruthy()

    await rightClick(reasoningText)
    expect(menuLabels()).toEqual(['复制', '全选'])

    // 无选区 → 复制整段思考内容
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('先想一下')

    await act(async () => root.unmount())
  })
})
