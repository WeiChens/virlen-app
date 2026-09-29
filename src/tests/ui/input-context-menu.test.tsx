/**
 * 输入框右键菜单（剪切 / 复制 / 粘贴 / 全选）
 *
 * 背景：自绘窗口在生产环境全局禁用了浏览器原生右键菜单（`WindowLayout`），
 * 输入框的原生菜单里恰好全是常用操作（复制粘贴全靠它），因此得自补一份。
 * 这里覆盖两层：
 *   1. 菜单项工厂 `editableMenuItems`：四项的文案 / 禁用态矩阵 / 各自的动作；
 *   2. 接线：聊天输入框的 textarea 右键能弹出这四项。
 * 还有一条隐性但最容易写错的契约：动作必须能被 **React 受控组件**接住 ——
 * 值经「原生 setter + `input` 事件」写回，否则受控组件的 `onChange` 收不到、
 * 值会在下一次渲染被 React 用旧值覆写回去。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))

import { showToast } from '@/ui/components/shared/Toast'
import ContextMenu, {
  useContextMenu,
} from '@/ui/components/shared/ContextMenu'
import { editableMenuItems } from '@/ui/components/shared/ContextMenu/editable'
import ChatInput from '@/ui/pages/chat/components/input'
import { initDefaultAgent } from '@/services/agent-service'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let clipboardWriteText: ReturnType<typeof vi.fn>
let clipboardReadText: ReturnType<typeof vi.fn>

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(showToast).mockClear()
  // jsdom 没有 navigator.clipboard，注入可断言的替身
  clipboardWriteText = vi.fn().mockResolvedValue(undefined)
  clipboardReadText = vi.fn().mockResolvedValue('')
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText, readText: clipboardReadText },
    configurable: true,
  })
})

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

/** 菜单里的项文案（按 DOM 顺序） */
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

/** 点第 index 个菜单项（动作是 async 的，等它跑完） */
async function clickItem(index: number) {
  await act(async () => {
    menuButtons()[index].click()
  })
}

/**
 * 受控 textarea + 右键菜单 —— 复刻聊天输入框的接线方式。
 * `mirror` 是受控 state 的镜像：动作有没有真的走到 React 那一层，看它就知道。
 */
function ControlledHarness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const menu = useContextMenu<void>()
  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onContextMenu={(e) => menu.openAt(e, undefined)}
      />
      <span className="mirror">{value}</span>
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={editableMenuItems(ref.current)}
          onClose={menu.close}
        />
      )}
    </div>
  )
}

const mirror = (host: HTMLElement) =>
  host.querySelector('.mirror')!.textContent
const textareaOf = (host: HTMLElement) =>
  host.querySelector('textarea') as HTMLTextAreaElement

/** 渲染受控输入框并模拟「拖选 [start, end)」 */
async function mountHarness(initial: string, select?: [number, number]) {
  const mounted = await render(<ControlledHarness initial={initial} />)
  const ta = textareaOf(mounted.host)
  if (select) ta.setSelectionRange(select[0], select[1])
  return { ...mounted, ta }
}

describe('editableMenuItems（输入框菜单项工厂）', () => {
  /** 直接拿一个真实 textarea 试菜单项（不渲染 React） */
  function bareTextarea(value: string): HTMLTextAreaElement {
    const ta = document.createElement('textarea')
    ta.value = value
    document.body.appendChild(ta)
    return ta
  }

  it('四项：剪切 / 复制 / 粘贴 / 全选，顺序与终端菜单的约定一致（全选在最后）', () => {
    const items = editableMenuItems(bareTextarea('abc'))
    expect(items.map((i) => i.label)).toEqual([
      '剪切',
      '复制',
      '粘贴',
      '全选',
    ])
  })

  it('无选区时「剪切 / 复制」禁用；空值时「全选」禁用', () => {
    const withText = editableMenuItems(bareTextarea('abc'))
    expect(withText.map((i) => i.disabled)).toEqual([
      true,
      true,
      false,
      false,
    ])

    const empty = editableMenuItems(bareTextarea(''))
    expect(empty.map((i) => i.disabled)).toEqual([
      true,
      true,
      false,
      true,
    ])
  })

  it('有选区时「剪切 / 复制」启用', () => {
    const ta = bareTextarea('abc')
    ta.setSelectionRange(0, 2)
    expect(
      editableMenuItems(ta)
        .slice(0, 2)
        .map((i) => i.disabled),
    ).toEqual([false, false])
  })

  it('只读控件：能「复制 / 全选」，不能「剪切 / 粘贴」', () => {
    const ta = bareTextarea('abc')
    ta.readOnly = true
    ta.setSelectionRange(0, 2)
    expect(editableMenuItems(ta).map((i) => i.disabled)).toEqual([
      true,
      false,
      true,
      false,
    ])
  })

  it('未渲染出控件（null）/ disabled：四项全禁用', () => {
    expect(
      editableMenuItems(null).map((i) => i.disabled),
    ).toEqual([true, true, true, true])

    const ta = bareTextarea('abc')
    ta.disabled = true
    expect(editableMenuItems(ta).map((i) => i.disabled)).toEqual([
      true,
      true,
      true,
      true,
    ])
  })
})

