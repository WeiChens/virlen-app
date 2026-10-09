/**
 * 批量任务进度弹窗（shared/TaskProgress）—— 进度、最新文案、取消 / 关闭
 *
 * 为什么值得单独测：这块 UI 是「几十秒的批量操作（导入 / 清理）」全程唯一的反馈，
 * 而且它的状态机不在组件里（模块级单例 + 事件），jsdom 之外没人会提醒它被改坏 ——
 * 比如「结束之后按钮还是『取消』」或者「按了取消弹窗却直接消失、用户不知道停没停」。
 *
 * 它由 `shared/ImportProgress` 泛化而来（导入 / 删除共用）：所以额外守一条「结束语与
 * 停下说明由调用方给」—— 同一次批量里导入说「导入完成」、删除要说「删除完成」，
 * 写成一句通用的话两边都别扭。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import TaskProgress, {
  beginTask,
  requestTaskCancel,
} from '@/ui/components/shared/TaskProgress'
import type { BatchTask } from '@/ui/components/shared/TaskProgress'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 挂上弹窗宿主（WindowLayout 里就是这么挂的），返回根与卸载函数 */
function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<TaskProgress />)
  })
  return {
    root,
    unmount: () => act(() => root.unmount()),
  }
}

function buttonTexts(): string[] {
  return Array.from(document.querySelectorAll('.modal-footer button')).map(
    (b) => b.textContent?.trim() ?? '',
  )
}

function clickButton(text: string) {
  const btn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`找不到按钮「${text}」，当前：${buttonTexts().join(' / ')}`)
  act(() => (btn as HTMLButtonElement).click())
}

function bodyText(): string {
  return document.querySelector('.modal-body')?.textContent ?? ''
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('批量任务进度弹窗', () => {
  it('没开始任务时什么都不显示；取消按钮在没有任务时是空操作', () => {
    const { unmount } = mount()
    expect(document.querySelector('.modal-overlay')).toBeNull()
    requestTaskCancel() // 不该抛
    unmount()
  })

  it('开始：显示标题、来源、进度条与「准备中…」，跑起来后显示第几份与最新文案', () => {
    const { unmount } = mount()
    let task!: BatchTask
    act(() => {
      task = beginTask({
        title: '正在添加文档',
        source: '「我的库」· 从文件夹 docs',
        total: 3,
      })
    })

    const dialog = document.querySelector('.modal-overlay')
    expect(dialog).not.toBeNull()
    expect(document.querySelector('.modal-header')?.textContent).toContain('正在添加文档')
    expect(bodyText()).toContain('「我的库」· 从文件夹 docs')
    // 还没处理第一份：不显示「第 0 / 3 份」这种别扭数字
    expect(bodyText()).toContain('准备中…')
    expect(
      document.querySelector('.task-progress-bar')?.getAttribute('aria-valuenow'),
    ).toBe('0')

    act(() => task.step(1, '正在读入「a.md」…', '新增 0 份'))
    expect(bodyText()).toContain('第 1 / 3 份')
    expect(bodyText()).toContain('正在读入「a.md」…')
    expect(
      document.querySelector('.task-progress-bar')?.getAttribute('aria-valuenow'),
    ).toBe('1')
    expect(buttonTexts()).toEqual(['取消'])
    unmount()
  })

  it('取消：立刻说明「正在停下」，任务被标记为取消，但弹窗留着等循环停在边界上', () => {
    const { unmount } = mount()
    let task!: BatchTask
    act(() => {
      task = beginTask({
        title: '正在删除文档',
        source: '来源',
        total: 5,
        stoppingHint: '正在停下 —— 这一份删完就不删了',
      })
    })
    act(() => task.step(1, '正在删除「a.md」', '已删除 0 份'))

    clickButton('取消')

    expect(task.cancelled).toBe(true)
    // 调用方给的那句「停在哪」的说明要真的显示出来（入口用它会话说清「已删的收不回来」）
    expect(bodyText()).toContain('正在停下 —— 这一份删完就不删了')
    expect(buttonTexts()).toEqual(['正在停止…'])
    // 弹窗没被关掉（用户按取消不是「逃离」，而是「停下」）
    expect(document.querySelector('.modal-overlay')).not.toBeNull()
    unmount()
  })

  it('结束：标题换成调用方给的结束语、按钮换成关闭、汇总替换最新文案；关闭后弹窗消失', () => {
    const { unmount } = mount()
    let task!: BatchTask
    act(() => {
      task = beginTask({
        title: '正在删除文档',
        source: '来源',
        total: 2,
        doneText: '删除完成',
        stoppedText: '已停止删除',
      })
    })
    act(() => task.step(1, '正在删除「a.md」', '已删除 0 份'))
    act(() => task.finish(false, '已删除 2 份'))

    expect(document.querySelector('.modal-header')?.textContent).toContain('删除完成')
    expect(bodyText()).toContain('已删除 2 份')
    expect(buttonTexts()).toEqual(['关闭'])

    clickButton('关闭')
    expect(document.querySelector('.modal-overlay')).toBeNull()
    unmount()
  })

  it('取消收尾：标题用调用方给的「已停止…」，进度停在中断处（不假装跑完了）', () => {
    const { unmount } = mount()
    let task!: BatchTask
    act(() => {
      task = beginTask({
        title: '正在删除文档',
        total: 9,
        doneText: '删除完成',
        stoppedText: '已停止删除',
      })
    })
    act(() => task.step(2, '正在删除「b.md」', '已删除 1 份'))
    act(() => task.finish(true, '已删除 1 份'))

    expect(document.querySelector('.modal-header')?.textContent).toContain('已停止删除')
    expect(bodyText()).toContain('第 2 / 9 份')
    expect(bodyText()).toContain('已删除 1 份')
    unmount()
  })

  it('不传结束语时用通用默认（已完成 / 已停止），不传停下说明就不显示那句', () => {
    const { unmount } = mount()
    let task!: BatchTask
    act(() => {
      task = beginTask({ title: '正在处理', total: 1 })
    })
    act(() => task.step(1, '处理中', ''))
    clickButton('取消')
    expect(bodyText()).not.toContain('正在停下')
    act(() => task.finish(true, ''))

    expect(document.querySelector('.modal-header')?.textContent).toContain('已停止')
    unmount()
  })

  it('重复收尾不会覆盖最终文案（调用方在 catch 里兜底再收一次时）', () => {
    const { unmount } = mount()
    let task!: BatchTask
    act(() => {
      task = beginTask({ title: '正在添加文档', source: '来源', total: 1 })
    })
    act(() => task.finish(false, '新增 1 份'))
    act(() => task.finish(true, '导入没能完成'))

    expect(document.querySelector('.modal-header')?.textContent).toContain('已完成')
    expect(bodyText()).toContain('新增 1 份')
    unmount()
  })
})
