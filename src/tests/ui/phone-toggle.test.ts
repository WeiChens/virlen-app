import { describe, expect, it } from 'vitest'
import { phoneToggleView } from '@/ui/layout/WindowLayout/phone-toggle'

/**
 * 标题栏「手机控制」快捷开关的状态映射。
 *
 * 需要守住的语义：
 *   1. **正在启用**也算「亮」—— 否则用户点完那几秒（初始化身份 + 解析 ICE）看到的是
 *      「点了没反应」；
 *   2. 状态点必须能区分「在等手机」与「手机已连上」（前者琥珀呼吸、后者绿）；
 *   3. 出错 / 被拒是**否定结论**，得是红点，不能和「还在等」显示成一样。
 *
 * 测试环境是中文（`t()` 直接返回 key），所以断言写中文原文。
 */
describe('phoneToggleView', () => {
  it('未启用 → 图标暗、无状态点、提示「点击开启」', () => {
    const view = phoneToggleView({
      enabled: false,
      starting: false,
      status: 'disabled',
    })
    expect(view).toEqual({
      active: false,
      dot: null,
      hint: '点击开启手机控制',
    })
  })

  it('正在启用（enabled 还没翻转）→ 已经算「亮」，并显示等待点', () => {
    const view = phoneToggleView({
      enabled: false,
      starting: true,
      status: 'disabled',
    })
    expect(view.active).toBe(true)
    expect(view.dot).toBe('waiting')
    expect(view.hint).toBe('手机控制正在启用…')
  })

  it('已连接 → 绿点 + 「已连接」提示', () => {
    const view = phoneToggleView({
      enabled: true,
      starting: false,
      status: 'connected',
    })
    expect(view).toEqual({
      active: true,
      dot: 'connected',
      hint: '手机控制已连接（点击关闭）',
    })
  })

  it('等待 / 验证中 / 刚启用尚无状态 → 琥珀等待点', () => {
    for (const status of ['waiting', 'verifying', 'disabled'] as const) {
      const view = phoneToggleView({ enabled: true, starting: false, status })
      expect(view.dot, status).toBe('waiting')
      expect(view.hint, status).toBe('手机控制等待手机连接（点击关闭）')
    }
  })

  it('出错 / 被拒 → 红点（否定结论不能显示成「还在等」）', () => {
    for (const status of ['error', 'rejected'] as const) {
      const view = phoneToggleView({ enabled: true, starting: false, status })
      expect(view.dot, status).toBe('error')
      expect(view.hint, status).toBe('手机控制出错（点击关闭）')
    }
  })

  it('过渡态优先：正在启用时即使已是 connected 也只显示等待点', () => {
    // 真实场景几乎不会同时出现（starting 由点击那一刻置位、enabled 翻转后即清），
    // 但优先级写死成「starting 最高」，避免两处状态打架时闪现错误的绿点。
    const view = phoneToggleView({
      enabled: true,
      starting: true,
      status: 'connected',
    })
    expect(view.dot).toBe('waiting')
  })
})
