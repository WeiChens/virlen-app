/**
 * CodeBlock 右键菜单（回归：右键代码块不该复制整条气泡）
 *
 * 背景：代码块常嵌在消息气泡里，而气泡本身有右键菜单，其「复制」取的是
 * **整条气泡正文**（`message-bubble.tsx` 的 `getContent(false)`）。
 * 又因 Monaco 的选区不进 `window.getSelection()`，气泡菜单的「选区优先」拿不到代码选区，
 * 于是右键代码块 → 复制，会把整条回复都复制走 —— 这正是本用例要守住的回归。
 *
 * 本文件覆盖：
 *   ① 代码块自带右键菜单（「复制代码」/「全选」），且会 stopPropagation，外层气泡不再接管；
 *   ② 「复制代码」复制的是代码正文，不是气泡文本；
 *   ③ 选区（window 选区 / Monaco 选区）优先；
 *   ④ 「全选」后「复制代码」能拿到全部代码（Monaco 走命令式 API，<pre> 回退走 DOM 选区）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  // 模拟 Monaco：渲染即下发命令式 API（全选→上报 ALL_IN_MONACO）；点击模拟“框选一段代码”
  default: ({ code, onSelectionChange, onApiReady }: any) => {
    onApiReady?.({ selectAll: () => onSelectionChange?.('ALL_IN_MONACO') })
    return (
      <pre
        className="mock-code-preview"
        onClick={() => onSelectionChange?.('SELECTED_IN_MONACO')}>
        {code}
      </pre>
    )
  },
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
vi.mock('@/services/editor-service', () => ({
  editorService: {
    isEnabled: vi.fn(() => true),
    getSelectedConfig: vi.fn(() => undefined),
    getSelectedCommand: vi.fn(() => ''),
    openFile: vi.fn(() => Promise.resolve({ ok: true })),
    openWithConfig: vi.fn(() => Promise.resolve({ ok: true })),
  },
}))

import { copyText } from '@/utils/clipboard'
import CodeBlock from '@/ui/pages/chat/components/message/code-block'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const CODE = 'const a = 1\nconst b = 2'

const menuLabels = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.context-menu-item')).map(
    (el) => el.textContent,
  )
const menuButtons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll('.context-menu-item'))

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
  window.getSelection()?.removeAllRanges()
  vi.mocked(copyText).mockClear()
})

describe('CodeBlock 右键菜单', () => {
  it('右键代码块弹出「复制代码」，且不冒泡到外层容器', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    // 外层模拟“消息气泡”：它的右键处理若被触发即为回归
    const outerContextMenu = vi.fn()
    await act(async () => {
      root.render(
        <div onContextMenu={outerContextMenu}>
          <CodeBlock fileName="demo.ts">{CODE}</CodeBlock>
        </div>,
      )
    })

    await rightClick(host.querySelector('.code-block-wrapper')!)
    expect(menuLabels()).toEqual(['复制代码', '全选'])
    // 事件被代码块菜单拦下 → 外层（气泡）的右键处理不该被触发
    expect(outerContextMenu).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('「复制代码」复制的是代码正文（无选区时），不是气泡文本', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<CodeBlock fileName="demo.ts">{CODE}</CodeBlock>)
    })

    await rightClick(host.querySelector('.code-block-wrapper')!)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith(CODE)

    await act(async () => root.unmount())
  })

  it('有选区时「复制代码」只复制选区（沿用文本菜单的选区优先语义）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <div>
          <span>SELECTED</span>
          <CodeBlock fileName="demo.ts">{CODE}</CodeBlock>
        </div>,
      )
    })

    const textNode = host.querySelector('span')!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 8)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    await rightClick(host.querySelector('.code-block-wrapper')!)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('SELECTED')

    window.getSelection()!.removeAllRanges()
    await act(async () => root.unmount())
  })

  it('Monaco 内选区（不入 window.getSelection）→「复制代码」复制该选区', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<CodeBlock fileName="demo.ts">{CODE}</CodeBlock>)
    })

    // 模拟用户在 Monaco 里框选了一段代码（window 选区为空）
    expect(window.getSelection()!.toString()).toBe('')
    await act(async () => {
      ;(host.querySelector('.mock-code-preview') as HTMLElement).click()
    })

    await rightClick(host.querySelector('.code-block-wrapper')!)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('SELECTED_IN_MONACO')

    await act(async () => root.unmount())
  })

  it('「全选」→「复制代码」复制全部代码（Monaco 路径经命令式 API）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<CodeBlock fileName="demo.ts">{CODE}</CodeBlock>)
    })

    await rightClick(host.querySelector('.code-block-wrapper')!)
    // 「全选」不关菜单（keepOpen），方便紧接着「复制代码」
    await act(async () => {
      menuButtons()[1].click()
    })
    expect(document.querySelector('.context-menu')).toBeTruthy()

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('ALL_IN_MONACO')

    await act(async () => root.unmount())
  })

  it('流式回退（<pre>）「全选」选中全部代码 → 「复制代码」复制全部', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <CodeBlock fileName="demo.ts" streaming>
          {CODE}
        </CodeBlock>,
      )
    })

    // 走 <pre> 回退（未挂载 Monaco）
    expect(host.querySelector('.mock-code-preview')).toBeNull()
    expect(host.querySelector('.code-fallback')).toBeTruthy()

    await rightClick(host.querySelector('.code-block-wrapper')!)
    await act(async () => {
      menuButtons()[1].click()
    })
    expect(window.getSelection()!.toString()).toBe(CODE)

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith(CODE)

    window.getSelection()!.removeAllRanges()
    await act(async () => root.unmount())
  })
})
