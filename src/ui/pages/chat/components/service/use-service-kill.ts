/**
 * useServiceKill — 「终止后台服务」的用户侧动作（面板行内按钮与终端面板头部共用）。
 *
 * 三条口径（与 Rust `panel::kill_service_snapshot` 对应）：
 * 1. **直接杀，不弹二次确认**（用户要求）；返回 `null` = 条目已不在表里 → 如实提示，不谎报成功；
 * 2. 发出信号但没等到退出 → 也说清楚（下一次轮询会把真实状态带回来）；
 * 3. 失败向上抛给界面 → toast + 就地刷新列表，不静默失败。
 */
import { useCallback, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import {
  killBackgroundService,
  type BackgroundServiceInfo,
} from '@/infrastructure/backgroundService'

export interface ServiceKillState {
  /** 正在终止的服务 id（按钮禁用 / 「终止中」文案） */
  killing: string | null
  kill: (sessionId: string, service: BackgroundServiceInfo) => Promise<void>
}

export function useServiceKill(
  refresh: () => Promise<void> | void,
): ServiceKillState {
  const [killing, setKilling] = useState<string | null>(null)

  const kill = useCallback(
    async (sessionId: string, svc: BackgroundServiceInfo) => {
      setKilling(svc.id)
      try {
        const row = await killBackgroundService(sessionId, svc.id)
        if (!row) {
          // 不在表里了（多半是 AI 刚 kill 掉并清出注册表）
          showToast(t('该服务已不在列表中'))
        } else if (row.status === 'running') {
          // 发了信号但没等到退出 —— 如实说
          showToast(
            tpl('已向 $__name__ 发出终止信号，尚未确认退出', {
              name: row.name,
            }),
          )
        } else {
          showToast(tpl('已终止 $__name__', { name: row.name }))
        }
        await refresh()
      } catch (e: any) {
        showToast(`${t('操作失败')}：${e?.message || String(e)}`)
        await refresh()
      } finally {
        setKilling(null)
      }
    },
    [refresh],
  )

  return { killing, kill }
}
