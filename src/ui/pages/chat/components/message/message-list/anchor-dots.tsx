/**
 * 用户消息锚点列表（覆盖整个会话的全量 user 消息，可视区内滚动查找）。
 *
 * 圆点可能有上千个：外层 memo 挡住「users 换了」之外的输入，内层 `AnchorDot` 再按 id 挡住
 * 「active / loading 变了」——否则滚动时每换一次活跃消息，几百个 Tooltip 都要整片重渲染
 * （单个圆点约 0.5ms，几百个就是几十到上百毫秒）。
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

/** 单个圆点：props 全是原始值，active / loading 不变就跳过重渲染 */
const AnchorDot = memo(function AnchorDot({
  id,
  preview,
  active,
  loading,
  onJump,
}: {
  id: string
  preview: string
  active: boolean
  loading: boolean
  onJump: (id: string) => void
}) {
  return (
    <Tooltip content={preview || ''} direction="left">
      <button
        className={`msg-anchor-dot${active ? ' active' : ''}${loading ? ' loading' : ''}`}
        onClick={() => onJump(id)}
        type="button"
        aria-label={t('跳转到该消息')}
      />
    </Tooltip>
  )
})

export const AnchorDots = memo(function AnchorDots({
  users,
  activeId,
  loadingId,
  onJump,
}: Props) {
  return (
    <>
      {users.slice(-MAX_ANCHOR_DOTS).map((u) => (
        <AnchorDot
          key={u.id}
          id={u.id}
          preview={u.preview}
          active={activeId === u.id}
          loading={loadingId === u.id}
          onJump={onJump}
        />
      ))}
    </>
  )
})
