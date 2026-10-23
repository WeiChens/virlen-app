/**
 * 待应答交互的两条**呈现通道** —— 设置决定走跨会话弹窗，还是「会话内卡片」。
 *
 * 守五条用户可见的承诺：
 *  1. 提问默认**不弹窗**：卡片出现在所属会话的消息列表下方，别的会话看不到（「不引导立即解决」）；
 *  2. 授权默认**仍弹窗**；改成行内要显式打开设置；
 *  3. 行内模式**不打断**（不闪任务栏 / 不置前），弹窗模式照旧；
 *  4. 应答仍走同一条路（按 interactionId 精确路由），载荷与原弹窗一致；
 *  5. 切会话走一趟回来，卡片里的勾选还在（草稿按 `sessionId|toolCallId`）。
 *
 * 弹窗通道自身的队列 / 切换条由 `pending-switcher.test.tsx` 守；这里只钉「选哪条通道 + 行内的行为」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** 真实 MarkdownRenderer 静态引入 monaco（jsdom 无 CSS.escape），导入即崩 —— 换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div className="mock-md">{content}</div>,
}))

/** 授权正文的代码区（Monaco）：jsdom 里跑不了，替身只把「给了什么代码」如实报出来 */
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code }: { code: string }) => (
    <pre className="mock-code-preview">{code}</pre>
  ),
}))

/** 窗口闪烁提醒：行内模式必须**不**触发（那是「引导立即解决」的一部分） */
const attention = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<void> => {}),
)
vi.mock('@/utils/windowAttention', () => ({
  requestAttentionIfUnfocused: (...args: unknown[]) => attention(...args),
}))

import toolInteractEvent from '@/events/toolInteractEvent'
import { useToolUI } from '@/ui/pages/chat/components/tool-ui'
import { settingsState } from '@/ui/store/settingStore'
import { chatState } from '@/ui/store/chatState'
import { clearAllChoiceDrafts } from '@/ui/pages/chat/components/modals/choice-drafts'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const { toolUI, inlineUI } = useToolUI()
  return (
    <>
      {toolUI}
      {inlineUI}
    </>
  )
}

let host: HTMLElement | null = null
let root: Root | null = null

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Harness />)
  })
}

beforeEach(async () => {
  clearAllChoiceDrafts()
  attention.mockClear()
  // 默认值就是被测口径：提问走会话内、授权走弹窗
  settingsState.setValue('userChoiceInline', true)
  settingsState.setValue('authorizationInline', false)
  chatState.setValue('currentSessionId', 's1')
  await mount()
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  host?.remove()
  host = null
})

function showChoice(
  id: string,
  sessionId = 's1',
  question = '要继续吗？',
  toolCallId = `tc-${id}`,
): void {
  act(() => {
    toolInteractEvent.emit('showChoice', {
      interactionId: id,
      sessionId,
      toolCallId,
      question,
      options: ['继续', '停下'],
      multi: false,
    })
  })
}

function showAuthorization(
  id: string,
  sessionId = 's1',
  title = '执行命令',
  extra: {
    desc?: string
    command?: string
    subTitle?: string
    hint?: string
    risk?: string
  } = {},
): void {
  act(() => {
    toolInteractEvent.emit('showAuthorization', {
      interactionId: id,
      sessionId,
      toolCallId: `tc-${id}`,
      permName: 'terminal.normal.execute',
      title,
      ...extra,
    })
  })
}

function click(selector: string, index = 0): void {
  const el = document.querySelectorAll(selector)[index] as HTMLElement | undefined
  if (!el) throw new Error(`找不到元素：${selector}[${index}]`)
  act(() => {
    el.click()
  })
}

const choiceCards = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.inline-interaction-card.is-choice'))
const authCards = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.inline-interaction-card.is-auth'))

