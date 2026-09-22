/**
 * message-list 浮层 / 提示条（纯展示，状态与回调由父组件注入）
 *
 * 抽出的目的是把大段 JSX 从 message-list.tsx 移出，
 * 这些组件不含任何 hook 状态，行为与内联 JSX 等价。
 */
import { t } from '@/ui/i18n'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import { LOAD_MORE_HINT_HEIGHT } from './constants'

/** 顶部错误提示条 */
export function ErrorBanner({
  error,
  onClose,
}: {
  error: string
  onClose: () => void
}) {
  return (
    <div className="error-banner">
      <span>{error}</span>
      <button onClick={onClose}>✕</button>
    </div>
  )
}

/** 「点击查看更多 / 加载中」提示条（覆盖在列表顶部） */
export function LoadMoreHint({
  loading,
  onClick,
}: {
  loading: boolean
  onClick: () => void
}) {
  return (
    <div
      className="load-more-hint"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: LOAD_MORE_HINT_HEIGHT,
      }}
      onClick={onClick}>
      {loading ? t('加载更多消息...') : t('点击查看更多')}
    </div>
  )
}

/** 「定位中」提示（点击锚点需回补历史时显示） */
export function JumpLoadingIndicator() {
  return (
    <div className="msg-jump-loading" aria-live="polite">
      <span className="msg-jump-spinner" />
      <span>{t('定位中...')}</span>
    </div>
  )
}

/** 滚动到底部按钮 */
export function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="scroll-to-bottom-btn" onClick={onClick}>
      <DropDownSvg />
    </button>
  )
}

/** 工具调用暂停提示条 */
export function PausedRunBanner({
  onResume,
  onCancel,
}: {
  onResume: () => void
  onCancel: () => void
}) {
  return (
    <div className="paused-run-banner">
      <div className="paused-info">
        <span className="paused-icon">
          <svg
            className="icon"
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            width="200"
            height="200">
            <path
              d="M885.333333 85.333333H138.666667a53.393333 53.393333 0 0 0-53.333334 53.333334v746.666666a53.393333 53.393333 0 0 0 53.333334 53.333334h746.666666a53.393333 53.393333 0 0 0 53.333334-53.333334V138.666667a53.393333 53.393333 0 0 0-53.333334-53.333334z m-458.666666 618.666667a21.333333 21.333333 0 0 1-42.666667 0V320a21.333333 21.333333 0 0 1 42.666667 0z m213.333333 0a21.333333 21.333333 0 0 1-42.666667 0V320a21.333333 21.333333 0 0 1 42.666667 0z"
              fill="var(--accent-color)"></path>
          </svg>
        </span>
        <span className="paused-text">{t('会话已暂停，是否继续？')}</span>
      </div>
      <button className="paused-resume-btn" onClick={onResume}>
        {t('继续')}
      </button>
      <button className="paused-cancel-btn" onClick={onCancel}>
        {t('取消')}
      </button>
    </div>
  )
}
