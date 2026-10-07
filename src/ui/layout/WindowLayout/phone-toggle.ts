/**
 * phone-toggle —— 标题栏「手机控制」快捷开关的状态映射（纯函数，无 React 依赖，便于单测）
 *
 * 图标只有亮 / 暗两档，但用户还关心**连线状态**，所以拆成三项：
 *   - `active`（亮）= 已启用 **或** 正在启用：`enableAsync()` 要先初始化设备身份再解析 ICE，
 *     真机上这几百毫秒到数秒内 `enabled` 仍是 false，不亮就成了「点了没反应」；
 *   - `dot`（右下角状态点）说「连没连上、怎么个错法」；
 *   - `hint` 悬停提示，同时告诉用户「点它会怎样」。
 */
import type { PhoneControlStatus } from '@/bridge'
import { t } from '@/ui/i18n'

/** 状态点：`waiting` 等待 / `connected` 已连接 / `error` 出错或被拒；`null` = 不显示 */
export type PhoneToggleDot = 'waiting' | 'connected' | 'error' | null

export interface PhoneToggleInput {
  /** 手机控制是否已启用（store 的 `enabled`） */
  enabled: boolean
  /** 本次会话内「点了开启、服务还没起来」的过渡态（组件持有） */
  starting: boolean
  status: PhoneControlStatus
}

export interface PhoneToggleView {
  /** 图标亮起（已启用或正在启用） */
  active: boolean
  dot: PhoneToggleDot
  hint: string
}

export function phoneToggleView({
  enabled,
  starting,
  status,
}: PhoneToggleInput): PhoneToggleView {
  if (starting) {
    return { active: true, dot: 'waiting', hint: t('手机控制正在启用…') }
  }
  if (!enabled) {
    return { active: false, dot: null, hint: t('点击开启手机控制') }
  }
  if (status === 'connected') {
    return {
      active: true,
      dot: 'connected',
      hint: t('手机控制已连接（点击关闭）'),
    }
  }
  if (status === 'error' || status === 'rejected') {
    return { active: true, dot: 'error', hint: t('手机控制出错（点击关闭）') }
  }
  // waiting / verifying / disabled（刚点开、服务还没上报状态）
  return { active: true, dot: 'waiting', hint: t('手机控制等待手机连接（点击关闭）') }
}
