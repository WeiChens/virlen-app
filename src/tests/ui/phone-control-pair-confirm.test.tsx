/**
 * 设置页「有手机请求配对」确认弹窗 —— 钉住**显示的是谁的名字**。
 *
 * 真机缺陷回归：弹窗曾显示「「Virlen 电脑」请求连接并操作本机，是否允许？」——
 * 名字取成了**本机（电脑）**的名字，而事实是**手机**在请求，读起来像电脑在请求自己。
 *
 * store / bridge 侧的语义（`confirmPair` 的上下文、归一与兜底）在
 * `src/tests/bridge/phone-control.test.ts`；本文件只钉界面上的这两下：
 *  1. 弹窗正文里的 `$__name__` 是手机名，且本机名不出现；
 *  2. 「允许」/「拒绝」把选择交回等待中的桥接 Promise，弹窗随之消失。
 *
 * 用 `createRoot` + 真实事件（与 `phone-control-rename.test.tsx` 同一套设施）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { runInAction } from 'mobx'
import { createRoot } from 'react-dom/client'
import PhoneControlSettings from '@/ui/pages/Settings/phone-control-settings'
import { phoneControlStore } from '@/ui/store/phoneControlStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('设置页 —— 配对确认弹窗', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    // 配对表是模块级单例：清干净，免得上个用例的手机混进列表
    phoneControlStore.pairing.restore({ devices: [], tickets: [] })
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
    runInAction(() => {
      phoneControlStore.pendingPair = null
    })
    phoneControlStore.pairing.restore({ devices: [], tickets: [] })
  })

  const dialog = () => container.querySelector('.phone-control__confirm')
  const confirmBtn = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('.phone-control__confirm-actions button')).find(
      (b) => b.textContent?.includes(text),
    )

  /** 摆上「手机刚发来配对请求」的状态；返回收集用户选择的数组（桥接 Promise 的那一头） */
  async function requestPair(mobileName: string): Promise<boolean[]> {
    const answers: boolean[] = []
    await act(async () => {
      runInAction(() => {
        phoneControlStore.pendingPair = {
          token: 'tk-ui-confirm',
          mobileName,
          resolve: (ok) => answers.push(ok),
        }
      })
    })
    return answers
  }

  it('弹窗显示**手机**的名字，本机名不出现', async () => {
    await requestPair('小米 14')

    expect(dialog()).toBeTruthy()
    const text = dialog()!.textContent ?? ''
    expect(text).toContain('有手机请求配对')
    expect(text).toContain('小米 14')
    // 回归钉子：本机名（`phoneControlStore` 里的 DEVICE_NAME）不该出现在这句里
    expect(text).not.toContain('Virlen 电脑')
  })

  it('点「允许」→ 交回 true 并收起弹窗', async () => {
    const answers = await requestPair('小米 14')

    await act(async () => confirmBtn('允许')!.click())

    expect(answers).toEqual([true])
    expect(dialog()).toBeNull()
  })

  it('点「拒绝」→ 交回 false 并收起弹窗', async () => {
    const answers = await requestPair('小米 14')

    await act(async () => confirmBtn('拒绝')!.click())

    expect(answers).toEqual([false])
    expect(dialog()).toBeNull()
  })
})
