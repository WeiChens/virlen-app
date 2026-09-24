/**
 * Agent 编辑弹窗 —— 校验定位 / 输入端驳回 / 未保存拦截
 *
 * 三条都在钉「用户不会被无声地坑」：
 *  1. **保存校验失败要定位到字段**：此前只弹一个 Toast + `setTab(0)`，用户得自己猜
 *     是哪个字段、再自己切回哪个 Tab（六个页签）；
 *  2. **规则文件非法路径在输入端就被驳回**：值不进 state（界面保持上一个合法值），
 *     并且挂着未修正的驳回时必须拦住保存 —— 否则保存会拿「旧值」静默成功，
 *     用户以为换成了 `~/.ssh/id_rsa`，实际什么都没变；
 *  3. **有未保存修改时关闭要二次确认**：六个 Tab 一次丢干净且无挽回入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AgentEditModal from '@/ui/pages/Settings/agent-edit-modal'
import { useMessageBox } from '@/ui/components/shared/MessageBox'
import { toolRegistry } from '@/domain/tools'
import type { ToolDefinition, ToolExecutor } from '@/domain/tools/types'
import type { Agent } from '@/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 测试用假工具（注册进真实注册中心，让「工具选择」Tab 有东西可过滤） */
const fakeTool = (name: string, description: string): ToolDefinition => ({
  name,
  label: name,
  description,
  parameters: { type: 'object', properties: {}, required: [] },
})
const noopExecutor = (async () => '') as ToolExecutor

const AGENT: Agent = {
  id: 'agent-1',
  name: '代码助手',
  description: '写代码的',
  personality: '',
  identity: '',
  defaultWorkspace: 'E:/proj',
  projectRulesFile: 'AGENTS.md',
  defaultModel: { providerConfigId: '', modelId: '' },
  allowTools: [],
  skills: [],
  defaultParams: {},
  createdAt: 0,
  updatedAt: 0,
}

/** React 受控输入：必须走原生 setter + input 事件，直接赋 value 不会触发 onChange */
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** MessageBox 需要 `useMessageBox()` 挂载后才可用（真实环境在 WindowLayout 里挂） */
function Harness({ children }: { children: React.ReactNode }) {
  const { MessageBox } = useMessageBox()
  return (
    <>
      {children}
      <MessageBox />
    </>
  )
}