describe('提问：默认走会话内卡片', () => {
  it('不弹 modal，卡片出现在当前会话；勾选 + 确认把结构化结果回给工具层', async () => {
    const resolved: { id: string; value: any }[] = []
    const off = toolInteractEvent.on('resolve', (id, value) =>
      resolved.push({ id, value }),
    )

    showChoice('it-1')

    expect(document.querySelector('.user-choice-modal')).toBeNull()
    expect(choiceCards()).toHaveLength(1)
    // 问题（头部摘要）与选项都在卡片里
    expect(choiceCards()[0].textContent).toContain('要继续吗？')
    expect(choiceCards()[0].textContent).toContain('继续')

    // 选中「继续」再确认
    click('.inline-interaction-card .inline-interaction-option', 0)
    click('.inline-interaction-card .inline-interaction-btn.is-primary')

    expect(resolved).toHaveLength(1)
    expect(resolved[0].id).toBe('it-1')
    expect(resolved[0].value).toMatchObject({
      content: '继续',
      uiData: { selected: ['继续'], customReply: '' },
    })
    // 应答后卡片出队
    expect(choiceCards()).toHaveLength(0)
    off()
  })

  it('行内模式不打断：不闪烁、不置前', () => {
    showChoice('it-quiet')
    expect(attention).not.toHaveBeenCalled()
    expect(choiceCards()).toHaveLength(1)
  })

  it('别的会话的提问不显示；切过去才出现', async () => {
    showChoice('it-other', 's2')
    expect(choiceCards()).toHaveLength(0)

    await act(async () => {
      chatState.setValue('currentSessionId', 's2')
    })
    expect(choiceCards()).toHaveLength(1)
    expect(choiceCards()[0].textContent).toContain('要继续吗？')
  })

  it('切会话走一趟回来，卡片里勾选的选项还在（草稿按 sessionId|toolCallId）', async () => {
    showChoice('it-draft')
    click('.inline-interaction-card .inline-interaction-option', 1) // 勾「停下」
    expect(
      document.querySelector('.inline-interaction-card .inline-interaction-option.is-on'),
    ).not.toBeNull()

    await act(async () => {
      chatState.setValue('currentSessionId', 's2')
    })
    expect(choiceCards()).toHaveLength(0)

    await act(async () => {
      chatState.setValue('currentSessionId', 's1')
    })
    expect(choiceCards()).toHaveLength(1)
    expect(
      document.querySelector(
        '.inline-interaction-card .inline-interaction-option.is-on',
      )?.textContent,
    ).toContain('停下')
  })

  it('多个提问同时挂起：都在列表里，应答一个不影响另一个', () => {
    showChoice('it-a', 's1', '第一个问题')
    showChoice('it-b', 's1', '第二个问题')
    expect(choiceCards()).toHaveLength(2)
    expect(document.querySelector('.inline-interactions-count')).not.toBeNull()
    // 第二张默认折叠（不一口气吃掉半个屏幕）
    expect(choiceCards()[1].querySelector('.inline-interaction-option')).toBeNull()

    click('.inline-interaction-card .inline-interaction-option', 0)
    click('.inline-interaction-card .inline-interaction-btn.is-primary')
    expect(choiceCards()).toHaveLength(1)
  })

  it('另一个应答端（手机）应答 → 卡片自己收掉', () => {
    showChoice('it-remote')
    expect(choiceCards()).toHaveLength(1)

    act(() => {
      toolInteractEvent.emit('interactionSettled', 'it-remote', 'allow')
    })
    expect(choiceCards()).toHaveLength(0)
  })

  it('卡片里没有「暂存」：它就躺在会话结尾，不需要「先放下」（弹窗才需要）', () => {
    showChoice('it-no-shelve')
    expect(choiceCards()[0].textContent).not.toContain('暂存')

    settingsState.setValue('authorizationInline', true)
    showAuthorization('auth-no-shelve')
    expect(authCards()[0].textContent).not.toContain('暂存')
  })

  it('在自定义输入框里按 Enter 提交；按钮上的 Enter 不算（原生行为）', () => {
    const resolved: string[] = []
    const off = toolInteractEvent.on('resolve', (id) => resolved.push(id))

    showChoice('it-enter')
    click('.inline-interaction-card .inline-interaction-btn.is-ghost')
    const input = document.querySelector<HTMLInputElement>(
      '.inline-interaction-card .inline-interaction-input',
    )!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, '就按这个来')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(resolved).toEqual(['it-enter'])
    expect(choiceCards()).toHaveLength(0)
    off()
  })
})

describe('授权：默认仍弹窗，打开设置才走会话内', () => {
  it('默认弹 modal（并闪烁提醒）', () => {
    showAuthorization('auth-1')
    // 弹窗模态：`.modal-overlay` 是共享 Modal 的外壳（行内卡片不会渲染它）
    expect(document.querySelector('.modal-overlay')).not.toBeNull()
    expect(authCards()).toHaveLength(0)
    expect(attention).toHaveBeenCalledTimes(1)
  })

  it('authorizationInline=true → 卡片；「允许执行」回 commandResolve', () => {
    settingsState.setValue('authorizationInline', true)
    const allowed: string[] = []
    const off = toolInteractEvent.on('commandResolve', (id) => allowed.push(id))

    showAuthorization('auth-2')
    expect(authCards()).toHaveLength(1)
    expect(attention).not.toHaveBeenCalled()

    click('.inline-interaction-card .btn-confirm')
    expect(allowed).toEqual(['auth-2'])
    expect(authCards()).toHaveLength(0)
    off()
  })

  it('「拒绝」回 commandReject，卡片出队', () => {
    settingsState.setValue('authorizationInline', true)
    const denied: string[] = []
    const off = toolInteractEvent.on('commandReject', (id) => denied.push(id))

    showAuthorization('auth-3')
    click('.inline-interaction-card .btn-cancel')
    expect(denied).toEqual(['auth-3'])
    expect(authCards()).toHaveLength(0)
    off()
  })

  it('权限名称只出现一次：头部那行就是它，展开收起都不换位置', () => {
    settingsState.setValue('authorizationInline', true)
    showAuthorization('auth-dup', 's1', '终端正常命令执行')

    const occurrences = () =>
      (authCards()[0].textContent ?? '').split('终端正常命令执行').length - 1
    // 展开：权限名在卡片头，正文（auth-body）不再写一遍（曾经两条一样的标题叠在一起）
    expect(occurrences()).toBe(1)

    click('.inline-interaction-card .inline-interaction-toggle')
    expect(occurrences()).toBe(1)
  })
})

