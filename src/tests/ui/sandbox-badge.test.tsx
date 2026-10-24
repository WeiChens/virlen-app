/**
 * 沙盒徽标（`.terminal-sandbox-badge`）的**显示口径**。
 *
 * 只有「真在沙盒里」的两种模式画徽标（`write_isolation` / `readonly`）；`no_sandbox*` 一律不画 ——
 * 「没沙盒」是常态而不是异常：设置里关掉沙盒、命中「忽略沙盒命令」规则、AI 申请脱壳、
 * 用户终端本来就不进沙盒，全落在这一档。四档再各配一枚红标，界面很快就成一片红，谁都不看了。
 * 真正需要人当场注意的脱壳，在**审批弹窗**那一刻已经拦过一次（那一步必须点过）。
 *
 * 这条是用户明确要求的（2026-10-24：「不是沙盒模式的时候不显示 `terminal-sandbox-badge`」），
 * 改回去之前先问 —— 组件测试只断言 DOM，看不出「满屏红标」这种界面问题。
 */
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SandboxBadge } from '@/ui/pages/chat/components/tool-call/SandboxBadge'

// 显式告诉 React 这是 act 环境（否则每次 `act()` 都会打一条警告）
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 渲染一枚徽标，返回可见文字（没画出来就是 `null`） */
function render(kind?: string): string | null {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<SandboxBadge kind={kind} />))
  const badge = host.querySelector<HTMLElement>('.terminal-sandbox-badge')
  const text = badge ? badge.textContent : null
  act(() => root.unmount())
  host.remove()
  return text
}

describe('沙盒徽标只在「真在沙盒里」时出现', () => {
  it('写隔离 / 只读：各有一枚徽标（这两种才是要说明的状态）', () => {
    expect(render('write_isolation')).toBe('沙盒·写隔离')
    expect(render('readonly')).toBe('沙盒·只读')
  })

  it('no_sandbox* 五档一律不画（脱壳 / 忽略规则 / 设置里关掉 / 降级 / 其它）', () => {
    for (const kind of [
      'no_sandbox_bypass',
      'no_sandbox_disabled',
      'no_sandbox_degraded',
      'no_sandbox_rule',
      'no_sandbox',
    ]) {
      expect(render(kind), kind).toBeNull()
    }
  })

  it('还没拿到模式 / 不认识的模式：也不画（不编一枚空徽标占位）', () => {
    expect(render(undefined)).toBeNull()
    expect(render('something_new')).toBeNull()
  })
})
