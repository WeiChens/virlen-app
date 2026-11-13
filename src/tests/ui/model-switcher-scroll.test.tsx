/**
 * 聊天输入框「模型下拉」—— 打开时把**当前选中的那一项**滚进可视区。
 *
 * 真机缺陷回归：`.dropdown-list` 是独立滚动容器，而列表每开一次都整体重新挂载
 * （`open && …`），`scrollTop` 恒从 0 开始 —— provider / 模型一多，选中项就落在
 * 可视区之外，用户看到的是「第一家的第一个模型」，而不是自己当前在用的那个。
 *
 * 这里钉四件事：
 *  1. 打开列表时把选中项滚到列表中间（写入的是 `.dropdown-list` 自己的 `scrollTop`）；
 *  2. 偏移按**内容顶部**算（`item.top - list.top + scrollTop`），列表已在滚动位置上时
 *     不会少滚一截；
 *  3. 选中项不在列表里（provider 被停用 / 模型被删）时回到顶端，不抛出、不瞎滚；
 *  4. 量不到布局（rect 全 0）时**不动** —— 拿 0 当真值会算出凭空位移。
 *
 * 环境：happy-dom 不做布局，矩形与高度由本文件装成可断言的替身
 * （与 `details-fold.test.ts` 同一套做法）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { runInAction } from 'mobx'
import { createRoot } from 'react-dom/client'
import ModelSwitcher from '@/ui/pages/chat/components/modals/model-switcher'
import { settingsState } from '@/ui/store/settingStore'
import { chatState } from '@/ui/store/chatState'
import type { ProviderConfig } from '@/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LIST_H = 380 // .model-dropdown 的 max-height
const ITEM_H = 34
const HEADER_H = 30 // .dropdown-provider-header

function provider(id: string, name: string, models: string[]): ProviderConfig {
  return {
    id,
    name,
    templateName: 'custom',
    type: 'openai',
    apiKey: '',
    baseUrl: '',
    models,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

/**
 * 给列表与选中项装可断言的矩形替身（卷上 `HTMLElement.prototype`，按 class 命中）。
 *
 * 真实浏览器里 `getBoundingClientRect().top` 是视口坐标（会随滚动变化），组件算的是
 * `item.top - list.top + list.scrollTop` = **选中项相对内容顶部的偏移**。
 * 替身照这个语义给：列表顶固定 0，选中项顶 = `contentOffset - scrollTop`。
 *
 * 为什么装在原型上而不是逐个实例上：组件在 `useEffect` 里读布局，effect 在 React 处理完
 * click 后的 commit 阶段就跑完了 —— 事后再装替身，读到的已经是 0。原型上的替身按 class
 * 命中，列表一挂载就生效。
 */
function withLayout(contentOffset: number) {
  const proto = HTMLElement.prototype
  const originalClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  const originalRect = proto.getBoundingClientRect

  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('dropdown-list') ? LIST_H : 0
    },
  })
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('dropdown-model-item') ? ITEM_H : 0
    },
  })
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('dropdown-list')) {
      return { top: 0, left: 0, bottom: LIST_H, right: 240, width: 240, height: LIST_H } as DOMRect
    }
    if (this.classList.contains('dropdown-model-item') && this.classList.contains('active')) {
      // 选中项的顶边 = 内容偏移 − 当前已滚动量
      const list = this.closest('.dropdown-list') as HTMLElement
      const top = contentOffset - (list?.scrollTop ?? 0)
      return { top, left: 0, bottom: top + ITEM_H, right: 240, width: 240, height: ITEM_H } as DOMRect
    }
    return originalRect.call(this)
  }

  return () => {
    if (originalClientHeight) Object.defineProperty(proto, 'clientHeight', originalClientHeight)
    if (originalOffsetHeight) Object.defineProperty(proto, 'offsetHeight', originalOffsetHeight)
    proto.getBoundingClientRect = originalRect
  }
}