describe('AgentEditModal', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    toolRegistry.register(
      fakeTool('alpha_tool', 'Fetches alpha data from the network'),
      noopExecutor,
    )
    toolRegistry.register(
      fakeTool('beta_tool', 'Writes beta content to disk'),
      noopExecutor,
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    toolRegistry.clear()
  })

  const el = <T extends Element>(sel: string) => container.querySelector<T>(sel)
  const tabByText = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('.aem-tab')).find(
      (b) => b.textContent?.includes(text),
    )!

  const render = async (agent: Agent | null, onSave = vi.fn(), onClose = vi.fn()) => {
    await act(async () => {
      root.render(
        <Harness>
          <AgentEditModal
            visible
            agent={agent}
            onClose={onClose}
            onSave={onSave}
          />
        </Harness>,
      )
    })
    return { onSave, onClose }
  }

  it('保存校验失败：切到出错字段所在 Tab、打红点、聚焦该字段，且不保存', async () => {
    const { onSave } = await render(null)

    // 先去别的 Tab —— 用来验证「会自己跳回来」
    await act(async () => tabByText('工具选择').click())
    expect(tabByText('工具选择').className).toContain('active')

    await act(async () => el<HTMLButtonElement>('.btn-confirm')!.click())

    expect(onSave).not.toHaveBeenCalled()
    // 名称 / 简介是必填，落在「基础信息」
    const active = container.querySelector('.aem-tab.active')!
    expect(active.textContent).toContain('基础信息')
    expect(active.className).toContain('has-error')
    expect(active.querySelector('.aem-tab-dot')).toBeTruthy()
    // 焦点必须落在出错字段上（否则用户仍要自己在 6 个页签里找）
    expect(document.activeElement?.id).toBe('agent-name')
    expect(el<HTMLInputElement>('#agent-name')!.className).toContain(
      'input-invalid',
    )
  })

  it('规则文件非法路径：输入被驳回（不写入表单）并拦住保存', async () => {
    const { onSave } = await render(AGENT)
    await act(async () => tabByText('模型与目录').click())

    const input = el<HTMLInputElement>('#agent-rules-file')!
    expect(input.value).toBe('AGENTS.md')

    await act(async () => setInputValue(input, 'C:/Users/x/.ssh/id_rsa'))

    // 驳回：值没进 state，界面仍是上一个合法值（配合红字说明「为什么不接受」）
    expect(el<HTMLInputElement>('#agent-rules-file')!.value).toBe('AGENTS.md')
    expect(el('.form-error')?.textContent).toContain('相对路径')
    // Tab 上打红点 —— 用户在别的页签也知道这里有问题
    expect(tabByText('模型与目录').className).toContain('has-error')

    // 挂着未修正的驳回 → 不允许保存（否则会拿旧值静默成功）
    await act(async () => el<HTMLButtonElement>('.btn-confirm')!.click())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('规则文件合法路径：接受（含 ./ 归一化）并清掉报错', async () => {
    const { onSave } = await render(AGENT)
    await act(async () => tabByText('模型与目录').click())

    const input = el<HTMLInputElement>('#agent-rules-file')!
    await act(async () => setInputValue(input, './.cursor/rules.md'))

    expect(el<HTMLInputElement>('#agent-rules-file')!.value).toBe(
      './.cursor/rules.md',
    )
    expect(el('.form-error')).toBeNull()
    expect(tabByText('模型与目录').className).not.toContain('has-error')

    await act(async () => el<HTMLButtonElement>('.btn-confirm')!.click())
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('有未保存修改时关闭：先二次确认，「放弃修改」才真的关', async () => {
    const { onClose } = await render(AGENT)

    // 改一处 → 变得「脏」
    await act(async () =>
      setInputValue(el<HTMLInputElement>('#agent-name')!, '代码助手2'),
    )

    await act(async () => el<HTMLButtonElement>('.btn-cancel')!.click())
    // 未确认前不能关
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent).toContain('放弃未保存的修改？')

    await act(async () => el<HTMLElement>('.confirm')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('没有改动时关闭：不打扰，直接关', async () => {
    const { onClose } = await render(AGENT)

    await act(async () => el<HTMLButtonElement>('.btn-cancel')!.click())

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('放弃未保存的修改？')
  })

  it('工具检索：只显示匹配项，且全选只作用于筛选结果', async () => {
    const { onSave } = await render(AGENT)
    await act(async () => tabByText('工具选择').click())

    const toolIds = () =>
      Array.from(container.querySelectorAll('.tool-item .tool-id')).map(
        (e) => e.textContent,
      )
    const checked = () =>
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          '.tool-item input[type="checkbox"]',
        ),
      )
        .filter((c) => c.checked)
        .length

    expect(toolIds().sort()).toEqual(['alpha_tool', 'beta_tool'])

    // 检索后只剩一项
    await act(async () =>
      setInputValue(el<HTMLInputElement>('.list-filter')!, 'alpha'),
    )
    expect(toolIds()).toEqual(['alpha_tool'])

    // 全选 —— 只该选中筛选出来的那一个（而不是默默选了看不见的 27 个）
    await act(async () => el<HTMLButtonElement>('.toggle-all-btn')!.click())
    expect(checked()).toBe(1)

    // 清掉检索：alpha 已选、beta 未选
    await act(async () => setInputValue(el<HTMLInputElement>('.list-filter')!, ''))
    expect(checked()).toBe(1)
    expect(
      el<HTMLInputElement>('.tool-item input[type="checkbox"]')!.checked,
    ).toBe(true)

    // 检索不影响保存出的 allowTools
    await act(async () => el<HTMLButtonElement>('.btn-confirm')!.click())
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('检索无结果：给出空态提示，不留下空列表', async () => {
    await render(AGENT)
    await act(async () => tabByText('工具选择').click())

    await act(async () =>
      setInputValue(el<HTMLInputElement>('.list-filter')!, 'zzz-no-hit'),
    )

    expect(container.querySelectorAll('.tool-item')).toHaveLength(0)
    expect(container.textContent).toContain('没有匹配的工具')
  })

  it('Tab 支持左右方向键 / Home / End 切换（ARIA tabs 模式）', async () => {
    await render(AGENT)
    const tabs = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.aem-tab'))
    const selected = () =>
      tabs()
        .findIndex((b) => b.getAttribute('aria-selected') === 'true')

    expect(container.querySelector('[role="tablist"]')).toBeTruthy()
    expect(selected()).toBe(0)

    await act(async () => {
      tabs()[0].focus()
      tabs()[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    })
    expect(selected()).toBe(1)
    expect(document.activeElement).toBe(tabs()[1])

    // End → 最后一个，并跟随焦点
    await act(async () => {
      tabs()[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      )
    })
    expect(selected()).toBe(5)
    expect(document.activeElement).toBe(tabs()[5])

    // 首页再按左键 → 绕到末页
    await act(async () => {
      tabs()[5].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    })
    expect(selected()).toBe(0)
    expect(document.activeElement).toBe(tabs()[0])

    await act(async () => {
      tabs()[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      )
    })
    expect(selected()).toBe(5)

    // 其他按键不受影响
    await act(async () => {
      tabs()[5].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
      )
    })
    expect(selected()).toBe(5)
  })

  it('预设模板：字段非空时先二次确认，「取消」则保留原文', async () => {
    await render(AGENT)
    await act(async () => tabByText('身份设定').click())

    const textarea = el<HTMLTextAreaElement>('textarea.md-textarea')!
    await act(async () => setInputValue(textarea, '我自己写的内容'))

    const preset = container.querySelectorAll<HTMLElement>('.preset-btn')[0]
    await act(async () => preset.click())

    // 未确认前不覆盖
    expect(container.textContent).toContain('覆盖当前内容？')
    expect(el<HTMLTextAreaElement>('textarea.md-textarea')!.value).toBe(
      '我自己写的内容',
    )

    // 「取消」→ 原文保留
    await act(async () => el<HTMLElement>('.cancel')!.click())
    expect(el<HTMLTextAreaElement>('textarea.md-textarea')!.value).toBe(
      '我自己写的内容',
    )

    // 「覆盖」→ 真的换掉
    await act(async () => preset.click())
    await act(async () => el<HTMLElement>('.confirm')!.click())
    expect(el<HTMLTextAreaElement>('textarea.md-textarea')!.value).toContain(
      '资深软件架构师',
    )
  })

  it('预设模板：字段为空时直接填入，不多问一句', async () => {
    await render(null)
    await act(async () => tabByText('性格设定').click())

    await act(async () =>
      container.querySelectorAll<HTMLElement>('.preset-btn')[0].click(),
    )

    expect(container.textContent).not.toContain('覆盖当前内容？')
    expect(el<HTMLTextAreaElement>('textarea.md-textarea')!.value).toContain(
      '说话严谨',
    )
  })
})
