/**
 * 后台服务状态 → 徽标（工具卡片 `BackgroundServiceMessage` 与标题栏面板 `ServiceEntry` 共用）。
 *
 * 取值契约只有一处：Rust `service/common.rs::status`（`running` / `exited` / `failed`）+ `killed`。
 * 面（卡片 / 面板）与后端同源，因此这张映射表也只能有一份 —— 两份就会分叉成两种说法。
 */
import { t } from '@/ui/i18n'

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  running: { label: '运行中', className: 'is-running' },
  exited: { label: '已退出', className: 'is-exited' },
  failed: { label: '启动失败', className: 'is-failed' },
}

/** 状态 → 徽标文案与配色类（缺字段 = 结果还没回来，按「等待中」渲染）。 */
export function serviceStatusLabel(
  status?: string,
  killed?: boolean,
): { label: string; className: string } {
  // 「被终止」自己一条说法：与「自行退出」对模型的含义完全不同，对用户也一样
  if (status === 'exited' && killed) {
    return { label: t('已终止'), className: 'is-killed' }
  }
  const info = status ? STATUS_LABELS[status] : undefined
  return info
    ? { label: t(info.label), className: info.className }
    : { label: t('等待中…'), className: 'is-pending' }
}