describe('行内授权卡片的正文：用代码预览，不复用弹窗正文', () => {
  it('命令工具的授权：命令进 CodePreview，没有多余的工具头', () => {
    settingsState.setValue('authorizationInline', true)
    showAuthorization('auth-cmd', 's1', '终端正常命令执行', { desc: 'pnpm build' })

    const card = authCards()[0]
    const preview = card.querySelector('.mock-code-preview')!
    expect(preview.textContent).toBe('pnpm build')
    // 命令工具的命令本身就是正文，不需要「运行 xxx」那行工具头
    expect(card.querySelector('.inline-auth-code-head')).toBeNull()
    // 弹窗正文那套层级（大标题 / 引文块 / 满宽按钮）不该出现在卡片里
    expect(card.querySelector('.authorization')).toBeNull()
  })

  it('脚本工具的授权：运行命令进工具头，脚本文本进代码区', () => {
    settingsState.setValue('authorizationInline', true)
    showAuthorization('auth-script', 's1', '脚本执行', {
      desc: 'import os\nprint(os.getcwd())',
      command: 'python /tmp/virlen/a.py',
    })

    const card = authCards()[0]
    expect(card.querySelector('.inline-auth-code-cmd')?.textContent).toBe(
      'python /tmp/virlen/a.py',
    )
    // 要审的是脚本正文，不是那行运行命令
    expect(card.querySelector('.mock-code-preview')?.textContent).toBe(
      'import os\nprint(os.getcwd())',
    )
  })

  it('风险提示成警示条：高危（risk=dangerous）转红，卡片左侧那道竖条也跟着转', () => {
    settingsState.setValue('authorizationInline', true)
    showAuthorization('auth-risk', 's1', '终端高危命令执行', {
      desc: 'rm -rf build',
      hint: '此命令可能对系统造成破坏，请确认是否执行',
      risk: 'dangerous',
    })

    const card = authCards()[0]
    const hint = card.querySelector('.inline-auth-hint')!
    expect(hint.textContent).toContain('此命令可能对系统造成破坏')
    expect(hint.classList.contains('is-dangerous')).toBe(true)
    expect(card.classList.contains('is-dangerous')).toBe(true)
  })

  it('没有 hint 就不占一根警示条；AI 的操作说明（tips）照原样展示', () => {
    settingsState.setValue('authorizationInline', true)
    showAuthorization('auth-tips', 's1', '终端正常命令执行', {
      desc: 'git status',
      subTitle: '先看一下工作区状态',
      risk: 'safe',
    })

    const card = authCards()[0]
    expect(card.querySelector('.inline-auth-hint')).toBeNull()
    expect(card.querySelector('.inline-auth-note')?.textContent).toBe(
      '先看一下工作区状态',
    )
    expect(card.classList.contains('is-dangerous')).toBe(false)
  })
})

describe('两条通道的边界', () => {
  it('行内项不进待处理切换条（切换条只统计弹窗项）', () => {
    settingsState.setValue('userChoiceInline', false)
    // 一个弹窗项 + 一个行内项（授权改成行内）
    settingsState.setValue('authorizationInline', true)
    showChoice('mix-modal')
    showAuthorization('mix-inline')

    // 切换条只在「待处理 ≥ 2」时出现：弹窗项只有 1 个 → 不出现
    expect(document.querySelector('.pending-switcher')).toBeNull()
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
    expect(authCards()).toHaveLength(1)
  })

  it('设置只影响新到的交互：已挂起的行内卡片不会被热切换成弹窗', () => {
    showChoice('it-sticky')
    expect(choiceCards()).toHaveLength(1)

    act(() => {
      settingsState.setValue('userChoiceInline', false)
    })
    // 已经在队列里的那一项仍是卡片（mode 入队即定死）
    expect(choiceCards()).toHaveLength(1)
    expect(document.querySelector('.user-choice-modal')).toBeNull()

    // 新到的走弹窗
    showChoice('it-new')
    expect(document.querySelector('.user-choice-modal')).not.toBeNull()
  })
})