describe('模型下拉 —— 打开时聚焦滚动到选中项', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    runInAction(() => {
      settingsState.value.providers = []
      chatState.setValue('selectModel', null)
      chatState.setValue('currentSessionId', null)
    })
  })

  function render(
    providers: ProviderConfig[],
    selected: { providerConfigId: string; modelId: string } | null,
  ) {
    runInAction(() => {
      settingsState.value.providers = providers
      // 无会话时走 `selectModel` 这一路（有会话走 sessionStore，本用例不涉及）
      chatState.setValue('currentSessionId', null)
      chatState.setValue('selectModel', selected)
    })
    act(() => root.render(<ModelSwitcher />))
  }

  const clickTrigger = () =>
    act(() => container.querySelector<HTMLButtonElement>('.model-switcher-trigger')!.click())

  it('把选中项滚到列表中间', () => {
    const models = Array.from({ length: 40 }, (_, i) => `model-${i}`)
    render([provider('p1', 'P1', models)], { providerConfigId: 'p1', modelId: 'model-30' })

    const contentOffset = HEADER_H + 30 * ITEM_H
    const restore = withLayout(contentOffset)
    try {
      clickTrigger()
      const list = container.querySelector<HTMLElement>('.dropdown-list')!
      const active = container.querySelector<HTMLElement>('.dropdown-model-item.active')!
      expect(active.textContent).toContain('model-30')
      // 居中：内容偏移 − (容器高 − 行高) / 2
      expect(list.scrollTop).toBe(contentOffset - (LIST_H - ITEM_H) / 2)
    } finally {
      restore()
    }
  })

  it('偏移按内容顶部算，列表已滚动时不会少滚一截', () => {
    const models = Array.from({ length: 40 }, (_, i) => `model-${i}`)
    render([provider('p1', 'P1', models)], { providerConfigId: 'p1', modelId: 'model-30' })

    const contentOffset = HEADER_H + 30 * ITEM_H
    const restore = withLayout(contentOffset)
    try {
      clickTrigger()
      const list = container.querySelector<HTMLElement>('.dropdown-list')!
      const expected = contentOffset - (LIST_H - ITEM_H) / 2
      expect(list.scrollTop).toBe(expected)
      // 替身随 scrollTop 变化给出新的 top；再改一次 scrollTop 后重跑 effect（关/开）
      // 仍应算出同一个目标 —— 即偏移与「当前滚动量」无关。
      list.scrollTop = 100
      clickTrigger() // 关
      clickTrigger() // 开（重新挂载，scrollTop 归 0）
      const list2 = container.querySelector<HTMLElement>('.dropdown-list')!
      expect(list2.scrollTop).toBe(expected)
    } finally {
      restore()
    }
  })

  it('选中项在列表最前面时不产生负偏移', () => {
    const models = Array.from({ length: 40 }, (_, i) => `model-${i}`)
    render([provider('p1', 'P1', models)], { providerConfigId: 'p1', modelId: 'model-0' })

    const restore = withLayout(HEADER_H) // 第一个模型就在头下面
    try {
      clickTrigger()
      const list = container.querySelector<HTMLElement>('.dropdown-list')!
      expect(list.scrollTop).toBe(0)
    } finally {
      restore()
    }
  })

  it('选中项不在列表里（provider 被停用）时回到顶端', () => {
    const p1 = provider('p1', 'P1', ['a', 'b'])
    const p2 = provider('p2', 'P2', ['x', 'y'])
    p2.enabled = false // 选中的是**停用** provider 的模型
    render([p1, p2], { providerConfigId: 'p2', modelId: 'x' })

    clickTrigger()

    const list = container.querySelector<HTMLElement>('.dropdown-list')!
    expect(list.scrollTop).toBe(0)
    expect(container.querySelector('.dropdown-model-item.active')).toBeNull()
  })

  it('量不到布局（clientHeight 为 0）时不改 scrollTop', () => {
    const models = Array.from({ length: 40 }, (_, i) => `model-${i}`)
    render([provider('p1', 'P1', models)], { providerConfigId: 'p1', modelId: 'model-30' })

    // 不装替身：happy-dom 的 rect / clientHeight 全是 0
    clickTrigger()

    const list = container.querySelector<HTMLElement>('.dropdown-list')!
    expect(list.scrollTop).toBe(0)
  })

  it('没有任何可用 provider 时不渲染列表', () => {
    render([], null)
    clickTrigger()
    expect(container.querySelector('.dropdown-list')).toBeNull()
    expect(container.querySelector('.dropdown-empty')).toBeTruthy()
  })
})
