/**
 * 设置页「已绑定的手机」**改名**（真机需求的交互侧）。
 *
 * 需求原话：「给记录的手机添加改名功能，可以修改名称」。
 *
 * store / bridge 侧的语义在 `src/tests/bridge/pairing-rename.test.ts` 与
 * `src/tests/ui/phone-control-devices.test.ts`；本文件只钉**界面上那几下**：
 *  1. 点「重命名」→ 名字变成输入框并回填当前名（用户直接打字即覆盖）；
 *  2. 回车 / 点「保存」/ 失焦 = 提交（三条入口都要真的写进配对表）；
 *  3. Esc / 「取消」= 不改（不能因为试了一下就悄悄改掉名字）；
 *  4. 空名时「保存」是禁用态（空名不是合法名字，界面上先说清楚，而不是提交后什么也没发生）。
 *
 * 用 `createRoot` + 真实事件（与 `agent-edit-modal.test.tsx` 同一套设施），
 * 因为这几条都是「点下去之后会发生什么」，静态 markup 断言盖不到。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import PhoneControlSettings from '@/ui/pages/Settings/phone-control-settings'
import { phoneControlStore } from '@/ui/store/phoneControlStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** React 受控输入：必须走原生 setter + input 事件，直接赋 value 不会触发 onChange */
function setInputValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('设置页 —— 已绑定手机的改名', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    // 配对表是模块级单例：先清干净，免得上个用例的手机混进列表
    phoneControlStore.pairing.restore({ devices: [], tickets: [] })
    phoneControlStore.pairing.register('Android', { mobileKey: 'mk-ui-rename' })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<PhoneControlSettings />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    phoneControlStore.pairing.restore({ devices: [], tickets: [] })
  })

  const el = <T extends Element>(sel: string) => container.querySelector<T>(sel)
  const btn = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes(text),
    )!
  const nameOnScreen = () =>
    el('.phone-control__device-name-text')?.textContent ??
    el<HTMLInputElement>('.phone-control__device-input')?.value

  /** 点「重命名」进入编辑态，返回那个输入框 */
  async function startEdit(): Promise<HTMLInputElement> {
    await act(async () => btn('重命名').click())
    const input = el<HTMLInputElement>('.phone-control__device-input')!
    expect(input).toBeTruthy()
    return input
  }

  it('点「重命名」→ 输入框回填当前名并聚焦（直接打字即覆盖）', async () => {
    expect(nameOnScreen()).toBe('Android')

    const input = await startEdit()

    expect(input.value).toBe('Android')
    expect(document.activeElement).toBe(input)
    // 编辑态下不再显示「移除」——避免「正在改名」和「删掉这台」两个按钮挤在一起
    expect(btn('移除')).toBeUndefined()
    expect(btn('保存')).toBeTruthy()
  })

  it('回车提交：配对表与界面都换成新名，输入框收起', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, '  我的主力机  '))
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    // 前后空白由 bridge 归一，写进配对表的是干净名字
    expect(phoneControlStore.devices[0].name).toBe('我的主力机')
    expect(el('.phone-control__device-input')).toBe(null)
    expect(nameOnScreen()).toBe('我的主力机')
  })

  it('点「保存」提交（不只是回车能用 —— 鼠标用户也得点得到）', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, '客厅 iPad'))
    await act(async () => btn('保存').click())

    expect(phoneControlStore.devices[0].name).toBe('客厅 iPad')
    expect(el('.phone-control__device-input')).toBe(null)
  })

  it('失焦提交（点页面别处不该把改了一半的名字丢掉）', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, '书房那台'))
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(phoneControlStore.devices[0].name).toBe('书房那台')
  })

  it('Esc 取消：一个字都不改（试一下不等于改掉了）', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, '打错的字'))
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    expect(phoneControlStore.devices[0].name).toBe('Android')
    expect(el('.phone-control__device-input')).toBe(null)
    expect(nameOnScreen()).toBe('Android')
  })

  it('「取消」按钮同理：退出编辑但不改名', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, '还是算了'))
    await act(async () => btn('取消').click())

    expect(phoneControlStore.devices[0].name).toBe('Android')
    expect(nameOnScreen()).toBe('Android')
  })

  it('空名（或全空格）时「保存」是禁用的，且强行回车也不写空名', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, '   '))

    expect(btn('保存').disabled).toBe(true)

    // 回车走同一条判定：退回非编辑态，名字保持原样
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(phoneControlStore.devices[0].name).toBe('Android')
  })

  it('名字没改就想退出：不写库、不报错（归一后同名 = 没变）', async () => {
    const input = await startEdit()

    await act(async () => setInputValue(input, ' Android '))
    await act(async () => btn('保存').click())

    expect(phoneControlStore.devices[0].name).toBe('Android')
    expect(phoneControlStore.devices).toHaveLength(1)
  })
})
