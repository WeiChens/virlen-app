/**
 * message-list 浮层 / 提示条（状态与回调由父组件注入，唯一的内部状态是错误详情弹窗的开关）。
 * 抽出来是为了把大段 JSX 从 message-list.tsx 移出 —— 除 ErrorBanner 的「查看详情」外无 hook 状态。
 */
import { useState } from 'react'
import { t } from '@/ui/i18n'
import Modal from '@/ui/components/shared/Modal'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import { LOAD_MORE_HINT_HEIGHT } from './constants'

/**
 * 顶部错误提示条：条形里只放**单行省略**的摘要（长报错会把整条撑成一段正文），
 * 全文交给「查看详情」弹窗（弹窗内滚动），「✕」只关提示条、不影响详情弹窗。
 */
export function ErrorBanner({
  error,
  onClose,
}: {
  error: string
  onClose: () => void
}) {
  const [detailVisible, setDetailVisible] = useState(false)
  return (
    <>
      <div className="error-banner">
        <span className="error-banner-text" title={error}>
          {error}
        </span>
        <button
          className="error-banner-detail"
          onClick={() => setDetailVisible(true)}>
          {t('查看详情')}
        </button>
        <button className="error-banner-close" onClick={onClose}>
          ✕
        </button>
      </div>
      <Modal
        visible={detailVisible}
        title={t('错误详情')}
        width={640}
        onClose={() => setDetailVisible(false)}
        footer={
          <button
            className="btn-confirm"
            onClick={() => setDetailVisible(false)}>
            {t('关闭')}
          </button>
        }>
        {/* 全文原样呈现（保留换行 / 缩进）：stack / API 报文靠空白定位问题 */}
        <pre className="error-detail-text">{error}</pre>
      </Modal>
    </>
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
        <span className="paused-text">{t('本轮回复已暂停，是否继续？')}</span>
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
