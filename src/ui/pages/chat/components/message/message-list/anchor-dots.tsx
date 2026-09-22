/**
 * 用户消息锚点列表（覆盖整个会话的全量 user 消息，可视区内滚动查找）
 *
 * 用 memo 包裹：长会话下圆点可能上千个，避免流式 token 高频更新
 *（父组件重渲染）时反复创建 DOM 树。
 */
import { memo } from 'react'
import { t } from '@/ui/i18n'
import Tooltip from '@/ui/components/shared/Tooltip'
import { MAX_ANCHOR_DOTS } from './constants'
import type { AnchorUser } from './types'

interface Props {
  users: AnchorUser[]
  activeId: string | null
  loadingId: string | null
  onJump: (id: string) => void
}

export const AnchorDots = memo(function AnchorDots({
  users,
  activeId,
  loadingId,
  onJump,
}: Props) {
  return (
    <>
      {users.slice(-MAX_ANCHOR_DOTS).map((u) => (
        <Tooltip key={u.id} content={u.preview || ''} direction="left">
          <button
            className={`msg-anchor-dot${activeId === u.id ? ' active' : ''}${loadingId === u.id ? ' loading' : ''
              }`}
            onClick={() => onJump(u.id)}
            type="button"
            aria-label={t('跳转到该消息')}
          />
        </Tooltip>
      ))}
    </>
  )
})