describe('输入框右键菜单的接线（受控 textarea）', () => {
  it('右键弹出四项菜单，且挂在 body 下（浅色皮肤）', async () => {
    const { host, root, ta } = await mountHarness('hello world')
    await rightClick(ta)
    expect(menuLabels()).toEqual(['剪切', '复制', '粘贴', '全选'])
    const menu = document.querySelector('.context-menu')!
    // 消息列表祖先带 transform/overflow，fixed 定位必须脱离它们
    expect(menu.parentElement).toBe(document.body)
    expect(menu.classList.contains('context-menu--dark')).toBe(false)
    await act(async () => root.unmount())
  })

  it('「复制」：写入选区文本并提示成功', async () => {
    const { root, ta } = await mountHarness('hello world', [0, 5])
    await rightClick(ta)
    await clickItem(1)
    expect(clipboardWriteText).toHaveBeenCalledWith('hello')
    expect(showToast).toHaveBeenCalledWith('已复制到剪贴板')
    await act(async () => root.unmount())
  })

  it('「剪切」：写入选区文本 + 删掉选区，受控 state 跟着更新', async () => {
    const { host, root, ta } = await mountHarness('hello world', [0, 6])
    await rightClick(ta)
    await clickItem(0)
    expect(clipboardWriteText).toHaveBeenCalledWith('hello ')
    expect(textareaOf(host).value).toBe('world')
    // 关键：走的是 React 的 onChange，受控 state 不能停在旧值
    expect(mirror(host)).toBe('world')
    await act(async () => root.unmount())
  })

  it('「粘贴」：插到光标处（有选区则替换），受控 state 跟着更新', async () => {
    clipboardReadText.mockResolvedValue('XYZ')
    const { host, root, ta } = await mountHarness('hello world', [6, 11])
    await rightClick(ta)
    await clickItem(2)
    expect(textareaOf(host).value).toBe('hello XYZ')
    expect(mirror(host)).toBe('hello XYZ')
    // 光标落在插入内容之后，接着打字不会插错位置
    expect(textareaOf(host).selectionStart).toBe(9)
    await act(async () => root.unmount())
  })

  it('「粘贴」：剪贴板没有文本时什么都不做（也不弹提示）', async () => {
    const { host, root, ta } = await mountHarness('abc', [0, 0])
    await rightClick(ta)
    await clickItem(2)
    expect(textareaOf(host).value).toBe('abc')
    expect(showToast).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('「全选」：选中全部且菜单保持打开（接着还能点「复制」）', async () => {
    const { root, ta } = await mountHarness('hello world')
    await rightClick(ta)
    await clickItem(3)
    const el = document.querySelector('textarea') as HTMLTextAreaElement
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 11])
    expect(document.querySelector('.context-menu')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('点菜单外部 / Esc 关闭菜单', async () => {
    const { root, ta } = await mountHarness('abc')
    await rightClick(ta)
    expect(document.querySelector('.context-menu')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      )
    })
    expect(document.querySelector('.context-menu')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('聊天输入框的接线', () => {
  it('右键 textarea 弹出四项菜单（关掉浏览器原生菜单）', async () => {
    // 输入框里带 Agent 选择器，它要求默认 Agent 已就位
    // （真实启动流程在 main.ts 的 step('defaultAgent') 里做这一步）
    await initDefaultAgent()
    const { host, root } = await render(<ChatInput onSend={() => {}} />)
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    expect(ta).toBeTruthy()
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    })
    await act(async () => {
      ta.dispatchEvent(ev)
    })
    // 原生菜单必须被拦下（自绘窗口里它本来也不出现，拦下是为了 DEV 模式一致）
    expect(ev.defaultPrevented).toBe(true)
    expect(menuLabels()).toEqual(['剪切', '复制', '粘贴', '全选'])
    await act(async () => root.unmount())
  })
})
